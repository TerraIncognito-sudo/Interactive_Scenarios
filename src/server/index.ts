/**
 * Server bootstrap.
 *
 * The same process runs on a container host and on a presenter's laptop in
 * offline fallback mode. Every difference between those two is an environment
 * variable read in config.ts — there are no cloud-specific APIs here.
 */

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, lanAddress, lanCandidates, type Config } from './config.ts';
import { Store } from './db.ts';
import { RoomRegistry } from './rooms.ts';
import { attachWebSocketServer } from './ws.ts';
import { loadLibrary, assetsOf, type ScenarioLibrary } from '../scenario/load.ts';
import {
  CreateRoomSchema,
  type CreateRoomResponse,
  type ScenarioListResponse,
} from '../shared/protocol.ts';

export async function buildServer(config: Config) {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: config.local ? undefined : undefined,
    },
    // Behind Cloudflare or any proxy, trust forwarded headers so logged client
    // addresses are the real ones rather than the proxy's.
    trustProxy: true,
  });

  const store = new Store(config.dataDir);
  const registry = new RoomRegistry(store, config.roomTtlMs);

  let library: ScenarioLibrary = await loadLibrary(config.scenariosDir);
  for (const failure of library.failures) {
    app.log.error(
      { dir: failure.dir, problems: failure.error.problems },
      `Scenario failed to load: ${failure.error.message}`,
    );
  }
  for (const [id, loaded] of library.scenarios) {
    for (const warning of loaded.warnings) {
      app.log.warn(`[${id}] ${warning.nodeId ? `[${warning.nodeId}] ` : ''}${warning.message}`);
    }
  }

  const restored = registry.restore(library.scenarios);
  if (restored > 0) app.log.info(`Restored ${restored} live room(s) after restart`);
  registry.startSweeper();

  // ---------------------------------------------------------------------------
  // REST
  // ---------------------------------------------------------------------------

  app.get('/api/health', async () => ({
    ok: true,
    scenarios: library.scenarios.size,
    rooms: registry.list().length,
    uptime: Math.round(process.uptime()),
  }));

  app.get('/api/scenarios', async (): Promise<ScenarioListResponse> => ({
    scenarios: [...library.scenarios.values()].map(({ scenario }) => ({
      id: scenario.id,
      title: scenario.title,
      description: scenario.description,
      nodes: scenario.nodes.length,
      polls: scenario.nodes.filter((n) => n.type === 'poll').length,
    })),
    failures: library.failures.map((f) => ({
      dir: f.dir,
      message: f.error.message,
      problems: f.error.problems,
    })),
  }));

  /**
   * The full scenario, for the display's optimistic local rendering.
   *
   * Token-gated: it contains every branch and ending, and an audience member
   * poking at the network tab should not be able to read the story ahead.
   */
  app.get<{ Params: { code: string }; Querystring: { token?: string } }>(
    '/api/rooms/:code/scenario',
    async (request, reply) => {
      const room = registry.get(request.params.code);
      if (!room) return reply.code(404).send({ error: 'No such room' });
      if (!registry.hasAnyToken(room, request.query.token)) {
        return reply.code(403).send({ error: 'A host or display token is required' });
      }
      return {
        scenario: room.loaded.scenario,
        assets: assetsOf(room.loaded.scenario),
        assetBase: `/scenario-assets/${room.loaded.scenario.id}/`,
      };
    },
  );

  app.post('/api/rooms', async (request, reply): Promise<CreateRoomResponse | undefined> => {
    const parsed = CreateRoomSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'Expected { scenarioId }' });
      return undefined;
    }

    const loaded = library.scenarios.get(parsed.data.scenarioId);
    if (!loaded) {
      reply.code(404).send({ error: `No scenario "${parsed.data.scenarioId}"` });
      return undefined;
    }

    const room = registry.create(loaded);
    app.log.info({ room: room.code, scenario: loaded.scenario.id }, 'Room created');

    const base = config.publicUrl;
    return {
      code: room.code,
      hostToken: room.hostToken,
      displayToken: room.displayToken,
      urls: {
        host: `${base}/host/?room=${room.code}&token=${room.hostToken}`,
        display: `${base}/display/?room=${room.code}&token=${room.displayToken}`,
        join: `${base}/join/${room.code}`,
      },
    };
  });

  /** Re-reads scenario folders without a restart, for authoring iteration. */
  app.post('/api/reload', async () => {
    library = await loadLibrary(config.scenariosDir);
    return {
      scenarios: library.scenarios.size,
      failures: library.failures.map((f) => ({
        dir: f.dir,
        message: f.error.message,
        problems: f.error.problems,
      })),
    };
  });

  // ---------------------------------------------------------------------------
  // Static assets
  // ---------------------------------------------------------------------------

  await app.register(fastifyStatic, {
    root: config.scenariosDir,
    prefix: '/scenario-assets/',
    decorateReply: false,
    // Only serve files that live under a scenario's assets/ folder.
    allowedPath: (pathname) => /^\/[A-Za-z0-9_-]+\/assets\//.test(pathname),
  });

  if (existsSync(config.clientDir)) {
    await app.register(fastifyStatic, {
      root: config.clientDir,
      prefix: '/',
      decorateReply: true,
    });

    // /join/CODE is a client-side route; serve the player app for any code.
    app.get('/join/:code', async (_request, reply) => reply.sendFile('player/index.html'));
  } else {
    app.log.warn(
      `Client bundle not found at ${config.clientDir} — run "npm run build" to serve the UI`,
    );
    app.get('/', async () => ({
      status: 'API only. Run "npm run build" to serve the client.',
    }));
  }

  attachWebSocketServer(app.server, registry);

  app.addHook('onClose', async () => {
    registry.stopSweeper();
    // Shut down rather than close: the process is stopping, the shows are not.
    // State is already persisted, so the next process resumes them.
    registry.shutdownAll();
    store.close();
  });

  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildServer(config);

  await app.listen({ port: config.port, host: config.host });

  const lan = lanAddress();

  if (config.local) {
    // Fallback mode is used when the venue's internet is dead and there is no
    // host console handy — so print everything needed to run a show from the
    // terminal alone, including a QR the room can scan off the laptop screen.
    const { default: QRCode } = await import('qrcode');
    const url = config.publicUrl;

    console.log('\n  LOCAL FALLBACK MODE\n');
    console.log(`  Open this to start:  ${url}`);
    console.log(`  Audience joins at:   ${url}/join/<CODE>\n`);
    console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
    console.log(`  Everyone must be on the same network as ${lan ?? 'this machine'}.`);

    // Interface choice is a guess, and a wrong QR code is only discovered when
    // a room of people cannot join. Show the alternatives so it can be
    // corrected in seconds with PUBLIC_URL rather than debugged live.
    const others = lanCandidates().filter((c) => c.address !== lan);
    if (others.length > 0) {
      console.log(`\n  Other addresses on this machine:`);
      for (const candidate of others) {
        console.log(`    http://${candidate.address}:${config.port}  (${candidate.iface})`);
      }
      console.log(`  If phones cannot reach the address above, restart with:`);
      console.log(`    PUBLIC_URL=http://<the right one>:${config.port} npm run local`);
    }
    console.log();
  } else {
    app.log.info(`Public URL   ${config.publicUrl}`);
    if (lan) app.log.info(`LAN URL      http://${lan}:${config.port}`);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      app.log.info(`${signal} received, shutting down`);
      app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
}

// Only run when executed directly, so tests can import buildServer.
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().catch((err) => {
    console.error('Server failed to start:', err);
    process.exit(1);
  });
}

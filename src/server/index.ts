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
  type LiveSession,
  type ScenarioListResponse,
  type SessionListResponse,
} from '../shared/protocol.ts';
import type { Room } from './room.ts';
import {
  ADMIN_COOKIE,
  buildCookie,
  clearCookie,
  issueToken,
  readCookie,
  safeEqual,
  verifyToken,
} from './auth.ts';

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

  registry.onRoomError = (error, room, nodeId) => {
    app.log.error({ room, nodeId, err: error }, 'Room clock stalled');
  };

  const restored = registry.restore(library.scenarios);
  if (restored > 0) app.log.info(`Restored ${restored} live room(s) after restart`);
  registry.startSweeper();

  // ---------------------------------------------------------------------------
  // REST
  // ---------------------------------------------------------------------------

  const secret = store.secret();

  /**
   * The base URL for links we hand out.
   *
   * Derived from the request unless explicitly overridden, so browsing to
   * http://192.168.1.149:8880 yields links back to that same address. The old
   * behaviour — falling back to localhost — produced links that looked valid
   * and pointed at the operator's own machine.
   */
  const baseUrlFor = (request: { protocol: string; headers: Record<string, unknown> }): string => {
    if (config.publicUrl) return config.publicUrl;

    const forwardedHost = String(request.headers['x-forwarded-host'] ?? '')
      .split(',')[0]
      ?.trim();
    const forwardedProto = String(request.headers['x-forwarded-proto'] ?? '')
      .split(',')[0]
      ?.trim();
    const host = forwardedHost || String(request.headers['host'] ?? '') || 'localhost';
    const protocol = forwardedProto || request.protocol || 'http';
    return `${protocol}://${host}`;
  };

  /** The three links a session is driven from, built once so they cannot drift. */
  const linksFor = (room: Room, base: string): LiveSession['urls'] => ({
    host: `${base}/host/?room=${room.code}&token=${room.hostToken}&displayToken=${encodeURIComponent(room.displayToken)}`,
    display: `${base}/display/?room=${room.code}&token=${room.displayToken}`,
    join: `${base}/join/${room.code}`,
  });

  const isAuthed = (request: { headers: Record<string, unknown> }): boolean => {
    const cookie = readCookie(request.headers['cookie'] as string | undefined, ADMIN_COOKIE);
    if (verifyToken(cookie, secret)) return true;

    // Also accept the password directly, so scripts and curl can create rooms.
    const header = request.headers['x-admin-password'];
    return typeof header === 'string' && safeEqual(header, config.adminPassword);
  };

  app.get('/api/health', async () => ({
    ok: true,
    scenarios: library.scenarios.size,
    rooms: registry.list().length,
    uptime: Math.round(process.uptime()),
  }));

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  app.get('/api/session', async (request) => ({ authenticated: isAuthed(request) }));

  app.post('/api/login', async (request, reply) => {
    const body = request.body as { password?: unknown } | undefined;
    const password = typeof body?.password === 'string' ? body.password : '';

    if (!safeEqual(password, config.adminPassword)) {
      // A uniform small delay blunts trivial online guessing without pretending
      // this is more than a rudimentary gate.
      await new Promise((resolve) => setTimeout(resolve, 400));
      return reply.code(401).send({ error: 'Incorrect password' });
    }

    const secureCookie = baseUrlFor(request).startsWith('https://');
    reply.header('set-cookie', buildCookie(ADMIN_COOKIE, issueToken(secret), secureCookie));
    return { ok: true };
  });

  app.post('/api/logout', async (_request, reply) => {
    reply.header('set-cookie', clearCookie(ADMIN_COOKIE));
    return { ok: true };
  });

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
        // Down to `assets/`, because that is where the files are and the
        // display joins this to a name straight out of the scenario. Stopping
        // one level short went unnoticed for as long as it did because no
        // scenario had a single asset made yet — the first one would have been
        // a 404 in front of a room.
        assetBase: `/scenario-assets/${room.loaded.scenario.id}/assets/`,
      };
    },
  );

  app.post('/api/rooms', async (request, reply): Promise<CreateRoomResponse | undefined> => {
    if (!isAuthed(request)) {
      reply.code(401).send({ error: 'Sign in to create a session' });
      return undefined;
    }

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

    return {
      code: room.code,
      hostToken: room.hostToken,
      displayToken: room.displayToken,
      urls: linksFor(room, baseUrlFor(request)),
    };
  });

  // ---------------------------------------------------------------------------
  // Session control
  // ---------------------------------------------------------------------------

  /**
   * Every live session, with its links.
   *
   * Admin-only, and not merely for tidiness: the response carries host and
   * display tokens, which exist nowhere else once the creating tab is gone.
   * That is the point — it is what makes a lost host console recoverable — but
   * it means this endpoint hands over full control of every running show.
   */
  app.get('/api/rooms', async (request, reply): Promise<SessionListResponse | undefined> => {
    if (!isAuthed(request)) {
      reply.code(401).send({ error: 'Sign in to view sessions' });
      return undefined;
    }

    const base = baseUrlFor(request);
    const sessions: LiveSession[] = registry
      .list()
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .map((room) => ({
        code: room.code,
        scenario: { id: room.loaded.scenario.id, title: room.loaded.scenario.title },
        phase: room.phase,
        nodeId: room.state.nodeId,
        beat: room.state.beat,
        displayReady: room.displayReady,
        presence: { displays: room.displayCount, players: room.playerCount },
        pollEndsAt: room.state.phase === 'polling' ? room.state.poll?.endsAt : undefined,
        createdAt: room.createdAt,
        lastActivityAt: room.lastActivityAt,
        urls: linksFor(room, base),
      }));

    return { sessions, serverNow: Date.now() };
  });

  /** Ends a session for good. It will not come back after a restart. */
  app.post<{ Params: { code: string } }>('/api/rooms/:code/close', async (request, reply) => {
    if (!isAuthed(request)) {
      reply.code(401).send({ error: 'Sign in to end a session' });
      return undefined;
    }
    if (!registry.closeRoom(request.params.code)) {
      reply.code(404).send({ error: 'No such room' });
      return undefined;
    }
    app.log.info({ room: request.params.code.toUpperCase() }, 'Room closed from admin');
    return { ok: true };
  });

  /**
   * Rewinds a session to the top without ending it.
   *
   * The room code, tokens and connected clients all survive, so a rehearsal can
   * be reset without asking a room full of people to rescan a new QR code.
   */
  app.post<{ Params: { code: string } }>('/api/rooms/:code/reset', async (request, reply) => {
    if (!isAuthed(request)) {
      reply.code(401).send({ error: 'Sign in to reset a session' });
      return undefined;
    }
    const room = registry.get(request.params.code);
    if (!room) {
      reply.code(404).send({ error: 'No such room' });
      return undefined;
    }
    room.handleCommand({ name: 'reset' });
    app.log.info({ room: room.code }, 'Room reset from admin');
    return { ok: true, phase: room.phase };
  });

  /** Re-reads scenario folders without a restart, for authoring iteration. */
  app.post('/api/reload', async (request, reply) => {
    if (!isAuthed(request)) {
      reply.code(401).send({ error: 'Sign in to reload scenarios' });
      return undefined;
    }
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

    // The root belongs to the audience. Almost everyone who reaches this
    // server is here to join a session, not to run one, so the landing page
    // is the join screen and the controls live at /admin behind the password.
    app.get('/', async (_request, reply) => reply.sendFile('player/index.html'));

    // /join/CODE is a client-side route; serve the player app for any code.
    app.get('/join/:code', async (_request, reply) => reply.sendFile('player/index.html'));

    app.get('/admin', async (_request, reply) => reply.sendFile('admin/index.html'));

    // /new was the original name. Kept as a redirect because it is written down
    // in notes and browser histories that this rename cannot reach.
    //
    // 302 rather than 301 on purpose: a permanent redirect is cached by the
    // browser indefinitely, so if /new ever needs to mean something else, every
    // machine that visited it once would keep going to /admin regardless.
    app.get('/new', async (_request, reply) => reply.redirect('/admin', 302));
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
    const url = config.publicUrl ?? `http://${lan ?? 'localhost'}:${config.port}`;

    console.log('\n  LOCAL FALLBACK MODE\n');
    console.log(`  Open this to start:  ${url}/admin`);
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
    const shown = config.publicUrl ?? `http://${lan ?? 'localhost'}:${config.port}`;
    app.log.info(`Audience join page   ${shown}/`);
    app.log.info(`Admin console at     ${shown}/admin`);
    if (!config.publicUrl) {
      app.log.info('PUBLIC_URL is not set; links are derived from each request');
    }
  }

  // Printed rather than logged, so it is legible in `docker logs` even at a
  // raised log level. A generated password is useless if nobody can find it.
  if (config.adminPasswordGenerated) {
    console.log('\n  ADMIN PASSWORD (generated — set ADMIN_PASSWORD to choose your own)\n');
    console.log(`      ${config.adminPassword}\n`);
    console.log('  Needed once, at /admin, to run sessions.\n');
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

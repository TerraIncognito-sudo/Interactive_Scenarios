/**
 * The relay.
 *
 * A box that carries votes between an operator's machine and a room full of
 * phones. It holds no scenario, no beat and no state machine — hand it a
 * `scenario.yaml` and it could not read one, because it has no YAML parser and
 * nothing here imports the engine. That inability is the security property,
 * and it is enforced by the dependency list rather than by care: a test walks
 * this file's import graph and fails if anything from `shared/scenario/` or
 * `shared/engine/` is reachable from it.
 *
 * Three surfaces. `/join/CODE` is the audience's page, and the root is that
 * same page, because almost everyone who reaches this server is here to vote.
 * `/status` says what is running, for the night somebody is holding a phone in
 * front of forty people saying "it says no such room". `/keys` is where the
 * passphrases that let a client open a room are issued and revoked.
 */

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadConfig, baseUrlFor, type Config } from './config.ts';
import { Store } from './db.ts';
import { RelayRegistry } from './rooms.ts';
import { attachRelayWebSocketServer } from './ws.ts';
import { generatePhrase, KeyAttempts } from './keys.ts';
import type {
  RelayKeysResponse,
  RelayRoomView,
  RelayStatusResponse,
} from '../shared/relay/protocol.ts';
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
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Behind Cloudflare or any proxy, trust forwarded headers so logged client
    // addresses are the real ones rather than the proxy's.
    trustProxy: true,
  });

  const store = new Store(config.dataDir);
  const registry = new RelayRegistry(store, config.roomTtlMs);
  const attempts = new KeyAttempts();

  const restored = registry.restore();
  if (restored > 0) app.log.info(`Restored ${restored} live room(s) after restart`);
  registry.startSweeper();

  const secret = store.secret();

  const isAuthed = (request: { headers: Record<string, unknown> }): boolean => {
    const cookie = readCookie(request.headers['cookie'] as string | undefined, ADMIN_COOKIE);
    if (verifyToken(cookie, secret)) return true;

    // Also accept the password directly, so scripts and curl can issue keys.
    const header = request.headers['x-admin-password'];
    return typeof header === 'string' && safeEqual(header, config.adminPassword);
  };

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  /**
   * `keyed` is the one field that explains a relay which is up and refusing
   * everything: a fresh container issues no keys and opens no rooms until
   * somebody signs into the console and generates one.
   */
  app.get('/api/health', async () => ({
    ok: true,
    rooms: registry.list().length,
    keyed: store.liveKeys().length > 0,
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

    const secureCookie = baseUrlFor(config.publicUrl, request.headers, request.protocol).startsWith(
      'https://',
    );
    reply.header('set-cookie', buildCookie(ADMIN_COOKIE, issueToken(secret), secureCookie));
    return { ok: true };
  });

  app.post('/api/logout', async (_request, reply) => {
    reply.header('set-cookie', clearCookie(ADMIN_COOKIE));
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  /**
   * Every live room.
   *
   * **It must not carry the room token.** The list this replaces did, and said
   * why: a host link lost to a closed tab stranded a live show, and the tokens
   * existed nowhere else. There is no host link any more — the client holds its
   * own token and resumes with it — so the field goes, and with it this
   * endpoint's ability to hand a reader full control of every running show.
   * The absence is deliberate; do not add it back for convenience.
   */
  app.get('/api/rooms', async (request, reply): Promise<RelayStatusResponse | undefined> => {
    if (!isAuthed(request)) {
      reply.code(401).send({ error: 'Sign in to view rooms' });
      return undefined;
    }

    const base = baseUrlFor(config.publicUrl, request.headers, request.protocol);
    const labels = new Map(store.listKeys().map((key) => [key.id, key.label]));

    const rooms: RelayRoomView[] = registry
      .list()
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .map((room) => {
        const poll = room.openPoll();
        return {
          code: room.code,
          ...(room.title !== undefined ? { title: room.title } : {}),
          players: room.playerCount,
          clientConnected: room.hasClient,
          ...(room.keyId !== null ? { keyId: room.keyId } : {}),
          ...(room.keyId !== null && labels.has(room.keyId)
            ? { keyLabel: labels.get(room.keyId)! }
            : {}),
          ...(poll
            ? { poll: { nodeId: poll.nodeId, endsAt: poll.endsAt, closed: poll.closed } }
            : {}),
          createdAt: room.createdAt,
          lastActivityAt: room.lastActivityAt,
          joinUrl: `${base}/join/${room.code}`,
        };
      });

    return { rooms, serverNow: Date.now() };
  });

  /**
   * Ends a room for good.
   *
   * The escape for a room a crashed client left holding a code, and the
   * deliberate way to stop a show whose key has been revoked — because
   * revoking a key does not touch a room already running.
   */
  app.post<{ Params: { code: string } }>('/api/rooms/:code/close', async (request, reply) => {
    if (!isAuthed(request)) {
      reply.code(401).send({ error: 'Sign in to end a room' });
      return undefined;
    }
    if (!registry.closeRoom(request.params.code)) {
      reply.code(404).send({ error: 'No such room' });
      return undefined;
    }
    app.log.info({ room: request.params.code.toUpperCase() }, 'Room ended from the console');
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Keys
  // ---------------------------------------------------------------------------

  const roomsPerKey = (): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const room of registry.list()) {
      if (room.keyId === null) continue;
      counts.set(room.keyId, (counts.get(room.keyId) ?? 0) + 1);
    }
    return counts;
  };

  app.get('/api/keys', async (request, reply): Promise<RelayKeysResponse | undefined> => {
    if (!isAuthed(request)) {
      reply.code(401).send({ error: 'Sign in to view keys' });
      return undefined;
    }
    const open = roomsPerKey();
    return {
      keys: store.listKeys().map((key) => ({
        id: key.id,
        label: key.label,
        // Listed in the clear on purpose: a key you can only see once is a key
        // that ends up on a sticky note. See `server/keys.ts`.
        phrase: key.phrase,
        createdAt: key.created_at,
        ...(key.last_used_at !== null ? { lastUsedAt: key.last_used_at } : {}),
        ...(key.revoked_at !== null ? { revokedAt: key.revoked_at } : {}),
        openRooms: open.get(key.id) ?? 0,
      })),
    };
  });

  app.post('/api/keys', async (request, reply) => {
    if (!isAuthed(request)) {
      reply.code(401).send({ error: 'Sign in to issue a key' });
      return undefined;
    }
    const body = request.body as { label?: unknown } | undefined;
    const label = typeof body?.label === 'string' ? body.label.trim().slice(0, 80) : '';
    // A list of five-word phrases with no note beside them is a list nobody
    // dares revoke from, so the label is required rather than encouraged.
    if (!label) {
      reply.code(400).send({ error: 'Give the key a label — whose machine is it for?' });
      return undefined;
    }

    const key = {
      id: randomUUID(),
      label,
      phrase: generatePhrase(),
      created_at: Date.now(),
      last_used_at: null,
      revoked_at: null,
    };
    store.createKey(key);
    app.log.info({ key: key.id, label }, 'Key issued');
    return { id: key.id, label: key.label, phrase: key.phrase, createdAt: key.created_at };
  });

  app.post<{ Params: { id: string } }>('/api/keys/:id/revoke', async (request, reply) => {
    if (!isAuthed(request)) {
      reply.code(401).send({ error: 'Sign in to revoke a key' });
      return undefined;
    }
    if (!store.revokeKey(request.params.id, Date.now())) {
      reply.code(404).send({ error: 'No such key, or it is already revoked' });
      return undefined;
    }
    app.log.info({ key: request.params.id }, 'Key revoked');
    // Rooms already open under it keep running. Ending one is a decision
    // somebody makes on the status page while looking at it.
    return { ok: true, openRooms: roomsPerKey().get(request.params.id) ?? 0 };
  });

  // ---------------------------------------------------------------------------
  // Static
  // ---------------------------------------------------------------------------

  if (existsSync(config.webDir)) {
    await app.register(fastifyStatic, {
      root: config.webDir,
      prefix: '/',
      decorateReply: true,
    });

    // The root belongs to the audience. Almost everyone who reaches this
    // server is here to vote, so the landing page is the join screen.
    app.get('/', async (_request, reply) => reply.sendFile('player/index.html'));

    // /join/CODE is a client-side route; serve the player app for any code.
    app.get('/join/:code', async (_request, reply) => reply.sendFile('player/index.html'));

    app.get('/status', async (_request, reply) => reply.sendFile('status/index.html'));
    app.get('/keys', async (_request, reply) => reply.sendFile('keys/index.html'));

    // /admin was where the console lived when this server ran shows. Kept as a
    // redirect because it is written down in notes and browser histories that
    // a rename cannot reach. 302 rather than 301: a permanent redirect is
    // cached indefinitely, so if /admin ever means something else again, every
    // machine that visited it once would keep going to /status regardless.
    app.get('/admin', async (_request, reply) => reply.redirect('/status', 302));
  } else {
    app.log.warn(`Web bundle not found at ${config.webDir} — run "npm run build" to serve it`);
    app.get('/', async () => ({
      status: 'API only. Run "npm run build" to serve the join page and console.',
    }));
  }

  attachRelayWebSocketServer(app.server, {
    registry,
    store,
    attempts,
    publicUrl: config.publicUrl,
    onRoomOpened: (room) => app.log.info({ room: room.code, key: room.keyId }, 'Room opened'),
  });

  app.addHook('onClose', async () => {
    registry.stopSweeper();
    // Shut down rather than close: the process is stopping, the rooms are not.
    // They are already persisted, so the next process picks them back up.
    registry.shutdownAll();
    store.close();
  });

  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildServer(config);

  await app.listen({ port: config.port, host: config.host });

  const shown = config.publicUrl ?? `http://localhost:${config.port}`;
  app.log.info(`Audience join page   ${shown}/`);
  app.log.info(`Live rooms at        ${shown}/status`);
  app.log.info(`Keys at              ${shown}/keys`);
  if (!config.publicUrl) {
    app.log.info('PUBLIC_URL is not set; join links are derived from each request');
  }

  // Printed rather than logged, so it is legible in `docker logs` even at a
  // raised log level. A generated password is useless if nobody can find it.
  if (config.adminPasswordGenerated) {
    console.log('\n  ADMIN PASSWORD (generated — set ADMIN_PASSWORD to choose your own)\n');
    console.log(`      ${config.adminPassword}\n`);
    console.log('  Needed once, at /keys, to issue the key a client signs in with.\n');
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
    console.error('Relay failed to start:', err);
    process.exit(1);
  });
}

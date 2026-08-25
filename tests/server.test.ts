/**
 * End-to-end integration over real WebSockets.
 *
 * This is the risk milestone in test form: prove that votes arriving from
 * separate connections actually drive the story to a different ending, that
 * the room code alone cannot drive the show, and that a poll nobody votes in
 * still moves on.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { buildServer } from '../src/server/index.ts';
import type { Config } from '../src/server/config.ts';
import type { PlayerState, SessionListResponse, Snapshot } from '../src/shared/protocol.ts';

type App = Awaited<ReturnType<typeof buildServer>>;

let app: App;
let baseUrl: string;
let wsUrl: string;
let dataDir: string;

const TEST_PASSWORD = 'test-password';
const fixtures = join(import.meta.dirname, 'fixtures', 'scenarios');

before(async () => {
  process.env.LOG_LEVEL = 'silent';
  dataDir = mkdtempSync(join(tmpdir(), 'interactive-scenario-test-'));
  const config: Config = {
    port: 0,
    host: '127.0.0.1',
    dataDir,
    scenariosDir: fixtures,
    clientDir: join(dataDir, 'no-client'),
    // Unset, so link generation is exercised the way it runs in production.
    publicUrl: undefined,
    local: false,
    roomTtlMs: 60_000,
    adminPassword: TEST_PASSWORD,
    adminPasswordGenerated: false,
  };
  app = await buildServer(config);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});

after(async () => {
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Client = {
  socket: WebSocket;
  messages: unknown[];
  /** Waits for the first message matching a predicate, with a timeout. */
  next<T>(match: (m: any) => boolean, timeoutMs?: number): Promise<T>;
  send(message: unknown): void;
  close(): void;
};

function connect(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const messages: unknown[] = [];
    const waiters: { match: (m: any) => boolean; resolve: (v: any) => void }[] = [];

    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      messages.push(message);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.match(message)) {
          waiters[i]!.resolve(message);
          waiters.splice(i, 1);
        }
      }
    });

    socket.on('error', reject);
    socket.on('open', () =>
      resolve({
        socket,
        messages,
        next<T>(match: (m: any) => boolean, timeoutMs = 4000): Promise<T> {
          const existing = messages.find((m) => match(m));
          if (existing) return Promise.resolve(existing as T);
          return new Promise<T>((res, rej) => {
            const timer = setTimeout(
              () =>
                rej(
                  new Error(
                    `Timed out. Saw: ${messages.map((m: any) => m.type).join(', ') || '(none)'}`,
                  ),
                ),
              timeoutMs,
            );
            waiters.push({
              match,
              resolve: (v) => {
                clearTimeout(timer);
                res(v);
              },
            });
          });
        },
        send: (message) => socket.send(JSON.stringify(message)),
        close: () => socket.close(),
      }),
    );
  });
}

async function createRoom(scenarioId = 'quick') {
  const response = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-password': TEST_PASSWORD },
    body: JSON.stringify({ scenarioId }),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as {
    code: string;
    hostToken: string;
    displayToken: string;
  };
}

const isSnapshot = (m: any): m is Snapshot => m?.type === 'snapshot';
const isPlayerState = (m: any): m is PlayerState => m?.type === 'playerState';

async function joinHost(code: string, token: string): Promise<Client> {
  const client = await connect();
  client.send({ type: 'hello', role: 'host', room: code, token });
  await client.next(isSnapshot);
  return client;
}

async function joinPlayer(code: string, deviceId: string): Promise<Client> {
  const client = await connect();
  client.send({ type: 'hello', role: 'player', room: code, deviceId });
  await client.next(isPlayerState);
  return client;
}

/**
 * Retries until the callback returns something, for state that settles a beat
 * after the request that caused it — socket presence, mainly.
 */
async function pollUntil<T>(attempt: () => Promise<T | undefined>, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await attempt();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error('Timed out waiting for server state');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Drives a room to its open poll and returns the host client. */
async function runToPoll(code: string, hostToken: string): Promise<Client> {
  const host = await joinHost(code, hostToken);
  host.send({ type: 'command', command: { name: 'start' } });
  await host.next<Snapshot>((m) => isSnapshot(m) && m.beatInfo?.kind === 'poll');
  return host;
}

// ---------------------------------------------------------------------------

describe('creating a session is gated', () => {
  test('an unauthenticated request cannot create a room', async () => {
    const response = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenarioId: 'quick' }),
    });
    assert.equal(response.status, 401, 'strangers must not be able to spawn sessions');
  });

  test('a wrong password is rejected', async () => {
    const response = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-password': 'wrong' },
      body: JSON.stringify({ scenarioId: 'quick' }),
    });
    assert.equal(response.status, 401);
  });

  test('logging in returns a cookie that works for creating rooms', async () => {
    const bad = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'not-it' }),
    });
    assert.equal(bad.status, 401);

    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    assert.equal(login.status, 200);

    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    assert.match(cookie, /^scenario_admin=/);

    const created = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ scenarioId: 'quick' }),
    });
    assert.equal(created.status, 200);

    const session = await (await fetch(`${baseUrl}/api/session`, { headers: { cookie } })).json();
    assert.equal((session as { authenticated: boolean }).authenticated, true);
  });

  test('a forged cookie is rejected', async () => {
    const response = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: 'scenario_admin=eyJhIjoxfQ.deadbeef',
      },
      body: JSON.stringify({ scenarioId: 'quick' }),
    });
    assert.equal(response.status, 401);
  });

  test('reloading scenarios is gated too', async () => {
    const response = await fetch(`${baseUrl}/api/reload`, { method: 'POST' });
    assert.equal(response.status, 401);
  });

  test('the audience still needs nothing to see the join page or vote', async () => {
    // Gating session creation must not gate participation.
    const scenarios = await fetch(`${baseUrl}/api/scenarios`);
    assert.equal(scenarios.status, 200);
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
  });
});

describe('link generation', () => {
  test('links follow the address the request arrived on', async () => {
    // The old behaviour fell back to localhost regardless of how the server
    // was reached, producing links that looked valid but pointed at the
    // operator's own machine. Here baseUrl is 127.0.0.1:<ephemeral port>, so
    // matching it proves the base is derived from the request rather than
    // from a fixed default.
    const response = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-password': TEST_PASSWORD },
      body: JSON.stringify({ scenarioId: 'quick' }),
    });
    const room = (await response.json()) as { urls: Record<string, string> };

    for (const [name, url] of Object.entries(room.urls)) {
      assert.ok(
        url.startsWith(`${baseUrl}/`),
        `${name} link should start with ${baseUrl}, got ${url}`,
      );
      assert.ok(!url.includes('localhost'), `${name} link must not fall back to localhost`);
    }
  });

  test('a proxy that forwards its own host and scheme is honoured', async () => {
    const response = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-password': TEST_PASSWORD,
        'x-forwarded-host': 'scurrycat.ca',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ scenarioId: 'quick' }),
    });
    const room = (await response.json()) as { urls: Record<string, string> };
    const join = room.urls.join ?? '';
    assert.ok(join.startsWith('https://scurrycat.ca/join/'), join);
  });
});

describe('room access control', () => {
  test('the room code alone lets you vote but not drive', async () => {
    const room = await createRoom();

    const player = await connect();
    player.send({ type: 'hello', role: 'player', room: room.code, deviceId: 'device-aaaaaaa' });
    const state = await player.next<PlayerState>(isPlayerState);
    assert.equal(state.type, 'playerState');
    player.close();

    // Same code, host role, no token.
    const impostor = await connect();
    impostor.send({ type: 'hello', role: 'host', room: room.code });
    const error = await impostor.next<any>((m) => m.type === 'error');
    assert.equal(error.code, 'badToken');
    impostor.close();
  });

  test('a wrong token is rejected', async () => {
    const room = await createRoom();
    const client = await connect();
    client.send({ type: 'hello', role: 'display', room: room.code, token: 'not-the-token' });
    const error = await client.next<any>((m) => m.type === 'error');
    assert.equal(error.code, 'badToken');
    client.close();
  });

  test('a well-formed but unknown room code is rejected', async () => {
    const client = await connect();
    // Valid alphabet, so it passes schema validation and reaches the lookup.
    client.send({ type: 'hello', role: 'player', room: 'ABCDEF', deviceId: 'device-aaaaaaa' });
    const error = await client.next<any>((m) => m.type === 'error');
    assert.equal(error.code, 'badRoom');
    client.close();
  });

  test('a code using letters excluded from the alphabet never reaches lookup', async () => {
    // Z, O, I and S are excluded because they misread off a projector.
    const client = await connect();
    client.send({ type: 'hello', role: 'player', room: 'ZZZZZZ', deviceId: 'device-aaaaaaa' });
    const error = await client.next<any>((m) => m.type === 'error');
    assert.equal(error.code, 'badMessage');
    client.close();
  });

  test('malformed frames are rejected without dropping the connection', async () => {
    const client = await connect();
    client.socket.send('this is not json');
    const error = await client.next<any>((m) => m.type === 'error');
    assert.equal(error.code, 'badMessage');
    assert.equal(error.fatal, false);
    assert.equal(client.socket.readyState, WebSocket.OPEN);
    client.close();
  });

  test('commands are refused before a hello', async () => {
    const client = await connect();
    client.send({ type: 'command', command: { name: 'start' } });
    const error = await client.next<any>((m) => m.type === 'error');
    assert.equal(error.code, 'badMessage');
    client.close();
  });

  test('the full scenario needs a token, so the audience cannot read ahead', async () => {
    const room = await createRoom();

    const denied = await fetch(`${baseUrl}/api/rooms/${room.code}/scenario`);
    assert.equal(denied.status, 403);

    const allowed = await fetch(
      `${baseUrl}/api/rooms/${room.code}/scenario?token=${room.displayToken}`,
    );
    assert.equal(allowed.status, 200);
    const body = (await allowed.json()) as any;
    assert.equal(body.scenario.id, 'quick');
    assert.ok(Array.isArray(body.assets));
  });
});

describe('media reaches the projector', () => {
  test('the prefetch list includes voice clips and scene video', async () => {
    const room = await createRoom('media');
    const response = await fetch(
      `${baseUrl}/api/rooms/${room.code}/scenario?token=${room.displayToken}`,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { assets: string[] };

    // The display blocks on this list before reporting ready, so anything
    // missing from it is an asset that streams in live in front of the room.
    assert.deepEqual(body.assets.sort(), [
      'harbour.jpg',
      'harbour.mp3',
      'harbour.mp4',
      'open-1.mp3',
    ]);
  });

  test('a snapshot carries the line voice and the scene video', async () => {
    const room = await createRoom('media');
    const host = await joinHost(room.code, room.hostToken);
    host.send({ type: 'command', command: { name: 'start' } });

    const first = await host.next<Snapshot>(
      (m) => isSnapshot(m) && m.beatInfo?.kind === 'dialogue' && m.beatInfo.lineIndex === 0,
    );

    assert.equal(first.beatInfo.kind === 'dialogue' && first.beatInfo.voice, 'open-1.mp3');
    assert.equal(first.scene?.id, 'harbour');
    assert.equal(first.scene?.video, 'harbour.mp4');
    assert.equal(
      first.scene?.background,
      'harbour.jpg',
      'the still has to travel with the clip — it is the poster frame',
    );

    host.close();
  });

  test('a line with no voice says so, rather than inheriting the last one', async () => {
    const room = await createRoom('media');
    const host = await joinHost(room.code, room.hostToken);
    host.send({ type: 'command', command: { name: 'start' } });

    const second = await host.next<Snapshot>(
      (m) => isSnapshot(m) && m.beatInfo?.kind === 'dialogue' && m.beatInfo.lineIndex === 1,
    );
    assert.equal(second.beatInfo.kind === 'dialogue' && second.beatInfo.voice, undefined);

    // Scene is sticky, so the clip stays until a node names a different scene.
    const later = await host.next<Snapshot>(
      (m) => isSnapshot(m) && m.scene?.id === 'quiet',
    );
    assert.equal(later.scene?.video, undefined, 'a scene without a clip must clear it');

    host.close();
  });
});

describe('a show driven by audience votes', () => {
  test('votes decide which branch the story takes', async () => {
    const room = await createRoom();
    const host = await runToPoll(room.code, room.hostToken);

    const a = await joinPlayer(room.code, 'device-aaaaaaa');
    const b = await joinPlayer(room.code, 'device-bbbbbbb');
    const c = await joinPlayer(room.code, 'device-ccccccc');

    a.send({ type: 'vote', optionKey: 'left' });
    b.send({ type: 'vote', optionKey: 'left' });
    c.send({ type: 'vote', optionKey: 'right' });

    // Host sees the live tally before the poll closes.
    const tallied = await host.next<Snapshot>(
      (m) => isSnapshot(m) && (m.tally?.voters ?? 0) === 3,
    );
    assert.deepEqual(tallied.tally?.counts, { left: 2, right: 1 });

    host.send({ type: 'command', command: { name: 'closePoll' } });

    const finished = await host.next<Snapshot>(
      (m) => isSnapshot(m) && m.phase === 'finished',
    );
    assert.equal(finished.beatInfo.kind, 'end');
    assert.equal(
      finished.beatInfo.kind === 'end' && finished.beatInfo.text,
      'Went left.',
      'the majority choice must decide the ending',
    );
    assert.equal(finished.lastResult?.winner, 'left');
    assert.equal(finished.lastResult?.total, 3);

    for (const client of [host, a, b, c]) client.close();
  });

  test('one device counts once, however many times it votes', async () => {
    const room = await createRoom();
    const host = await runToPoll(room.code, room.hostToken);
    const player = await joinPlayer(room.code, 'device-repeat1');

    for (let i = 0; i < 5; i++) player.send({ type: 'vote', optionKey: 'left' });
    player.send({ type: 'vote', optionKey: 'right' });

    const snapshot = await host.next<Snapshot>(
      (m) => isSnapshot(m) && (m.tally?.counts?.right ?? 0) === 1,
    );
    assert.equal(snapshot.tally?.voters, 1, 'one device is one voter');
    assert.deepEqual(snapshot.tally?.counts, { left: 0, right: 1 }, 'last vote wins');

    host.close();
    player.close();
  });

  test('a player reconnecting sees their own choice restored', async () => {
    const room = await createRoom();
    const host = await runToPoll(room.code, room.hostToken);

    const first = await joinPlayer(room.code, 'device-sticky1');
    first.send({ type: 'vote', optionKey: 'left' });
    await first.next<PlayerState>((m) => isPlayerState(m) && m.choice === 'left');
    first.close();

    const again = await joinPlayer(room.code, 'device-sticky1');
    const restored = await again.next<PlayerState>((m) => isPlayerState(m) && !!m.poll);
    assert.equal(restored.choice, 'left');

    host.close();
    again.close();
  });

  test('a poll nobody votes in takes the default and the show continues', async () => {
    const room = await createRoom();
    const host = await runToPoll(room.code, room.hostToken);

    // The fixture's poll window is 1s; let it expire with no votes at all.
    const finished = await host.next<Snapshot>(
      (m) => isSnapshot(m) && m.phase === 'finished',
      6000,
    );
    assert.equal(finished.lastResult?.usedDefault, true);
    assert.equal(finished.lastResult?.winner, 'right');
    assert.equal(
      finished.beatInfo.kind === 'end' && finished.beatInfo.text,
      'Went right.',
      'the declared default must decide it',
    );

    host.close();
  });

  test('players are never sent the story, only their own poll', async () => {
    const room = await createRoom();
    const host = await runToPoll(room.code, room.hostToken);
    const player = await joinPlayer(room.code, 'device-nosecret');

    host.send({ type: 'command', command: { name: 'closePoll' } });
    await host.next<Snapshot>((m) => isSnapshot(m) && m.phase === 'finished');

    // Give the broadcast a moment to arrive, then confirm nothing leaked.
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(
      player.messages.every((m: any) => m.type === 'playerState'),
      `players must only receive playerState, saw: ${player.messages
        .map((m: any) => m.type)
        .join(', ')}`,
    );

    host.close();
    player.close();
  });

  test('a player cannot send host commands', async () => {
    const room = await createRoom();
    const player = await joinPlayer(room.code, 'device-notahost');
    player.send({ type: 'command', command: { name: 'start' } });
    const error = await player.next<any>((m) => m.type === 'error');
    assert.equal(error.code, 'badToken');
    player.close();
  });
});

describe('host overrides', () => {
  test('forceBranch overrides the tally', async () => {
    const room = await createRoom();
    const host = await runToPoll(room.code, room.hostToken);

    const player = await joinPlayer(room.code, 'device-override');
    player.send({ type: 'vote', optionKey: 'left' });
    await host.next<Snapshot>((m) => isSnapshot(m) && (m.tally?.voters ?? 0) === 1);

    host.send({
      type: 'command',
      command: { name: 'forceBranch', optionKey: 'right' },
    });

    const finished = await host.next<Snapshot>((m) => isSnapshot(m) && m.phase === 'finished');
    assert.equal(finished.lastResult?.winner, 'right', 'the override must win over the vote');
    assert.equal(finished.beatInfo.kind === 'end' && finished.beatInfo.text, 'Went right.');

    host.close();
    player.close();
  });

  test('extendPoll pushes the deadline out', async () => {
    const room = await createRoom();
    const host = await runToPoll(room.code, room.hostToken);

    const before = await host.next<Snapshot>((m) => isSnapshot(m) && m.beatInfo.kind === 'poll');
    const originalEnd = before.beatInfo.kind === 'poll' ? before.beatInfo.endsAt : 0;

    host.send({ type: 'command', command: { name: 'extendPoll', seconds: 30 } });
    const after = await host.next<Snapshot>(
      (m) => isSnapshot(m) && m.beatInfo.kind === 'poll' && m.beatInfo.endsAt > originalEnd,
    );
    const extendedEnd = after.beatInfo.kind === 'poll' ? after.beatInfo.endsAt : 0;
    assert.equal(extendedEnd - originalEnd, 30_000);

    host.close();
  });

  test('pause stops the clock and resume restarts it', async () => {
    const room = await createRoom();
    const host = await joinHost(room.code, room.hostToken);

    host.send({ type: 'command', command: { name: 'start' } });
    await host.next<Snapshot>((m) => isSnapshot(m) && m.phase === 'running');

    host.send({ type: 'command', command: { name: 'pause' } });
    const paused = await host.next<Snapshot>((m) => isSnapshot(m) && m.phase === 'paused');
    const frozenBeat = paused.beat;

    await new Promise((r) => setTimeout(r, 400));
    const stillPaused = host.messages.filter(isSnapshot).at(-1)!;
    assert.equal(stillPaused.beat, frozenBeat, 'a paused show must not advance');

    host.send({ type: 'command', command: { name: 'resume' } });
    await host.next<Snapshot>((m) => isSnapshot(m) && m.beat > frozenBeat);

    host.close();
  });

  test('reset returns a finished show to the lobby', async () => {
    const room = await createRoom();
    const host = await runToPoll(room.code, room.hostToken);
    host.send({ type: 'command', command: { name: 'closePoll' } });
    await host.next<Snapshot>((m) => isSnapshot(m) && m.phase === 'finished');

    host.send({ type: 'command', command: { name: 'reset' } });
    const lobby = await host.next<Snapshot>((m) => isSnapshot(m) && m.phase === 'lobby');
    assert.equal(lobby.beatInfo.kind, 'idle');

    host.close();
  });
});

describe('presence and readiness', () => {
  test('the host sees display and player counts', async () => {
    const room = await createRoom();
    const host = await joinHost(room.code, room.hostToken);

    const display = await connect();
    display.send({
      type: 'hello',
      role: 'display',
      room: room.code,
      token: room.displayToken,
    });
    await display.next(isSnapshot);

    const withDisplay = await host.next<Snapshot>(
      (m) => isSnapshot(m) && m.presence.displays === 1,
    );
    assert.equal(withDisplay.presence.displays, 1);
    assert.equal(withDisplay.displayReady, false, 'assets are not loaded yet');

    display.send({ type: 'displayReady' });
    const ready = await host.next<Snapshot>((m) => isSnapshot(m) && m.displayReady);
    assert.equal(ready.displayReady, true);

    const player = await joinPlayer(room.code, 'device-presence');
    const withPlayer = await host.next<Snapshot>(
      (m) => isSnapshot(m) && m.presence.players === 1,
    );
    assert.equal(withPlayer.presence.players, 1);

    player.close();
    display.close();
    host.close();
  });
});

describe('load', () => {
  test('fifty simultaneous voters are tallied exactly once each', async () => {
    const room = await createRoom();
    const host = await runToPoll(room.code, room.hostToken);

    const players = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        joinPlayer(room.code, `device-load-${String(i).padStart(4, '0')}`),
      ),
    );

    // A realistic burst: everyone taps at once.
    players.forEach((player, i) => {
      player.send({ type: 'vote', optionKey: i < 30 ? 'left' : 'right' });
    });

    const tallied = await host.next<Snapshot>(
      (m) => isSnapshot(m) && (m.tally?.voters ?? 0) === 50,
      8000,
    );
    assert.deepEqual(tallied.tally?.counts, { left: 30, right: 20 });

    host.send({ type: 'command', command: { name: 'closePoll' } });
    const finished = await host.next<Snapshot>((m) => isSnapshot(m) && m.phase === 'finished');
    assert.equal(finished.lastResult?.total, 50);
    assert.equal(finished.lastResult?.winner, 'left');

    for (const player of players) player.close();
    host.close();
  });
});

// ---------------------------------------------------------------------------

describe('the admin session list', () => {
  test('is not readable without the password', async () => {
    const response = await fetch(`${baseUrl}/api/rooms`);
    // It hands out host tokens, so an open one would let a stranger drive
    // every running show.
    assert.equal(response.status, 401);
  });

  test('lists a running session with the links needed to recover it', async () => {
    const room = await createRoom();

    const response = await fetch(`${baseUrl}/api/rooms`, {
      headers: { 'x-admin-password': TEST_PASSWORD },
    });
    assert.equal(response.status, 200);
    const { sessions } = (await response.json()) as SessionListResponse;

    const found = sessions.find((s) => s.code === room.code);
    assert.ok(found, 'the room just created should appear in the list');
    assert.equal(found.scenario.id, 'quick');
    assert.equal(found.phase, 'lobby');
    // The recovery case: the tokens are here, or a lost host console is fatal.
    assert.match(found.urls.host, new RegExp(`room=${room.code}&token=${room.hostToken}`));
    assert.match(found.urls.display, new RegExp(`token=${room.displayToken}`));
    assert.equal(found.urls.join, `${baseUrl}/join/${room.code}`);
  });

  test('reports the current node and who is connected', async () => {
    // slowpoll, not quick: its poll window outlives the assertions, so the
    // test is not racing the story to the next node.
    const room = await createRoom('slowpoll');
    const host = await runToPoll(room.code, room.hostToken);
    const player = await joinPlayer(room.code, 'device-admin-1');

    // Presence is reported off live sockets, so give the joins a beat to land.
    const found = await pollUntil(async () => {
      const response = await fetch(`${baseUrl}/api/rooms`, {
        headers: { 'x-admin-password': TEST_PASSWORD },
      });
      const { sessions } = (await response.json()) as SessionListResponse;
      const session = sessions.find((s) => s.code === room.code);
      return session?.presence.players === 1 ? session : undefined;
    });

    assert.equal(found.phase, 'running');
    assert.equal(found.nodeId, 'vote');
    assert.ok(found.pollEndsAt !== undefined, 'an open poll should report its deadline');

    player.close();
    host.close();
  });
});

describe('admin session control', () => {
  test('restart rewinds a running session without ending it', async () => {
    const room = await createRoom('slowpoll');
    const host = await runToPoll(room.code, room.hostToken);

    const response = await fetch(`${baseUrl}/api/rooms/${room.code}/reset`, {
      method: 'POST',
      headers: { 'x-admin-password': TEST_PASSWORD },
    });
    assert.equal(response.status, 200);

    // The host stays connected and simply sees the show back at the top —
    // which is the point: a rehearsal resets without a new QR code.
    const back = await host.next<Snapshot>((m) => isSnapshot(m) && m.phase === 'lobby');
    assert.equal(back.phase, 'lobby');

    host.send({ type: 'command', command: { name: 'start' } });
    await host.next<Snapshot>((m) => isSnapshot(m) && m.beatInfo?.kind === 'dialogue');
    host.close();
  });

  test('ending a session disconnects everyone and frees the code', async () => {
    const room = await createRoom();
    const host = await joinHost(room.code, room.hostToken);

    const response = await fetch(`${baseUrl}/api/rooms/${room.code}/close`, {
      method: 'POST',
      headers: { 'x-admin-password': TEST_PASSWORD },
    });
    assert.equal(response.status, 200);

    const closed = await host.next<any>((m) => m?.type === 'error' && m.code === 'roomClosed');
    assert.equal(closed.fatal, true);

    const list = await fetch(`${baseUrl}/api/rooms`, {
      headers: { 'x-admin-password': TEST_PASSWORD },
    });
    const { sessions } = (await list.json()) as SessionListResponse;
    assert.equal(sessions.some((s) => s.code === room.code), false);

    host.close();
  });

  test('both controls require the password', async () => {
    const room = await createRoom();
    for (const action of ['reset', 'close']) {
      const response = await fetch(`${baseUrl}/api/rooms/${room.code}/${action}`, {
        method: 'POST',
      });
      assert.equal(response.status, 401, `${action} must not be open to strangers`);
    }
  });

  test('an unknown room code is a 404, not a crash', async () => {
    const response = await fetch(`${baseUrl}/api/rooms/ZZZZZZ/close`, {
      method: 'POST',
      headers: { 'x-admin-password': TEST_PASSWORD },
    });
    assert.equal(response.status, 404);
  });
});

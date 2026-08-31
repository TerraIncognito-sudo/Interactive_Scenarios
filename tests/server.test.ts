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

/**
 * Saying what is happening during the minute before a show can start.
 *
 * A projector on venue wifi spends a minute or two pulling a few hundred
 * megabytes down, and for that whole minute the host console said "loading…"
 * and nothing else — no number, nothing moving, which from the front of a room
 * is indistinguishable from a console that has hung. Every one of these is
 * about a state being distinguishable from the next one.
 */
describe('what the projector is doing while it loads', () => {
  test('the scenario endpoint says what each asset weighs', async () => {
    // So the display can report megabytes. Eighty-six is a number nobody can
    // turn into a guess about how much longer; "18 of 31 MB" is.
    const room = await createRoom('media');
    const response = await fetch(
      `${baseUrl}/api/rooms/${room.code}/scenario?token=${room.displayToken}`,
    );
    const body = (await response.json()) as { assets: string[]; sizes: Record<string, number> };

    assert.ok(body.sizes['voice/open-1.mp3']! > 0, 'a file that is there has a size');
    assert.ok(body.sizes['images/narrator.png']! > 0);
    assert.equal(
      body.sizes['images/harbour.jpg'],
      undefined,
      'and art that has not been made yet simply has none, rather than a zero the ' +
        'progress bar would creep towards forever',
    );
    for (const file of Object.keys(body.sizes)) {
      assert.ok(body.assets.includes(file), `${file} is on the prefetch list`);
    }
  });

  test('progress from the display reaches the host console', async () => {
    const room = await createRoom('media');
    const host = await joinHost(room.code, room.hostToken);

    const display = await connect();
    display.send({ type: 'hello', role: 'display', room: room.code, token: room.displayToken });
    await display.next(isSnapshot);

    display.send({
      type: 'displayProgress',
      done: 3,
      total: 5,
      failed: 1,
      bytes: 1_500_000,
      totalBytes: 4_000_000,
    });

    const seen = await host.next<Snapshot>(
      (m) => isSnapshot(m) && m.displayLoading?.done === 3,
    );
    assert.deepEqual(seen.displayLoading, {
      done: 3,
      total: 5,
      failed: 1,
      bytes: 1_500_000,
      totalBytes: 4_000_000,
    });
    assert.equal(seen.displayReady, false, 'progress is not readiness');

    display.close();
    host.close();
  });

  test('ready clears it, so the console never shows both answers at once', async () => {
    const room = await createRoom('media');
    const host = await joinHost(room.code, room.hostToken);

    const display = await connect();
    display.send({ type: 'hello', role: 'display', room: room.code, token: room.displayToken });
    await display.next(isSnapshot);

    display.send({ type: 'displayProgress', done: 4, total: 5, failed: 0 });
    await host.next<Snapshot>((m) => isSnapshot(m) && m.displayLoading?.done === 4);

    display.send({ type: 'displayReady' });
    const ready = await host.next<Snapshot>((m) => isSnapshot(m) && m.displayReady === true);
    assert.equal(ready.displayLoading, undefined);

    // A report that was already in flight when it finished must not put the
    // console back to loading — the last thing said would be the wrong thing.
    display.send({ type: 'displayProgress', done: 4, total: 5, failed: 0 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const latest = [...host.messages].reverse().find(isSnapshot) as Snapshot;
    assert.equal(latest.displayReady, true);
    assert.equal(latest.displayLoading, undefined);

    display.close();
    host.close();
  });

  test('ready is not the same as complete, and the console is told which', async () => {
    // A missing decoration must never stop a show — but "ready" over three
    // assets that 404'd is the same lie as "ready" halfway through, and this
    // line is the only warning before a shot opens black.
    const room = await createRoom('media');
    const host = await joinHost(room.code, room.hostToken);

    const display = await connect();
    display.send({ type: 'hello', role: 'display', room: room.code, token: room.displayToken });
    await display.next(isSnapshot);

    display.send({ type: 'displayReady', failed: 3, total: 5 });
    const seen = await host.next<Snapshot>((m) => isSnapshot(m) && m.displayReady === true);
    assert.deepEqual(seen.displayMissing, { failed: 3, total: 5 });

    display.close();
    host.close();
  });

  test('a display that fetched everything says so by saying nothing', async () => {
    const room = await createRoom('media');
    const host = await joinHost(room.code, room.hostToken);

    const display = await connect();
    display.send({ type: 'hello', role: 'display', room: room.code, token: room.displayToken });
    await display.next(isSnapshot);

    display.send({ type: 'displayReady', failed: 0, total: 5 });
    const seen = await host.next<Snapshot>((m) => isSnapshot(m) && m.displayReady === true);
    assert.equal(seen.displayMissing, undefined, 'no warning where there is nothing to warn about');

    display.close();
    host.close();
  });

  test('a projector that goes away takes its number with it', async () => {
    // Otherwise the console counts up for a display that is not there.
    const room = await createRoom('media');
    const host = await joinHost(room.code, room.hostToken);

    const display = await connect();
    display.send({ type: 'hello', role: 'display', room: room.code, token: room.displayToken });
    await display.next(isSnapshot);
    display.send({ type: 'displayProgress', done: 2, total: 5, failed: 0 });
    await host.next<Snapshot>((m) => isSnapshot(m) && m.displayLoading?.done === 2);

    display.close();
    const gone = await host.next<Snapshot>(
      (m) => isSnapshot(m) && m.presence.displays === 0,
    );
    assert.equal(gone.displayLoading, undefined);
    assert.equal(gone.displayMissing, undefined);
    assert.equal(gone.displayReady, false);

    host.close();
  });

  test('only the display may report progress', async () => {
    const room = await createRoom('media');
    const host = await joinHost(room.code, room.hostToken);

    host.send({ type: 'displayProgress', done: 1, total: 5, failed: 0 });
    const error = await host.next<any>((m) => m.type === 'error');
    assert.equal(error.code, 'badToken');

    host.close();
  });

  test('a nonsense report is rejected rather than shown', async () => {
    const room = await createRoom('media');
    const display = await connect();
    display.send({ type: 'hello', role: 'display', room: room.code, token: room.displayToken });
    await display.next(isSnapshot);

    display.send({ type: 'displayProgress', done: -1, total: 5, failed: 0 });
    const error = await display.next<any>((m) => m.type === 'error');
    assert.equal(error.code, 'badMessage');

    display.close();
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
      'ambience/harbour.mp3',
      'images/harbour.jpg',
      'images/narrator.png',
      'video/harbour.mp4',
      'voice/open-1.mp3',
    ]);
  });

  test('a speaker carries their portrait into the snapshot', async () => {
    const room = await createRoom('media');
    const host = await joinHost(room.code, room.hostToken);
    host.send({ type: 'command', command: { name: 'start' } });

    const first = await host.next<Snapshot>(
      (m) => isSnapshot(m) && m.beatInfo?.kind === 'dialogue' && m.beatInfo.lineIndex === 0,
    );
    // The display draws it bottom-right over the dialogue box while the line
    // plays, which is the shape every 2D RPG has used for thirty years. It has
    // been able to do that from the beginning; what no scenario ever did was
    // declare a picture for it to draw.
    assert.equal(first.beatInfo.kind === 'dialogue' && first.beatInfo.speaker?.sprite,
      'images/narrator.png');

    // And it is in the prefetch list, so the portrait is decoded before the
    // show starts rather than popping in a beat late.
    const response = await fetch(
      `${baseUrl}/scenario-assets/media/assets/images/narrator.png`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');

    host.close();
  });

  test('a line with no speaker carries no portrait', async () => {
    const room = await createRoom('media');
    const host = await joinHost(room.code, room.hostToken);
    host.send({ type: 'command', command: { name: 'start' } });

    // Narration is a voice without a face. A portrait that stayed on screen
    // through it would attribute the line to whoever spoke last.
    const second = await host.next<Snapshot>(
      (m) => isSnapshot(m) && m.beatInfo?.kind === 'dialogue' && m.beatInfo.lineIndex === 1,
    );
    assert.equal(second.beatInfo.kind === 'dialogue' && second.beatInfo.speaker, undefined);

    host.close();
  });

  test('the base and the manifest join into a URL that actually serves', async () => {
    // The bug this exists for: `assetBase` stopped one level above `assets/`,
    // so every name in the manifest resolved to a 404. It went unnoticed for
    // months because no scenario had a single asset made yet — the first one
    // would have been a missing picture in front of a room.
    //
    // So the assertion is the join itself, done exactly as the display does it,
    // for every asset the scenario declares.
    const room = await createRoom('media');
    const response = await fetch(
      `${baseUrl}/api/rooms/${room.code}/scenario?token=${room.displayToken}`,
    );
    const body = (await response.json()) as { assets: string[]; assetBase: string };

    const made = ['images/narrator.png', 'voice/open-1.mp3'];
    for (const file of body.assets.filter((name) => made.includes(name))) {
      const asset = await fetch(`${baseUrl}${body.assetBase}${file}`);
      assert.equal(asset.status, 200, `${body.assetBase}${file} did not serve`);
    }
  });

  test('an asset filed in a folder is served from one', async () => {
    // The last link in the chain. The editor files a name, the publisher writes
    // to it and the validator checks it — and none of that is worth anything if
    // the route the projector actually fetches from refuses a path with a
    // slash in it.
    const response = await fetch(`${baseUrl}/scenario-assets/media/assets/voice/open-1.mp3`);
    assert.equal(response.status, 200);
    assert.equal((await response.text()).trim(), 'not really an mp3');

    // And the boundary still holds: the route serves a scenario's assets
    // folder and nothing above it.
    const escaped = await fetch(`${baseUrl}/scenario-assets/media/scenario.yaml`);
    assert.notEqual(escaped.status, 200);
  });

  test('a snapshot carries the line voice and the scene video', async () => {
    const room = await createRoom('media');
    const host = await joinHost(room.code, room.hostToken);
    host.send({ type: 'command', command: { name: 'start' } });

    const first = await host.next<Snapshot>(
      (m) => isSnapshot(m) && m.beatInfo?.kind === 'dialogue' && m.beatInfo.lineIndex === 0,
    );

    // Exactly the name the scenario declares, folder and all. The display
    // joins this to the asset base and opens it — nothing along the way is
    // allowed to work out a folder for itself.
    assert.equal(
      first.beatInfo.kind === 'dialogue' && first.beatInfo.voice,
      'voice/open-1.mp3',
    );
    assert.equal(first.scene?.id, 'harbour');
    assert.equal(first.scene?.video, 'video/harbour.mp4');
    assert.equal(
      first.scene?.background,
      'images/harbour.jpg',
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
describe('the result of a poll is a beat, not an animation', () => {
  test('closing a poll shows the result before the next line', async () => {
    // The bug this exists for. The reveal was a `setTimeout` inside the display
    // and nothing else knew about it, so the server started the next line's
    // `hold` the instant the poll closed — while the projector was still
    // showing the bar chart. The first line after every vote lost that time:
    // truncated where its hold was longer, never drawn at all where it was
    // shorter, which is most of them.
    const room = await createRoom();
    const host = await runToPoll(room.code, room.hostToken);

    host.send({ type: 'command', command: { name: 'closePoll' } });
    const reveal = await host.next<Snapshot>(
      (m) => isSnapshot(m) && m.beatInfo.kind === 'result',
    );

    assert.equal(reveal.beatInfo.kind, 'result');
    if (reveal.beatInfo.kind === 'result') {
      assert.equal(reveal.beatInfo.pollId, 'vote', 'names the poll, not the node it moved to');
      assert.ok(reveal.beatInfo.durationMs > 0, 'and it lasts a measurable length of time');
      assert.equal(typeof reveal.beatInfo.winnerLabel, 'string');
    }

    host.close();
  });

  test('the line after a vote gets its whole hold, measured from the reveal ending', async () => {
    // The assertion that would have caught it. The dialogue beat must not
    // arrive until the reveal is over — if it arrives with the reveal, its hold
    // is already running behind a screen the audience cannot read it through.
    const room = await createRoom();
    const host = await runToPoll(room.code, room.hostToken);

    host.send({ type: 'command', command: { name: 'closePoll' } });
    const reveal = await host.next<Snapshot>(
      (m) => isSnapshot(m) && m.beatInfo.kind === 'result',
    );
    const revealAt = Date.now();
    const revealMs = reveal.beatInfo.kind === 'result' ? reveal.beatInfo.durationMs : 0;

    // Keyed on the beat number, not merely the kind: the host has been
    // connected since the lobby and its buffer already holds the dialogue
    // beats from before the vote, which `next` would match at once.
    const line = await host.next<Snapshot>(
      (m) => isSnapshot(m) && m.beatInfo.kind === 'dialogue' && m.beat > reveal.beat,
      revealMs + 4000,
    );
    const waited = Date.now() - revealAt;

    assert.ok(
      waited >= revealMs - 150,
      `the line waited ${waited}ms for a ${revealMs}ms reveal — it used to arrive at once`,
    );
    assert.equal(line.beatInfo.kind, 'dialogue');
    assert.ok(line.beat > reveal.beat, 'and it is a beat of its own, so the display redraws');

    host.close();
  });

  test('a vote leading into another poll opens that poll only once the reveal is done', async () => {
    // The reveal happens on the node the vote chose, so a second poll's clock
    // must not start while the first poll's result is still up. Opening was
    // keyed on the node changing, which by then had already happened.
    const room = await createRoom('twopolls');
    const host = await runToPoll(room.code, room.hostToken);

    host.send({ type: 'command', command: { name: 'closePoll' } });
    await host.next<Snapshot>((m) => isSnapshot(m) && m.beatInfo.kind === 'result');

    const second = await host.next<Snapshot>(
      (m) => isSnapshot(m) && m.beatInfo.kind === 'poll',
      6000,
    );
    assert.equal(second.beatInfo.kind, 'poll');
    if (second.beatInfo.kind === 'poll') {
      assert.ok(
        second.beatInfo.endsAt > second.serverNow,
        'the second poll must have a live deadline, not the zero it is stamped with on entry',
      );
    }

    host.close();
  });
});

describe('a gate holds the show until a person releases it', () => {
  /**
   * Starts the gate fixture and parks on the held beat, handing back the beat
   * number it stopped on.
   *
   * The number is the point. `next` scans messages already received, so
   * "no snapshot on another kind of beat" would match the dialogue snapshot
   * from *before* the gate and pass whatever the server did. `beat` is
   * monotonic, so a later one is the only honest evidence the show moved.
   */
  async function runToGate() {
    const room = await createRoom('gate');
    const host = await joinHost(room.code, room.hostToken);
    host.send({ type: 'command', command: { name: 'start' } });
    const held = await host.next<Snapshot>((m) => isSnapshot(m) && m.beatInfo?.kind === 'gate');
    return { host, beat: held.beat };
  }

  test('no clock releases it', async () => {
    const { host, beat } = await runToGate();

    // Every hold in the fixture is 0.05s, so 600ms is a dozen beats' worth of
    // opportunity for something to schedule its way past the gate. The
    // assertion is that the wait *times out*: a later beat number means the
    // show moved with nobody having asked it to.
    await assert.rejects(() =>
      host.next<Snapshot>((m) => isSnapshot(m) && m.beat > beat, 600),
    );

    host.close();
  });

  test('pausing and resuming does not release it', async () => {
    const { host, beat } = await runToGate();

    host.send({ type: 'command', command: { name: 'pause' } });
    host.send({ type: 'command', command: { name: 'resume' } });

    // The bug this pins: `resume` restored the previous beat's leftover
    // deadline, so un-pausing at a gate handed setTimeout a stale number and
    // released it on its own — the one thing a gate exists to prevent.
    // Neither pause nor resume bumps the beat, so any later one is the show
    // having walked forward on its own.
    await assert.rejects(() =>
      host.next<Snapshot>((m) => isSnapshot(m) && m.beat > beat, 600),
    );

    host.close();
  });

  test('continue releases it, and carries the show to the next beat', async () => {
    const { host, beat } = await runToGate();

    host.send({ type: 'command', command: { name: 'continue' } });

    const next = await host.next<Snapshot>((m) => isSnapshot(m) && m.beat > beat, 4000);
    assert.notEqual(next.beatInfo.kind, 'gate', 'continue is what moves a gate on');

    host.close();
  });

  test('continue does nothing when no gate is holding', async () => {
    const room = await createRoom('gate');
    const host = await joinHost(room.code, room.hostToken);

    // In the lobby: nothing is held, so there is nothing to release. A
    // `continue` that could start a show would be a second start button with
    // none of its confirmation.
    host.send({ type: 'command', command: { name: 'continue' } });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const sessions = await fetch(`${baseUrl}/api/rooms`, {
      headers: { 'x-admin-password': TEST_PASSWORD },
    });
    const body = (await sessions.json()) as SessionListResponse;
    const session = body.sessions.find((s) => s.code === room.code);
    assert.equal(session?.phase, 'lobby', 'continue must not be able to start a show');

    host.close();
  });
});

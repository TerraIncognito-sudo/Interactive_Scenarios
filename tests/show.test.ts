/**
 * A show running in the client's own process.
 *
 * The same claims `server.test.ts` makes about the public server, made against
 * the loopback half: a real HTTP server on an ephemeral port, real WebSockets,
 * and the real `Room`. Nothing is mocked, because the failures worth catching
 * here are the ones that only appear when two real ends talk — the asset base
 * that was one directory short for months is the canonical example, and the
 * only assertion that could ever have caught it is the one that fetches a file
 * for real.
 *
 * What is *not* here is the audience. Phones talk to the relay and the relay
 * talks to the link; neither exists yet, and a simulated vote is step 5's. So
 * this file proves the spine: a show starts, a stage joins, commands drive it,
 * assets arrive, and the folder it is running out of stops accepting edits
 * that would change a file under the projector.
 */

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { WebSocket } from 'ws';
import type { Snapshot } from '../shared/show/protocol.ts';

// Before the import, not after: `workspace.ts` reads this when the module is
// first evaluated, and a test run must never change which folder the real app
// opens next.
const configDir = mkdtempSync(join(tmpdir(), 'is-show-config-'));
process.env.EDITOR_CONFIG_DIR = configDir;

const { buildEditorServer } = await import('../client/app/server.ts');
const { setWorkspace } = await import('../client/app/workspace.ts');

const fixtures = join(import.meta.dirname, 'fixtures', 'scenarios');

let server: Server;
let baseUrl: string;
let wsUrl: string;

before(async () => {
  server = await buildEditorServer();
  await setWorkspace(fixtures);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(configDir, { recursive: true, force: true });
});

// A show left running would hold the project lock into the next test and, more
// quietly, leave a clock ticking through beats nobody is reading.
afterEach(async () => {
  await fetch(`${baseUrl}/api/show/stop`, { method: 'POST' });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Client = {
  socket: WebSocket;
  messages: unknown[];
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

const isSnapshot = (m: any): m is Snapshot => m?.type === 'snapshot';

async function start(project = 'quick'): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/api/show/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 200, `start failed: ${JSON.stringify(body)}`);
  return body;
}

/** A stage window, joined and holding its first snapshot. */
async function joinStage(): Promise<Client> {
  const client = await connect();
  client.send({ type: 'hello', role: 'display' });
  await client.next(isSnapshot);
  return client;
}

/** The board window. Same socket, same snapshots, and it may command. */
async function joinBoard(): Promise<Client> {
  const client = await connect();
  client.send({ type: 'hello', role: 'host' });
  await client.next(isSnapshot);
  return client;
}

// ---------------------------------------------------------------------------

describe('starting and stopping a show', () => {
  test('a show starts from a project folder and reports what it loaded', async () => {
    const status = await start('quick');
    assert.equal(status.running, true);
    assert.equal(status.project, 'quick');
    assert.deepEqual((status.scenario as { id: string }).id, 'quick');
    assert.equal(status.phase, 'lobby');
  });

  test('a second show is refused rather than replacing the first', async () => {
    await start('quick');
    const response = await fetch(`${baseUrl}/api/show/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'media' }),
    });
    assert.equal(response.status, 400);
    // Names what is holding it. "Already running" with no name is a puzzle in
    // a window that has three projects open in tabs.
    assert.match((await response.json()).error, /quick/);
  });

  test('stopping is idempotent, so a second click is not an error', async () => {
    await start('quick');
    const first = await (await fetch(`${baseUrl}/api/show/stop`, { method: 'POST' })).json();
    const second = await (await fetch(`${baseUrl}/api/show/stop`, { method: 'POST' })).json();
    assert.equal(first.stopped, true);
    assert.equal(second.stopped, false);
    assert.equal(second.running, false);
  });

  test('a project that is not a folder in the workspace is refused', async () => {
    const response = await fetch(`${baseUrl}/api/show/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: '../..' }),
    });
    assert.equal(response.status, 400);
  });
});

describe('the lobby when nothing is linked', () => {
  test('a snapshot carries no room code, and that is the ordinary state', async () => {
    await start('quick');
    const stage = await joinStage();
    const snapshot = await stage.next<Snapshot>(isSnapshot);

    // Absent rather than empty or a placeholder: the stage keys its "running
    // on this machine" line off exactly this, and a six-character string of
    // any kind would put a code on a projector that no phone can use.
    assert.equal(snapshot.room, undefined);
    assert.equal(snapshot.joinUrl, undefined);
    stage.close();
  });

  test('the stage says so in words, not by leaving a gap', () => {
    // The markup half of the claim above. A hidden QR block and nothing in its
    // place is indistinguishable from a QR that failed to draw.
    const html = readFileSync(
      join(import.meta.dirname, '..', 'client', 'web', 'stage', 'index.html'),
      'utf8',
    );
    assert.match(html, /id="lobby-unlinked"/);
    assert.match(html, /id="lobby-join" hidden/);
  });
});

describe('the projector is handed the show', () => {
  test('the manifest carries the whole scenario, its assets and their sizes', async () => {
    await start('media');
    const response = await fetch(`${baseUrl}/api/show/scenario`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      scenario: { id: string };
      assets: string[];
      sizes: Record<string, number>;
      assetBase: string;
    };

    assert.equal(body.scenario.id, 'media');
    assert.ok(body.assets.includes('voice/open-1.mp3'));
    assert.ok(body.assets.includes('images/narrator.png'));
    // Only where the file is actually there. A scenario declaring art before
    // the art exists is the normal state of a show being made, and a size of
    // zero would be a lie about a file rather than a silence about it.
    assert.ok(body.sizes['voice/open-1.mp3']! > 0);
    assert.equal(body.sizes['video/harbour.mp4'], undefined);
  });

  test('the base and a name out of the scenario join into a URL that serves', async () => {
    // The only form of this assertion that could have caught the original bug,
    // where `assetBase` stopped one directory short and made every asset in
    // every scenario a 404 that nothing noticed for months.
    await start('media');
    const manifest = (await (await fetch(`${baseUrl}/api/show/scenario`)).json()) as {
      assets: string[];
      assetBase: string;
    };

    for (const name of ['voice/open-1.mp3', 'images/narrator.png']) {
      assert.ok(manifest.assets.includes(name));
      const asset = await fetch(`${baseUrl}${manifest.assetBase}${name}`);
      assert.equal(asset.status, 200, `${manifest.assetBase}${name} did not serve`);
      // The name is a promise about the content, and the type follows the
      // name: a `.wav` served as `audio/mpeg` is a silent beat in front of a
      // room with nothing in any log.
      assert.equal(
        asset.headers.get('content-type'),
        name.endsWith('.mp3') ? 'audio/mpeg' : 'image/png',
      );
      // Consume it, or the socket stays open and `server.close()` never
      // resolves — which presents as the suite hanging with nothing failing.
      assert.ok((await asset.arrayBuffer()).byteLength > 0);
    }
  });

  test('an asset route with no show running serves nothing', async () => {
    const response = await fetch(`${baseUrl}/project-assets/voice/open-1.mp3`);
    assert.equal(response.status, 404);
    await response.arrayBuffer();
  });

  test('a name that walks out of the project is refused', async () => {
    await start('media');
    for (const name of ['../scenario.yaml', 'images/../../quick/scenario.yaml', 'a/./b.png']) {
      const response = await fetch(`${baseUrl}/project-assets/${encodeURIComponent(name)}`);
      assert.equal(response.status, 404, `${name} was not refused`);
      await response.arrayBuffer();
    }
  });

  test('a file the show will never play is refused even when it is right there', async () => {
    // `scenario.yaml` is inside the project and inside the publish root's
    // parent. The allow-list is what stops this route being a way to read the
    // author's disk one extension at a time.
    await start('media');
    const response = await fetch(`${baseUrl}/project-assets/scenario.yaml`);
    assert.equal(response.status, 404);
    await response.arrayBuffer();
  });
});

describe('the stage bundle', () => {
  test('/stage redirects to /stage/, because its asset URLs are relative', async () => {
    const response = await fetch(`${baseUrl}/stage`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/stage/');
    await response.arrayBuffer();
  });

  test('its assets folder is served by path, and nothing else is', async () => {
    // The unbundled source beside the bundle, and a nested name: the allow-list
    // is one flat filename inside one folder, which is exactly what Vite emits.
    for (const path of ['/stage/main.ts', '/stage/assets/sub/index.js']) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 404, `${path} was served`);
      await response.arrayBuffer();
    }
  });

  test('an encoded escape is normalised away before anything opens a file', async () => {
    // `%2e%2e` is not caught by the allow-list — it never reaches it. The URL
    // parser decodes and resolves dot segments, so this arrives as a request
    // for `/app/server.ts`, which is a route that does not exist. Worth
    // pinning: the reason this is safe is the parser rather than the regex,
    // and a hand-rolled path split somewhere upstream would quietly remove it.
    const response = await fetch(`${baseUrl}/stage/assets/%2e%2e/%2e%2e/app/server.ts`);
    assert.equal(response.status, 404);
    const body = await response.text();
    assert.doesNotMatch(body, /buildEditorServer/, 'the server source came back over HTTP');
  });
});

describe('the surfaces on the loopback socket', () => {
  test('a stage joins with no room and no token at all', async () => {
    await start('quick');
    const stage = await joinStage();
    const snapshot = await stage.next<Snapshot>(isSnapshot);
    assert.equal(snapshot.phase, 'lobby');
    assert.equal(snapshot.scenario.id, 'quick');
    stage.close();
  });

  test('a hello before any show is refused, so the surface reconnects', async () => {
    const client = await connect();
    client.send({ type: 'hello', role: 'display' });
    const error = await client.next<any>((m) => m.type === 'error');
    assert.equal(error.code, 'badRoom');
    // Fatal, so the socket closes and the stage's own backoff brings it back
    // against whatever runs next. A window open between two shows is ordinary.
    assert.equal(error.fatal, true);
    client.close();
  });

  test('a phone has no business here and is told so', async () => {
    await start('quick');
    const client = await connect();
    client.send({ type: 'hello', role: 'player', deviceId: 'device-aaaaaaaa' });
    const error = await client.next<any>((m) => m.type === 'error');
    assert.match(error.message, /relay/);
    client.close();
  });

  test('a vote sent here is refused rather than counted', async () => {
    await start('quick');
    const stage = await joinStage();
    stage.send({ type: 'vote', optionKey: 'left' });
    const error = await stage.next<any>((m) => m.type === 'error');
    assert.equal(error.fatal, false);
    stage.close();
  });

  test('presence counts both windows', async () => {
    await start('quick');
    const stage = await joinStage();
    const board = await joinBoard();
    const snapshot = await board.next<Snapshot>(
      (m) => isSnapshot(m) && m.presence.displays === 1,
    );
    assert.equal(snapshot.presence.displays, 1);
    stage.close();
    board.close();
  });
});

describe('the board drives the show', () => {
  test('start walks the story off the lobby', async () => {
    await start('quick');
    const board = await joinBoard();
    board.send({ type: 'command', command: { name: 'start' } });
    const snapshot = await board.next<Snapshot>(
      (m) => isSnapshot(m) && m.beatInfo?.kind === 'dialogue',
    );
    assert.equal(snapshot.phase, 'running');
    assert.equal((snapshot.beatInfo as { text: string }).text, 'One');
    board.close();
  });

  test('back steps to the previous node, and the beat still counts up', async () => {
    // Driven from the gate fixture rather than a timed one, because `back` is
    // the one command whose effect depends on where the show has got to — and
    // a beat holding on its own clock is the only place a test can be sure.
    await start('gate');
    const board = await joinBoard();
    board.send({ type: 'command', command: { name: 'start' } });
    const gate = await board.next<Snapshot>((m) => isSnapshot(m) && m.beatInfo?.kind === 'gate');

    board.send({ type: 'command', command: { name: 'back' } });
    const backward = await board.next<Snapshot>(
      (m) =>
        isSnapshot(m) &&
        m.beat > gate.beat &&
        m.beatInfo.kind !== 'idle' &&
        m.beatInfo.nodeId === 'open',
    );
    // Monotonic even going backwards: the beat counts transitions rather than
    // position, which is what lets a surface tell a stale snapshot from a new
    // one after it has been playing locally through a dropout.
    assert.ok(backward.beat > gate.beat);
    board.close();
  });

  test('a gate holds until somebody releases it, and no clock does', async () => {
    await start('gate');
    const board = await joinBoard();
    board.send({ type: 'command', command: { name: 'start' } });
    const gate = await board.next<Snapshot>((m) => isSnapshot(m) && m.beatInfo?.kind === 'gate');
    // No duration, because nothing is counting. The absence is the design.
    assert.equal((gate.beatInfo as Record<string, unknown>).durationMs, undefined);

    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(board.messages.filter(isSnapshot).at(-1)!.beat, gate.beat);

    board.send({ type: 'command', command: { name: 'continue' } });
    const after = await board.next<Snapshot>((m) => isSnapshot(m) && m.beat > gate.beat);
    assert.notEqual(after.beatInfo.kind, 'gate');
    board.close();
  });

  test('pause stops the clock and resume restarts it', async () => {
    await start('quick');
    const board = await joinBoard();
    board.send({ type: 'command', command: { name: 'start' } });
    await board.next<Snapshot>((m) => isSnapshot(m) && m.beatInfo?.kind === 'dialogue');

    board.send({ type: 'command', command: { name: 'pause' } });
    const paused = await board.next<Snapshot>((m) => isSnapshot(m) && m.phase === 'paused');

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(board.messages.filter(isSnapshot).at(-1)!.beat, paused.beat);

    board.send({ type: 'command', command: { name: 'resume' } });
    await board.next<Snapshot>((m) => isSnapshot(m) && m.beat > paused.beat);
    board.close();
  });
});

describe('what the projector says while it loads', () => {
  test('progress reaches the board, and ready replaces it', async () => {
    await start('media');
    const stage = await joinStage();
    const board = await joinBoard();

    stage.send({ type: 'displayProgress', done: 3, total: 8, failed: 0, bytes: 900 });
    const loading = await board.next<Snapshot>((m) => isSnapshot(m) && m.displayLoading !== undefined);
    assert.deepEqual(loading.displayLoading, { done: 3, total: 8, failed: 0, bytes: 900 });

    stage.send({ type: 'displayReady', failed: 2, total: 8 });
    const ready = await board.next<Snapshot>((m) => isSnapshot(m) && m.displayReady);
    // Ready and a progress bar at once is two answers to one question.
    assert.equal(ready.displayLoading, undefined);
    // And "ready" over two assets that 404'd is the same lie in a new place,
    // so what failed outlives the progress that has stopped being true.
    assert.deepEqual(ready.displayMissing, { failed: 2, total: 8 });

    stage.close();
    board.close();
  });

  test('a projector that goes away takes its number with it', async () => {
    await start('media');
    const stage = await joinStage();
    const board = await joinBoard();
    stage.send({ type: 'displayProgress', done: 1, total: 8, failed: 0 });
    await board.next<Snapshot>((m) => isSnapshot(m) && m.displayLoading !== undefined);

    stage.close();
    const gone = await board.next<Snapshot>(
      (m) => isSnapshot(m) && m.presence.displays === 0,
    );
    // Leaving the last number up would show a board counting toward ready for
    // a projector that is not there.
    assert.equal(gone.displayLoading, undefined);
    assert.equal(gone.displayReady, false);
    board.close();
  });
});

/**
 * The invariant this rebuild destroyed, and what replaced it.
 *
 * The editor used to be unable to reach a running show because it was a
 * different process that knew nothing about one, and `tests/project.test.ts`
 * asserted that the capability was absent from the source. It is not absent
 * any more — this program does both jobs — so that test is gone, and these are
 * what stand in its place.
 *
 * The rule CLAUDE.md always stated is the one being enforced: do not author
 * into a folder a show is being served from right now. The failure is exact.
 * Assets are read off disk as the display asks for them, so renaming one
 * mid-show is a 404 on the next projector to reconnect, and a room sees one
 * shot of the show as a black rectangle.
 */
describe('a show holds its own folder', () => {
  test('the destructive routes are refused while the project is on the projector', async () => {
    await start('media');
    for (const [path, method] of [
      ['publish', 'POST'],
      ['folders', 'POST'],
      ['extensions', 'POST'],
      ['discard', 'POST'],
      ['delete-take', 'POST'],
      ['scenario', 'PUT'],
    ] as const) {
      const response = await fetch(`${baseUrl}/api/projects/media/${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(response.status, 409, `${path} was not refused`);
      const body = (await response.json()) as { error: string };
      // Says what is holding it and how to get it back, because a refusal
      // somebody cannot act on reads as a bug in the button.
      assert.match(body.error, /projector/);
      assert.match(body.error, /Stop the show/);
    }
  });

  test('another project is untouched, because the lock is a folder and not a mode', async () => {
    await start('media');
    const response = await fetch(`${baseUrl}/api/projects/quick/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    // It may well fail — `quick` has no asset pipeline set up — but not with
    // this. Authoring the next show while one is on the wall is exactly the
    // thing having one program was supposed to make possible.
    assert.notEqual(response.status, 409);
    await response.arrayBuffer();
  });

  test('editing a prompt is not destructive and is never refused', async () => {
    // The distinction the list is drawing. A show holds the scenario it was
    // started with in memory and nothing re-reads it, so a field edit cannot
    // reach the projector — and a lock that refused everything would make
    // "run it and keep working" the thing it was supposed to enable.
    await start('media');
    const response = await fetch(`${baseUrl}/api/projects/media/asset`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: 'voice/open-1.mp3', field: 'prompt', value: '' }),
    });
    assert.notEqual(response.status, 409);
    await response.arrayBuffer();
  });

  test('the lock lifts when the show stops', async () => {
    await start('media');
    await fetch(`${baseUrl}/api/show/stop`, { method: 'POST' });
    const response = await fetch(`${baseUrl}/api/projects/media/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.notEqual(response.status, 409);
    await response.arrayBuffer();
  });
});


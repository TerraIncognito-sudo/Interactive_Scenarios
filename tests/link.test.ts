/**
 * The whole product, in one process.
 *
 * Every other test in this suite proves one half. `show.test.ts` runs a show
 * with nobody watching; `relay.test.ts` carries votes for a client that is a
 * few lines of test scaffolding. This is the only file where a real phone taps
 * a real option and a real `resolvePoll` decides a real branch, and it is the
 * only one that could ever catch the two halves disagreeing about what a poll
 * is — which is the failure that would happen in front of an audience and
 * nowhere else.
 *
 * So: a relay on an ephemeral port, the client's own server on another, the
 * link between them, and phones on the end of real sockets. Nothing is mocked.
 * The plan called for this in twenty lines and asked for it *before* the link
 * existed, because a link written first is a link whose tests are shaped by
 * what it happened to do.
 */

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { WebSocket } from 'ws';
import { buildServer } from '../server/index.ts';
import type { Config as RelayConfig } from '../server/config.ts';
import type { Snapshot } from '../shared/show/protocol.ts';
import type { PlayerState } from '../shared/relay/protocol.ts';

const TEST_PASSWORD = 'test-password';

// Before the import, not after: `workspace.ts` reads this when the module is
// first evaluated, and a test run must never change which folder the real app
// opens next.
const configDir = mkdtempSync(join(tmpdir(), 'is-link-config-'));
process.env.EDITOR_CONFIG_DIR = configDir;
process.env.LOG_LEVEL = 'silent';

const { buildEditorServer } = await import('../client/app/server.ts');
const { setWorkspace } = await import('../client/app/workspace.ts');
const { linkView } = await import('../client/app/show/link.ts');

const fixtures = join(import.meta.dirname, 'fixtures', 'scenarios');

let relayData: string;
let relay: Awaited<ReturnType<typeof buildServer>>;
let relayPort = 0;
let relayHttp: string;
let relayWs: string;

/**
 * Builds and listens on a port chosen once and kept.
 *
 * A fixed port rather than an ephemeral one because this relay has to come
 * back at the same address: the client's link holds the URL it was given, and
 * a restart that moved would be testing a reconfiguration rather than a
 * recovery.
 */
async function listenRelay(): Promise<void> {
  const config: RelayConfig = {
    port: relayPort,
    host: '127.0.0.1',
    dataDir: relayData,
    webDir: join(relayData, 'no-web'),
    publicUrl: undefined,
    roomTtlMs: 60_000,
    adminPassword: TEST_PASSWORD,
    adminPasswordGenerated: false,
  };
  relay = await buildServer(config);
  await relay.listen({ port: relayPort, host: '127.0.0.1' });
  const address = relay.server.address();
  relayPort = typeof address === 'object' && address ? address.port : relayPort;
  relayHttp = `http://127.0.0.1:${relayPort}`;
  relayWs = `ws://127.0.0.1:${relayPort}`;
}

/** Takes the relay down and brings it back, the way a redeploy does. */
async function restartRelay(): Promise<void> {
  await relay.close();
  await listenRelay();
}

let client: Server;
let clientUrl: string;
let clientWs: string;

before(async () => {
  relayData = mkdtempSync(join(tmpdir(), 'is-link-relay-'));
  await listenRelay();

  client = await buildEditorServer();
  await setWorkspace(fixtures);
  await new Promise<void>((resolve) => client.listen(0, '127.0.0.1', resolve));
  const clientAddress = client.address();
  const clientPort = typeof clientAddress === 'object' && clientAddress ? clientAddress.port : 0;
  clientUrl = `http://127.0.0.1:${clientPort}`;
  clientWs = `ws://127.0.0.1:${clientPort}/ws`;
});

after(async () => {
  await new Promise<void>((resolve) => client.close(() => resolve()));
  await relay.close();
  rmSync(configDir, { recursive: true, force: true });
  try {
    rmSync(relayData, { recursive: true, force: true });
  } catch {
    // Windows keeps a handle on the SQLite WAL briefly after close.
  }
});

// Unlinking before stopping, in that order: a show stopped while linked leaves
// a room open on the relay for the next test to trip over.
afterEach(async () => {
  await post('/api/show/unlink');
  await post('/api/show/stop');
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Peer = {
  socket: WebSocket;
  next<T>(match: (m: any) => boolean, timeoutMs?: number): Promise<T>;
  send(message: unknown): void;
  close(): void;
};

function connect(url: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const messages: any[] = [];
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
        next<T>(match: (m: any) => boolean, timeoutMs = 5000): Promise<T> {
          const existing = messages.find((m) => match(m));
          if (existing) return Promise.resolve(existing as T);
          return new Promise<T>((res, rej) => {
            const timer = setTimeout(
              () => rej(new Error(`timed out; saw: ${messages.map((m) => m.type).join(', ')}`)),
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

async function post(path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${clientUrl}${path}`, {
    method: 'POST',
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  return { status: response.status, body: await response.json() };
}

/** Issues a key through the relay console's own route, the way an operator would. */
async function issueKey(label: string): Promise<string> {
  const response = await fetch(`${relayHttp}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-password': TEST_PASSWORD },
    body: JSON.stringify({ label }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { phrase: string }).phrase;
}

const isSnapshot = (m: any): m is Snapshot => m?.type === 'snapshot';

/** The board window: the same loopback socket the operator's UI holds. */
async function joinBoard(): Promise<Peer> {
  const board = await connect(clientWs);
  board.send({ type: 'hello', role: 'board' });
  await board.next(isSnapshot);
  return board;
}

/** A phone, on the relay, at a code somebody read off a projector. */
async function joinPhone(room: string, deviceId: string): Promise<Peer> {
  const phone = await connect(`${relayWs}/ws`);
  phone.send({ type: 'hello', role: 'player', room, deviceId });
  await phone.next((m) => m.type === 'playerState');
  return phone;
}

/** Starts a show, links it, and returns the room code the relay handed back. */
async function goLive(project = 'slowpoll'): Promise<{ room: string; joinUrl: string }> {
  const key = await issueKey(`link test ${Math.random()}`);
  await post('/api/show/start', { project });
  const linked = await post('/api/show/link', { relayUrl: relayHttp, key });
  assert.equal(linked.status, 200, `link failed: ${JSON.stringify(linked.body)}`);
  assert.equal(linked.body.status, 'live', JSON.stringify(linked.body));
  return { room: linked.body.room, joinUrl: linked.body.joinUrl };
}

// ---------------------------------------------------------------------------

describe('a phone in the room decides the show', () => {
  test('two votes reach the client, and resolvePoll picks the branch', async () => {
    const { room, joinUrl } = await goLive();
    const board = await joinBoard();

    // The code reaches the projector through the ordinary snapshot, which is
    // what puts it on the lobby screen. A link that knew the code and never
    // told the Room would be a room nobody could be invited to.
    const lobby = await board.next<Snapshot>((m) => isSnapshot(m) && m.room === room);
    assert.equal(lobby.joinUrl, joinUrl);

    board.send({ type: 'command', command: { name: 'start' } });
    await board.next<Snapshot>((m) => isSnapshot(m) && m.beatInfo.kind === 'poll');

    // Two phones, joined after the poll opened — which is the ordinary case,
    // since people arrive late and the relay holds the question for them.
    const one = await joinPhone(room, 'device-one-aaaaaaaa');
    const two = await joinPhone(room, 'device-two-bbbbbbbb');

    const asked = await one.next<PlayerState>((m) => m.type === 'playerState' && m.poll);
    assert.equal(asked.poll?.question, 'Which way?');
    assert.deepEqual(
      asked.poll?.options.map((o) => o.key),
      ['left', 'right'],
    );

    one.send({ type: 'vote', optionKey: 'left' });
    two.send({ type: 'vote', optionKey: 'left' });

    // The tally on the operator's own screen, carried back from the relay.
    const tallied = await board.next<Snapshot>((m) => isSnapshot(m) && m.tally?.voters === 2);
    assert.deepEqual(tallied.tally?.counts, { left: 2, right: 0 });

    board.send({ type: 'command', command: { name: 'closePoll' } });
    const result = await board.next<Snapshot>((m) => isSnapshot(m) && m.beatInfo.kind === 'result');
    if (result.beatInfo.kind !== 'result') return assert.fail('expected a result beat');

    // Through `resolvePoll`, on the client, from counts the relay carried. The
    // fixture's declared default is `right`, so a winner of `left` is the two
    // taps and nothing else — and `usedDefault: false` is what says the votes
    // were actually counted rather than the poll quietly falling through.
    assert.equal(result.beatInfo.winner, 'left');
    assert.equal(result.beatInfo.total, 2);
    assert.equal(result.beatInfo.usedDefault, false);

    one.close();
    two.close();
    board.close();
  });

  test('a voter changing their mind moves their vote rather than adding one', async () => {
    const { room } = await goLive();
    const board = await joinBoard();
    board.send({ type: 'command', command: { name: 'start' } });
    await board.next<Snapshot>((m) => isSnapshot(m) && m.beatInfo.kind === 'poll');

    const phone = await joinPhone(room, 'device-changes-mind');
    phone.send({ type: 'vote', optionKey: 'left' });
    await board.next<Snapshot>((m) => isSnapshot(m) && m.tally?.counts?.left === 1);

    phone.send({ type: 'vote', optionKey: 'right' });
    const moved = await board.next<Snapshot>((m) => isSnapshot(m) && m.tally?.counts?.right === 1);
    // One voter, not two. The dedupe is the relay's — it holds the ballots —
    // and this asserts the client is showing that rather than accumulating a
    // stream of its own, which is how a bar chart drifts past the number of
    // people in the room.
    assert.deepEqual(moved.tally?.counts, { left: 0, right: 1 });
    assert.equal(moved.tally?.voters, 1);

    phone.close();
    board.close();
  });

  test('the board counts the phones that are actually there', async () => {
    const { room } = await goLive();
    const board = await joinBoard();

    const phone = await joinPhone(room, 'device-presence-one');
    const seen = await board.next<Snapshot>((m) => isSnapshot(m) && m.presence?.players === 1);
    // No phone is ever on the loopback socket, so this number can only come
    // from the relay. Reporting zero while forty people are looking at a code
    // is worse than reporting nothing at all.
    assert.equal(seen.presence?.players, 1);

    phone.close();
    board.close();
  });
});

describe('the link goes away and comes back', () => {
  test('it resumes the same room rather than opening another', async () => {
    const { room, joinUrl } = await goLive();
    const board = await joinBoard();
    board.send({ type: 'command', command: { name: 'start' } });
    await board.next<Snapshot>((m) => isSnapshot(m) && m.beatInfo.kind === 'poll');

    const phone = await joinPhone(room, 'device-holds-on');
    phone.send({ type: 'vote', optionKey: 'left' });
    await board.next<Snapshot>((m) => isSnapshot(m) && m.tally?.counts?.left === 1);

    await post('/api/show/link/reconnect');

    // The whole of this test. A reconnect that called `openRoom` would come
    // back with a new code while the audience is holding the old one, and the
    // show would look fine from the operator's chair.
    const back = await waitFor(() => {
      const view = linkView();
      return view.status === 'live' ? view : undefined;
    });
    assert.equal(back.room, room);
    assert.equal(back.joinUrl, joinUrl);

    phone.close();
    board.close();
  });

  test('a vote cast while it was away is on the board when it gets back', async () => {
    const { room } = await goLive();
    const board = await joinBoard();
    board.send({ type: 'command', command: { name: 'start' } });
    await board.next<Snapshot>((m) => isSnapshot(m) && m.beatInfo.kind === 'poll');

    const early = await joinPhone(room, 'device-votes-early');
    early.send({ type: 'vote', optionKey: 'left' });
    await board.next<Snapshot>((m) => isSnapshot(m) && m.tally?.voters === 1);
    early.close();

    // The relay goes down and comes back, which is a redeploy, and it takes
    // the link and the phones with it. The room is in SQLite and so are the
    // ballots — the client's clock never moved, because it was never there.
    await restartRelay();

    // A phone votes into the room while the link is still backing off. This is
    // the vote the client can only learn about from `roomResumed`: no tally is
    // ever sent for it, because nothing was connected to send one to. A link
    // that ignored the recovered ballots would sit on a stale count of one
    // forever, and this test would never finish.
    const late = await joinPhone(room, 'device-votes-late');
    late.send({ type: 'vote', optionKey: 'right' });

    const restored = await board.next<Snapshot>(
      (m) => isSnapshot(m) && m.tally?.voters === 2,
      15_000,
    );
    assert.deepEqual(restored.tally?.counts, { left: 1, right: 1 });

    // And the poll still resolves on all of them, which is the only assertion
    // here an audience would ever notice.
    board.send({ type: 'command', command: { name: 'closePoll' } });
    const result = await board.next<Snapshot>((m) => isSnapshot(m) && m.beatInfo.kind === 'result');
    if (result.beatInfo.kind !== 'result') return assert.fail('expected a result beat');
    assert.equal(result.beatInfo.total, 2);

    late.close();
    board.close();
  });
});

describe('what going live costs the rehearsal controls', () => {
  test('a simulated vote is refused while linked, and says why', async () => {
    const { room } = await goLive();
    const board = await joinBoard();
    board.send({ type: 'command', command: { name: 'start' } });
    const open = await board.next<Snapshot>((m) => isSnapshot(m) && m.beatInfo.kind === 'poll');
    assert.equal(open.room, room);

    board.send({ type: 'command', command: { name: 'castVotes', optionKey: 'left', count: 9 } });

    // A real vote arrives afterwards, so this is not merely asserting that
    // nothing happened for 250ms — the count that comes back is one, and nine
    // simulated ballots would have been in front of it.
    const phone = await joinPhone(room, 'device-real-voter');
    phone.send({ type: 'vote', optionKey: 'right' });
    const tallied = await board.next<Snapshot>((m) => isSnapshot(m) && m.tally?.voters === 1);
    assert.deepEqual(tallied.tally?.counts, { left: 0, right: 1 });

    phone.close();
    board.close();
  });

  test('unlinking hands the rehearsal back', async () => {
    await goLive();
    const board = await joinBoard();
    board.send({ type: 'command', command: { name: 'start' } });
    await board.next<Snapshot>((m) => isSnapshot(m) && m.beatInfo.kind === 'poll');

    await post('/api/show/unlink');
    // And the code goes with it, because there is nothing to join any more.
    // A projector still showing a dead code is a room of people typing it in.
    const unlinked = await board.next<Snapshot>((m) => isSnapshot(m) && m.room === undefined);
    assert.equal(unlinked.joinUrl, undefined);

    board.send({ type: 'command', command: { name: 'castVotes', optionKey: 'left', count: 4 } });
    const simulated = await board.next<Snapshot>((m) => isSnapshot(m) && m.tally?.voters === 4);
    assert.deepEqual(simulated.tally?.counts, { left: 4, right: 0 });
    board.close();
  });
});

describe('what the operator is told when it will not link', () => {
  test('a key the relay does not know is reported as a key, not as a failure', async () => {
    await post('/api/show/start', { project: 'slowpoll' });
    const refused = await post('/api/show/link', {
      relayUrl: relayHttp,
      key: 'amber-amber-amber-amber-amber',
    });
    assert.equal(refused.body.status, 'failed');
    // `needsKey` is what puts the box back on screen. Without it the board
    // would retry a phrase that is never going to work, all evening.
    assert.equal(refused.body.needsKey, true);
    assert.match(refused.body.message, /revoked|not valid/i);
  });

  test('a relay that is not there is reported without ending the show', async () => {
    await post('/api/show/start', { project: 'slowpoll' });
    const refused = await post('/api/show/link', {
      // Port 1 is reserved and nothing is listening on it.
      relayUrl: 'http://127.0.0.1:1',
      key: 'amber-amber-amber-amber-amber',
    });
    assert.equal(refused.body.status, 'failed');
    assert.notEqual(refused.body.needsKey, true);

    // The show is still running. Going live is an addition to a show, not the
    // way one starts — the failure mode this guards is a link error taking the
    // projector down five minutes before the doors open.
    const status = await (await fetch(`${clientUrl}/api/show`)).json();
    assert.equal(status.running, true);
    assert.equal(status.room, undefined);
  });

  test('linking with no show running is refused', async () => {
    const refused = await post('/api/show/link', { relayUrl: relayHttp, key: 'whatever' });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /show/i);
  });
});

describe('the key the operator only types once', () => {
  test('a working key is remembered, so the next show links with no arguments', async () => {
    const { room } = await goLive();
    await post('/api/show/unlink');
    await post('/api/show/stop');

    await post('/api/show/start', { project: 'slowpoll' });
    const again = await post('/api/show/link');
    assert.equal(again.body.status, 'live', JSON.stringify(again.body));
    // A different room — the first was closed — but no phrase was typed. The
    // key and the relay URL are the machine's business, like the models root:
    // they must never reach `project.yaml`, which travels to other machines.
    assert.notEqual(again.body.room, room);
  });

  test('a key that was refused is not remembered', async () => {
    // Otherwise the one thing the operator has to fix is the one thing the
    // config keeps handing back to them.
    await post('/api/show/start', { project: 'slowpoll' });
    await post('/api/show/link', { relayUrl: relayHttp, key: 'amber-amber-amber-amber-amber' });
    await post('/api/show/stop');

    await post('/api/show/start', { project: 'slowpoll' });
    const again = await post('/api/show/link');
    assert.equal(again.body.status, 'live', JSON.stringify(again.body));
  });
});

// ---------------------------------------------------------------------------

/** Polls a predicate until it answers. For state that is not a message. */
async function waitFor<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for state');
    await new Promise((r) => setTimeout(r, 25));
  }
}

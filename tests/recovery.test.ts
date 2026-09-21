/**
 * Surviving a restart mid-poll.
 *
 * Two different processes can die in the middle of a vote and the show has to
 * absorb both, so both get a test rather than a paragraph.
 *
 * The **relay** restarting is a container being redeployed while forty phones
 * are holding a question. That is the entire reason it has a database: the
 * room, the poll and every ballot have to come back, and the phones must not
 * be asked to do anything about it. A voter's own choice comes back
 * highlighted, which is the part that would otherwise look like their vote was
 * lost.
 *
 * The **client** dropping its link is a laptop that changed networks. The
 * relay keeps taking votes while it is gone — nobody in the room notices —
 * and the client comes back with its room token, replays the ballots into a
 * fresh box, and carries on. Its clock never moved, because it was never here.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { buildServer } from '../server/index.ts';
import type { Config } from '../server/config.ts';
import { RELAY_PROTOCOL } from '../shared/relay/protocol.ts';
import type { PlayerState, RelayTally, RoomOpened, RoomResumed } from '../shared/relay/protocol.ts';

let dataDir: string;
const TEST_PASSWORD = 'test-password';

before(() => {
  process.env.LOG_LEVEL = 'silent';
  dataDir = mkdtempSync(join(tmpdir(), 'interactive-scenario-recovery-'));
});

after(() => {
  // Windows keeps a handle on the SQLite WAL briefly after close; a leftover
  // temp directory is not worth failing a green suite over.
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function configFor(): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    dataDir,
    webDir: join(dataDir, 'no-web'),
    publicUrl: 'http://test.local',
    roomTtlMs: 60_000,
    adminPassword: TEST_PASSWORD,
    adminPasswordGenerated: false,
  };
}

type Started = {
  app: Awaited<ReturnType<typeof buildServer>>;
  baseUrl: string;
  wsUrl: string;
};

async function startRelay(): Promise<Started> {
  const app = await buildServer(configFor());
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
  };
}

type Peer = {
  socket: WebSocket;
  next<T>(match: (m: any) => boolean, timeoutMs?: number): Promise<T>;
  send(message: unknown): void;
  close(): void;
};

function connect(wsUrl: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
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
        next<T>(match: (m: any) => boolean, timeoutMs = 4000): Promise<T> {
          const existing = messages.find((m) => match(m));
          if (existing) return Promise.resolve(existing as T);
          return new Promise<T>((res, rej) => {
            const timer = setTimeout(
              () =>
                rej(
                  new Error(
                    `timed out; saw: ${messages
                      .map((m) => `${m.type}${m.type === 'error' ? `(${m.code})` : ''}`)
                      .join(', ')}`,
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

async function issueKey(baseUrl: string, label: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-password': TEST_PASSWORD },
    body: JSON.stringify({ label }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { phrase: string }).phrase;
}

const A_POLL = {
  type: 'poll',
  nodeId: 'choose',
  question: 'Which way?',
  options: [
    { key: 'left', label: 'Left' },
    { key: 'right', label: 'Right' },
  ],
  endsAt: Date.now() + 300_000,
};

describe('surviving a relay restart', () => {
  test('a room mid-poll comes back with its votes, and a phone sees its own choice', async () => {
    // --- First container: a room, a question, two phones --------------------
    const first = await startRelay();
    const key = await issueKey(first.baseUrl, 'the presenting laptop');

    const client = await connect(first.wsUrl);
    client.send({ type: 'openRoom', protocol: RELAY_PROTOCOL, key, title: 'Arctic Sentinel' });
    const opened = await client.next<RoomOpened>((m) => m.type === 'roomOpened');
    client.send(A_POLL);
    await client.next((m) => m.type === 'tally');

    const alice = await connect(first.wsUrl);
    alice.send({ type: 'hello', role: 'player', room: opened.room, deviceId: 'alice-device-01' });
    await alice.next((m) => m.type === 'playerState');
    alice.send({ type: 'vote', optionKey: 'left' });

    const bob = await connect(first.wsUrl);
    bob.send({ type: 'hello', role: 'player', room: opened.room, deviceId: 'bob-device-0001' });
    await bob.next((m) => m.type === 'playerState');
    bob.send({ type: 'vote', optionKey: 'right' });

    await client.next((m) => m.type === 'tally' && m.voters === 2);

    // --- The container goes away --------------------------------------------
    client.close();
    alice.close();
    bob.close();
    await first.app.close();

    // --- Second container, same volume --------------------------------------
    const second = await startRelay();

    // Alice's phone reconnects the way `Connection` does on its own: same
    // room, same device id, nothing about a restart anywhere in the frame.
    const aliceAgain = await connect(second.wsUrl);
    aliceAgain.send({
      type: 'hello',
      role: 'player',
      room: opened.room,
      deviceId: 'alice-device-01',
    });
    const restored = await aliceAgain.next<PlayerState>((m) => m.type === 'playerState');
    assert.equal(restored.poll?.nodeId, 'choose');
    assert.equal(restored.poll?.question, 'Which way?');
    assert.equal(restored.poll?.options.length, 2);
    // The one that would otherwise look like a lost vote: her own choice comes
    // back, so the option she picked is still highlighted on her screen.
    assert.equal(restored.choice, 'left');

    // And the client resumes onto the same room with both ballots.
    const clientAgain = await connect(second.wsUrl);
    clientAgain.send({
      type: 'resumeRoom',
      protocol: RELAY_PROTOCOL,
      room: opened.room,
      token: opened.token,
    });
    const resumed = await clientAgain.next<RoomResumed>((m) => m.type === 'roomResumed');
    assert.equal(resumed.room, opened.room, 'the code on the wall must not change');
    assert.equal(resumed.open?.nodeId, 'choose');
    assert.equal(resumed.open?.votes.length, 2);
    assert.deepEqual(
      resumed.open?.votes.map((v) => v.optionKey).sort(),
      ['left', 'right'],
      'every ballot comes back, or the tally on the board is a lie',
    );

    aliceAgain.close();
    clientAgain.close();
    await second.app.close();
  });

  test('a key survives, because it is in the volume rather than the environment', async () => {
    // The whole reason keys are data. A redeploy that silently invalidated
    // every key would lock out every client at once, which is the failure an
    // environment variable has by design.
    const relay = await startRelay();
    const response = await fetch(`${relay.baseUrl}/api/keys`, {
      headers: { 'x-admin-password': TEST_PASSWORD },
    });
    const listed = (await response.json()) as { keys: { label: string }[] };
    assert.ok(listed.keys.some((k) => k.label === 'the presenting laptop'));

    const health = (await (await fetch(`${relay.baseUrl}/api/health`)).json()) as { keyed: boolean };
    assert.equal(health.keyed, true);
    await relay.app.close();
  });
});

describe('surviving a client that drops mid-poll', () => {
  test('the room keeps taking votes, and the client comes back to all of them', async () => {
    const relay = await startRelay();
    const key = await issueKey(relay.baseUrl, 'a laptop on bad wifi');

    const client = await connect(relay.wsUrl);
    client.send({ type: 'openRoom', protocol: RELAY_PROTOCOL, key });
    const opened = await client.next<RoomOpened>((m) => m.type === 'roomOpened');
    client.send(A_POLL);
    await client.next((m) => m.type === 'tally');

    const phone = await connect(relay.wsUrl);
    phone.send({ type: 'hello', role: 'player', room: opened.room, deviceId: 'phone-device-001' });
    await phone.next((m) => m.type === 'playerState');
    phone.send({ type: 'vote', optionKey: 'left' });
    await client.next((m) => m.type === 'tally' && m.voters === 1);

    // The link dies. Nothing in the room changes — this is the difference
    // between a relay that holds the votes and one that merely forwards them.
    client.close();
    await new Promise((r) => setTimeout(r, 50));

    const late = await connect(relay.wsUrl);
    late.send({ type: 'hello', role: 'player', room: opened.room, deviceId: 'late-device-0001' });
    const stillOpen = await late.next<PlayerState>((m) => m.type === 'playerState');
    assert.equal(stillOpen.poll?.nodeId, 'choose', 'a phone must not notice the client leaving');
    late.send({ type: 'vote', optionKey: 'right' });
    await new Promise((r) => setTimeout(r, 50));

    const back = await connect(relay.wsUrl);
    back.send({
      type: 'resumeRoom',
      protocol: RELAY_PROTOCOL,
      room: opened.room,
      token: opened.token,
    });
    const resumed = await back.next<RoomResumed>((m) => m.type === 'roomResumed');
    // **The same room code.** Opening a new one instead would put a fresh code
    // on the projector and leave every phone in the room on a dead one.
    assert.equal(resumed.room, opened.room);
    assert.equal(resumed.open?.votes.length, 2);
    assert.equal(resumed.players, 2);

    // And the room is live again straight away: the next vote reaches it.
    phone.send({ type: 'vote', optionKey: 'right' });
    const tally = await back.next<RelayTally>((m) => m.type === 'tally');
    assert.deepEqual(tally.counts, { left: 0, right: 2 });

    phone.close();
    late.close();
    back.close();
    await relay.app.close();
  });
});

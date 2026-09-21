/**
 * The relay: what it carries, what it refuses, and what it cannot do.
 *
 * Half of this file is about the relay working — a phone joins a code, taps an
 * option, and a number reaches the machine running the show. The other half is
 * about its limits, and those are the assertions worth keeping: it faces the
 * internet, so what it *cannot* do is the design. It cannot read a scenario.
 * It cannot decide a poll. Nothing travelling toward a client is a command,
 * and nothing a phone sends is anything but a vote.
 *
 * Real sockets against a real server on an ephemeral port, in the house style.
 * The relay has no engine to stub and nothing here is worth a mock.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { buildServer } from '../server/index.ts';
import type { Config } from '../server/config.ts';
import {
  RELAY_PROTOCOL,
  RoomCodeSchema,
  RoomNameSchema,
  generateRoomCode,
  normalizeRoomName,
  parseRelayMessage,
} from '../shared/relay/protocol.ts';
import type { PlayerState, RelayTally, RoomOpened } from '../shared/relay/protocol.ts';

const TEST_PASSWORD = 'test-password';
const ROOT = resolve(import.meta.dirname, '..');

let dataDir: string;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let wsUrl: string;

before(async () => {
  process.env.LOG_LEVEL = 'silent';
  dataDir = mkdtempSync(join(tmpdir(), 'interactive-scenario-relay-'));

  const config: Config = {
    port: 0,
    host: '127.0.0.1',
    dataDir,
    webDir: join(dataDir, 'no-web'),
    // Undefined so links are derived from each request, which is the mode the
    // join URL has to be right in — it is what a LAN deployment runs.
    publicUrl: undefined,
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
  await app.close();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows keeps a handle on the SQLite WAL briefly after close; a leftover
    // temp directory is not worth failing a green suite over.
  }
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Peer = {
  socket: WebSocket;
  next<T>(match: (m: any) => boolean, timeoutMs?: number): Promise<T>;
  /** Nothing should arrive. Proves a refusal that is correctly silent. */
  quiet(ms?: number): Promise<void>;
  send(message: unknown): void;
  close(): void;
};

function connect(headers: Record<string, string> = {}): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, { headers });
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
                      .map((m) => `${m.type}${m.type === 'error' ? `(${m.code}: ${m.message})` : ''}`)
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
        async quiet(ms = 250): Promise<void> {
          const before = messages.length;
          await new Promise((r) => setTimeout(r, ms));
          assert.equal(
            messages.length,
            before,
            `expected silence, got ${JSON.stringify(messages.slice(before))}`,
          );
        },
        send: (message) => socket.send(JSON.stringify(message)),
        close: () => socket.close(),
      }),
    );
  });
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      // Only when there is a body. Fastify refuses a POST that announces a
      // JSON body and sends none — which is Revoke and End, both of which take
      // no arguments.
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      'x-admin-password': TEST_PASSWORD,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

/** Issues a key through the console's own route, the way an operator would. */
async function issueKey(label: string): Promise<string> {
  const response = await api('/api/keys', {
    method: 'POST',
    body: JSON.stringify({ label }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { phrase: string }).phrase;
}

/** A client with a room open, plus the code and token it was given. */
async function openRoom(
  key: string,
  options: { title?: string; name?: string; headers?: Record<string, string> } = {},
): Promise<{ client: Peer; opened: RoomOpened }> {
  const client = await connect(options.headers ?? {});
  client.send({
    type: 'openRoom',
    protocol: RELAY_PROTOCOL,
    key,
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.name !== undefined ? { name: options.name } : {}),
  });
  const opened = await client.next<RoomOpened>((m) => m.type === 'roomOpened');
  return { client, opened };
}

async function joinAs(code: string, deviceId: string): Promise<Peer> {
  const phone = await connect();
  phone.send({ type: 'hello', role: 'player', room: code, deviceId });
  await phone.next((m) => m.type === 'playerState');
  return phone;
}

const A_POLL = {
  type: 'poll',
  nodeId: 'choose',
  question: 'Which way?',
  options: [
    { key: 'left', label: 'Left' },
    { key: 'right', label: 'Right' },
  ],
  endsAt: Date.now() + 60_000,
};

// ---------------------------------------------------------------------------

describe('a relay with no keys opens no rooms', () => {
  test('the very first openRoom is refused, and says where to get one', async () => {
    // Ordering matters: this runs before any key exists, which is the state a
    // fresh container is in. An empty key list must never quietly mean the
    // permissive thing — the same rule as an empty PUBLIC_URL.
    const client = await connect();
    client.send({ type: 'openRoom', protocol: RELAY_PROTOCOL, key: 'amber-amber-amber-amber-amber' });
    const error = await client.next<any>((m) => m.type === 'error');
    assert.equal(error.code, 'badKey');
    assert.match(error.message, /console/);
    client.close();
  });

  test('health says so, which is what explains a relay that refuses everything', async () => {
    const health = (await (await api('/api/health')).json()) as { keyed: boolean };
    assert.equal(health.keyed, false);
  });
});

describe('a key opens a room', () => {
  test('a phrase is issued, used, and the room comes back with a code', async () => {
    const key = await issueKey('the test laptop');
    const { client, opened } = await openRoom(key, { title: 'Arctic Sentinel' });

    assert.match(opened.room, /^[ABCDEFGHJKLMNPQRTUVWXY2346789]{6}$/);
    assert.ok(opened.token.length > 20);
    assert.equal(opened.players, 0);
    client.close();
  });

  test('a key must be a label somebody dares revoke from', async () => {
    const response = await api('/api/keys', { method: 'POST', body: JSON.stringify({ label: '  ' }) });
    assert.equal(response.status, 400);
  });

  test('the join link follows the request, so a LAN deployment needs no config', async () => {
    const key = await issueKey('forwarded');
    const { client, opened } = await openRoom(key, {
      headers: { 'x-forwarded-host': 'interact.example', 'x-forwarded-proto': 'https' },
    });
    // The invariant that moved here from the show server. A Cloudflare-proxied
    // handshake has to yield a public link and a LAN one a LAN link, with
    // nothing configured — and this is the link that goes on a projector.
    assert.equal(opened.joinUrl, `https://interact.example/join/${opened.room}`);
    client.close();
  });

  test('a client speaking another protocol is told which end is old', async () => {
    const key = await issueKey('from the future');
    const client = await connect();
    client.send({ type: 'openRoom', protocol: RELAY_PROTOCOL + 1, key });
    const error = await client.next<any>((m) => m.type === 'error');
    assert.equal(error.code, 'badProtocol');
    assert.match(error.message, /Update whichever is older/);
    client.close();
  });

  test('a wrong key is refused, and the message admits it may have been revoked', async () => {
    // Different advice from the one above, and the difference is the point: a
    // relay that has never issued a key and one whose keys were all withdrawn
    // this morning are the same refusal and completely different problems.
    // Told the wrong one, somebody goes off to check the container's setup.
    const client = await connect();
    client.send({ type: 'openRoom', protocol: RELAY_PROTOCOL, key: 'not-a-real-phrase-at-all' });
    const error = await client.next<any>((m) => m.type === 'error');
    assert.equal(error.code, 'badKey');
    assert.match(error.message, /revoked/);
    client.close();
  });
});

describe('a phone in a room', () => {
  test('a vote reaches the client as a number', async () => {
    const key = await issueKey('votes');
    const { client, opened } = await openRoom(key);
    client.send(A_POLL);
    // An empty poll draws as empty bars rather than as nothing having happened.
    const empty = await client.next<RelayTally>((m) => m.type === 'tally');
    assert.deepEqual(empty.counts, { left: 0, right: 0 });

    const phone = await joinAs(opened.room, 'device-one-aaaa');
    const question = await phone.next<PlayerState>((m) => m.type === 'playerState' && !!m.poll);
    assert.equal(question.poll?.question, 'Which way?');

    phone.send({ type: 'vote', optionKey: 'left' });
    const tally = await client.next<RelayTally>((m) => m.type === 'tally' && m.voters === 1);
    assert.deepEqual(tally.counts, { left: 1, right: 0 });
    assert.equal(tally.nodeId, 'choose');

    phone.close();
    client.close();
  });

  test('changing your mind moves a vote rather than adding one', async () => {
    const key = await issueKey('minds');
    const { client, opened } = await openRoom(key);
    client.send(A_POLL);
    const phone = await joinAs(opened.room, 'device-two-bbbb');

    phone.send({ type: 'vote', optionKey: 'left' });
    await client.next<RelayTally>((m) => m.type === 'tally' && m.counts.left === 1);
    phone.send({ type: 'vote', optionKey: 'right' });

    const moved = await client.next<RelayTally>((m) => m.type === 'tally' && m.counts.right === 1);
    assert.equal(moved.voters, 1, 'one phone is one voter however many times it taps');
    assert.deepEqual(moved.counts, { left: 0, right: 1 });
    phone.close();
    client.close();
  });

  test('an option that is not on the poll is not a vote', async () => {
    const key = await issueKey('strays');
    const { client, opened } = await openRoom(key);
    client.send(A_POLL);
    await client.next((m) => m.type === 'tally');
    const phone = await joinAs(opened.room, 'device-three-cccc');

    phone.send({ type: 'vote', optionKey: 'sideways' });
    // The phone is told where it stands rather than disconnected: the poll may
    // simply have moved on under it, which is not an error worth closing over.
    const state = await phone.next<PlayerState>(
      (m) => m.type === 'playerState' && m.choice === undefined && !!m.poll,
    );
    assert.equal(state.choice, undefined);
    phone.close();
    client.close();
  });

  test('presence reaches the client, so the board can say nobody has joined', async () => {
    const key = await issueKey('presence');
    const { client, opened } = await openRoom(key);
    const phone = await joinAs(opened.room, 'device-four-dddd');
    const arrived = await client.next<any>((m) => m.type === 'presence' && m.players === 1);
    assert.equal(arrived.players, 1);

    phone.close();
    const left = await client.next<any>((m) => m.type === 'presence' && m.players === 0);
    assert.equal(left.players, 0);
    client.close();
  });

  test('a closed poll stops taking votes and shows the voter their own choice', async () => {
    const key = await issueKey('closing');
    const { client, opened } = await openRoom(key);
    client.send(A_POLL);
    const phone = await joinAs(opened.room, 'device-five-eeee');
    phone.send({ type: 'vote', optionKey: 'left' });
    await client.next((m) => m.type === 'tally' && m.voters === 1);

    client.send({ type: 'closePoll', nodeId: 'choose' });
    const locked = await phone.next<PlayerState>(
      (m) => m.type === 'playerState' && m.poll === undefined,
    );
    // Their choice travels with the closure — the page draws "you chose Left"
    // off it, and a countdown nobody can answer is a button people keep
    // pressing.
    assert.equal(locked.choice, 'left');

    phone.send({ type: 'vote', optionKey: 'right' });
    const after = await phone.next<PlayerState>(
      (m) => m.type === 'playerState' && m.poll === undefined && m.choice === 'left',
    );
    assert.equal(after.choice, 'left', 'a vote after the close must not land');
    phone.close();
    client.close();
  });

  test('a code nobody opened is refused', async () => {
    const phone = await connect();
    phone.send({ type: 'hello', role: 'player', room: 'ABCD24', deviceId: 'device-six-ffff' });
    const error = await phone.next<any>((m) => m.type === 'error');
    assert.equal(error.code, 'badRoom');
    phone.close();
  });
});

describe('the relay decides nothing', () => {
  test('closing a poll produces no winner anywhere', async () => {
    const key = await issueKey('deciding');
    const { client, opened } = await openRoom(key);
    client.send(A_POLL);
    const phone = await joinAs(opened.room, 'device-seven-gggg');
    phone.send({ type: 'vote', optionKey: 'right' });
    await client.next((m) => m.type === 'tally' && m.voters === 1);

    client.send({ type: 'closePoll', nodeId: 'choose' });
    // Nothing comes back. A winner depends on the poll's `default:`, its
    // tie-break mode and `resolvePoll`, none of which exist here — so the one
    // right answer to "who won" is silence.
    await client.quiet();
    phone.close();
    client.close();
  });

  test('nothing the relay can say is a command', () => {
    // The transport could not deliver one, because the union has nowhere to
    // put it. Stated as a parse rather than as a grep: a `command` frame is
    // not merely unhandled, it is unrepresentable.
    const command = JSON.stringify({ type: 'command', command: { name: 'reset' } });
    assert.equal(parseRelayMessage(command), undefined);
    const snapshot = JSON.stringify({ type: 'snapshot', phase: 'running', beat: 3 });
    assert.equal(parseRelayMessage(snapshot), undefined);
  });

  test('the protocol file names neither of the two things it must not carry', async () => {
    const source = await readFile(join(ROOT, 'shared', 'relay', 'protocol.ts'), 'utf8');
    // Named in the header as the two that must never appear. The header is
    // where somebody would read that; this is what makes it true.
    const body = source.slice(source.indexOf('*/') + 2);
    assert.ok(!body.includes('ShowCommandSchema'), 'the relay protocol must carry no commands');
    assert.ok(!body.includes('DISPLAY_COMMANDS'), 'the relay protocol must carry no key list');
  });

  test('a client cannot vote and a phone cannot publish a poll', async () => {
    const key = await issueKey('roles');
    const { client, opened } = await openRoom(key);
    client.send(A_POLL);
    await client.next((m) => m.type === 'tally');

    client.send({ type: 'vote', optionKey: 'left' });
    const clientRefused = await client.next<any>((m) => m.type === 'error');
    assert.equal(clientRefused.code, 'badToken');

    const phone = await joinAs(opened.room, 'device-eight-hhhh');
    phone.send({ ...A_POLL, nodeId: 'hijacked' });
    const phoneRefused = await phone.next<any>((m) => m.type === 'error');
    assert.equal(phoneRefused.code, 'badToken');

    phone.close();
    client.close();
  });
});

describe('what a key buys, and what revoking costs', () => {
  test('revoking refuses the next room and never the running one', async () => {
    const key = await issueKey('the loaner ThinkPad');
    const { client, opened } = await openRoom(key);
    client.send(A_POLL);
    await client.next((m) => m.type === 'tally');

    const listed = (await (await api('/api/keys')).json()) as {
      keys: { id: string; label: string; phrase: string; lastUsedAt?: number; openRooms: number }[];
    };
    const mine = listed.keys.find((k) => k.label === 'the loaner ThinkPad')!;
    assert.equal(mine.phrase, key, 'the console has to be able to read a key out loud');
    assert.ok(mine.lastUsedAt !== undefined, 'a key in use must look different from one that is not');
    assert.equal(mine.openRooms, 1);

    const revoked = await api(`/api/keys/${mine.id}/revoke`, { method: 'POST' });
    assert.equal(revoked.status, 200);

    // The running room is untouched: a phone can still join it and vote.
    const phone = await joinAs(opened.room, 'device-nine-iiii');
    phone.send({ type: 'vote', optionKey: 'left' });
    const tally = await client.next<RelayTally>((m) => m.type === 'tally' && m.voters === 1);
    assert.deepEqual(tally.counts, { left: 1, right: 0 });

    // And it is still resumable by its own token, which is exactly why resume
    // authenticates with that rather than with the key.
    client.close();
    const resuming = await connect();
    resuming.send({
      type: 'resumeRoom',
      protocol: RELAY_PROTOCOL,
      room: opened.room,
      token: opened.token,
    });
    const resumed = await resuming.next<any>((m) => m.type === 'roomResumed');
    assert.equal(resumed.room, opened.room);
    assert.equal(resumed.open?.nodeId, 'choose');
    assert.equal(resumed.open?.votes.length, 1);

    // But the next room is refused — and told the right thing. This relay has
    // issued keys, so "no keys yet" would send somebody to check its setup.
    const blocked = await connect();
    blocked.send({ type: 'openRoom', protocol: RELAY_PROTOCOL, key });
    const error = await blocked.next<any>((m) => m.type === 'error');
    assert.equal(error.code, 'badKey');
    assert.match(error.message, /revoked/);

    blocked.close();
    resuming.close();
    phone.close();
  });

  test('a revoked key stays listed, because one that vanishes gets re-issued', async () => {
    const listed = (await (await api('/api/keys')).json()) as {
      keys: { label: string; revokedAt?: number }[];
    };
    const mine = listed.keys.find((k) => k.label === 'the loaner ThinkPad')!;
    assert.ok(mine.revokedAt !== undefined);
  });

  test('a resume with the wrong token gives nothing away', async () => {
    const key = await issueKey('wrong token');
    const { client, opened } = await openRoom(key);
    const impostor = await connect();
    impostor.send({
      type: 'resumeRoom',
      protocol: RELAY_PROTOCOL,
      room: opened.room,
      token: 'x'.repeat(43),
    });
    const error = await impostor.next<any>((m) => m.type === 'error');
    assert.equal(error.code, 'badToken');
    // One answer for "no such room" and "wrong token": the difference is only
    // ever useful to somebody who has neither.
    assert.match(error.message, /not open, or the token is wrong/);
    impostor.close();
    client.close();
  });

  test('a second client takes the room over rather than being locked out', async () => {
    const key = await issueKey('takeover');
    const { client, opened } = await openRoom(key);

    const second = await connect();
    second.send({
      type: 'resumeRoom',
      protocol: RELAY_PROTOCOL,
      room: opened.room,
      token: opened.token,
    });
    await second.next((m) => m.type === 'roomResumed');

    // The first is told, rather than left holding a socket that silently does
    // nothing. The common cause is its own dead connection, and refusing the
    // second would lock an operator out of their own room at the worst moment.
    const evicted = await client.next<any>((m) => m.type === 'error');
    assert.match(evicted.message, /took over/);

    second.close();
    client.close();
  });
});

describe('the console', () => {
  test('every route that matters needs the password', async () => {
    for (const path of ['/api/rooms', '/api/keys']) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 401, `${path} must be gated`);
    }
    const issuing = await fetch(`${baseUrl}/api/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'sneaky' }),
    });
    assert.equal(issuing.status, 401);
  });

  test('the room list carries no room token', async () => {
    const key = await issueKey('status page');
    const { client, opened } = await openRoom(key, { title: 'Team Union' });

    const body = await (await api('/api/rooms')).text();
    assert.ok(body.includes(opened.room), 'the page has to name the room');
    // The absence is the design. The list this replaces carried host and
    // display tokens and therefore full control of every running show; there
    // is no host link any more, so the field goes.
    assert.ok(!body.includes(opened.token), 'the status page must never hand over a room token');

    const listed = (await (await api('/api/rooms')).json()) as {
      rooms: { code: string; title?: string; keyLabel?: string; clientConnected: boolean }[];
    };
    const room = listed.rooms.find((r) => r.code === opened.room)!;
    assert.equal(room.title, 'Team Union');
    assert.equal(room.keyLabel, 'status page', 'revoking safely means knowing what is running');
    assert.equal(room.clientConnected, true);
    client.close();
  });

  test('End closes a room, and the phones in it are told', async () => {
    const key = await issueKey('ending');
    const { client, opened } = await openRoom(key);
    const phone = await joinAs(opened.room, 'device-ten-jjjj');

    const ended = await api(`/api/rooms/${opened.room}/close`, { method: 'POST' });
    assert.equal(ended.status, 200);

    const told = await phone.next<any>((m) => m.type === 'error');
    assert.equal(told.code, 'roomClosed');

    // And it is gone for good — it must not come back on the next restart.
    const listed = (await (await api('/api/rooms')).json()) as { rooms: { code: string }[] };
    assert.ok(!listed.rooms.some((r) => r.code === opened.room));
    phone.close();
    client.close();
  });

  test('ending a room nobody opened is a 404 rather than a shrug', async () => {
    const response = await api('/api/rooms/ABCD24/close', { method: 'POST' });
    assert.equal(response.status, 404);
  });
});

/**
 * The relay could not read a scenario if you handed it one.
 *
 * This is the capability the split was for, and it is worth an assertion
 * rather than a paragraph because nothing else would notice it going. An
 * import added for one convenient helper is how a relay ends up with a YAML
 * parser, and a relay with a YAML parser is one somebody will eventually
 * teach to decide a poll.
 *
 * Walked from `server/index.ts` rather than globbed over `server/**`, because
 * the question is what the deployed program can reach. A file sitting in the
 * folder that nothing imports is not part of the relay, and a test that could
 * not tell the difference would be one people route around.
 */
describe('the relay cannot understand a show', () => {
  async function reachableFrom(entry: string): Promise<string[]> {
    const seen = new Set<string>();
    const queue = [resolve(ROOT, entry)];

    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);

      const source = await readFile(file, 'utf8');
      // Relative specifiers only: a bare one is an npm package, and those are
      // the dependency list's problem rather than the graph's.
      for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
        queue.push(resolve(dirname(file), match[1]!));
      }
    }

    return [...seen].map((file) => relative(ROOT, file).replaceAll('\\', '/'));
  }

  test('nothing it loads can parse a scenario or run the engine', async () => {
    const files = await reachableFrom('server/index.ts');
    assert.ok(files.length > 5, `only walked ${files.length} files — the walk is broken`);

    for (const file of files) {
      assert.ok(
        !file.startsWith('shared/scenario/'),
        `${file} is reachable from the relay: it must not be able to read a scenario`,
      );
      assert.ok(
        !file.startsWith('shared/engine/'),
        `${file} is reachable from the relay: it must not be able to decide a poll`,
      );
    }
  });

  test('the whole of what it borrows is one file', async () => {
    // Stronger than the two exclusions above, and cheap now that it is true:
    // the relay's entire reach outside its own folder is the protocol it
    // speaks. It does not even load `shared/show/protocol.ts` any more — the
    // show's wire went with `Room` when that moved into the client, and the
    // two halves now share a vocabulary rather than a program.
    //
    // Written as an equality rather than a set of bans so that *adding* a
    // dependency is what fails, rather than only adding one somebody thought
    // of in advance.
    const files = await reachableFrom('server/index.ts');
    const borrowed = files.filter((file) => !file.startsWith('server/')).sort();
    assert.deepEqual(borrowed, ['shared/relay/protocol.ts']);
  });

  test('nothing it loads knows what a command is', async () => {
    const files = await reachableFrom('server/index.ts');
    for (const file of files) {
      const source = await readFile(join(ROOT, file), 'utf8');
      assert.ok(
        !source.includes('handleCommand'),
        `${file} is reachable from the relay and mentions handleCommand`,
      );
    }
  });

  test('it declares no YAML parser, so it could not read one if it tried', async () => {
    const manifest = JSON.parse(await readFile(join(ROOT, 'server', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    // The generalisation of "the game server never learns about Python": the
    // inability is enforced by the dependency list rather than by care.
    assert.ok(!('yaml' in manifest.dependencies), 'the relay must not depend on a YAML parser');
    assert.ok(!('qrcode' in manifest.dependencies), 'the relay draws no QR codes; the client does');
  });

  test('nothing is left in server/web that the relay does not serve', async () => {
    // The host console and the old admin page were deleted rather than merely
    // unrouted. A page that still builds and no longer works is one somebody
    // opens from a bookmark in front of a room.
    const pages = await readdir(join(ROOT, 'server', 'web'));
    assert.deepEqual(pages.sort(), ['console', 'keys', 'lib', 'player', 'status']);
  });

  test('every file under server/ is one the relay actually loads', async () => {
    // The other direction, and the one that catches the opposite mistake. The
    // walk above proves nothing forbidden is reachable; this proves nothing
    // unreachable is lying around. `room.ts` sat here for two commits after
    // the show moved out — reachable from nothing, deleted by nobody, and
    // still the first file anyone would read to find out what the relay does.
    const reachable = new Set(await reachableFrom('server/index.ts'));
    for (const page of ['player', 'status', 'keys']) {
      for (const file of await reachableFrom(`server/web/${page}/main.ts`)) reachable.add(file);
    }

    const onDisk: string[] = [];
    const sweep = async (dir: string): Promise<void> => {
      for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
        if (entry.isDirectory()) await sweep(`${dir}/${entry.name}`);
        else if (entry.name.endsWith('.ts')) onDisk.push(`${dir}/${entry.name}`);
      }
    };
    await sweep('server');

    const orphans = onDisk.filter((file) => !reachable.has(file));
    assert.deepEqual(orphans, [], `nothing loads these: ${orphans.join(', ')}`);
  });
});

describe('the image the relay ships in', () => {
  // The block above proves the relay's own dependency list has no parser in
  // it; these prove the build does not put one back. That is a separate
  // failure, and the mechanism is not the one anybody would guess -- see the
  // second test. A file nothing imports is still a file somebody can read,
  // and the Dockerfile's claim is about the container rather than about the
  // call graph.
  //
  // What they cannot prove is that `docker build` produced what the lines
  // say. That was checked against a real container: 62 packages, no `yaml`,
  // no `qrcode`, one file under `shared/`, and the whole key lifecycle run
  // through it. These are what stop the lines drifting away from it after.

  /**
   * A build file's lines, minus every comment.
   *
   * Dropping the comments is what lets these assertions be written as "the
   * word does not appear", when the files deliberately explain in prose why
   * `RELAY_KEY` and the scenario mount are absent.
   *
   * Carriage returns go too. These three files are checked out with whatever
   * endings the machine's git prefers, and an assertion that passes on one
   * developer's clone and fails on another's is worse than no assertion.
   */
  async function lines(name: string): Promise<string[]> {
    const text = await readFile(join(ROOT, name), 'utf8');
    return text.split('\n').map((line) => line.replace('\r', ''));
  }

  async function withoutComments(name: string): Promise<string> {
    return (await lines(name)).filter((line) => !line.trimStart().startsWith('#')).join('\n');
  }

  test('only the workspace with no parser in it is described to npm', async () => {
    // Subtle and worth a test, because the mechanism is not the flag anybody
    // would reach for first. `--workspace server` does not keep `yaml` out on
    // its own: with `shared/package.json` present npm hoists it and leaves it
    // *extraneous*, where `npm prune` will not remove it either. What works is
    // not copying the manifest, because npm skips a workspace whose folder
    // holds none.
    const dockerfile = await withoutComments('Dockerfile');
    assert.ok(
      !dockerfile.includes('shared/package.json'),
      'copying shared/package.json puts yaml back in the image',
    );
    assert.ok(
      !dockerfile.includes('client/package.json'),
      'copying client/package.json puts qrcode back in the image',
    );
  });

  test('one folder of shared travels, and it is the protocol', async () => {
    const dockerfile = await withoutComments('Dockerfile');
    for (const line of dockerfile.split('\n')) {
      if (!line.startsWith('COPY ')) continue;
      const source = line.split(/\s+/)[1] ?? '';
      if (!source.startsWith('shared')) continue;
      assert.equal(source, 'shared/relay', `${line.trim()} would ship the engine or the loader`);
    }
  });

  test('no scenario reaches the container by any of the three routes', async () => {
    // It used to arrive twice: copied at build time and mounted at run time,
    // the mount so a scenario could be edited without a rebuild. There is
    // nothing left in here to reload it into.
    const dockerfile = await withoutComments('Dockerfile');
    const compose = await withoutComments('docker-compose.yml');
    const ignored = await lines('.dockerignore');

    assert.ok(!dockerfile.includes('scenarios'), 'the image copies a scenario in');
    assert.ok(!compose.includes('scenarios'), 'compose mounts a scenario in');
    assert.ok(
      ignored.includes('scenarios'),
      'the build context still offers scenarios to a COPY somebody adds later',
    );
  });

  test('the database is the only thing mounted', async () => {
    const compose = await withoutComments('docker-compose.yml');
    const mounts = compose
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- ') && line.includes(':/'));
    assert.deepEqual(mounts, ['- scenario-data:/data']);
  });

  test('nothing hands the relay a key through its environment', async () => {
    // A secret in compose is one phrase shared by everyone who has ever been
    // told it: it cannot be withdrawn from one person, and changing it locks
    // out every client at once. Keys are rows in the database, issued and
    // revoked one at a time. The comment in compose says so; this is what
    // stops somebody helpfully acting on the name it mentions.
    const compose = await withoutComments('docker-compose.yml');
    const dockerfile = await withoutComments('Dockerfile');
    assert.ok(!compose.includes('RELAY_KEY'), 'compose sets a relay key');
    assert.ok(!dockerfile.includes('RELAY_KEY'), 'the image bakes in a relay key');
  });
});

describe('the key phrase', () => {
  test('the word list is exactly the size the arithmetic assumes', async () => {
    const { WORDS, PHRASE_WORDS, generatePhrase } = await import('../server/keys.ts');
    // 256 so `randomInt` is unbiased. A list that drifted to 255 would still
    // work and would quietly stop being uniform, which is the kind of weakness
    // nothing ever reports.
    assert.equal(WORDS.length, 256);
    assert.equal(new Set(WORDS).size, 256, 'a repeated word is entropy nobody counted');
    assert.equal(generatePhrase().split('-').length, PHRASE_WORDS);
  });

  test('two phrases are not the same phrase', async () => {
    const { generatePhrase } = await import('../server/keys.ts');
    const phrases = new Set(Array.from({ length: 50 }, () => generatePhrase()));
    assert.equal(phrases.size, 50);
  });

  test('guessing is rate limited, which is the other half of forty bits', async () => {
    const { KeyAttempts } = await import('../server/keys.ts');
    const attempts = new KeyAttempts(3, 60_000);
    assert.equal(attempts.blocked('1.2.3.4'), false);
    for (let i = 0; i < 3; i++) attempts.fail('1.2.3.4');
    assert.equal(attempts.blocked('1.2.3.4'), true);
    // Only that address. A venue where six operators open rooms from behind
    // one NAT is an ordinary evening, but a stranger is not everybody.
    assert.equal(attempts.blocked('5.6.7.8'), false);
    // And a key that works clears the record, so one typo costs nothing later.
    attempts.succeed('1.2.3.4');
    assert.equal(attempts.blocked('1.2.3.4'), false);
  });
});

describe('a room can be asked for by name', () => {
  test('a minted code is still a legal name, which is what lets one field carry both', () => {
    // The wire has one room field, widened rather than made a union. That is
    // only safe while every code the relay mints is also a legal name — check
    // it rather than assume it, because the minted alphabet and the name
    // pattern are two constants that could drift apart in one commit.
    for (let i = 0; i < 50; i++) {
      const code = generateRoomCode();
      assert.equal(RoomCodeSchema.safeParse(code).success, true);
      assert.equal(RoomNameSchema.safeParse(code).success, true);
    }
  });

  test('what the operator types is tidied rather than refused', () => {
    assert.equal(normalizeRoomName('Arctic Sentinel'), 'ARCTIC-SENTINEL');
    assert.equal(normalizeRoomName('  team_union  '), 'TEAM-UNION');
    assert.equal(normalizeRoomName('a--b'), 'A-B');
    assert.equal(normalizeRoomName('-edges-'), 'EDGES');
    // Length is the one thing it will not fix by guessing: shortening a name
    // somebody chose opens a room under a code they have never seen.
    assert.equal(normalizeRoomName('ab'), undefined);
    assert.equal(normalizeRoomName('x'.repeat(25)), undefined);
    assert.equal(normalizeRoomName('!!!'), undefined);
  });

  test('it opens under the name, and the join link carries it', async () => {
    const key = await issueKey('naming laptop');
    const { client, opened } = await openRoom(key, { name: 'HARBOUR-ONE' });

    assert.equal(opened.room, 'HARBOUR-ONE');
    assert.match(opened.joinUrl, /\/join\/HARBOUR-ONE$/);

    client.send({ type: 'closeRoom' });
    client.close();
  });

  test('a phone joins a named room exactly as it joins a code', async () => {
    const key = await issueKey('naming laptop 2');
    const { client, opened } = await openRoom(key, { name: 'HARBOUR-TWO' });
    client.send(A_POLL);

    const phone = await joinAs(opened.room, 'device-named-1');
    phone.send({ type: 'vote', optionKey: 'left' });

    const tally = await client.next<RelayTally>((m) => m.type === 'tally' && m.voters === 1);
    assert.equal(tally.counts.left, 1);

    phone.close();
    client.send({ type: 'closeRoom' });
    client.close();
  });

  test('a live room is not handed to a different key', async () => {
    // A name is public — it is written on a wall and read out to a room — so
    // the only thing standing between two operators who both like ARCTIC is
    // this. Without it the second one is handed the first one's audience.
    const mine = await issueKey('mine');
    const theirs = await issueKey('theirs');
    const { client } = await openRoom(mine, { name: 'CONTESTED' });

    const intruder = await connect();
    intruder.send({ type: 'openRoom', protocol: RELAY_PROTOCOL, key: theirs, name: 'CONTESTED' });
    const error = await intruder.next<any>((m) => m.type === 'error');
    assert.equal(error.code, 'nameTaken');
    assert.match(error.message, /CONTESTED/);
    intruder.close();

    client.send({ type: 'closeRoom' });
    client.close();
  });

  test('the key that opened it walks back in, with the open vote intact', async () => {
    // The whole reason a name is worth having. The operator's machine died
    // mid-vote: the room token went with the process, so `resumeRoom` has
    // nothing to prove itself with, and a fresh `openRoom` would mint a new
    // code while forty people hold the old one. The key is what is left, and
    // the key is what opened this room.
    const key = await issueKey('the laptop that crashed');
    const { client, opened } = await openRoom(key, { name: 'CRASH-TEST' });
    client.send(A_POLL);

    const phone = await joinAs(opened.room, 'device-crash-1');
    phone.send({ type: 'vote', optionKey: 'right' });
    await client.next<RelayTally>((m) => m.type === 'tally' && m.voters === 1);

    // Not `close()`: a crash does not say goodbye.
    client.socket.terminate();

    const revived = await connect();
    revived.send({ type: 'openRoom', protocol: RELAY_PROTOCOL, key, name: 'CRASH-TEST' });
    const resumed = await revived.next<any>((m) => m.type === 'roomResumed');

    assert.equal(resumed.room, 'CRASH-TEST');
    assert.equal(resumed.token, opened.token, 'the room is the same room, not a new one');
    assert.equal(resumed.open?.nodeId, 'choose');
    assert.deepEqual(
      resumed.open?.votes.map((v: { deviceId: string; optionKey: string }) => [
        v.deviceId,
        v.optionKey,
      ]),
      [['device-crash-1', 'right']],
      'the ballot cast before the crash is still there',
    );

    // And the phone never noticed: it is still on the same room, holding its
    // own choice, which is the part you cannot ask forty people to do again.
    assert.equal(resumed.players, 1);

    phone.close();
    revived.send({ type: 'closeRoom' });
    revived.close();
  });

  test('a name is free again once the show that used it is over', async () => {
    // A named room is meant to be opened again next week. `rooms.code` is a
    // primary key, so without `forgetRoom` the second show under a name fails
    // on a constraint violation nobody can read.
    const key = await issueKey('next week');
    const first = await openRoom(key, { name: 'WEEKLY' });
    first.client.send({ type: 'closeRoom' });
    first.client.close();
    await new Promise((r) => setTimeout(r, 50));

    const second = await openRoom(key, { name: 'WEEKLY' });
    assert.equal(second.opened.room, 'WEEKLY');
    assert.notEqual(second.opened.token, first.opened.token, 'a new show, so a new token');

    second.client.send({ type: 'closeRoom' });
    second.client.close();
  });

  test('a name the schema will not have never reaches the relay as one', async () => {
    // The relay validates rather than trusts: the client normalises before it
    // asks, and a frame that arrived with a bad name anyway is a bad frame.
    const key = await issueKey('bad names');
    const client = await connect();
    client.send({ type: 'openRoom', protocol: RELAY_PROTOCOL, key, name: 'lower case' });
    const error = await client.next<any>((m) => m.type === 'error');
    assert.equal(error.code, 'badMessage');
    client.close();
  });
});

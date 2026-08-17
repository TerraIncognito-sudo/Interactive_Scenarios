/**
 * Surviving a server restart mid-show.
 *
 * The plan lists "server process restarts" as a failure the system must absorb
 * rather than a scenario to hope against, so it gets a test rather than a
 * paragraph. A room is driven into an open poll, votes are cast, the process
 * is torn down, and a fresh server is built against the same data directory.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { buildServer } from '../src/server/index.ts';
import type { Config } from '../src/server/config.ts';
import type { PlayerState, Snapshot } from '../src/shared/protocol.ts';

let dataDir: string;
const fixtures = join(import.meta.dirname, 'fixtures', 'scenarios');

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
    scenariosDir: fixtures,
    clientDir: join(dataDir, 'no-client'),
    publicUrl: 'http://test.local',
    local: false,
    roomTtlMs: 60_000,
  };
}

type Started = {
  app: Awaited<ReturnType<typeof buildServer>>;
  baseUrl: string;
  wsUrl: string;
};

async function startServer(): Promise<Started> {
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

type Client = {
  socket: WebSocket;
  next<T>(match: (m: any) => boolean, timeoutMs?: number): Promise<T>;
  send(message: unknown): void;
  close(): void;
};

function connect(wsUrl: string): Promise<Client> {
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
                      .map((m) => `${m.type}${m.type === 'snapshot' ? `(${m.phase}/${m.beatInfo?.kind}/v${m.tally?.voters ?? '-'})` : m.type === 'error' ? `(${m.code}: ${m.message})` : ''}`)
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

const isSnapshot = (m: any): m is Snapshot => m?.type === 'snapshot';
const isPlayerState = (m: any): m is PlayerState => m?.type === 'playerState';

describe('surviving a server restart', () => {
  test('a room mid-poll resumes with its votes intact', async () => {
    // --- First process: get into a poll and collect votes -------------------
    const first = await startServer();

    const created = await fetch(`${first.baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenarioId: 'slowpoll' }),
    });
    assert.equal(created.status, 200);
    const room = (await created.json()) as {
      code: string;
      hostToken: string;
      displayToken: string;
    };
    assert.match(room.code, /^[A-Z0-9]{6}$/);

    const host = await connect(first.wsUrl);
    host.send({ type: 'hello', role: 'host', room: room.code, token: room.hostToken });
    await host.next(isSnapshot);
    host.send({ type: 'command', command: { name: 'start' } });
    await host.next<Snapshot>((m) => isSnapshot(m) && m.beatInfo?.kind === 'poll');

    for (const device of ['device-r-001', 'device-r-002', 'device-r-003']) {
      const player = await connect(first.wsUrl);
      player.send({ type: 'hello', role: 'player', room: room.code, deviceId: device });
      await player.next(isPlayerState);
      player.send({ type: 'vote', optionKey: device === 'device-r-003' ? 'right' : 'left' });
      await player.next<PlayerState>((m) => isPlayerState(m) && m.choice !== undefined);
      player.close();
    }

    const beforeRestart = await host.next<Snapshot>(
      (m) => isSnapshot(m) && (m.tally?.voters ?? 0) === 3,
    );
    assert.deepEqual(beforeRestart.tally?.counts, { left: 2, right: 1 });

    host.close();
    await first.app.close();

    // --- Second process: same data directory, nothing else carried over -----
    const second = await startServer();

    const revived = await connect(second.wsUrl);
    revived.send({ type: 'hello', role: 'host', room: room.code, token: room.hostToken });
    const restored = await revived.next<Snapshot>(isSnapshot);

    assert.equal(restored.beatInfo.kind, 'poll', 'the room should still be mid-poll');
    assert.equal(
      restored.beatInfo.kind === 'poll' && restored.beatInfo.nodeId,
      'vote',
      'it should resume on the same node',
    );
    assert.deepEqual(
      restored.tally?.counts,
      { left: 2, right: 1 },
      'votes cast before the restart must still count',
    );

    // A late voter joining after the restart is counted alongside the old ones.
    const late = await connect(second.wsUrl);
    late.send({ type: 'hello', role: 'player', room: room.code, deviceId: 'device-r-late' });
    await late.next(isPlayerState);
    late.send({ type: 'vote', optionKey: 'right' });

    const withLate = await revived.next<Snapshot>(
      (m) => isSnapshot(m) && (m.tally?.voters ?? 0) === 4,
    );
    assert.deepEqual(withLate.tally?.counts, { left: 2, right: 2 });

    // And the restored poll still decides the story correctly.
    revived.send({ type: 'command', command: { name: 'forceBranch', optionKey: 'left' } });
    const finished = await revived.next<Snapshot>((m) => isSnapshot(m) && m.phase === 'finished');
    assert.equal(finished.beatInfo.kind === 'end' && finished.beatInfo.text, 'Went left.');

    late.close();
    revived.close();
    await second.app.close();
  });

  test('the host token still works after a restart', async () => {
    const first = await startServer();
    const created = await fetch(`${first.baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenarioId: 'slowpoll' }),
    });
    const room = (await created.json()) as { code: string; hostToken: string };

    const host = await connect(first.wsUrl);
    host.send({ type: 'hello', role: 'host', room: room.code, token: room.hostToken });
    await host.next(isSnapshot);
    host.send({ type: 'command', command: { name: 'start' } });
    await host.next<Snapshot>((m) => isSnapshot(m) && m.phase === 'running');
    host.close();
    await first.app.close();

    const second = await startServer();

    // The old token is honoured...
    const good = await connect(second.wsUrl);
    good.send({ type: 'hello', role: 'host', room: room.code, token: room.hostToken });
    const snapshot = await good.next<Snapshot>(isSnapshot);
    assert.equal(snapshot.room, room.code);
    good.close();

    // ...and a wrong one still is not.
    const bad = await connect(second.wsUrl);
    bad.send({ type: 'hello', role: 'host', room: room.code, token: 'nope' });
    const error = await bad.next<any>((m) => m.type === 'error');
    assert.equal(error.code, 'badToken');
    bad.close();

    await second.app.close();
  });
});

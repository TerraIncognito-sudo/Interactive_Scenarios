/**
 * The room registry: minting codes, looking them up, resuming, and expiry.
 */

import { RelayRoom, type OpenPoll } from './relay.ts';
import { generateRoomCode, generateRoomToken, type RecordedVote } from '../shared/relay/protocol.ts';
import type { Store } from './db.ts';

export class RelayRegistry {
  private readonly rooms = new Map<string, RelayRoom>();
  private readonly store: Store;
  private readonly ttlMs: number;
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(store: Store, ttlMs: number) {
    this.store = store;
    this.ttlMs = ttlMs;
  }

  create(options: { keyId: string | null; title?: string }): RelayRoom {
    const now = Date.now();

    // Collisions are vanishingly unlikely, but a duplicate code would hand a
    // stranger someone else's room, so retry rather than assume. Checked
    // against the database as well as the live map: a room that fell out of
    // memory on a restart is still a code somebody has written on a wall.
    let code = generateRoomCode();
    for (let attempt = 0; attempt < 10; attempt++) {
      if (!this.rooms.has(code) && !this.store.getRoom(code)) break;
      code = generateRoomCode();
    }

    const room = new RelayRoom({
      code,
      token: generateRoomToken(),
      ...(options.title !== undefined ? { title: options.title } : {}),
      keyId: options.keyId,
      store: this.store,
      now,
    });

    this.store.createRoom({
      code,
      token: room.token,
      title: options.title ?? null,
      key_id: options.keyId,
      created_at: now,
      updated_at: now,
    });

    this.rooms.set(code, room);
    return room;
  }

  get(code: string): RelayRoom | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  /**
   * A client coming back to its own room.
   *
   * Proved by the room token and deliberately not by the key that opened it:
   * a key may have been revoked while the client was away, and a revocation
   * that stranded the show it was holding would leave forty phones on a dead
   * code with no way to finish. Revoking refuses the *next* room.
   */
  resume(code: string, token: string): RelayRoom | undefined {
    const room = this.get(code);
    if (!room || room.closed) return undefined;
    return timingSafeEqual(token, room.token) ? room : undefined;
  }

  list(): RelayRoom[] {
    return [...this.rooms.values()];
  }

  /**
   * Ends one room and drops it from the registry, the way the sweeper does for
   * an idle one. Distinct from `shutdownAll`: this one really is over, so it
   * must not come back on the next restart.
   *
   * It is also the deliberate way to stop a show whose key has been revoked,
   * and the escape for a room that a crashed client left holding a code.
   */
  closeRoom(code: string): boolean {
    const room = this.get(code);
    if (!room) return false;
    room.close();
    this.rooms.delete(room.code);
    return true;
  }

  /**
   * Rebuilds rooms from disk after a restart, so a live show survives one.
   *
   * Phones reconnect through `Connection`'s backoff, get a `playerState` for
   * the same poll, and their own recorded choice comes back highlighted. The
   * client reconnects and resumes with its token. Nothing in the room needs to
   * be told a restart happened.
   */
  restore(): number {
    const since = Date.now() - this.ttlMs;
    let restored = 0;

    for (const row of this.store.liveRooms(since)) {
      if (this.rooms.has(row.code)) continue;

      let poll: OpenPoll | undefined;
      let votes: RecordedVote[] | undefined;
      if (row.current_node) {
        const saved = this.store.pollFor(row.code, row.current_node);
        if (saved) {
          let options: { key: string; label: string }[];
          try {
            options = JSON.parse(saved.options_json) as { key: string; label: string }[];
          } catch {
            options = [];
          }
          // A poll with no options is one nobody can answer, so it is dropped
          // rather than restored — the client will republish on resume.
          if (options.length >= 2) {
            poll = {
              nodeId: saved.node_id,
              question: saved.question,
              ...(saved.prompt !== null ? { prompt: saved.prompt } : {}),
              options,
              endsAt: saved.ends_at,
              closed: saved.closed === 1,
            };
            votes = this.store.votesFor(row.code, row.current_node).map((vote) => ({
              deviceId: vote.device_id,
              optionKey: vote.option_key,
              at: vote.at,
            }));
          }
        }
      }

      const room = new RelayRoom({
        code: row.code,
        token: row.token,
        ...(row.title !== null ? { title: row.title } : {}),
        keyId: row.key_id,
        store: this.store,
        now: row.created_at,
        ...(poll ? { poll } : {}),
        ...(votes ? { votes } : {}),
      });
      room.lastActivityAt = row.updated_at;

      this.rooms.set(row.code, room);
      restored++;
    }

    return restored;
  }

  startSweeper(intervalMs = 60_000): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), intervalMs);
    this.sweeper.unref?.();
  }

  stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  /** Closes rooms idle beyond the TTL so abandoned ones do not accumulate. */
  sweep(now = Date.now()): number {
    let closed = 0;
    for (const [code, room] of this.rooms) {
      if (now - room.lastActivityAt > this.ttlMs) {
        room.close('This room was idle for too long and has closed.');
        this.rooms.delete(code);
        closed++;
      }
    }
    return closed;
  }

  /**
   * Releases rooms because the process is stopping. They stay open in the
   * database so the next process picks a live show back up.
   */
  shutdownAll(): void {
    for (const room of this.rooms.values()) room.shutdown();
    this.rooms.clear();
  }
}

/** Constant-time-ish comparison, so token checks do not leak length or prefix. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

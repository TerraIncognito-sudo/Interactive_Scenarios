/**
 * The room registry: creation, lookup, token checks, and expiry.
 */

import { Room, generateRoomCode, generateToken } from './room.ts';
import type { LoadedScenario } from '../scenario/load.ts';
import type { Store } from './db.ts';
import type { Role } from '../shared/protocol.ts';
import { initialState, type RunState } from '../engine/engine.ts';

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly store: Store;
  private readonly ttlMs: number;
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(store: Store, ttlMs: number) {
    this.store = store;
    this.ttlMs = ttlMs;
  }

  create(loaded: LoadedScenario): Room {
    const now = Date.now();

    // Collisions are vanishingly unlikely, but a duplicate code would hand a
    // stranger someone else's session, so retry rather than assume.
    let code = generateRoomCode();
    for (let attempt = 0; this.rooms.has(code) && attempt < 10; attempt++) {
      code = generateRoomCode();
    }

    const room = new Room({
      code,
      hostToken: generateToken(),
      displayToken: generateToken(),
      loaded,
      store: this.store,
      now,
    });

    this.store.createRoom({
      code,
      scenario_id: loaded.scenario.id,
      host_token: room.hostToken,
      display_token: room.displayToken,
      state_json: JSON.stringify(room.state),
      created_at: now,
      updated_at: now,
    });

    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  /**
   * Authorises a connection. Host and display need their token; the room code
   * alone only ever grants the ability to vote.
   */
  authorize(room: Room, role: Role, token: string | undefined): boolean {
    switch (role) {
      case 'host':
        return token !== undefined && timingSafeEqual(token, room.hostToken);
      case 'display':
        return token !== undefined && timingSafeEqual(token, room.displayToken);
      case 'player':
        return true;
    }
  }

  /** Any valid token for the room, used to gate full-scenario downloads. */
  hasAnyToken(room: Room, token: string | undefined): boolean {
    if (token === undefined) return false;
    return timingSafeEqual(token, room.hostToken) || timingSafeEqual(token, room.displayToken);
  }

  list(): Room[] {
    return [...this.rooms.values()];
  }

  /** Rebuilds rooms from disk after a restart so a live show survives it. */
  restore(scenarios: Map<string, LoadedScenario>): number {
    const since = Date.now() - this.ttlMs;
    let restored = 0;

    for (const row of this.store.liveRooms(since)) {
      if (this.rooms.has(row.code)) continue;
      const loaded = scenarios.get(row.scenario_id);
      if (!loaded) continue;

      let state: RunState;
      try {
        state = JSON.parse(row.state_json) as RunState;
      } catch {
        state = initialState(loaded.scenario);
      }

      const room = new Room({
        code: row.code,
        hostToken: row.host_token,
        displayToken: row.display_token,
        loaded,
        store: this.store,
        now: row.created_at,
        state,
      });
      room.lastActivityAt = row.updated_at;

      this.rooms.set(row.code, room);
      room.resumeClock();
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

  /** Closes rooms idle beyond the TTL so abandoned sessions do not accumulate. */
  sweep(now = Date.now()): number {
    let closed = 0;
    for (const [code, room] of this.rooms) {
      if (now - room.lastActivityAt > this.ttlMs) {
        room.close();
        this.rooms.delete(code);
        closed++;
      }
    }
    return closed;
  }

  closeAll(): void {
    for (const room of this.rooms.values()) room.close();
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

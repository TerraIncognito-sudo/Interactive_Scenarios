/**
 * Persistence.
 *
 * SQLite via Node's built-in driver: one file, no native build step, and it
 * behaves identically on a container host and on a laptop in fallback mode.
 * That last property is a hard requirement of this project, so the storage
 * layer must never grow a cloud-specific dependency.
 *
 * Everything the database holds is either operational (rooms, so a restart
 * does not end a live show) or analytical (votes, so you can compare how
 * different audiences chose). No personal data is stored: a device id is an
 * opaque random string generated in the browser.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export type RoomRow = {
  code: string;
  scenario_id: string;
  host_token: string;
  display_token: string;
  state_json: string;
  created_at: number;
  updated_at: number;
  closed: number;
};

export type VoteRow = {
  room: string;
  node_id: string;
  device_id: string;
  option_key: string;
  at: number;
};

export class Store {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'scenario.db'));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        code          TEXT PRIMARY KEY,
        scenario_id   TEXT NOT NULL,
        host_token    TEXT NOT NULL,
        display_token TEXT NOT NULL,
        state_json    TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        closed        INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS votes (
        room        TEXT NOT NULL,
        node_id     TEXT NOT NULL,
        device_id   TEXT NOT NULL,
        option_key  TEXT NOT NULL,
        at          INTEGER NOT NULL,
        PRIMARY KEY (room, node_id, device_id)
      );

      CREATE TABLE IF NOT EXISTS poll_results (
        room         TEXT NOT NULL,
        node_id      TEXT NOT NULL,
        winner       TEXT NOT NULL,
        counts_json  TEXT NOT NULL,
        total        INTEGER NOT NULL,
        used_default INTEGER NOT NULL,
        at           INTEGER NOT NULL,
        PRIMARY KEY (room, node_id, at)
      );

      CREATE TABLE IF NOT EXISTS events (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        room     TEXT NOT NULL,
        at       INTEGER NOT NULL,
        kind     TEXT NOT NULL,
        payload  TEXT
      );

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_room ON events (room, id);
      CREATE INDEX IF NOT EXISTS idx_votes_room ON votes (room, node_id);
    `);
  }

  /**
   * A stable secret for signing admin cookies. Persisted so an operator does
   * not get logged out every time the container restarts.
   */
  secret(): string {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'secret'`).get() as
      | { value: string }
      | undefined;
    if (row) return row.value;

    const value = randomBytes(32).toString('base64url');
    this.db.prepare(`INSERT INTO settings (key, value) VALUES ('secret', ?)`).run(value);
    return value;
  }

  createRoom(row: Omit<RoomRow, 'closed'>): void {
    this.db
      .prepare(
        `INSERT INTO rooms
           (code, scenario_id, host_token, display_token, state_json, created_at, updated_at, closed)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        row.code,
        row.scenario_id,
        row.host_token,
        row.display_token,
        row.state_json,
        row.created_at,
        row.updated_at,
      );
  }

  /** Called on every state transition, so a restart resumes mid-show. */
  saveState(code: string, stateJson: string, now: number): void {
    this.db
      .prepare(`UPDATE rooms SET state_json = ?, updated_at = ? WHERE code = ?`)
      .run(stateJson, now, code);
  }

  closeRoom(code: string, now: number): void {
    this.db.prepare(`UPDATE rooms SET closed = 1, updated_at = ? WHERE code = ?`).run(now, code);
  }

  getRoom(code: string): RoomRow | undefined {
    return this.db.prepare(`SELECT * FROM rooms WHERE code = ?`).get(code) as RoomRow | undefined;
  }

  /** Open rooms touched since `since`, used to rebuild state after a restart. */
  liveRooms(since: number): RoomRow[] {
    return this.db
      .prepare(`SELECT * FROM rooms WHERE closed = 0 AND updated_at >= ? ORDER BY updated_at`)
      .all(since) as RoomRow[];
  }

  /** Upsert, because a voter may change their mind until the poll closes. */
  recordVote(vote: VoteRow): void {
    this.db
      .prepare(
        `INSERT INTO votes (room, node_id, device_id, option_key, at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (room, node_id, device_id)
         DO UPDATE SET option_key = excluded.option_key, at = excluded.at`,
      )
      .run(vote.room, vote.node_id, vote.device_id, vote.option_key, vote.at);
  }

  recordPollResult(
    room: string,
    nodeId: string,
    winner: string,
    counts: Record<string, number>,
    total: number,
    usedDefault: boolean,
    at: number,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO poll_results
           (room, node_id, winner, counts_json, total, used_default, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(room, nodeId, winner, JSON.stringify(counts), total, usedDefault ? 1 : 0, at);
  }

  /** Votes already cast for a poll, so reopening after a restart is lossless. */
  votesFor(room: string, nodeId: string): VoteRow[] {
    return this.db
      .prepare(`SELECT * FROM votes WHERE room = ? AND node_id = ?`)
      .all(room, nodeId) as VoteRow[];
  }

  /** Removes one device's vote. Only ever a simulated one — see `RoomStore`. */
  forgetVote(room: string, nodeId: string, deviceId: string): void {
    this.db
      .prepare(`DELETE FROM votes WHERE room = ? AND node_id = ? AND device_id = ?`)
      .run(room, nodeId, deviceId);
  }

  appendEvent(room: string, kind: string, payload: unknown, at: number): void {
    this.db
      .prepare(`INSERT INTO events (room, at, kind, payload) VALUES (?, ?, ?, ?)`)
      .run(room, at, kind, payload === undefined ? null : JSON.stringify(payload));
  }

  close(): void {
    this.db.close();
  }
}

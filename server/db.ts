/**
 * Persistence, for a box that carries votes.
 *
 * SQLite via Node's built-in driver: one file, no native build step, and it
 * behaves identically in a container and on a laptop running the relay off
 * `docker compose up` on venue wifi. That last property is a hard requirement,
 * so the storage layer must never grow a cloud-specific dependency.
 *
 * Three things are worth keeping across a restart and nothing else is. The
 * **rooms**, because a container restart must not end a live show. The
 * **votes**, because forty phones are the part you cannot ask to do it again —
 * they are what a client replays when its link comes back. And the **keys**,
 * because a key that vanished on redeploy would be configuration wearing a
 * database's clothes. Losing this volume locks out every client until new keys
 * are issued, which is the price of them being revocable one at a time.
 *
 * No personal data is stored: a device id is an opaque random string generated
 * in the browser and never leaves the vote row.
 *
 * The room token is here in the clear, and that is fine for the same reason
 * the key phrases are: it buys the ability to publish a poll to some phones
 * and nothing else, because no command travels back toward a client.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { KeyRow } from './keys.ts';

export type RoomRow = {
  code: string;
  token: string;
  title: string | null;
  key_id: string | null;
  /** The poll phones are voting in right now, or null between questions. */
  current_node: string | null;
  created_at: number;
  updated_at: number;
  closed: number;
};

export type PollRow = {
  room: string;
  node_id: string;
  question: string;
  prompt: string | null;
  options_json: string;
  ends_at: number;
  closed: number;
  at: number;
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
    this.dropShowEra();
    this.migrate();
  }

  /**
   * Clears out the tables of the server this relay replaced.
   *
   * The old `rooms` carried a `scenario_id`, a `state_json` and two tokens for
   * roles that no longer exist, and `CREATE TABLE IF NOT EXISTS` would leave
   * every one of them in place and then fail on the first insert — a container
   * that came up healthy and refused to open a room, with the reason four
   * layers down in a constraint error.
   *
   * Dropping rather than migrating, because there is nothing to migrate to: a
   * room from the old world is a story mid-flight, and a relay cannot resume
   * one. It has no scenario and no engine, which is the whole point of it.
   */
  private dropShowEra(): void {
    const columns = this.db.prepare(`PRAGMA table_info(rooms)`).all() as { name: string }[];
    if (!columns.some((column) => column.name === 'scenario_id')) return;
    this.db.exec(`
      DROP TABLE IF EXISTS rooms;
      DROP TABLE IF EXISTS votes;
      DROP TABLE IF EXISTS poll_results;
      DROP TABLE IF EXISTS events;
    `);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        code         TEXT PRIMARY KEY,
        token        TEXT NOT NULL,
        title        TEXT,
        key_id       TEXT,
        current_node TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        closed       INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS polls (
        room         TEXT NOT NULL,
        node_id      TEXT NOT NULL,
        question     TEXT NOT NULL,
        prompt       TEXT,
        options_json TEXT NOT NULL,
        ends_at      INTEGER NOT NULL,
        closed       INTEGER NOT NULL DEFAULT 0,
        at           INTEGER NOT NULL,
        PRIMARY KEY (room, node_id)
      );

      CREATE TABLE IF NOT EXISTS votes (
        room        TEXT NOT NULL,
        node_id     TEXT NOT NULL,
        device_id   TEXT NOT NULL,
        option_key  TEXT NOT NULL,
        at          INTEGER NOT NULL,
        PRIMARY KEY (room, node_id, device_id)
      );

      CREATE TABLE IF NOT EXISTS keys (
        id           TEXT PRIMARY KEY,
        label        TEXT NOT NULL,
        phrase       TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at   INTEGER
      );

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

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

  // -------------------------------------------------------------------- rooms

  createRoom(row: Omit<RoomRow, 'closed' | 'current_node'>): void {
    this.db
      .prepare(
        `INSERT INTO rooms (code, token, title, key_id, current_node, created_at, updated_at, closed)
         VALUES (?, ?, ?, ?, NULL, ?, ?, 0)`,
      )
      .run(row.code, row.token, row.title, row.key_id, row.created_at, row.updated_at);
  }

  touchRoom(code: string, now: number): void {
    this.db.prepare(`UPDATE rooms SET updated_at = ? WHERE code = ?`).run(now, code);
  }

  /** Which poll phones are voting in, or null between questions. */
  setCurrentPoll(code: string, nodeId: string | null, now: number): void {
    this.db
      .prepare(`UPDATE rooms SET current_node = ?, updated_at = ? WHERE code = ?`)
      .run(nodeId, now, code);
  }

  closeRoom(code: string, now: number): void {
    this.db.prepare(`UPDATE rooms SET closed = 1, updated_at = ? WHERE code = ?`).run(now, code);
  }

  getRoom(code: string): RoomRow | undefined {
    return this.db.prepare(`SELECT * FROM rooms WHERE code = ?`).get(code) as RoomRow | undefined;
  }

  /** Open rooms touched since `since`, used to rebuild them after a restart. */
  liveRooms(since: number): RoomRow[] {
    return this.db
      .prepare(`SELECT * FROM rooms WHERE closed = 0 AND updated_at >= ? ORDER BY updated_at`)
      .all(since) as RoomRow[];
  }

  // -------------------------------------------------------------------- polls

  savePoll(row: PollRow): void {
    this.db
      .prepare(
        `INSERT INTO polls (room, node_id, question, prompt, options_json, ends_at, closed, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (room, node_id) DO UPDATE SET
           question = excluded.question,
           prompt = excluded.prompt,
           options_json = excluded.options_json,
           ends_at = excluded.ends_at,
           closed = excluded.closed,
           at = excluded.at`,
      )
      .run(
        row.room,
        row.node_id,
        row.question,
        row.prompt,
        row.options_json,
        row.ends_at,
        row.closed,
        row.at,
      );
  }

  extendPoll(room: string, nodeId: string, endsAt: number): void {
    this.db
      .prepare(`UPDATE polls SET ends_at = ? WHERE room = ? AND node_id = ?`)
      .run(endsAt, room, nodeId);
  }

  markPollClosed(room: string, nodeId: string): void {
    this.db
      .prepare(`UPDATE polls SET closed = 1 WHERE room = ? AND node_id = ?`)
      .run(room, nodeId);
  }

  pollFor(room: string, nodeId: string): PollRow | undefined {
    return this.db.prepare(`SELECT * FROM polls WHERE room = ? AND node_id = ?`).get(room, nodeId) as
      | PollRow
      | undefined;
  }

  // -------------------------------------------------------------------- votes

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

  /** Every ballot for a poll, so a reconnecting client replays them exactly. */
  votesFor(room: string, nodeId: string): VoteRow[] {
    return this.db
      .prepare(`SELECT * FROM votes WHERE room = ? AND node_id = ? ORDER BY at`)
      .all(room, nodeId) as VoteRow[];
  }

  // --------------------------------------------------------------------- keys

  createKey(row: KeyRow): void {
    this.db
      .prepare(
        `INSERT INTO keys (id, label, phrase, created_at, last_used_at, revoked_at)
         VALUES (?, ?, ?, ?, NULL, NULL)`,
      )
      .run(row.id, row.label, row.phrase, row.created_at);
  }

  /** Every key, revoked ones included: one that vanished gets re-issued. */
  listKeys(): KeyRow[] {
    return this.db.prepare(`SELECT * FROM keys ORDER BY created_at DESC`).all() as KeyRow[];
  }

  /** The ones a client could actually present. See `matchKey`. */
  liveKeys(): KeyRow[] {
    return this.db
      .prepare(`SELECT * FROM keys WHERE revoked_at IS NULL ORDER BY created_at`)
      .all() as KeyRow[];
  }

  /**
   * Stamped on every successful `openRoom`.
   *
   * This is what makes revoking safe to do rather than merely possible: a key
   * nobody has used in four months can go without a phone call first.
   */
  touchKey(id: string, now: number): void {
    this.db.prepare(`UPDATE keys SET last_used_at = ? WHERE id = ?`).run(now, id);
  }

  revokeKey(id: string, now: number): boolean {
    const result = this.db
      .prepare(`UPDATE keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .run(now, id);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

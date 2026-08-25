/**
 * The wire protocol between the server and the three client surfaces.
 *
 * Every inbound message is Zod-validated before it reaches the engine. The
 * server is public, so client messages are untrusted input: a malformed or
 * hostile frame must be rejected at the boundary, never partway through a
 * state transition.
 */

import { z } from 'zod';

export const ROLES = ['host', 'display', 'player'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Room codes avoid characters that misread off a projector: no O/0, I/1, S/5.
 * At six characters this is ~24 bits, which is ample given the code alone only
 * grants the ability to vote.
 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXY2346789';
export const ROOM_CODE_LENGTH = 6;
export const RoomCodeSchema = z
  .string()
  .length(ROOM_CODE_LENGTH)
  .regex(new RegExp(`^[${ROOM_CODE_ALPHABET}]+$`), 'invalid room code');

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

/** Sent once on connect, before anything else is accepted. */
export const HelloSchema = z.object({
  type: z.literal('hello'),
  role: z.enum(ROLES),
  room: RoomCodeSchema,
  /** Required for host and display; ignored for players. */
  token: z.string().max(128).optional(),
  /** Opaque per-device id used only to dedupe votes. Players only. */
  deviceId: z.string().min(8).max(128).optional(),
  /** Beat the client already has, so the server can tell if it is behind. */
  beat: z.number().int().nonnegative().optional(),
});

export const CastVoteSchema = z.object({
  type: z.literal('vote'),
  optionKey: z.string().min(1).max(12),
});

/** Display reports that every asset for the scenario has loaded. */
export const DisplayReadySchema = z.object({
  type: z.literal('displayReady'),
});

export const HostCommandSchema = z.object({
  type: z.literal('command'),
  command: z.discriminatedUnion('name', [
    z.object({ name: z.literal('start') }),
    z.object({ name: z.literal('pause') }),
    z.object({ name: z.literal('resume') }),
    z.object({ name: z.literal('back') }),
    z.object({ name: z.literal('skip') }),
    z.object({ name: z.literal('closePoll') }),
    z.object({ name: z.literal('extendPoll'), seconds: z.number().int().min(5).max(600) }),
    z.object({ name: z.literal('forceBranch'), optionKey: z.string().min(1).max(12) }),
    z.object({ name: z.literal('jump'), nodeId: z.string().min(1).max(64) }),
    z.object({ name: z.literal('reset') }),
  ]),
});

export const PingSchema = z.object({ type: z.literal('ping') });

export const ClientMessageSchema = z.discriminatedUnion('type', [
  HelloSchema,
  CastVoteSchema,
  DisplayReadySchema,
  HostCommandSchema,
  PingSchema,
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type HostCommand = z.infer<typeof HostCommandSchema>['command'];

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

/**
 * Server messages are typed but not parsed at runtime by clients — the server
 * is the trusted end of this connection, and re-validating its own output on
 * every frame would cost more than it proves.
 */

export type PublicScenario = {
  id: string;
  title: string;
  description?: string;
};

export type SnapshotBeat =
  | { kind: 'idle' }
  | {
      kind: 'dialogue';
      nodeId: string;
      lineIndex: number;
      who?: string;
      speaker?: { name: string; color: string; sprite?: string };
      text: string;
      scene?: string;
      durationMs: number;
      voice?: string;
      sfx?: string;
    }
  | { kind: 'pause'; nodeId: string; text?: string; scene?: string; durationMs: number }
  | {
      kind: 'poll';
      nodeId: string;
      question: string;
      prompt?: string;
      options: { key: string; label: string }[];
      scene?: string;
      /** ms since epoch on the server clock; clients correct with `serverNow`. */
      endsAt: number;
    }
  | { kind: 'end'; nodeId: string; text?: string; scene?: string };

/**
 * The complete renderable state. Sent on connect and on every transition, so
 * a client that reloads mid-show resyncs from one message.
 */
export type Snapshot = {
  type: 'snapshot';
  room: string;
  phase: 'lobby' | 'running' | 'paused' | 'finished';
  /** Monotonic. A higher beat from the server always wins over local playback. */
  beat: number;
  scenario: PublicScenario;
  beatInfo: SnapshotBeat;
  /** Resolved scene media for the active scene, if any. */
  scene?: {
    id: string;
    background?: string;
    video?: string;
    music?: string;
    ambience?: string;
  };
  /** Live tally while a poll is open. */
  tally?: { counts: Record<string, number>; voters: number };
  /** Revealed once a poll closes, for the display's result animation. */
  lastResult?: {
    nodeId: string;
    winner: string;
    winnerLabel: string;
    counts: Record<string, number>;
    total: number;
    usedDefault: boolean;
    usedTiebreak: boolean;
  };
  /** Server wall clock at send time, so clients can correct for drift. */
  serverNow: number;
  /** Connected counts, shown on the host console. */
  presence: { displays: number; players: number };
  /** Whether the display has finished prefetching assets. */
  displayReady: boolean;
};

/** Sent to a player so their phone can restore its own selection. */
export type PlayerState = {
  type: 'playerState';
  /** Undefined when no poll is open. */
  poll?: {
    nodeId: string;
    question: string;
    prompt?: string;
    options: { key: string; label: string }[];
    endsAt: number;
  };
  /** What this device currently has selected. */
  choice?: string;
  serverNow: number;
};

export type ServerError = {
  type: 'error';
  code: 'badRoom' | 'badToken' | 'badMessage' | 'rateLimited' | 'roomClosed' | 'internal';
  message: string;
  /** True when the connection is about to close. */
  fatal: boolean;
};

export type Pong = { type: 'pong'; serverNow: number };

export type ServerMessage = Snapshot | PlayerState | ServerError | Pong;

// ---------------------------------------------------------------------------
// REST payloads
// ---------------------------------------------------------------------------

export const CreateRoomSchema = z.object({
  scenarioId: z.string().min(1).max(64),
});

export type CreateRoomResponse = {
  code: string;
  hostToken: string;
  displayToken: string;
  /** Ready-to-use links, already carrying tokens where needed. */
  urls: { host: string; display: string; join: string };
};

export type ScenarioListResponse = {
  scenarios: (PublicScenario & { nodes: number; polls: number })[];
  /** Folders that failed to load, surfaced rather than hidden. */
  failures: { dir: string; message: string; problems: string[] }[];
};

/**
 * One running session, as the admin page sees it.
 *
 * This carries the host and display tokens, which is the whole point: a host
 * link lost to a closed tab or a flat phone currently strands a live show, and
 * the tokens exist nowhere else. It is why the endpoint is admin-only.
 */
export type LiveSession = {
  code: string;
  scenario: { id: string; title: string };
  phase: 'lobby' | 'running' | 'paused' | 'finished';
  /** Where the story currently stands, for recognising a session at a glance. */
  nodeId: string;
  beat: number;
  displayReady: boolean;
  presence: { displays: number; players: number };
  /** Voting deadline in ms since epoch, when a poll is open. */
  pollEndsAt?: number;
  createdAt: number;
  lastActivityAt: number;
  urls: { host: string; display: string; join: string };
};

export type SessionListResponse = {
  sessions: LiveSession[];
  serverNow: number;
};

/** Safe JSON parse + validate for an inbound frame. */
export function parseClientMessage(raw: string): ClientMessage | undefined {
  if (raw.length > 8192) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = ClientMessageSchema.safeParse(json);
  return result.success ? result.data : undefined;
}

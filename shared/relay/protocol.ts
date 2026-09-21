/**
 * The wire between an operator's machine and the box that carries the votes.
 *
 * The relay holds a room code, the phones attached to it, at most one open
 * poll and the ballots. It holds no scenario, no beat and no state machine,
 * and **it decides nothing**: a winner depends on the poll's `default:`, its
 * tie-break mode and `resolvePoll`, all of which are the client's. What comes
 * back here is counts.
 *
 * Two roles share one socket. A `client` is the operator's own process, one
 * per room, connecting outbound — which is what lets the show run from behind
 * a domestic router with nothing forwarded. A `player` is a phone, and the
 * room code alone is its whole authorisation, because the code only ever
 * grants the ability to vote.
 *
 * **Nothing travelling toward a client is a command, and nothing from a phone
 * is anything but a vote.** That absence is the security property this file
 * exists to state: the relay faces the internet and the client does not, so a
 * compromised relay must not be able to drive somebody's presentation.
 * `ShowCommandSchema` and `DISPLAY_COMMANDS` live in `shared/show/protocol.ts`
 * and must never appear here.
 *
 * Unlike the show protocol, **relay output is parsed at the client end**. The
 * two halves deploy separately and will be different versions of themselves
 * sooner or later; a tally that half-parses is a bar chart that lies in front
 * of a room.
 */

import { z } from 'zod';
import { randomBytes } from 'node:crypto';

/**
 * Bumped when a frame changes shape in a way an older peer cannot read.
 *
 * Checked on `openRoom` rather than on every message, because that is the one
 * moment there is somebody to tell: a client refused at the handshake can say
 * "update the relay", where a client that fails on the ninth frame of a show
 * fails in front of an audience.
 */
export const RELAY_PROTOCOL = 1;

// ---------------------------------------------------------------------------
// The room code
// ---------------------------------------------------------------------------

/**
 * Room codes avoid characters that misread off a projector: no O/0, I/1, S/5,
 * no Z. At six characters this is ~29 bits, which is ample given the code
 * alone only grants the ability to vote.
 *
 * It lives here rather than with the show protocol because the relay is what
 * mints one and a phone is what types it in — and the two ends disagreeing
 * about which characters are legal is a room of people entering a code that
 * cannot exist.
 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXY2346789';
export const ROOM_CODE_LENGTH = 6;
export const RoomCodeSchema = z
  .string()
  .length(ROOM_CODE_LENGTH)
  .regex(new RegExp(`^[${ROOM_CODE_ALPHABET}]+$`), 'invalid room code');

export function generateRoomCode(): string {
  const bytes = randomBytes(ROOM_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[bytes[i]! % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

/**
 * A code the operator chose, instead of one the relay minted.
 *
 * Wider than `ROOM_CODE_ALPHABET` on purpose. That alphabet drops O/0, I/1,
 * S/5 and Z because nobody proofreads six random characters — but a name is
 * chosen and read back by the person who picked it, and a rule that outlawed
 * SEPTEMBER would be a rule nobody uses twice.
 *
 * Capitals because the minted codes are, and because `RelayRegistry.get`
 * upper-cases before it looks anything up: two cases of one name would be two
 * rooms on the phone side and one in the database.
 *
 * It is also what makes a crash survivable. A show that loses its client
 * leaves a code nobody can ask for again, because a code is minted and never
 * chosen; a *named* room is re-entered by the key that opened it, with its
 * open question and every ballot still in place. See `server/ws.ts`.
 */
export const ROOM_NAME_MIN = 3;
export const ROOM_NAME_MAX = 24;
export const RoomNameSchema = z
  .string()
  .min(ROOM_NAME_MIN)
  .max(ROOM_NAME_MAX)
  .regex(/^[A-Z0-9][A-Z0-9-]*[A-Z0-9]$/, 'capitals, digits and hyphens');

/**
 * A room as it travels on the wire: either sort of code.
 *
 * Every minted code satisfies the name pattern, so this *is* the name pattern
 * — exported under its own name because the two are different promises.
 * `RoomCodeSchema` is what `generateRoomCode` guarantees about what it makes;
 * this is what a phone may be holding.
 */
export const RoomIdSchema = RoomNameSchema;

/**
 * What the operator typed, as a room name, or undefined if it cannot be one.
 *
 * Forgiving at the edges, because the box it comes from is filled in while a
 * projector is warming up: `Arctic Sentinel` becomes `ARCTIC-SENTINEL` rather
 * than an error message about capital letters. Length is the one thing it will
 * not fix by guessing, because shortening a name somebody chose would open a
 * room under a code they have never seen.
 *
 * Shared rather than written twice. The client normalises before it asks and
 * the relay validates what arrived, and two spellings of that rule is a room
 * whose name is not the one on the operator's screen.
 */
export function normalizeRoomName(raw: string): string | undefined {
  const value = raw
    .trim()
    .toUpperCase()
    .replace(/[\s_.]+/g, '-')
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return RoomNameSchema.safeParse(value).success ? value : undefined;
}

/** A room's own secret, proved on resume. See `ResumeRoomSchema`. */
export function generateRoomToken(): string {
  return randomBytes(32).toString('base64url');
}

// ---------------------------------------------------------------------------
// Client -> relay
// ---------------------------------------------------------------------------

/**
 * Opens a room. The first frame a client sends, and the only authenticated one.
 *
 * `key` is a passphrase the relay issued and can revoke — see `server/keys.ts`
 * for why it is data rather than an environment variable. `title` is for the
 * status page, so somebody looking at four live rooms can tell which is which;
 * it is a label, and nothing reads it as a scenario.
 */
export const OpenRoomSchema = z.object({
  type: z.literal('openRoom'),
  protocol: z.number().int().min(1).max(1000),
  key: z.string().min(1).max(200),
  title: z.string().max(120).optional(),
  /**
   * The code to open under, instead of a minted one.
   *
   * Absent is the ordinary case and mints six characters. Present, it does two
   * jobs: it puts something readable on the wall, and it is the only way back
   * into a show whose client died — a name already held by a live room that
   * **this key** opened is handed back rather than refused, ballots intact.
   *
   * An older relay parses this frame with the field stripped and mints a code
   * as it always did, so the client compares what came back against what it
   * asked for. Refusing to carry a name and pretending to are different
   * things, and only one of them is safe to leave unsaid.
   */
  name: RoomNameSchema.optional(),
});

/**
 * Comes back to a room already open, after the client's socket dropped.
 *
 * Authenticated by the **room token**, deliberately not by the key. A key can
 * be revoked while a client is away, and a revocation that also stranded the
 * show it was holding would leave forty phones on a dead code with no way to
 * finish. Revoking refuses the next room; ending a running one is a decision
 * somebody makes on the status page while looking at it.
 */
export const ResumeRoomSchema = z.object({
  type: z.literal('resumeRoom'),
  protocol: z.number().int().min(1).max(1000),
  room: RoomIdSchema,
  token: z.string().min(1).max(200),
});

/** An option as a phone renders it. The relay never reads `label`. */
export const PollOptionSchema = z.object({
  key: z.string().min(1).max(12),
  label: z.string().min(1).max(200),
});

/**
 * Publishes a question to the phones.
 *
 * `endsAt` is the client's clock, passed through untouched and sent on to the
 * phones, so every countdown in the room is driven by the machine that owns
 * the beat. The relay does not close a poll when it expires — the client does,
 * because the reveal that follows is a beat the client is clocking.
 */
export const PublishPollSchema = z.object({
  type: z.literal('poll'),
  nodeId: z.string().min(1).max(64),
  question: z.string().min(1).max(500),
  prompt: z.string().max(1000).optional(),
  options: z.array(PollOptionSchema).min(2).max(9),
  endsAt: z.number().int().nonnegative(),
});

export const ExtendPollSchema = z.object({
  type: z.literal('extendPoll'),
  nodeId: z.string().min(1).max(64),
  endsAt: z.number().int().nonnegative(),
});

/** Voting is over. The ballots stay, so a client resuming can still read them. */
export const ClosePollSchema = z.object({
  type: z.literal('closePoll'),
  nodeId: z.string().min(1).max(64),
});

/** No poll at all — the show has moved on. Phones go back to waiting. */
export const ClearSchema = z.object({ type: z.literal('clear') });

/** Ends the room for good. It will not come back after a relay restart. */
export const CloseRoomSchema = z.object({ type: z.literal('closeRoom') });

export const RelayPingSchema = z.object({ type: z.literal('ping') });

// ---------------------------------------------------------------------------
// Phone -> relay
// ---------------------------------------------------------------------------

/**
 * A phone arriving.
 *
 * Byte-identical to the frame the player page has always sent, on purpose:
 * the page moved under the relay with one import changed, and a protocol
 * tidy-up here would have been a rewrite of the one surface in this system
 * that is held by forty strangers at once.
 */
export const PlayerHelloSchema = z.object({
  type: z.literal('hello'),
  role: z.literal('player'),
  room: RoomIdSchema,
  /** Opaque per-device id used only to dedupe votes. No personal data. */
  deviceId: z.string().min(8).max(128),
});

export const PlayerVoteSchema = z.object({
  type: z.literal('vote'),
  optionKey: z.string().min(1).max(12),
});

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

/**
 * Everything the relay will accept from anybody.
 *
 * One union rather than one per role, because the role is not established
 * until the first frame: a client announces itself by opening a room and a
 * phone by saying hello. Which frames a connection may send *after* that is
 * the transport's decision, and `ws.ts` makes it — validate the shape,
 * authorise the role, then act, never the other way round.
 */
export const RelayInboundSchema = z.discriminatedUnion('type', [
  OpenRoomSchema,
  ResumeRoomSchema,
  PublishPollSchema,
  ExtendPollSchema,
  ClosePollSchema,
  ClearSchema,
  CloseRoomSchema,
  RelayPingSchema,
  PlayerHelloSchema,
  PlayerVoteSchema,
]);

export type RelayInbound = z.infer<typeof RelayInboundSchema>;

/** Safe JSON parse + validate for an inbound frame. */
export function parseRelayInbound(raw: string): RelayInbound | undefined {
  if (raw.length > 8192) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = RelayInboundSchema.safeParse(json);
  return result.success ? result.data : undefined;
}

// ---------------------------------------------------------------------------
// Relay -> client
// ---------------------------------------------------------------------------

/** One recorded ballot, as a resuming client replays it into a fresh box. */
export const RecordedVoteSchema = z.object({
  deviceId: z.string().min(1).max(128),
  optionKey: z.string().min(1).max(12),
  at: z.number().int().nonnegative(),
});

export const RoomOpenedSchema = z.object({
  type: z.literal('roomOpened'),
  room: RoomIdSchema,
  token: z.string().min(1).max(200),
  /**
   * The whole address a phone opens, built by the relay from the request that
   * reached it. The client cannot compute this — it is on the operator's own
   * machine, and a join URL assembled there would put a loopback address on a
   * wall and ask forty people to type it in.
   */
  joinUrl: z.string().min(1).max(500),
  players: z.number().int().nonnegative(),
  serverNow: z.number().int().nonnegative(),
});

export const RoomResumedSchema = z.object({
  type: z.literal('roomResumed'),
  room: RoomIdSchema,
  token: z.string().min(1).max(200),
  joinUrl: z.string().min(1).max(500),
  players: z.number().int().nonnegative(),
  serverNow: z.number().int().nonnegative(),
  /**
   * The poll that was open when the link died, with every ballot cast since.
   *
   * This is the reason the relay has a database. The client's clock never
   * moved — it was never there — so resuming is replaying these into a fresh
   * `BallotBox` and carrying on. Forty phones are the part you cannot ask to
   * do it again.
   */
  open: z
    .object({
      nodeId: z.string().min(1).max(64),
      endsAt: z.number().int().nonnegative(),
      closed: z.boolean(),
      votes: z.array(RecordedVoteSchema).max(10_000),
    })
    .optional(),
});

/** Counts, never a winner. See this file's header. */
export const TallySchema = z.object({
  type: z.literal('tally'),
  nodeId: z.string().min(1).max(64),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  voters: z.number().int().nonnegative(),
  serverNow: z.number().int().nonnegative(),
});

export const PresenceSchema = z.object({
  type: z.literal('presence'),
  players: z.number().int().nonnegative(),
  serverNow: z.number().int().nonnegative(),
});

/**
 * `badKey` is its own code because it is the only one with a cure the operator
 * can act on, and because it is what a revoked key feels like from this end.
 * A client that reported "unauthorised" would send somebody off to check their
 * typing for the rest of the evening.
 */
export const RELAY_ERROR_CODES = [
  'badKey',
  'badProtocol',
  'badRoom',
  'badToken',
  'badMessage',
  /**
   * The requested name belongs to a live room somebody else's key opened.
   *
   * Its own code because the cure is the operator's and is nothing like any
   * other failure's: pick another name, or find out who is using that one.
   * Emphatically not `badRoom`, which means *the relay has lost the room we
   * were in* and sends a client off to open a replacement — here there is a
   * room and it is not ours to take.
   */
  'nameTaken',
  'rateLimited',
  'roomClosed',
  'internal',
] as const;

export const RelayErrorSchema = z.object({
  type: z.literal('error'),
  code: z.enum(RELAY_ERROR_CODES),
  message: z.string().max(500),
  fatal: z.boolean(),
});

export const RelayPongSchema = z.object({
  type: z.literal('pong'),
  serverNow: z.number().int().nonnegative(),
});

export const RelayToClientSchema = z.discriminatedUnion('type', [
  RoomOpenedSchema,
  RoomResumedSchema,
  TallySchema,
  PresenceSchema,
  RelayErrorSchema,
  RelayPongSchema,
]);

export type RelayToClient = z.infer<typeof RelayToClientSchema>;
export type RoomOpened = z.infer<typeof RoomOpenedSchema>;
export type RoomResumed = z.infer<typeof RoomResumedSchema>;
export type RelayTally = z.infer<typeof TallySchema>;
export type RelayError = z.infer<typeof RelayErrorSchema>;
export type RecordedVote = z.infer<typeof RecordedVoteSchema>;
export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number];

/** Validate what the relay said. See this file's header for why this exists. */
export function parseRelayMessage(raw: string): RelayToClient | undefined {
  if (raw.length > 1_000_000) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = RelayToClientSchema.safeParse(json);
  return result.success ? result.data : undefined;
}

// ---------------------------------------------------------------------------
// The console
// ---------------------------------------------------------------------------

/**
 * One live room, as the status page sees it.
 *
 * **There is no room token here.** The list this replaces carried host and
 * display tokens, and said why: a host link lost to a closed tab stranded a
 * live show and the tokens existed nowhere else. There is no host link any
 * more — a client holds its own token and resumes with it — so the field goes,
 * and with it this page's ability to hand a reader full control of every
 * running show. The absence is the design; do not add it back for convenience.
 */
export type RelayRoomView = {
  code: string;
  /** What the client called it, for telling four live rooms apart. */
  title?: string;
  players: number;
  /** False while a client is away — its room keeps taking votes regardless. */
  clientConnected: boolean;
  keyId?: string;
  keyLabel?: string;
  poll?: { nodeId: string; endsAt: number; closed: boolean };
  createdAt: number;
  lastActivityAt: number;
  joinUrl: string;
};

export type RelayStatusResponse = {
  rooms: RelayRoomView[];
  serverNow: number;
};

/** A key as the console lists it. `phrase` is in the clear — see `server/keys.ts`. */
export type RelayKeyView = {
  id: string;
  label: string;
  phrase: string;
  createdAt: number;
  /** Stamped on every successful `openRoom`, so revoking can be done knowingly. */
  lastUsedAt?: number;
  /** A revoked key stays listed, greyed: one that vanishes gets re-issued. */
  revokedAt?: number;
  openRooms: number;
};

export type RelayKeysResponse = { keys: RelayKeyView[] };

export type RelayHealth = {
  ok: boolean;
  rooms: number;
  /** False on a fresh relay, which is what explains one that refuses everything. */
  keyed: boolean;
  uptime: number;
};

// ---------------------------------------------------------------------------
// Relay -> phone
// ---------------------------------------------------------------------------

/**
 * Everything a phone is ever told.
 *
 * One question, its options, and what this device chose — and nothing else.
 * A phone never receives the story: a snapshot carries upcoming dialogue, the
 * scene and any pending result, and sending it would leak the ending to forty
 * people holding it in their hands. That was the show server's rule, guarded
 * by a test; here it is structural, because the relay has no story to leak.
 */
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

export type RelayToPhone = PlayerState | RelayError | z.infer<typeof RelayPongSchema>;

/**
 * What a phone may send: hello, a vote, and a keepalive.
 *
 * Three frames, and that is the whole of it. Worth reading as a list rather
 * than as a union, because it is the answer to what a stranger holding a room
 * code can do to somebody's show.
 */
export type PhoneMessage =
  | z.infer<typeof PlayerHelloSchema>
  | z.infer<typeof PlayerVoteSchema>
  | z.infer<typeof RelayPingSchema>;

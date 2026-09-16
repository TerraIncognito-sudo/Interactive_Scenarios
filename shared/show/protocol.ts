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
  /**
   * Which room to join. Optional, because the client's own loopback socket has
   * exactly one room and no code for it until somebody links to a relay — and
   * a surface that had to invent a code to connect to a show running on the
   * same machine would be inventing it for nobody.
   *
   * A socket that faces an audience still requires one, and refuses the
   * connection when it is absent; that check is the public server's, not this
   * schema's, because the two sockets have different answers.
   */
  room: RoomCodeSchema.optional(),
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
  /**
   * How many never arrived, and out of how many.
   *
   * A missing decoration must never stop a show, so the display goes ready
   * regardless — but "ready" over eleven assets that 404'd is the same lie as
   * "ready" halfway through the download. This is the operator's one chance to
   * hear about it before the black background is on the wall.
   */
  failed: z.number().int().nonnegative().max(100_000).optional(),
  total: z.number().int().nonnegative().max(100_000).optional(),
});

/**
 * Display reports how far it has got fetching artwork.
 *
 * A show is a few hundred megabytes and a projector on venue wifi takes a
 * minute or two over it. For that minute the host console said "loading…" and
 * nothing else — no number, nothing moving — which is indistinguishable from
 * broken. The only cure is to say what is happening, so the display says it.
 *
 * Bytes are optional because they are only known where the server could stat
 * the file; the count is always real.
 */
export const DisplayProgressSchema = z.object({
  type: z.literal('displayProgress'),
  done: z.number().int().nonnegative().max(100_000),
  total: z.number().int().nonnegative().max(100_000),
  /** Assets that errored or ran out of time. The show can still open. */
  failed: z.number().int().nonnegative().max(100_000),
  bytes: z.number().nonnegative().optional(),
  totalBytes: z.number().nonnegative().optional(),
});

/**
 * The projector says whether sound is allowed yet.
 *
 * Its own message rather than a field on `displayReady`, because the two are
 * about unrelated things that happen at unrelated times: readiness is the
 * download finishing, and this is a person having touched the window. Folding
 * one into the other would mean re-announcing a completed download in order to
 * report a click.
 *
 * This exists because merging the two programs created a failure that could
 * not happen before. Autoplay needs a gesture in the *window that plays the
 * sound*, and Start used to be pressed on a host console — a different device
 * — so the projector's own audio gate covered it. Start is now a button in the
 * board window, the stage may never have been clicked, and the first voice
 * line is silent with nothing anywhere saying why.
 */
export const DisplayAudioSchema = z.object({
  type: z.literal('displayAudio'),
  unlocked: z.boolean(),
});

/**
 * The most simulated voters one option can hold.
 *
 * A full room is forty phones; anything past a couple of hundred is a stress
 * test of the tally rather than a rehearsal of the show, and this command's
 * job is the show. It is a shared constant because the Room sweeps the whole
 * range on every press to take withdrawn voters back out — so a cap the two
 * ends disagreed about would leave simulated ballots nobody could clear.
 */
export const MAX_SIMULATED_VOTERS = 200;

export const HostCommandSchema = z.object({
  type: z.literal('command'),
  command: z.discriminatedUnion('name', [
    z.object({ name: z.literal('start') }),
    z.object({ name: z.literal('pause') }),
    z.object({ name: z.literal('resume') }),
    z.object({ name: z.literal('back') }),
    z.object({ name: z.literal('skip') }),
    /**
     * Releases a gate. Separate from `skip` even though the engine event is
     * the same one, because the two mean opposite things to the person
     * pressing them: `skip` cuts a beat short, and this is the beat arriving
     * on time. A moderator who has to press "Skip" to begin their own
     * presentation has been handed the wrong button.
     */
    z.object({ name: z.literal('continue') }),
    z.object({ name: z.literal('closePoll') }),
    z.object({ name: z.literal('extendPoll'), seconds: z.number().int().min(5).max(600) }),
    z.object({ name: z.literal('forceBranch'), optionKey: z.string().min(1).max(12) }),
    z.object({ name: z.literal('jump'), nodeId: z.string().min(1).max(64) }),
    z.object({ name: z.literal('reset') }),
    /**
     * Votes nobody cast, for rehearsing a poll at a desk.
     *
     * The difference between this and `forceBranch` is the whole reason both
     * exist. Force hands `closePoll` a decided result, so it never runs
     * `resolvePoll` and never draws a truthful bar chart — it is the override
     * for the night a vote goes wrong. This puts ballots in the box and lets
     * the poll close on its own clock, which is the only one of the two that
     * proves a poll's `default:`, its tie-break and the reveal beat work
     * before an audience is the thing testing them.
     *
     * **`count` is a target, not an increment**: it says how many simulated
     * voters have chosen this option, and pressing it again with a smaller
     * number takes some away. Zero is allowed and means nobody — which is how
     * a rehearsal gets back to an empty poll to watch its `default:` fire.
     *
     * The alternative was one pool of simulated voters shared across the
     * options, so that re-casting moved a voter rather than adding one. That
     * dedupes for free, and it is wrong at the only moment anybody uses this:
     * asking for five Left and two Right hands back three and two, because the
     * two Rights were taken out of the five Lefts. A control whose total is
     * less than the numbers typed into it is a control people stop trusting.
     * So each option owns its own voters and the counts are independent.
     *
     * Refused outright while a relay is linked. Otherwise the rehearsal
     * control stuffs a live ballot, and that will happen exactly once: in
     * front of a room, five minutes after somebody goes live having simulated
     * all afternoon.
     */
    z.object({
      name: z.literal('castVotes'),
      optionKey: z.string().min(1).max(12),
      count: z.number().int().min(0).max(MAX_SIMULATED_VOTERS),
    }),
  ]),
});

export const PingSchema = z.object({ type: z.literal('ping') });

export const ClientMessageSchema = z.discriminatedUnion('type', [
  HelloSchema,
  CastVoteSchema,
  DisplayReadySchema,
  DisplayProgressSchema,
  DisplayAudioSchema,
  HostCommandSchema,
  PingSchema,
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type HostCommand = z.infer<typeof HostCommandSchema>['command'];

/**
 * The commands a display may send on its own authority.
 *
 * The projector is a control surface as well as a renderer, because the person
 * standing in front of the room may have no console to reach: one laptop, one
 * screen, the show already on it. Its keyboard is the whole of that surface,
 * so this list is exactly the keys it has and nothing else.
 *
 * What is deliberately absent is what a stray keystroke must never be able to
 * do in front of an audience. `reset` puts the show back to the beginning, and
 * on the console it sits behind a confirm dialog that a key press has no
 * equivalent of. `jump` needs a node id, which the projector has no way to
 * offer and no way to check. Both stay with the host, whose link is handed to
 * a person rather than left open on a lectern all evening.
 */
export const DISPLAY_COMMANDS = [
  'start',
  'pause',
  'resume',
  'back',
  'skip',
  'continue',
  'forceBranch',
] as const;

/** Whether the projector may send this itself. See `DISPLAY_COMMANDS`. */
export function isDisplayCommand(command: HostCommand): boolean {
  return (DISPLAY_COMMANDS as readonly string[]).includes(command.name);
}

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
  | { kind: 'pause'; nodeId: string; text?: string; scene?: string; sfx?: string; durationMs: number }
  /**
   * No `durationMs`, because nothing is counting. The host console keys its
   * continue button off this kind, so the absence is what the moderator sees.
   */
  | { kind: 'gate'; nodeId: string; text?: string; label?: string; scene?: string; sfx?: string }
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
  | {
      /**
       * A poll's result, held on screen before the story continues.
       *
       * A beat with a duration rather than a client-side animation, because
       * the server is the clock: while this was a `setTimeout` in the display,
       * the next line's hold was already running behind the bar chart.
       */
      kind: 'result';
      nodeId: string;
      pollId: string;
      winner: string;
      winnerLabel: string;
      counts: Record<string, number>;
      total: number;
      usedDefault: boolean;
      usedTiebreak: boolean;
      scene?: string;
      durationMs: number;
    }
  | { kind: 'end'; nodeId: string; text?: string; scene?: string };

/**
 * The complete renderable state. Sent on connect and on every transition, so
 * a client that reloads mid-show resyncs from one message.
 */
export type Snapshot = {
  type: 'snapshot';
  /**
   * The code phones join at, once there is one.
   *
   * Absent is the ordinary state now, not a failure: a show runs start to
   * finish on the operator's machine with no relay behind it, and the lobby
   * has to say so deliberately rather than showing a blank where a code goes.
   */
  room?: string;
  /**
   * The full address a phone opens, when there is one.
   *
   * Sent rather than assembled by the projector, because the projector is on
   * the operator's machine and the room is on a relay somewhere else — a stage
   * that built this out of its own `location.origin` would put a loopback
   * address on a wall and ask forty people to type it in.
   */
  joinUrl?: string;
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
  /**
   * Whether the projector window is allowed to make a sound yet.
   *
   * False until somebody has touched that window, and a show started in that
   * state reads every line in silence. The board keeps Start behind this and
   * says which window needs the click — see `DisplayAudioSchema` for the
   * failure it exists for.
   */
  audioUnlocked: boolean;
  /**
   * How far it has got, while it has not. Absent once it is ready, and absent
   * before the first report — which is itself worth showing as "connected,
   * nothing said yet" rather than as a stalled zero.
   */
  displayLoading?: DisplayLoading;
  /** Assets the display could not fetch, out of how many. Absent when none. */
  displayMissing?: { failed: number; total: number };
};

export type DisplayLoading = {
  done: number;
  total: number;
  failed: number;
  bytes?: number;
  totalBytes?: number;
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
  /** How far its prefetch has got, while it has one. See `DisplayLoading`. */
  displayLoading?: DisplayLoading;
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

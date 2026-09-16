/**
 * The stage: a window dragged onto the projector.
 *
 * Two things make this more than a dumb renderer:
 *
 * 1. It prefetches every asset before reporting ready, so the show cannot open
 *    on a black screen while a background downloads.
 * 2. It holds the whole scenario and runs the same pure engine the clock does.
 *    While the socket is up the clock drives every transition; if the socket
 *    drops, the stage keeps playing locally instead of freezing, and snaps
 *    back the moment it reconnects.
 *
 * That second half used to be insurance against venue wifi. It still is, but
 * it now earns its keep every night: the clock is a Node process on this same
 * machine, and the *stage* is the tab a compositor is entitled to throttle.
 * This window spends a whole show occluded behind the board window on another
 * display, where Chrome clamps timers to a second and may suspend them — so
 * keeping the authoritative clock outside the browser is what stops a beat
 * held for 4.2 seconds lasting however long the compositor felt like.
 *
 * There is no token on this window's URL and there is no room code in it. Both
 * existed because the server was public and this page was one of three
 * surfaces a stranger could have guessed at. It is now a window opened by the
 * process it talks to, over loopback, and there is exactly one show running:
 * a token here would have proved only that the holder could reach a port on
 * their own machine.
 */

import QRCode from 'qrcode';
import { Connection } from '../lib/connection.ts';
import { pooled } from '../lib/pool.ts';
import { fetchAsset } from '../lib/fetch-asset.ts';
import type { DisplayLoading, HostCommand, Snapshot, SnapshotBeat } from '../../../shared/show/protocol.ts';
import { type Scenario } from '../../../shared/scenario/schema.ts';
import { beatOf, initialState, reduce, activeScene, type RunState } from '../../../shared/engine/engine.ts';

/**
 * The code phones join at, and the address they reach it on.
 *
 * Both arrive in the snapshot rather than in this window's URL, and both are
 * routinely absent — a show with no relay behind it has nothing to join. They
 * are `let` rather than `const` because linking to a relay happens *during* a
 * show: the operator presses Go Live while the lobby is already on the wall,
 * and the code has to appear there without anybody reloading the projector.
 */
let room: string | undefined;
let joinUrl: string | undefined;

const el = <T extends Element = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as unknown as T;
};

const views = {
  lobby: el('view-lobby'),
  dialogue: el('view-dialogue'),
  pause: el('view-pause'),
  poll: el('view-poll'),
  result: el('view-result'),
  end: el('view-end'),
};

const conn = el('conn');
const scene = el('scene');
const sceneVideo = el<HTMLVideoElement>('scene-video');
const audioGate = el<HTMLButtonElement>('audio-gate');
const cue = el('cue');
const keys = el('keys');

// ---------------------------------------------------------------------------
// Stage scaling — author at 1920x1080, fit whatever projector we are given.
// ---------------------------------------------------------------------------

const STAGE_WIDTH = 1920;
const STAGE_HEIGHT = 1080;

/**
 * Scales the stage to the window and centres what is left over.
 *
 * The letterboxing is arithmetic here rather than CSS centring on purpose —
 * see `.stage-wrap`, where the version that let the browser do it is written
 * down along with the way it failed on every screen under 1920 wide.
 */
function fitStage(): void {
  const stage = el('stage');
  const scale = Math.min(window.innerWidth / STAGE_WIDTH, window.innerHeight / STAGE_HEIGHT);
  const left = (window.innerWidth - STAGE_WIDTH * scale) / 2;
  const top = (window.innerHeight - STAGE_HEIGHT * scale) / 2;
  stage.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;
}
window.addEventListener('resize', fitStage);
fitStage();

// ---------------------------------------------------------------------------
// Local state
// ---------------------------------------------------------------------------

let scenario: Scenario | undefined;
let assetBase = '';
let assetsLoaded = false;
/** What never arrived, reported with readiness so the host hears about it. */
let assetsMissing = { failed: 0, total: 0 };
/**
 * How far the prefetch has got, while it is still going.
 *
 * Kept rather than derived so the same numbers reach the screen and the host
 * console — two counters over one download would eventually disagree, and the
 * one on the far end of a socket is the one nobody could check.
 */
let loading: DisplayLoading | undefined;
let local: RunState | undefined;
let localTimer: ReturnType<typeof setTimeout> | undefined;
let lastRenderedBeat = -1;
/**
 * Set while the last thing on screen came from local playback. The same-beat
 * guard in `onSnapshot` must not skip a resync just because the server's beat
 * number matches the last one we took from it — locally we may have drifted
 * several beats past it during the dropout.
 */
let renderedLocally = false;
/** The scene last painted, so a beat that names none keeps the current place. */
let lastSceneId: string | undefined;
/** What is on the projector right now, as a media key rather than a scene id. */
let paintedKey: string | undefined;
/** The scene the beds belong to, which is not the same as the shot painted. */
let bedScene: string | undefined;
/** The last snapshot, which is what the keyboard reads to know what a key means. */
let latest: Snapshot | undefined;
/**
 * The phase it was in when we last acted on one.
 *
 * Pausing does not move the beat number, so a pause arrives as a snapshot the
 * same-beat guard in `onSnapshot` is built to drop. Tracking the phase
 * separately is what lets that guard stay exactly as strict as it is.
 */
let lastPhase: Snapshot['phase'] | undefined;
/** Whether the pause stopped a clip mid-sentence, and so owes it a resume. */
let voiceHeld = false;
let typeTimer: ReturnType<typeof setInterval> | undefined;
let countdownTimer: ReturnType<typeof setInterval> | undefined;

function show(which: keyof typeof views): void {
  for (const [name, node] of Object.entries(views)) {
    node.hidden = name !== which;
  }
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/**
 * How many at once — and now a limit on downloads rather than on starts.
 *
 * Under the media elements this number bounded how many loads were *begun*: each
 * freed its slot at `canplaythrough` and kept streaming, so the real figure in
 * flight climbed with every asset and the pool throttled nothing. A `fetch` holds
 * its slot until the last byte, so six means six. About what a browser will open
 * to one host anyway.
 */
const PRELOAD_CONCURRENCY = 6;

/** Megabytes, at one decimal — the unit a person can hold in their head. */
function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** What the lobby says while it is fetching. */
function describeLoading(at: DisplayLoading): string {
  const size =
    at.totalBytes !== undefined && at.totalBytes > 0
      ? ` · ${mb(at.bytes ?? 0)} of ${mb(at.totalBytes)}`
      : '';
  const bad = at.failed > 0 ? ` · ${at.failed} unavailable` : '';
  return `Loading artwork… ${at.done} of ${at.total}${size}${bad}`;
}

/**
 * How often to tell the server. Often enough that the host console reads as
 * live, rarely enough that a two-hundred-file show is not two hundred
 * broadcasts to every connected phone.
 */
const PROGRESS_EVERY_MS = 500;
let progressSentAt = 0;

function reportProgress(force = false): void {
  if (!loading || assetsLoaded) return;
  const now = Date.now();
  if (!force && now - progressSentAt < PROGRESS_EVERY_MS) return;
  progressSentAt = now;
  connection.send({ type: 'displayProgress', ...loading });
}

async function loadScenario(): Promise<void> {
  const state = el('asset-state');

  // Said out loud because it is a real step with a real wait behind it: the
  // whole story, every branch, over the same link the artwork is about to come
  // down. Before this the screen sat blank and the console said "loading…"
  // with nothing to say how much of that was even reachable yet.
  state.textContent = 'Fetching the story…';

  const response = await fetch('/api/show/scenario').catch(() => undefined);
  if (!response) {
    state.textContent = 'Could not reach the show. Retrying when the connection returns.';
    return;
  }
  if (!response.ok) {
    state.textContent = `Could not load scenario (${response.status}).`;
    return;
  }

  const body = (await response.json()) as {
    scenario: Scenario;
    assets: string[];
    sizes?: Record<string, number>;
    assetBase: string;
  };
  scenario = body.scenario;
  assetBase = body.assetBase;
  local = initialState(body.scenario);

  const sizes = body.sizes ?? {};
  const total = body.assets.length;
  // Only over files the server could actually measure. A total that silently
  // counted the unmade ones as nothing would creep towards a number the
  // download can never reach.
  const totalBytes = body.assets.reduce((sum, file) => sum + (sizes[file] ?? 0), 0);

  loading = { done: 0, total, failed: 0, bytes: 0, ...(totalBytes > 0 ? { totalBytes } : {}) };
  if (total === 0) {
    state.textContent = 'Ready.';
    loading = undefined;
    assetsLoaded = true;
    announceReady();
    return;
  }

  state.textContent = describeLoading(loading);
  reportProgress(true);

  // What went wrong, kept per file so the screen can say more than a number. A
  // presenter who reads "2 unavailable" has to guess whether the venue's proxy
  // hiccuped or somebody renamed a clip, and those want opposite responses.
  const problems: { file: string; why: string }[] = [];

  await pooled(body.assets, PRELOAD_CONCURRENCY, async (file) => {
    // Real bytes as they stream, which the media elements could never report —
    // so the total now moves continuously and is measuring the download itself
    // rather than counting a file whole at the moment it finishes.
    const result = await fetchAsset(assetBase + file, (n) => {
      if (!loading) return;
      loading.bytes = Math.max(0, (loading.bytes ?? 0) + n);
      reportProgress();
    });
    if (!loading) return;
    loading.done += 1;
    if (!result.ok) {
      loading.failed += 1;
      problems.push({ file, why: result.why });
    }
    state.textContent = describeLoading(loading);
    reportProgress();
  });

  const failed = loading.failed;
  // Ready either way — a missing decoration must never stop a show — but never
  // silently. A bare "Ready." over eleven assets that are not there is how a
  // black background reaches a projector unannounced.
  // Naming the files is the difference between a number somebody can only worry
  // about and a fault they can act on before the room fills. Capped, because a
  // scenario whose whole asset folder is missing must not push the room code off
  // the screen — the join details are what the audience is reading.
  const named = problems
    .slice(0, 3)
    .map((p) => `${p.file} (${p.why})`)
    .join(', ');
  const rest = problems.length > 3 ? ` and ${problems.length - 3} more` : '';
  state.textContent =
    failed === 0
      ? 'Ready.'
      : `Ready — ${failed} of ${total} could not be fetched: ${named}${rest}. The show can still run.`;
  if (problems.length > 0) {
    // The screen is read from the back of a room and cannot hold sixty lines;
    // the console is where somebody debugging this actually looks.
    console.warn('[display] assets that never arrived:', problems);
  }
  assetsMissing = { failed, total };
  loading = undefined;
  assetsLoaded = true;
  // The other half of `paintLobby`'s two directions. Guarded on the lobby being
  // what is actually on screen: a scenario that finishes loading mid-show must
  // not repaint the shot the audience is looking at.
  if (!views.lobby.hidden) paintLobby();
  announceReady();
}

/**
 * Readiness has to be re-announced on every connect, not sent once. Assets
 * often finish loading before the socket opens (and always do when a scenario
 * has none), and a send on a closed socket is silently dropped — which would
 * leave the host staring at "loading…" forever.
 *
 * The same is true of progress, for the same reason: a projector that
 * reconnects halfway through its download would otherwise go back to being a
 * console entry with no number against it.
 */
function announceReady(): void {
  if (assetsLoaded && connection.isOpen) {
    connection.send({ type: 'displayReady', ...assetsMissing });
  } else if (loading && connection.isOpen) {
    reportProgress(true);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Paints the shot: the scene's still and clip, or the node's own where it
 * declares them.
 *
 * Keyed on the resolved media rather than the scene id, because two nodes in
 * one place are now two different pictures — comparing scene ids alone would
 * paint the first shot and then never repaint.
 */
function applyScene(sceneId: string | undefined, nodeId?: string): void {
  const definition = sceneId ? scenario?.scenes[sceneId] : undefined;
  const node = nodeId ? scenario?.nodes.find((n) => n.id === nodeId) : undefined;
  const background = node?.background ?? definition?.background;
  const video = node?.video ?? definition?.video;

  lastSceneId = sceneId;

  // The beds are keyed on the scene's own files rather than on the painted
  // key: `background` and `video` may be overridden per node, and a second
  // camera setup in one room must not restart the room's ambience. `Bed.play`
  // ignores a file it is already playing, so this is safe to call every beat.
  const changed = sceneId !== bedScene;
  bedScene = sceneId;
  ambience.play(definition?.ambience);
  music.play(definition?.music);
  // A crack should not follow the picture into another room.
  if (changed) stopSfx();

  const key = `${sceneId ?? ''}|${background ?? ''}|${video ?? ''}`;
  if (key === paintedKey) return;
  paintedKey = key;

  scene.style.backgroundImage = background ? `url("${assetBase}${background}")` : '';
  applySceneVideo(video);
}

/**
 * Paints whatever place the lobby sits in front of.
 *
 * The lobby is a place, so it goes through the same resolver as every other —
 * still, looping clip and pre-show bed from one scene id. Naming no scene paints
 * nothing, which is what every scenario written before `lobby:` asks for.
 *
 * Called from two directions on purpose. The `idle` beat arrives over the socket
 * and `loadScenario` is a separate async job, so whichever finishes second is
 * the one that can paint: an early snapshot finds `scenario` still undefined and
 * paints nothing, and if the room then simply sits there — which is exactly what
 * a lobby does — no further snapshot ever comes to correct it. That was a lobby
 * that stayed black on every projector that reached the room before the
 * download did, which is all of them.
 */
function paintLobby(): void {
  applyScene(scenario?.lobby);
}

/**
 * The clip is muted and looping, so autoplay policy never blocks it and it
 * needs no gesture. The still background stays painted underneath as the
 * poster frame.
 */
function applySceneVideo(file: string | undefined): void {
  if (!file) {
    sceneVideo.hidden = true;
    sceneVideo.pause();
    // Dropping the source releases the decoder; a projector left on a scene
    // for twenty minutes should not be decoding a clip nobody can see.
    sceneVideo.removeAttribute('src');
    sceneVideo.load();
    return;
  }

  const url = assetBase + file;
  if (sceneVideo.getAttribute('src') !== url) sceneVideo.src = url;
  sceneVideo.hidden = false;
  void sceneVideo.play().catch(() => {
    // A clip that will not start is a missing decoration, not a failure:
    // the background still holds the scene.
    sceneVideo.hidden = true;
  });
}

// ---------------------------------------------------------------------------
// Voice-over
// ---------------------------------------------------------------------------

const voiceEl = new Audio();
voiceEl.preload = 'auto';

/**
 * Plays the line's voice clip, cutting off whatever was speaking. Two voices
 * overlapping is worse than a clipped one — and a repeated snapshot for the
 * same beat used to restart the line, which with audio would stutter the
 * narration mid-sentence. `onSnapshot` guards that.
 */
function playVoice(file: string | undefined): void {
  voiceEl.pause();
  // A new line replaces whatever a pause was holding onto.
  voiceHeld = false;
  if (!file) {
    voiceEl.removeAttribute('src');
    return;
  }

  voiceEl.src = assetBase + file;
  voiceEl.currentTime = 0;
  void voiceEl
    .play()
    .then(() => {
      audioGate.hidden = true;
    })
    .catch(() => {
      // Autoplay policy, almost always. Ask for the one gesture that lifts it.
      audioGate.hidden = false;
    });
}

/**
 * Takes the browser's word that a person is here, and plays what was refused.
 *
 * Every element, not just the voice. One gesture lifts the policy for the
 * page, but a bed that was refused before it stays paused until something asks
 * it to play again — and nothing would.
 *
 * A keystroke counts as that gesture just as a click does, which matters:
 * a presenter driving from this keyboard has no reason to have a mouse in
 * reach, and the show running mute is the one failure they cannot hear coming.
 */
function unlockAudio(): void {
  audioGate.hidden = true;
  void voiceEl.play().catch(() => {
    // Still refused, or there is simply nothing loaded to play. Only the
    // former is worth a button, and an unstarted show is the latter.
    if (voiceEl.src) audioGate.hidden = false;
  });
  ambience.resume();
  music.resume();
}

audioGate.addEventListener('click', unlockAudio);

// ---------------------------------------------------------------------------
// Scene beds and one-shots
// ---------------------------------------------------------------------------

/**
 * The other three quarters of the sound.
 *
 * `music`, `ambience` and `sfx` have been in the schema, validated by the
 * checker and prefetched by this file since the beginning, and nothing ever
 * opened one. A scenario could declare a harbour bed, the board could report it
 * finished, the projector could download it — and the room heard silence, with
 * nothing anywhere saying why. Voice was the only audio that ever played.
 *
 * The split follows the one the scenario already makes. A bed belongs to a
 * scene and persists across every node played there, so it is keyed on the file
 * and only touched when that changes — restarting the sea on every line would
 * be a stutter every few seconds. A one-shot belongs to a line and fires with
 * it.
 */

/** Under the voice, which is the thing an audience has to follow. */
const AMBIENCE_VOLUME = 0.35;
const MUSIC_VOLUME = 0.4;
const SFX_VOLUME = 0.8;
/** Long enough not to be a cut, short enough not to smear two locations. */
const FADE_MS = 600;

/**
 * One looping bed, faded in and out.
 *
 * A class rather than two copies of the same six functions: music and ambience
 * differ only in their level, and the second copy is where the two would start
 * disagreeing about what a scene change does.
 */
class Bed {
  private readonly el = new Audio();
  private readonly volume: number;
  private file: string | undefined;
  private fade: ReturnType<typeof setInterval> | undefined;

  constructor(volume: number) {
    this.volume = volume;
    this.el.loop = true;
    this.el.preload = 'auto';
    this.el.volume = 0;
  }

  /** Swaps to a new bed, or fades the current one out when given nothing. */
  play(file: string | undefined): void {
    if (file === this.file) return;
    this.file = file;

    if (!file) {
      this.to(0, () => {
        this.el.pause();
        this.el.removeAttribute('src');
      });
      return;
    }

    // A hard swap under a crossfade would be audible as a click, so the
    // outgoing bed is faded down first and the incoming one starts silent.
    this.to(0, () => {
      this.el.src = assetBase + file;
      this.el.currentTime = 0;
      void this.el
        .play()
        .then(() => this.to(this.volume))
        .catch(() => {
          // Autoplay policy. The gate is already the answer to this, and the
          // voice raises it too — a bed alone must not, since a scene with a
          // bed and no line yet would show it before there is anything to hear.
          this.el.volume = this.volume;
        });
    });
  }

  /** Called when a gesture has lifted the autoplay policy. */
  resume(): void {
    if (!this.file || !this.el.src) return;
    void this.el.play().catch(() => undefined);
  }

  private to(target: number, then?: () => void): void {
    clearInterval(this.fade);
    const from = this.el.volume;
    const steps = Math.max(1, Math.round(FADE_MS / 40));
    let step = 0;
    this.fade = setInterval(() => {
      step += 1;
      this.el.volume = Math.min(1, Math.max(0, from + ((target - from) * step) / steps));
      if (step < steps) return;
      clearInterval(this.fade);
      then?.();
    }, 40);
  }
}

const ambience = new Bed(AMBIENCE_VOLUME);
const music = new Bed(MUSIC_VOLUME);

/**
 * A one-shot, fired by the line that declares it.
 *
 * Deliberately not cut by the next beat, unlike the voice: two voices at once
 * is worse than a clipped one, but an effect ringing on under the following
 * line is ordinary sound design — the storyboard asks for exactly that in
 * places ("one hard crack, then a long ringing decay"). A scene change does
 * stop it, because a crack should not follow the picture into another room.
 */
const sfxEl = new Audio();
sfxEl.preload = 'auto';
sfxEl.volume = SFX_VOLUME;

function playSfx(file: string | undefined): void {
  if (!file) return;
  sfxEl.pause();
  sfxEl.src = assetBase + file;
  sfxEl.currentTime = 0;
  // Silent failure on purpose. The gate belongs to the voice, which is the
  // audio an audience has to hear; raising it for a missing door slam would
  // put a button over the show for something nobody would miss.
  void sfxEl.play().catch(() => undefined);
}

function stopSfx(): void {
  sfxEl.pause();
  sfxEl.removeAttribute('src');
}

function typeLine(target: HTMLElement, text: string, charsPerSecond: number): void {
  clearInterval(typeTimer);

  if (charsPerSecond <= 0) {
    target.textContent = text;
    return;
  }

  target.textContent = '';
  const caret = document.createElement('span');
  caret.className = 'caret';
  target.appendChild(caret);

  let index = 0;
  const step = Math.max(1, Math.round(charsPerSecond / 30));
  typeTimer = setInterval(() => {
    index = Math.min(text.length, index + step);
    caret.remove();
    target.textContent = text.slice(0, index);
    if (index < text.length) {
      target.appendChild(caret);
    } else {
      clearInterval(typeTimer);
    }
  }, 1000 / 30);
}

function renderDialogue(beat: Extract<SnapshotBeat, { kind: 'dialogue' }>): void {
  show('dialogue');

  const box = views.dialogue.querySelector('.dialogue-box') as HTMLElement;
  const nameplate = el('nameplate');
  const portrait = el('portrait');
  const portraitImg = el<HTMLImageElement>('portrait-img');

  if (beat.speaker) {
    box.classList.remove('narration');
    nameplate.hidden = false;
    nameplate.textContent = beat.speaker.name;
    nameplate.style.setProperty('--nameplate', beat.speaker.color);

    if (beat.speaker.sprite) {
      portrait.hidden = false;
      portraitImg.src = assetBase + beat.speaker.sprite;
    } else {
      portrait.hidden = true;
    }
  } else {
    box.classList.add('narration');
    nameplate.hidden = true;
    portrait.hidden = true;
  }

  typeLine(el('line'), beat.text, scenario?.settings.charsPerSecond ?? 45);
  playVoice(beat.voice);
  playSfx(beat.sfx);
}

function renderPoll(
  beat: Extract<SnapshotBeat, { kind: 'poll' }>,
  tally: Snapshot['tally'],
): void {
  show('poll');
  el('poll-question').textContent = beat.question;

  const prompt = el('poll-prompt');
  prompt.textContent = beat.prompt ?? '';
  prompt.hidden = !beat.prompt;

  const list = el('poll-bars');
  const counts = tally?.counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const top = Math.max(0, ...Object.values(counts));

  // Rebuild only when the options change; otherwise update in place so the
  // bar widths animate rather than snapping.
  const signature = beat.options.map((o) => o.key).join(',');
  if (list.dataset.signature !== signature) {
    list.dataset.signature = signature;
    list.innerHTML = '';
    for (const option of beat.options) {
      const item = document.createElement('li');
      item.className = 'bar';
      item.dataset.key = option.key;
      item.innerHTML = `
        <div class="bar-fill"></div>
        <span class="bar-key"></span>
        <span class="bar-label"></span>
        <span class="bar-count">0</span>`;
      (item.querySelector('.bar-key') as HTMLElement).textContent = option.key.slice(0, 2);
      (item.querySelector('.bar-label') as HTMLElement).textContent = option.label;
      list.appendChild(item);
    }
  }

  for (const option of beat.options) {
    const item = list.querySelector<HTMLElement>(`[data-key="${CSS.escape(option.key)}"]`);
    if (!item) continue;
    const count = counts[option.key] ?? 0;
    const share = total > 0 ? count / total : 0;
    (item.querySelector('.bar-fill') as HTMLElement).style.width = `${share * 100}%`;
    (item.querySelector('.bar-count') as HTMLElement).textContent = String(count);
    item.classList.toggle('winner', count > 0 && count === top);
  }

  el('voters').textContent = `${tally?.voters ?? 0} voting`;
  startCountdown(beat.endsAt);
}

function startCountdown(endsAt: number): void {
  clearInterval(countdownTimer);

  const num = el('countdown');
  const ring = el<SVGCircleElement>('ring-fill');
  const wrap = num.parentElement!;
  const circumference = 2 * Math.PI * 52;
  const startedAt = connection.now();
  const span = Math.max(1, endsAt - startedAt);

  const tick = (): void => {
    const remaining = Math.max(0, endsAt - connection.now());
    num.textContent = String(Math.ceil(remaining / 1000));
    ring.style.strokeDashoffset = String(circumference * (1 - remaining / span));
    wrap.classList.toggle('urgent', remaining <= 10_000);
    if (remaining <= 0) clearInterval(countdownTimer);
  };

  tick();
  countdownTimer = setInterval(tick, 250);
}

/**
 * Shows a closed poll's result.
 *
 * No timer of its own any more. This used to hold the screen for 2600ms with a
 * `setTimeout` that nothing else knew about — so the server started the next
 * line's `hold` the moment the poll closed, and the first line after every
 * vote was truncated by that much, or skipped outright where its hold was
 * shorter. The reveal is a beat now, and the server clocks it like any other.
 */
function renderResult(result: {
  winnerLabel: string;
  winner: string;
  counts: Record<string, number>;
  total: number;
  usedDefault: boolean;
  usedTiebreak: boolean;
}): void {
  show('result');
  el('result-label').textContent = result.winnerLabel;

  const detail = result.usedDefault
    ? 'No votes were cast, so the story took its default path.'
    : result.usedTiebreak
      ? `${result.total} vote${result.total === 1 ? '' : 's'} — a tie, broken by the scenario's rule.`
      : `${result.counts[result.winner] ?? 0} of ${result.total} vote${result.total === 1 ? '' : 's'}.`;
  el('result-detail').textContent = detail;

}

function renderBeat(beat: SnapshotBeat, snapshot?: Snapshot): void {
  // Leaving a line for anything else silences it — including a host skipping
  // ahead, which would otherwise leave a voice talking over the next scene.
  if (beat.kind !== 'dialogue') playVoice(undefined);

  switch (beat.kind) {
    case 'idle':
      paintLobby();
      show('lobby');
      return;
    case 'dialogue':
      applyScene(beat.scene ?? lastSceneId, beat.nodeId);
      renderDialogue(beat);
      return;
    // A gate looks exactly like a pause from the front of the room, and that
    // is deliberate: the audience is not supposed to know whether a held beat
    // is waiting on a clock or on a person. Everything that differs about it
    // — the button, the absent countdown — belongs on the moderator's console.
    case 'pause':
    case 'gate':
      applyScene(beat.scene ?? lastSceneId, beat.nodeId);
      show('pause');
      el('pause-text').textContent = beat.text ?? '';
      // Often the whole reason the beat exists — four wordless seconds of a
      // gun firing. `applyScene` has already stopped anything ringing from
      // another room, so this is the only sound on it.
      playSfx(beat.sfx);
      return;
    case 'poll':
      applyScene(beat.scene ?? lastSceneId, beat.nodeId);
      renderPoll(beat, snapshot?.tally);
      return;
    case 'result':
      applyScene(beat.scene ?? lastSceneId, beat.nodeId);
      show('result');
      renderResult(beat);
      return;
    case 'end':
      applyScene(beat.scene ?? lastSceneId, beat.nodeId);
      show('end');
      el('end-text').textContent = beat.text ?? 'The end.';
      return;
  }
}

// ---------------------------------------------------------------------------
// Local playback continuity
// ---------------------------------------------------------------------------

/**
 * Schedules the next local transition. This only *fires* while the socket is
 * down — with the server connected, its snapshot always arrives first and
 * supersedes whatever we would have done.
 */
function scheduleLocal(): void {
  clearTimeout(localTimer);
  if (!scenario || !local) return;
  if (local.phase !== 'playing' && local.phase !== 'revealing') return;

  const beat = beatOf(scenario, local);
  // The reveal is timed here too: a socket that drops while the bar chart is
  // up would otherwise leave the projector on it for the rest of the show.
  if (beat.kind !== 'dialogue' && beat.kind !== 'pause' && beat.kind !== 'result') return;

  localTimer = setTimeout(() => {
    if (connection.isOpen) return; // the server is driving; do nothing
    if (!scenario || !local) return;
    local = reduce(scenario, local, { type: 'advance' });
    renderLocal();
    scheduleLocal();
  }, beat.durationMs);
}

/** Renders from the local engine copy, used only while disconnected. */
function renderLocal(): void {
  if (!scenario || !local) return;
  const beat = beatOf(scenario, local);
  if (beat.kind === 'dialogue') {
    const character = beat.line.who ? scenario.characters[beat.line.who] : undefined;
    renderBeat({
      kind: 'dialogue',
      nodeId: beat.nodeId,
      lineIndex: beat.lineIndex,
      who: beat.line.who,
      speaker: character
        ? { name: character.name, color: character.color, sprite: character.sprite }
        : undefined,
      text: beat.line.text,
      scene: activeScene(scenario, local),
      durationMs: beat.durationMs,
      voice: beat.line.voice,
      sfx: beat.line.sfx,
    });
  } else if (beat.kind === 'result') {
    // The engine nests the result where the protocol flattens it, so the cast
    // the other kinds take would hand the renderer a beat with no winner on it.
    renderBeat({
      kind: 'result',
      nodeId: beat.nodeId,
      pollId: beat.pollId,
      scene: activeScene(scenario, local),
      durationMs: beat.durationMs,
      ...beat.result,
    });
  } else {
    renderBeat(beat as SnapshotBeat);
  }
  renderedLocally = true;
}

// ---------------------------------------------------------------------------
// Server messages
// ---------------------------------------------------------------------------


function onSnapshot(snapshot: Snapshot): void {
  el('lobby-title').textContent = snapshot.scenario.title;
  el('lobby-sub').textContent = snapshot.scenario.description ?? '';

  // The code can arrive mid-show, because going live is something that happens
  // to a show already on the wall rather than a decision made before it starts.
  if (snapshot.room !== room || snapshot.joinUrl !== joinUrl) {
    room = snapshot.room;
    joinUrl = snapshot.joinUrl;
    void renderJoinInfo();
  }

  latest = snapshot;
  // Ahead of the same-beat guard below, deliberately. Pausing does not move
  // the beat number, so a pause arrives as a snapshot for the beat already on
  // screen — precisely the kind that guard exists to throw away.
  if (snapshot.phase !== lastPhase) {
    lastPhase = snapshot.phase;
    setPaused(snapshot.phase === 'paused');
    restCue();
  }
  if (!keys.hidden) updateLegend();

  // The server is authoritative: adopt its position unconditionally.
  if (scenario) {
    local = {
      ...(local ?? initialState(scenario)),
      nodeId: snapshot.beatInfo.kind === 'idle' ? scenario.start : snapshot.beatInfo.nodeId,
      lineIndex: snapshot.beatInfo.kind === 'dialogue' ? snapshot.beatInfo.lineIndex : 0,
      beat: snapshot.beat,
      phase:
        snapshot.phase === 'running'
          ? snapshot.beatInfo.kind === 'poll'
            ? 'polling'
            : 'playing'
          : snapshot.phase === 'paused'
            ? 'paused'
            : snapshot.phase === 'finished'
              ? 'finished'
              : 'idle',
    };
  }

  // A snapshot for a beat already on screen — a new tally, a player joining,
  // a display connecting — must not re-render it. Re-rendering restarted the
  // typewriter, and now it would restart the voice clip mid-sentence too.
  // `renderedLocally` is the exception: after a dropout the local engine may
  // have run past this beat, so the server's position has to be reasserted
  // even when its beat number is one we have already seen.
  if (snapshot.beat === lastRenderedBeat && !renderedLocally) {
    // Same beat, new tally: update the bars without restarting the countdown.
    if (snapshot.beatInfo.kind === 'poll') renderPoll(snapshot.beatInfo, snapshot.tally);
    return;
  }
  renderedLocally = false;


  lastRenderedBeat = snapshot.beat;
  renderBeat(snapshot.beatInfo, snapshot);
  scheduleLocal();
}

// ---------------------------------------------------------------------------
// Local control
// ---------------------------------------------------------------------------

/*
 * Driving the show from the projector itself.
 *
 * The console is the proper way to run a session and nothing here replaces it.
 * This is for the night it is not reachable: one laptop at a lectern, a phone
 * that has died, a venue where the second screen never appeared. The presenter
 * is standing at the machine the show is already on, so the machine the show is
 * already on has to be drivable.
 *
 * It is a keyboard and not a panel of buttons on purpose. A pointer means
 * looking away from the room to find something, and it means a cursor over the
 * picture; a key is a thumb on a space bar. That constraint is also what keeps
 * the surface honest — `DISPLAY_COMMANDS` on the server is exactly these keys,
 * so nothing here can reach past what a presenter can press.
 */

/** Long enough to read from a lectern, short enough not to sit on the picture. */
const CUE_MS = 1600;
let cueTimer: ReturnType<typeof setTimeout> | undefined;

/** Back to whatever is still true, which is usually nothing at all. */
function restCue(): void {
  clearTimeout(cueTimer);
  // A paused show and a long held beat are the same picture from the third
  // row. The presenter is the person who has to tell them apart, so this one
  // stays up rather than flashing — it is a state, not an acknowledgement.
  if (latest?.phase === 'paused') {
    cue.textContent = 'Paused';
    cue.hidden = false;
    return;
  }
  cue.hidden = true;
}

/** A momentary acknowledgement, over the top of whatever the badge was saying. */
function flashCue(text: string): void {
  clearTimeout(cueTimer);
  cue.textContent = text;
  cue.hidden = false;
  cueTimer = setTimeout(restCue, CUE_MS);
}

/**
 * A pause has to stop the voice, or it is not a pause.
 *
 * The server stops its clock, so the beat's `hold` is suspended — but a voice
 * clip is a media element with a clock of its own, and it read straight on
 * through the pause and then sat silent for the rest of the line once the show
 * resumed. Nobody caught it while pause was a button on a console someone had
 * to reach for. Under a presenter's thumb it is the first key they will press.
 *
 * Only the voice. The beds and the muted scene loop are the room's atmosphere
 * rather than the story, and a held beat with the sea still moving under it is
 * a stopped show; a frozen frame over dead air is a crashed one.
 *
 * Resuming only what we ourselves stopped, because calling `play()` on a clip
 * that had already finished restarts it — the line would be read twice.
 */
function setPaused(paused: boolean): void {
  if (paused) {
    voiceHeld = !voiceEl.paused;
    if (voiceHeld) voiceEl.pause();
    return;
  }
  if (!voiceHeld) return;
  voiceHeld = false;
  void voiceEl.play().catch(() => undefined);
}

/**
 * What the two ambiguous keys do right now.
 *
 * Space and the right arrow both mean different things at a gate, in a vote
 * and mid-line, and a legend that named only one of them would be worse than
 * none — it is read under pressure, by somebody about to press the key.
 */
function updateLegend(): void {
  const beat = latest?.beatInfo;
  const gate = beat?.kind === 'gate' ? beat : undefined;
  const poll = beat?.kind === 'poll' ? beat : undefined;

  el('key-space').textContent =
    latest === undefined || latest.phase === 'lobby'
      ? 'Start the show'
      : gate
        ? (gate.label ?? 'Continue')
        : latest.phase === 'paused'
          ? 'Resume'
          : poll
            ? 'Nothing — a vote is open'
            : 'Pause';

  el('key-right').textContent = poll ? 'Close the vote on the votes cast' : 'Next beat';

  // One per line. A poll option is a sentence in this show, not a word, and
  // strung together on one row they made the panel as wide as the picture.
  el('key-number').textContent = poll
    ? poll.options.map((option, index) => `${index + 1}  ${option.label}`).join('\n')
    : 'Pick a poll option, while one is open';
}

/**
 * Sends a command and says so.
 *
 * The cue acknowledges the key, never the result: what actually happened
 * arrives in the next snapshot and is drawn by the same code that draws
 * everything else. A projector announcing "Paused" off its own keystroke would
 * be a second opinion about the state of the show, and the two would disagree
 * in front of a room the first time the server said no.
 */
function control(command: HostCommand, note: string): void {
  if (!connection.isOpen) {
    // The local engine keeps the picture moving through a dropout, but it is a
    // continuity fallback and not an authority. Letting keys drive it would put
    // the show in two places at once, and reconnecting would snap back and undo
    // whatever the presenter thought they had just done.
    flashCue('Not connected — the show cannot be driven from here');
    return;
  }
  connection.send({ type: 'command', command });
  flashCue(note);
}

/** The vote override: 1 is the first option on screen, in the order shown. */
function forceOption(index: number): void {
  const beat = latest?.beatInfo;
  if (beat?.kind !== 'poll') {
    flashCue('No vote is open');
    return;
  }
  const option = beat.options[index];
  if (!option) {
    flashCue(`There is no option ${index + 1}`);
    return;
  }
  control({ name: 'forceBranch', optionKey: option.key }, `“${option.label}” wins`);
}

const CONTROL_KEYS = [' ', 'ArrowRight', 'ArrowLeft'];

document.addEventListener('keydown', (event) => {
  // Leave every modified key alone: ctrl-W, alt-tab and the browser's own
  // fullscreen and reload are exactly the keys a presenter still needs.
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.key === '?') {
    keys.hidden = !keys.hidden;
    if (!keys.hidden) updateLegend();
    return;
  }
  if (event.key === 'Escape') {
    keys.hidden = true;
    return;
  }

  const digit = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : undefined;
  if (digit === undefined && !CONTROL_KEYS.includes(event.key)) return;

  // Past this point the key is ours. Stopping the default matters most for
  // space, which would otherwise also click whatever has focus — the audio
  // gate, usually, since it is the only button on the page.
  event.preventDefault();
  // A keystroke is a user gesture, and it is the only one a presenter with no
  // mouse is going to make. Harmless when the policy was never in the way.
  if (!audioGate.hidden) unlockAudio();

  const beat = latest?.beatInfo;
  const phase = latest?.phase;

  if (digit !== undefined) {
    forceOption(digit);
    return;
  }

  if (event.key === 'ArrowLeft') {
    control({ name: 'back' }, 'Back');
    return;
  }

  if (event.key === 'ArrowRight') {
    if (phase === 'lobby') {
      control({ name: 'start' }, 'Starting');
      return;
    }
    // Paused, and asked to move on. `advance` alone is refused while paused, so
    // the show would sit there and the key would look broken — and moving on is
    // unambiguously what the presenter just asked for.
    if (phase === 'paused') connection.send({ type: 'command', command: { name: 'resume' } });
    control(
      { name: 'skip' },
      beat?.kind === 'poll' ? 'Vote closed' : beat?.kind === 'gate' ? 'Continuing' : 'Next',
    );
    return;
  }

  // Space, which is the key that means the most different things.
  if (phase === undefined || phase === 'lobby') {
    control({ name: 'start' }, 'Starting');
    return;
  }
  if (beat?.kind === 'gate') {
    // What it is in every other presenter tool: the thing that moves you on.
    // Pausing a beat that is already held would be a no-op the presenter has to
    // think about mid-sentence.
    control({ name: 'continue' }, beat.label ?? 'Continuing');
    return;
  }
  if (phase === 'paused') {
    control({ name: 'resume' }, 'Resumed');
    return;
  }
  if (phase === 'finished') {
    flashCue('The show has finished');
    return;
  }
  // The room refuses a pause during a vote and during the reveal that follows
  // it. Sending one anyway would leave the presenter pressing a key that does
  // nothing, with nothing to say why — so say why, and name the key that works.
  if (beat?.kind === 'poll') {
    flashCue('A vote is open — → closes it, 1–9 picks');
    return;
  }
  if (beat?.kind === 'result') {
    flashCue('Showing the result');
    return;
  }
  control({ name: 'pause' }, 'Pausing');
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const connection = new Connection({
  hello: () => ({
    type: 'hello',
    role: 'display',
    // No room and no token: there is one show in the process on the other end
    // of this socket, and naming it would be naming it to itself.
    //
    // Omitted until we have actually rendered something; -1 is not a beat.
    ...(lastRenderedBeat >= 0 ? { beat: lastRenderedBeat } : {}),
  }),
  onStatus: (status) => {
    conn.dataset.status = status;
    conn.textContent = status;
    if (status === 'open') {
      // Reconnected: the next snapshot resyncs us, so stop local playback.
      clearTimeout(localTimer);
      announceReady();
    }
  },
  onMessage: (message) => {
    if (message.type === 'snapshot') onSnapshot(message);
    if (message.type === 'error') {
      el('asset-state').textContent = message.message;
      if (message.fatal) {
        show('lobby');
        return;
      }
      // That line lives on the lobby panel, which mid-show is hidden behind
      // the story. A refused keystroke has to answer where the presenter is
      // actually looking, or the key just appears not to work.
      flashCue(message.message);
    }
  },
});

/**
 * Draws the join code, or says plainly that there is not one.
 *
 * The QR is redrawn only when the address actually changes: the alternative is
 * re-encoding a 600px bitmap several times a second while a poll's tally
 * streams in, on the machine that is also running the show's clock.
 */
let drawnFor: string | undefined;

async function renderJoinInfo(): Promise<void> {
  const linked = room !== undefined;
  el('lobby-join').hidden = !linked;
  el('poll-join').hidden = !linked;
  el('lobby-unlinked').hidden = linked;
  if (!room) return;

  el('lobby-code').textContent = room;
  el('poll-code').textContent = room;

  // The relay's own address, because the relay is the thing facing the
  // audience. Falling back to this window's origin is for the case where the
  // two are the same machine, which is what the offline fallback is.
  const url = joinUrl ?? `${location.origin}/join/${room}`;
  if (drawnFor === url) return;
  drawnFor = url;

  const dataUrl = await QRCode.toDataURL(url, {
    margin: 0,
    width: 600,
    color: { dark: '#0b0d12', light: '#ffffff' },
  });

  el<HTMLImageElement>('lobby-qr').src = dataUrl;
  el<HTMLImageElement>('poll-qr').src = dataUrl;
  el('lobby-url').textContent = url.replace(/^https?:\/\//, '');
  el('poll-url').textContent = url.replace(/^https?:\/\//, '');
}

void renderJoinInfo();
void loadScenario();

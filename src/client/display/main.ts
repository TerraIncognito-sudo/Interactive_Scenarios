/**
 * The projector.
 *
 * Two things make this more than a dumb renderer:
 *
 * 1. It prefetches every asset before reporting ready, so the show cannot open
 *    on a black screen while a background downloads.
 * 2. It holds the whole scenario and runs the same pure engine the server does.
 *    While the socket is up the server drives every transition; if the socket
 *    drops, the display keeps playing locally instead of freezing, and snaps
 *    back to the server's position the moment it reconnects.
 */

import QRCode from 'qrcode';
import { Connection, queryParam } from '../shared/connection.ts';
import type { Snapshot, SnapshotBeat } from '../../shared/protocol.ts';
import type { Scenario } from '../../scenario/schema.ts';
import { beatOf, initialState, reduce, activeScene, type RunState } from '../../engine/engine.ts';

const room = queryParam('room')?.toUpperCase();
const token = queryParam('token');

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

// ---------------------------------------------------------------------------
// Stage scaling — author at 1920x1080, fit whatever projector we are given.
// ---------------------------------------------------------------------------

function fitStage(): void {
  const stage = el('stage');
  const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  stage.style.transform = `scale(${scale})`;
}
window.addEventListener('resize', fitStage);
fitStage();

// ---------------------------------------------------------------------------
// Local state
// ---------------------------------------------------------------------------

let scenario: Scenario | undefined;
let assetBase = '';
let assetsLoaded = false;
let local: RunState | undefined;
let localTimer: ReturnType<typeof setTimeout> | undefined;
let lastRenderedBeat = -1;
let currentSceneId: string | undefined;
let typeTimer: ReturnType<typeof setInterval> | undefined;
let countdownTimer: ReturnType<typeof setInterval> | undefined;
let resultTimer: ReturnType<typeof setTimeout> | undefined;

function show(which: keyof typeof views): void {
  for (const [name, node] of Object.entries(views)) {
    node.hidden = name !== which;
  }
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

function preloadImage(url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    // Resolve on error too: a missing decoration must not block the show.
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = url;
  });
}

function preloadAudio(url: string): Promise<void> {
  return new Promise((resolve) => {
    const audio = new Audio();
    audio.oncanplaythrough = () => resolve();
    audio.onerror = () => resolve();
    audio.preload = 'auto';
    audio.src = url;
  });
}

async function loadScenario(): Promise<void> {
  if (!room || !token) {
    el('asset-state').textContent = 'Missing room or token in the URL.';
    return;
  }

  const response = await fetch(
    `/api/rooms/${encodeURIComponent(room)}/scenario?token=${encodeURIComponent(token)}`,
  );
  if (!response.ok) {
    el('asset-state').textContent = `Could not load scenario (${response.status}).`;
    return;
  }

  const body = (await response.json()) as {
    scenario: Scenario;
    assets: string[];
    assetBase: string;
  };
  scenario = body.scenario;
  assetBase = body.assetBase;
  local = initialState(body.scenario);

  const total = body.assets.length;
  let done = 0;
  const state = el('asset-state');
  state.textContent = total ? `Loading assets… 0/${total}` : 'Ready.';

  await Promise.all(
    body.assets.map(async (file) => {
      const url = assetBase + file;
      await (/\.(mp3|ogg|wav|m4a)$/i.test(file) ? preloadAudio(url) : preloadImage(url));
      done++;
      state.textContent = `Loading assets… ${done}/${total}`;
    }),
  );

  state.textContent = 'Ready.';
  assetsLoaded = true;
  announceReady();
}

/**
 * Readiness has to be re-announced on every connect, not sent once. Assets
 * often finish loading before the socket opens (and always do when a scenario
 * has none), and a send on a closed socket is silently dropped — which would
 * leave the host staring at "loading…" forever.
 */
function announceReady(): void {
  if (assetsLoaded && connection.isOpen) connection.send({ type: 'displayReady' });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function applyScene(sceneId: string | undefined): void {
  if (sceneId === currentSceneId) return;
  currentSceneId = sceneId;

  const definition = sceneId ? scenario?.scenes[sceneId] : undefined;
  scene.style.backgroundImage = definition?.background
    ? `url("${assetBase}${definition.background}")`
    : '';
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

function renderResult(result: NonNullable<Snapshot['lastResult']>, then: () => void): void {
  show('result');
  el('result-label').textContent = result.winnerLabel;

  const detail = result.usedDefault
    ? 'No votes were cast, so the story took its default path.'
    : result.usedTiebreak
      ? `${result.total} vote${result.total === 1 ? '' : 's'} — a tie, broken by the scenario's rule.`
      : `${result.counts[result.winner] ?? 0} of ${result.total} vote${result.total === 1 ? '' : 's'}.`;
  el('result-detail').textContent = detail;

  clearTimeout(resultTimer);
  resultTimer = setTimeout(then, 2600);
}

function renderBeat(beat: SnapshotBeat, snapshot?: Snapshot): void {
  switch (beat.kind) {
    case 'idle':
      show('lobby');
      return;
    case 'dialogue':
      applyScene(beat.scene ?? currentSceneId);
      renderDialogue(beat);
      return;
    case 'pause':
      applyScene(beat.scene ?? currentSceneId);
      show('pause');
      el('pause-text').textContent = beat.text ?? '';
      return;
    case 'poll':
      applyScene(beat.scene ?? currentSceneId);
      renderPoll(beat, snapshot?.tally);
      return;
    case 'end':
      applyScene(beat.scene ?? currentSceneId);
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
  if (!scenario || !local || local.phase !== 'playing') return;

  const beat = beatOf(scenario, local);
  if (beat.kind !== 'dialogue' && beat.kind !== 'pause') return;

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
      sfx: beat.line.sfx,
    });
  } else {
    renderBeat(beat as SnapshotBeat);
  }
}

// ---------------------------------------------------------------------------
// Server messages
// ---------------------------------------------------------------------------

let pendingResultNode: string | undefined;

function onSnapshot(snapshot: Snapshot): void {
  el('lobby-title').textContent = snapshot.scenario.title;
  el('lobby-sub').textContent = snapshot.scenario.description ?? '';

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

  if (snapshot.beat === lastRenderedBeat && snapshot.beatInfo.kind === 'poll') {
    // Same beat, new tally: update the bars without restarting the countdown.
    renderPoll(snapshot.beatInfo, snapshot.tally);
    return;
  }

  // A poll that just closed gets its reveal before the story continues.
  const result = snapshot.lastResult;
  if (result && result.nodeId !== pendingResultNode && snapshot.beatInfo.kind !== 'poll') {
    pendingResultNode = result.nodeId;
    lastRenderedBeat = snapshot.beat;
    renderResult(result, () => {
      renderBeat(snapshot.beatInfo, snapshot);
      scheduleLocal();
    });
    return;
  }

  lastRenderedBeat = snapshot.beat;
  renderBeat(snapshot.beatInfo, snapshot);
  scheduleLocal();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const connection = new Connection({
  hello: () => ({
    type: 'hello',
    role: 'display',
    room: room ?? '',
    token,
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
      if (message.fatal) show('lobby');
    }
  },
});

async function renderJoinInfo(): Promise<void> {
  if (!room) return;
  const url = `${location.origin}/join/${room}`;
  const dataUrl = await QRCode.toDataURL(url, {
    margin: 0,
    width: 600,
    color: { dark: '#0b0d12', light: '#ffffff' },
  });

  el<HTMLImageElement>('lobby-qr').src = dataUrl;
  el<HTMLImageElement>('poll-qr').src = dataUrl;
  el('lobby-url').textContent = url.replace(/^https?:\/\//, '');
  el('poll-url').textContent = url.replace(/^https?:\/\//, '');
  el('lobby-code').textContent = room;
  el('poll-code').textContent = room;
}

void renderJoinInfo();
void loadScenario();

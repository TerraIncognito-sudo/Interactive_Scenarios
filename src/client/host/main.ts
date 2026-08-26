/**
 * The operator console.
 *
 * The show is meant to run itself, so nothing here should be necessary. It
 * exists for the minutes when something has gone wrong in front of an
 * audience: the tally is obviously unrepresentative, the room needs more time,
 * or the story has to move on right now.
 */

import { Connection, queryParam } from '../shared/connection.ts';
import type { Snapshot } from '../../shared/protocol.ts';

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
};

const room = queryParam('room')?.toUpperCase() ?? '';
const token = queryParam('token');

let latest: Snapshot | undefined;
let clockTimer: ReturnType<typeof setInterval> | undefined;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function describeBeat(snapshot: Snapshot): { text: string; meta: string } {
  const beat = snapshot.beatInfo;
  switch (beat.kind) {
    case 'idle':
      return { text: 'Waiting to start.', meta: '' };
    case 'dialogue':
      return {
        text: `“${beat.text}”`,
        meta: `${beat.speaker?.name ?? 'Narration'} · ${beat.nodeId} · line ${beat.lineIndex + 1}`,
      };
    case 'pause':
      return { text: beat.text ?? 'A held beat.', meta: beat.nodeId };
    case 'poll':
      return { text: beat.question, meta: `${beat.nodeId} · voting open` };
    case 'result':
      // The host sees the beat the room is looking at, so the reveal has to
      // appear here too — otherwise the console reads as though the show has
      // already moved on while the projector still shows the bar chart.
      return {
        text: `“${beat.winnerLabel}” wins.`,
        meta: `${beat.pollId} · ${beat.total} vote${beat.total === 1 ? '' : 's'}${beat.usedDefault ? ', none cast' : ''} · showing the result`,
      };
    case 'end':
      return { text: beat.text ?? 'The end.', meta: `${beat.nodeId} · finished` };
  }
}

function renderTally(snapshot: Snapshot): void {
  const live = el('live');
  const beat = snapshot.beatInfo;

  if (beat.kind !== 'poll') {
    live.hidden = true;
    clearInterval(clockTimer);
    return;
  }

  live.hidden = false;

  const counts = snapshot.tally?.counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const top = Math.max(0, ...Object.values(counts));

  const list = el('tally');
  const signature = beat.options.map((o) => o.key).join(',');
  if (list.dataset.signature !== signature) {
    list.dataset.signature = signature;
    list.innerHTML = '';
    for (const option of beat.options) {
      const row = document.createElement('li');
      row.className = 'tally-row';
      row.dataset.key = option.key;
      row.innerHTML = `<div class="tally-fill"></div>
        <span class="tally-label"></span>
        <span class="tally-count">0</span>`;
      (row.querySelector('.tally-label') as HTMLElement).textContent = option.label;
      list.appendChild(row);
    }

    const overrides = el('override-buttons');
    overrides.innerHTML = '';
    for (const option of beat.options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = option.label;
      button.addEventListener('click', () => {
        send({ name: 'forceBranch', optionKey: option.key });
      });
      overrides.appendChild(button);
    }
  }

  for (const option of beat.options) {
    const row = list.querySelector<HTMLElement>(`[data-key="${CSS.escape(option.key)}"]`);
    if (!row) continue;
    const count = counts[option.key] ?? 0;
    (row.querySelector('.tally-fill') as HTMLElement).style.width =
      `${total > 0 ? (count / total) * 100 : 0}%`;
    (row.querySelector('.tally-count') as HTMLElement).textContent = String(count);
    row.classList.toggle('leading', count > 0 && count === top);
  }

  startClock(beat.endsAt);
}

function startClock(endsAt: number): void {
  clearInterval(clockTimer);
  const clock = el('live-clock');
  const tick = (): void => {
    const remaining = Math.max(0, endsAt - connection.now());
    const seconds = Math.ceil(remaining / 1000);
    clock.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    clock.classList.toggle('urgent', remaining <= 10_000);
    if (remaining <= 0) clearInterval(clockTimer);
  };
  tick();
  clockTimer = setInterval(tick, 250);
}

function render(snapshot: Snapshot): void {
  latest = snapshot;

  el('show-title').textContent = snapshot.scenario.title;
  el('room-code').textContent = snapshot.room;

  const phase = el('stat-phase');
  phase.textContent = snapshot.phase;
  phase.className = `stat-value ${snapshot.phase === 'running' ? 'good' : snapshot.phase === 'paused' ? 'warn' : ''}`;

  const display = el('stat-display');
  const displays = snapshot.presence.displays;
  display.textContent =
    displays === 0 ? 'not connected' : snapshot.displayReady ? 'ready' : 'loading…';
  display.className = `stat-value ${displays === 0 ? 'warn' : snapshot.displayReady ? 'good' : 'warn'}`;

  el('stat-players').textContent = String(snapshot.presence.players);

  const { text, meta } = describeBeat(snapshot);
  el('now-text').textContent = text;
  el('now-meta').textContent = meta;

  renderTally(snapshot);

  // Button availability follows the actual state, so the console never offers
  // a control that would do nothing.
  const isPoll = snapshot.beatInfo.kind === 'poll';
  const started = snapshot.phase !== 'lobby';

  const startButton = el<HTMLButtonElement>('btn-start');
  startButton.textContent =
    snapshot.phase === 'lobby'
      ? 'Start the show'
      : snapshot.phase === 'paused'
        ? 'Resume'
        : 'Running';
  startButton.disabled = snapshot.phase === 'running' || snapshot.phase === 'finished';

  el<HTMLButtonElement>('btn-pause').disabled = snapshot.phase !== 'running' || isPoll;
  el<HTMLButtonElement>('btn-back').disabled = !started;
  el<HTMLButtonElement>('btn-skip').disabled = !started || snapshot.phase === 'finished';
  el<HTMLButtonElement>('btn-extend').disabled = !isPoll;
  el<HTMLButtonElement>('btn-close').disabled = !isPoll;

  // Warn before starting into a display that has not loaded its artwork.
  el('ready-warning').hidden = !(snapshot.phase === 'lobby' && displays > 0 && !snapshot.displayReady);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

type Command = Parameters<typeof connection.send>[0] extends { command: infer C } ? C : never;

function send(command: unknown): void {
  connection.send({ type: 'command', command } as never);
}

const connection = new Connection({
  hello: () => ({ type: 'hello', role: 'host', room, token }),
  onStatus: (status) => {
    const conn = el('conn');
    conn.dataset.status = status;
    conn.textContent = status === 'open' ? 'connected' : status;
  },
  onMessage: (message) => {
    if (message.type === 'snapshot') render(message);
    if (message.type === 'error') {
      el('now-text').textContent = message.message;
      el('now-meta').textContent = message.code;
    }
  },
});

el('btn-start').addEventListener('click', () => {
  send({ name: latest?.phase === 'paused' ? 'resume' : 'start' });
});
el('btn-pause').addEventListener('click', () => send({ name: 'pause' }));
el('btn-back').addEventListener('click', () => send({ name: 'back' }));
el('btn-skip').addEventListener('click', () => send({ name: 'skip' }));
el('btn-close').addEventListener('click', () => send({ name: 'closePoll' }));
el('btn-extend').addEventListener('click', () => send({ name: 'extendPoll', seconds: 30 }));

el('btn-reset').addEventListener('click', () => {
  // Resetting mid-show in front of an audience is not something to do by accident.
  if (confirm('Reset the show to the very beginning? Everyone will see this.')) {
    send({ name: 'reset' });
  }
});

// Keyboard shortcuts, for hosting from a laptop rather than a phone.
document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement) return;
  switch (event.key) {
    case ' ':
      event.preventDefault();
      send({ name: latest?.phase === 'paused' ? 'resume' : 'pause' });
      break;
    case 'ArrowRight':
      send({ name: 'skip' });
      break;
    case 'ArrowLeft':
      send({ name: 'back' });
      break;
  }
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

const displayToken = queryParam('displayToken');
el<HTMLInputElement>('link-display').value = displayToken
  ? `${location.origin}/display/?room=${room}&token=${displayToken}`
  : 'Open the display link from the page that created this room.';
el<HTMLInputElement>('link-join').value = `${location.origin}/join/${room}`;

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  button.addEventListener('click', async () => {
    const input = el<HTMLInputElement>(button.dataset.copy!);
    await navigator.clipboard.writeText(input.value);
    const original = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => (button.textContent = original), 1200);
  });
}

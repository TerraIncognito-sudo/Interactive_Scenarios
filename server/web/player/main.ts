/**
 * The phone.
 *
 * Deliberately the least clever surface in the system: it shows one question,
 * takes one tap, and survives a bad connection. It never receives the story.
 */

import { Connection, deviceId, queryParam } from '../lib/connection.ts';
import type { PlayerState } from '../../../shared/relay/protocol.ts';

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
};

const views = {
  join: el('view-join'),
  waiting: el('view-waiting'),
  poll: el('view-poll'),
  locked: el('view-locked'),
  error: el('view-error'),
};

function show(which: keyof typeof views): void {
  for (const [name, node] of Object.entries(views)) node.hidden = name !== which;
}

/**
 * /join/CODE is the scanned form; ?room=CODE is the typed fallback.
 *
 * Hyphens are in the pattern because a room may be named rather than minted —
 * ARCTIC-SENTINEL is a legal room. Left out, the match stopped at the hyphen
 * and forty phones scanning a QR code all joined a room called ARCTIC.
 */
function roomFromLocation(): string | undefined {
  const fromPath = location.pathname.match(/\/join\/([A-Za-z0-9-]+)/)?.[1];
  return (fromPath ?? queryParam('room'))?.toUpperCase();
}

const room = roomFromLocation();
const device = deviceId();

let connection: Connection | undefined;
let currentPoll: PlayerState['poll'] | undefined;
let choice: string | undefined;
let timerHandle: ReturnType<typeof setInterval> | undefined;
/** Held so the UI can respond to a tap instantly, before the server confirms. */
let optimisticChoice: string | undefined;
/**
 * Which poll this device voted in, remembered locally. Once a poll closes the
 * server discards its ballot box, so the choice is gone from its next message
 * — but the voter still deserves to be told their vote counted.
 */
let votedInNode: string | undefined;
let votedLabel: string | undefined;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderOptions(): void {
  const container = el('options');
  const poll = currentPoll;
  if (!poll) return;

  const signature = poll.options.map((o) => o.key).join(',');
  if (container.dataset.signature !== signature) {
    container.dataset.signature = signature;
    container.innerHTML = '';

    for (const option of poll.options) {
      const button = document.createElement('button');
      button.className = 'option';
      button.type = 'button';
      button.dataset.key = option.key;
      button.setAttribute('aria-pressed', 'false');

      const key = document.createElement('span');
      key.className = 'option-key';
      key.textContent = option.key.slice(0, 2);

      const label = document.createElement('span');
      label.textContent = option.label;

      button.append(key, label);
      button.addEventListener('click', () => vote(option.key));
      container.appendChild(button);
    }
  }

  const selected = optimisticChoice ?? choice;
  for (const button of container.querySelectorAll<HTMLElement>('.option')) {
    button.setAttribute('aria-pressed', String(button.dataset.key === selected));
  }
}

function startTimer(endsAt: number): void {
  clearInterval(timerHandle);
  const bar = el('timer-bar');
  const startedAt = connection?.now() ?? Date.now();
  const span = Math.max(1, endsAt - startedAt);

  const tick = (): void => {
    const now = connection?.now() ?? Date.now();
    const remaining = Math.max(0, endsAt - now);
    bar.style.transform = `scaleX(${remaining / span})`;
    bar.classList.toggle('urgent', remaining <= 10_000);
    if (remaining <= 0) clearInterval(timerHandle);
  };

  tick();
  timerHandle = setInterval(tick, 250);
}

function onPlayerState(state: PlayerState): void {
  // The server is the authority on what this device actually has selected.
  choice = state.choice;
  if (state.choice !== undefined) {
    optimisticChoice = undefined;
    if (state.poll) {
      votedInNode = state.poll.nodeId;
      votedLabel = state.poll.options.find((o) => o.key === state.choice)?.label;
    }
  }

  if (!state.poll) {
    clearInterval(timerHandle);
    const closedNode = currentPoll?.nodeId;
    currentPoll = undefined;

    if (closedNode !== undefined && votedInNode === closedNode) {
      el('locked-choice').textContent = votedLabel
        ? `You chose “${votedLabel}”.`
        : 'Your choice was counted.';
      show('locked');
    } else {
      el('waiting-room').textContent = room ? `Room ${room}` : '';
      show('waiting');
    }
    return;
  }

  const isNewPoll = currentPoll?.nodeId !== state.poll.nodeId;
  currentPoll = state.poll;
  if (isNewPoll) optimisticChoice = undefined;

  el('question').textContent = state.poll.question;
  const prompt = el('prompt');
  prompt.textContent = state.poll.prompt ?? '';
  prompt.hidden = !state.poll.prompt;

  renderOptions();
  if (isNewPoll) startTimer(state.poll.endsAt);
  show('poll');

  if (navigator.vibrate && isNewPoll) navigator.vibrate(35);
}

function vote(optionKey: string): void {
  // Reflect the tap immediately; the next playerState confirms or corrects it.
  optimisticChoice = optionKey;
  if (currentPoll) {
    votedInNode = currentPoll.nodeId;
    votedLabel = currentPoll.options.find((o) => o.key === optionKey)?.label;
  }
  renderOptions();
  if (navigator.vibrate) navigator.vibrate(12);
  connection?.send({ type: 'vote', optionKey });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function start(code: string): void {
  connection = new Connection({
    hello: () => ({ type: 'hello', role: 'player', room: code, deviceId: device }),
    onStatus: (status) => {
      const conn = el('conn');
      conn.dataset.status = status;
      conn.textContent = status === 'open' ? 'connected' : status;
    },
    onMessage: (message) => {
      if (message.type === 'playerState') onPlayerState(message);
      if (message.type === 'error' && message.fatal) {
        el('error-text').textContent =
          message.code === 'badRoom'
            ? `No session with code ${code}. Check the screen and try again.`
            : message.message;
        show('error');
      }
    },
  });
}

if (room) {
  el('waiting-room').textContent = `Room ${room}`;
  show('waiting');
  start(room);
} else {
  show('join');
  el('join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    // Spaces to hyphens, because a code read off a wall as "arctic sentinel"
    // is typed with the space that is in the word rather than the hyphen that
    // is in the URL. Kept here and not shared with the relay's own
    // `normalizeRoomName`: this page is the one thing in the system a stranger
    // loads, and it borrows nothing.
    const value = el<HTMLInputElement>('code-input')
      .value.trim()
      .toUpperCase()
      .replace(/\s+/g, '-');
    if (!/^[A-Z0-9][A-Z0-9-]{1,22}[A-Z0-9]$/.test(value)) {
      // Not "six characters" any more: a room may be named, and telling
      // somebody holding ARCTIC-SENTINEL that codes are six long sends them
      // off to ask the room for a different code that does not exist.
      el('join-error').textContent = 'That does not look like a room code.';
      return;
    }
    location.href = `/join/${value}`;
  });
}

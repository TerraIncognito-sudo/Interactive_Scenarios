/**
 * Running the show, from the window the show is authored in.
 *
 * This is the operator console, rewritten. The old one was a page on a phone
 * at the back of a room, reached by a link with a token in it; the phone is
 * gone and the console is a tab, because the client machine is now the only
 * control surface there is. Its layout is the old one's, which was right:
 * what is on screen, then the vote, then the transport. Its behaviour is the
 * old one's too, including the gate button that carries the author's own word
 * and the confirm in front of Reset.
 *
 * Three things are genuinely new.
 *
 * **Two ways to decide a poll, and they are not the same thing.** Force hands
 * `closePoll` a decided result, so it never runs `resolvePoll`, never draws a
 * truthful bar chart and never exercises the poll's `default:` or its
 * tie-break — it is the override for the night a vote goes wrong. Cast puts
 * ballots in the box and lets the poll close on its own clock, which is the
 * only one of the two that proves a poll works before an audience is the thing
 * testing it. Both are here, side by side, labelled as what they are.
 *
 * Cast is a **dial per option** rather than a button that adds: the number is
 * how many of the room chose that option, and turning it down takes votes away
 * again. That is what makes trying a split, watching it resolve and then
 * trying a different one the ordinary thing to do — and it is why zero is a
 * legal number, since an empty poll is the case whose `default:` nobody ever
 * gets to see fire.
 *
 * **Simulated votes stop the moment a relay is linked.** The refusal is the
 * Room's, not this file's; what this file does is say so, and stop offering
 * buttons that would be ignored.
 *
 * **Start waits for the projector to have been clicked.** Autoplay needs a
 * gesture in the window that makes the sound, and Start used to be pressed on
 * a different device, so the projector's own gate covered it. Now it does not.
 *
 * The socket is a dozen lines of its own rather than `web/lib/connection.ts`.
 * That class exists for venue wifi and phones that sleep — eager retries on
 * `online` and `visibilitychange`, exponential backoff, clock-offset
 * correction across devices. None of it describes a socket to a process on
 * this machine, whose only failure mode is that process being gone, in which
 * case every other control in this window is already dead. What is kept is a
 * plain retry, because the process can be started again.
 */

import { $, h } from './dom.js';

/**
 * Kept in step with `MAX_SIMULATED_VOTERS` in the shared protocol by hand,
 * because the board is served raw and cannot import TypeScript. Only the
 * number box reads it — the Room enforces the real cap, so the worst a drift
 * here can do is offer a number the room refuses.
 */
const MAX_SIMULATED = 200;

const state = {
  /** What `/api/show` last said. Null before the first answer. */
  status: null,
  /** The latest snapshot off the socket, or null when no show is running. */
  snapshot: null,
  /** The stage window we opened, so Stop can take it away with the show. */
  stage: null,
  /** How many simulated voters the next Cast sends. */
  simCount: 12,
  /** What `/api/show` last said about the relay. See `linkPanel`. */
  link: { status: 'off' },
  /** Set while Go Live is in flight, so the button cannot be pressed twice. */
  linking: false,
  /** Open when the operator is entering a relay address and key. */
  keyForm: false,
  socket: null,
  retry: null,
  getProject: () => null,
  onStatus: () => {},
};

async function api(path, options) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `${response.status}`);
  return body;
}

// ---------------------------------------------------------------------------
// The socket
// ---------------------------------------------------------------------------

function connect() {
  clearTimeout(state.retry);
  const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
  const socket = new WebSocket(url);
  state.socket = socket;

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'hello', role: 'board' }));
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'snapshot') {
      state.snapshot = message;
      render();
    }
    if (message.type === 'error') {
      // Not fatal to this window even when it is fatal to the socket: no show
      // is running is the ordinary state between two shows, and saying so in
      // the status pill every time would be noise about nothing.
      if (message.code !== 'badRoom') state.onStatus('error', message.message);
      state.snapshot = null;
      render();
    }
  });

  const retry = () => {
    if (state.socket !== socket) return;
    state.snapshot = null;
    render();
    // A flat second. There is no network here — if this fails it is because
    // the process is gone, and backing off would only make the first moment
    // after it is restarted feel broken.
    state.retry = setTimeout(connect, 1000);
  };
  socket.addEventListener('close', retry);
  socket.addEventListener('error', () => socket.close());
}

function send(command) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type: 'command', command }));
  }
}

// ---------------------------------------------------------------------------
// Describing what is on screen
// ---------------------------------------------------------------------------

function describeBeat(beat) {
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
    case 'gate':
      return {
        text: beat.text ?? 'Held — waiting for you.',
        meta: `${beat.nodeId} · nothing is counting down`,
      };
    case 'poll':
      return { text: beat.question, meta: `${beat.nodeId} · voting open` };
    case 'result':
      // The beat the room is looking at, so the reveal appears here too —
      // otherwise this reads as though the show has moved on while the
      // projector is still showing the bar chart.
      return {
        text: `“${beat.winnerLabel}” wins.`,
        meta:
          `${beat.pollId} · ${beat.total} vote${beat.total === 1 ? '' : 's'}` +
          `${beat.usedDefault ? ', none cast' : ''}${beat.usedTiebreak ? ', tie broken' : ''}` +
          ` · showing the result`,
      };
    case 'end':
      return { text: beat.text ?? 'The end.', meta: `${beat.nodeId} · finished` };
    default:
      return { text: '', meta: '' };
  }
}

/** Megabytes at one decimal, the unit a person can hold in their head. */
const mb = (bytes) => `${(bytes / 1_000_000).toFixed(1)} MB`;

/**
 * What the projector is doing, in as many words as there are facts.
 *
 * Every state it can be in says which one it is. "loading…" for a whole minute
 * with nothing moving is indistinguishable from a window that has hung, and
 * the only thing to do about it was wait and hope.
 */
function describeDisplay(snapshot) {
  if (snapshot.presence.displays === 0) return 'not open';
  if (snapshot.displayReady) {
    const gone = snapshot.displayMissing;
    // Ready is not the same as complete. A shot whose background 404'd opens
    // black, and this is the only warning anyone gets before it does.
    return gone ? `ready · ${gone.failed} of ${gone.total} unavailable` : 'ready';
  }
  const at = snapshot.displayLoading;
  // Connected and nothing said yet: it is fetching the scenario itself, which
  // is a real step with a real wait behind it.
  if (!at || at.total === 0) return 'fetching the story…';
  const size =
    at.totalBytes > 0 ? ` · ${mb(at.bytes ?? 0)} of ${mb(at.totalBytes)}` : '';
  return `loading ${at.done}/${at.total}${size}`;
}

/**
 * Why Start is not available, or null when it is.
 *
 * Returned as a sentence rather than a boolean because a disabled button with
 * no explanation is a bug report. Ordered by what the operator has to do
 * first.
 */
function startBlockedBecause(snapshot) {
  if (snapshot.presence.displays === 0) {
    return 'The stage window is not open. Press Stage to open it.';
  }
  if (!snapshot.audioUnlocked) {
    // The failure the merge created: the gesture autoplay wants has to happen
    // in the window that makes the sound, and this is not that window.
    return 'Click the stage window once — until you do, the show will play silently.';
  }
  if (!snapshot.displayReady) {
    const at = snapshot.displayLoading;
    if (!at || at.total === 0) {
      return 'The stage is still fetching the story. Give it a moment.';
    }
    const bad = at.failed > 0 ? ` ${at.failed} could not be fetched so far.` : '';
    return (
      `The stage is still loading artwork — ${at.total - at.done} of ${at.total} to go.` +
      `${bad} Starting now would open on a blank background.`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderHeader() {
  const running = state.status?.running === true;
  const project = state.getProject();

  $('show-play').hidden = running;
  $('show-stop').hidden = !running;
  $('show-stage').hidden = !running;
  $('show-play').disabled = !project;

  const label = $('show-state');
  label.hidden = !running;
  if (!running) {
    label.textContent = '';
    $('show-badge').hidden = true;
    return;
  }
  // Names the project rather than saying "running", because the thing worth
  // knowing while several folders are open in several windows is *which* one
  // is on the wall — and that is what an edit refusal will name.
  label.textContent = `${state.status.project} on the projector`;
  label.dataset.linked = state.snapshot?.room ? 'yes' : 'no';

  const badge = $('show-badge');
  badge.hidden = false;
  badge.textContent = state.snapshot?.room ?? 'live';
}

function pollPanel(snapshot) {
  const beat = snapshot.beatInfo;
  if (beat.kind !== 'poll') return null;

  const counts = snapshot.tally?.counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const top = Math.max(0, ...Object.values(counts));
  const linked = snapshot.room !== undefined;
  const remaining = Math.max(0, Math.round((beat.endsAt - Date.now()) / 1000));

  return h(
    'section',
    { class: 'show-block' },
    h(
      'div',
      { class: 'show-block-head' },
      h('p', { class: 'eyebrow' }, 'Live vote'),
      h('span', { class: `show-clock${remaining <= 10 ? ' urgent' : ''}` }, `${remaining}s`),
    ),
    h(
      'ul',
      { class: 'tally' },
      beat.options.map((option) => {
        const count = counts[option.key] ?? 0;
        return h(
          'li',
          { class: `tally-row${count > 0 && count === top ? ' leading' : ''}` },
          h('div', {
            class: 'tally-fill',
            style: `width:${total > 0 ? (count / total) * 100 : 0}%`,
          }),
          h('span', { class: 'tally-label' }, option.label),
          h('span', { class: 'tally-count' }, String(count)),
        );
      }),
    ),

    // --- cast ------------------------------------------------------------
    h(
      'div',
      { class: 'show-decide' },
      h(
        'p',
        { class: 'show-decide-label' },
        'Cast — set how many of the room chose each option, then let it close',
      ),
      linked
        ? h(
            'p',
            { class: 'show-note' },
            `Linked to ${snapshot.room} — votes come from the room now.`,
          )
        : h(
            'div',
            { class: 'show-decide-row' },
            h('input', {
              type: 'number',
              min: '0',
              max: String(MAX_SIMULATED),
              value: String(state.simCount),
              class: 'show-count',
              'aria-label': 'How many of the room choose the option you press',
              oninput: (event) => {
                const n = Number(event.target.value);
                if (Number.isInteger(n) && n >= 0 && n <= MAX_SIMULATED) state.simCount = n;
              },
            }),
            beat.options.map((option) =>
              h(
                'button',
                {
                  type: 'button',
                  // Shows where the dial already is for this option, so the
                  // row reads as the state of the room rather than as a set of
                  // identical buttons whose effect you have to remember.
                  onclick: () =>
                    send({
                      name: 'castVotes',
                      optionKey: option.key,
                      count: state.simCount,
                    }),
                },
                `${option.label} · ${counts[option.key] ?? 0}`,
              ),
            ),
          ),
    ),

    // --- force -----------------------------------------------------------
    h(
      'div',
      { class: 'show-decide' },
      h(
        'p',
        { class: 'show-decide-label' },
        'Force — decide it yourself, whatever the tally says',
      ),
      h(
        'div',
        { class: 'show-decide-row' },
        beat.options.map((option) =>
          h(
            'button',
            {
              type: 'button',
              class: 'danger-quiet',
              onclick: () => send({ name: 'forceBranch', optionKey: option.key }),
            },
            option.label,
          ),
        ),
      ),
    ),
  );
}

/**
 * Why a decision was not simply the most votes winning.
 *
 * A short tag rather than the sentence `record.ts` writes, and the difference
 * is the register: this is a line in a list somebody scans during a show, that
 * is a page somebody reads afterwards. Both exist because a forced branch and
 * a landslide are indistinguishable in a table of counts.
 */
function decisionTag(poll) {
  if (poll.forced) return 'decided by you, not by the vote';
  if (poll.usedDefault) return 'nobody voted \u2014 the default was used';
  if (poll.usedTiebreak) return 'tied \u2014 broken by the poll\u2019s rule';
  return null;
}

/**
 * Every poll this show has decided, oldest first.
 *
 * Off the snapshot rather than accumulated here, which is the same rule the
 * tally follows: a board that built this out of the messages it happened to
 * see would show a different history depending on when its window was opened,
 * and the window opened halfway through a show is exactly the one somebody
 * opens to find out what has happened so far.
 */
function recordPanel(snapshot) {
  const polls = snapshot.polls;
  if (!polls || polls.length === 0) return null;
  const live = polls.some((poll) => poll.room !== undefined);

  return h(
    'section',
    { class: 'show-block' },
    h(
      'div',
      { class: 'show-block-head' },
      h('p', { class: 'eyebrow' }, 'Decided so far'),
      h('span', { class: 'show-note' }, `${polls.length} poll${polls.length === 1 ? '' : 's'}`),
    ),
    h(
      'ol',
      { class: 'record' },
      polls.map((poll) => {
        const tag = decisionTag(poll);
        return h(
          'li',
          { class: 'record-row' },
          h('p', { class: 'record-q' }, poll.question),
          h(
            'p',
            { class: 'record-a' },
            h('strong', {}, poll.winnerLabel),
            ` \u00b7 ${poll.total} vote${poll.total === 1 ? '' : 's'}`,
            // Which evidence this is. Simulated ballots and forty phones are
            // not the same thing, and a row that did not say so would be a
            // rehearsal quoted afterwards as a result.
            poll.room !== undefined ? ` \u00b7 room ${poll.room}` : ' \u00b7 rehearsal',
          ),
          h(
            'p',
            { class: 'record-counts' },
            poll.options
              .map((option) => `${option.label} ${poll.counts[option.key] ?? 0}`)
              .join('   \u00b7   '),
          ),
          tag && h('p', { class: 'record-tag' }, tag),
        );
      }),
    ),
    live
      ? h(
          'button',
          {
            type: 'button',
            onclick: async () => {
              try {
                const written = await api('/api/show/record', { method: 'POST' });
                state.onStatus('ok', `Saved to ${written.file}`);
              } catch (err) {
                state.onStatus('error', err.message);
              }
            },
          },
          'Save this to the project',
        )
      : h(
          'p',
          { class: 'show-note' },
          'Rehearsed votes stay here and go when the show does. Once a room is linked, ' +
            'this can be written into the project as a record of what the audience chose.',
        ),
  );
}

// ---------------------------------------------------------------------------
// Going live
// ---------------------------------------------------------------------------

/**
 * Asks the relay for a room, and reports what it said.
 *
 * Three outcomes worth telling apart, which is why this is not a boolean. It
 * worked; the relay would not take the key, which is a thing to fix and puts
 * the form back; or the relay could not be reached at all, which is a thing to
 * wait out. A single "could not go live" would send somebody off to retype a
 * key that was never the problem.
 */
async function goLive(body) {
  state.linking = true;
  render();
  try {
    state.link = await api('/api/show/link', {
      method: 'POST',
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    state.keyForm = state.link.needsKey === true;
    if (state.link.status === 'live') {
      state.onStatus('ok', `Live at ${state.link.room} \u2014 phones can join now.`);
    } else {
      state.onStatus('error', state.link.message ?? 'Could not go live.');
    }
  } catch (err) {
    state.onStatus('error', err.message);
  } finally {
    state.linking = false;
    render();
  }
}

/**
 * The audience-facing half of this window, and the only part of it that anyone
 * outside the room the operator is sitting in is ever affected by.
 *
 * Deliberately near the top and deliberately large. The room code exists to be
 * read off a wall and typed into forty phones; a code in small grey text
 * beside a status pill is a code somebody reads out wrong.
 */
function linkPanel(snapshot) {
  const link = state.link ?? { status: 'off' };
  const live = link.status === 'live' || link.status === 'retrying';

  const head = h(
    'div',
    { class: 'show-block-head' },
    h('p', { class: 'eyebrow' }, 'The audience'),
    live && h('span', { class: 'show-note' }, `${snapshot.presence.players} on the code`),
  );

  if (live) {
    return h(
      'section',
      { class: 'show-block' },
      head,
      // The code out of the snapshot rather than out of the link view: the
      // snapshot is what the projector is showing, and if the two ever
      // disagreed about the code, the wall is the one the audience is reading.
      h('p', { class: 'join-code' }, snapshot.room ?? link.room ?? ''),
      h('p', { class: 'join-url' }, snapshot.joinUrl ?? link.joinUrl ?? ''),
      // True of a link that is working, which is why it is not in with the
      // retry warning below: the room opened, and it is not the room that was
      // asked for.
      link.note && h('p', { class: 'show-warn' }, link.note),
      link.status === 'retrying' &&
        h(
          'p',
          { class: 'show-warn' },
          link.message ??
            'Lost the relay. The room is still open and still taking votes \u2014 trying again.',
        ),
      h(
        'div',
        { class: 'show-row' },
        h(
          'button',
          {
            type: 'button',
            title: 'Drop the connection and pick the same room back up',
            onclick: async () => {
              state.link = await api('/api/show/link/reconnect', { method: 'POST' });
              render();
            },
          },
          'Reconnect',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'danger-quiet',
            onclick: async () => {
              // Behind a confirm, because it is the one control on this tab
              // that ends something for other people: the code stops working
              // and every phone on it is left holding nothing.
              const code = snapshot.room ?? link.room ?? '';
              if (!confirm(`Close room ${code}? Every phone on it is dropped.`)) return;
              state.link = await api('/api/show/unlink', { method: 'POST' });
              state.onStatus('ok', 'Room closed. The show is still running.');
              render();
            },
          },
          'Close the room',
        ),
      ),
    );
  }

  // --- not live ----------------------------------------------------------
  //
  // The absence of a code is the ordinary state and has to look deliberate. A
  // show can now run start to finish with nobody watching from a phone, and
  // the old system could not \u2014 so without a sentence saying so, an
  // unlinked show reads as a broken one.
  const asking = state.keyForm || link.hasKey !== true;

  // One form either way, rather than a form and a bare button. The room code
  // has to be settable without re-entering a key that is already saved — it is
  // the thing that changes between shows, where the key is typed once a year.
  return h(
    'section',
    { class: 'show-block' },
    head,
    h(
      'p',
      { class: 'show-note' },
      'Nobody can join. The show runs fine like this \u2014 going live adds a code the room votes on.',
    ),
    link.status === 'failed' && link.message && h('p', { class: 'show-warn' }, link.message),
    h(
      'form',
      {
        class: 'link-form',
        onsubmit: (event) => {
          event.preventDefault();
          const data = new FormData(event.target);
          void goLive({
            // Always sent, empty included: a blank box means "mint me a code
            // this time", and a name that survived being cleared would be a
            // box with no way out of it.
            name: String(data.get('name') ?? '').trim(),
            ...(asking
              ? {
                  relayUrl: String(data.get('relayUrl') ?? '').trim(),
                  key: String(data.get('key') ?? '').trim(),
                }
              : {}),
          });
        },
      },
      asking && [
        h('label', {}, 'Relay address'),
        h('input', {
          name: 'relayUrl',
          type: 'text',
          placeholder: 'https://relay.example.com',
          value: link.relayUrl ?? '',
        }),
        h('label', {}, 'Key'),
        h('input', {
          name: 'key',
          type: 'text',
          placeholder: 'amber-kestrel-dusk-harbour-quill',
          autocomplete: 'off',
        }),
        h(
          'p',
          { class: 'show-note' },
          // Says where one comes from, because the answer is a page on a
          // different machine that most people will never have seen.
          'Generated in the relay\u2019s own console, at /keys. Typed once \u2014 this machine remembers it.',
        ),
      ],
      h('label', {}, 'Room code'),
      h('input', {
        name: 'name',
        type: 'text',
        placeholder: 'leave empty and the relay picks six characters',
        value: link.name ?? '',
        autocomplete: 'off',
        maxlength: '24',
        spellcheck: 'false',
      }),
      h(
        'p',
        { class: 'show-note' },
        'Remembered with this project. Worth setting: a named room can be walked back ' +
          'into after a crash, with its open vote intact \u2014 a code the relay picked ' +
          'cannot, because nothing can ask for it again.',
      ),
      h(
        'button',
        { type: 'submit', class: 'primary wide', disabled: state.linking },
        state.linking ? 'Opening a room\u2026' : 'Go live',
      ),
      !asking &&
        h(
          'button',
          {
            type: 'button',
            class: 'ghost',
            onclick: () => {
              state.keyForm = true;
              render();
            },
          },
          'Use a different key',
        ),
    ),
  );
}

function render() {
  renderHeader();

  const console_ = $('show-console');
  const snapshot = state.snapshot;

  if (!snapshot) {
    $('show-hint').textContent =
      'Press Play to run the open project on a projector. Nothing here reaches an audience ' +
      'until the show is linked to a relay.';
    console_.replaceChildren(
      h('p', { class: 'empty' }, 'No show is running.'),
    );
    return;
  }

  const beat = snapshot.beatInfo;
  const { text, meta } = describeBeat(beat);
  const isPoll = beat.kind === 'poll';
  const isGate = beat.kind === 'gate';
  const started = snapshot.phase !== 'lobby';
  const blocked = snapshot.phase === 'lobby' ? startBlockedBecause(snapshot) : null;

  $('show-hint').textContent =
    snapshot.room !== undefined
      ? `Linked to ${snapshot.room}. Votes are the room's; simulated voting is off.`
      : 'Running on this machine. Cast rehearses a vote; nobody else can see it.';

  // Collected and filtered rather than passed straight in. `h` drops a null
  // child; `replaceChildren` appends it as the four-character string "null",
  // which is what the console showed where the poll panel goes on every beat
  // that is not a poll.
  const parts = [
    h(
      'section',
      { class: 'show-strip' },
      h(
        'div',
        { class: 'stat' },
        h('span', { class: 'stat-label' }, 'Status'),
        h(
          'span',
          {
            class: `stat-value ${snapshot.phase === 'running' ? 'good' : snapshot.phase === 'paused' ? 'warn' : ''}`,
          },
          snapshot.phase,
        ),
      ),
      h(
        'div',
        { class: 'stat' },
        h('span', { class: 'stat-label' }, 'Stage'),
        h(
          'span',
          {
            class: `stat-value ${snapshot.displayReady && !snapshot.displayMissing ? 'good' : 'warn'}`,
          },
          describeDisplay(snapshot),
        ),
      ),
      h(
        'div',
        { class: 'stat' },
        h('span', { class: 'stat-label' }, 'Sound'),
        h(
          'span',
          { class: `stat-value ${snapshot.audioUnlocked ? 'good' : 'warn'}` },
          snapshot.audioUnlocked ? 'unlocked' : 'not yet',
        ),
      ),
      h(
        'div',
        { class: 'stat' },
        h('span', { class: 'stat-label' }, 'Phones'),
        h('span', { class: 'stat-value' }, String(snapshot.presence.players)),
      ),
    ),

    h(
      'section',
      { class: 'show-block' },
      h('p', { class: 'eyebrow' }, 'On screen now'),
      h('p', { class: 'show-now' }, text),
      h('p', { class: 'show-meta' }, meta),
    ),

    linkPanel(snapshot),

    pollPanel(snapshot),

    h(
      'section',
      { class: 'show-block' },
      blocked && h('p', { class: 'show-warn' }, blocked),
      // The gate's own button, carrying the word the author chose for it.
      // Shown rather than merely enabled: somebody glancing down mid-sentence
      // needs to find the one thing that moves the show on, not pick it out
      // of a row of five.
      isGate &&
        h(
          'button',
          { type: 'button', class: 'primary wide', onclick: () => send({ name: 'continue' }) },
          beat.label ?? 'Continue',
        ),
      !isGate &&
        h(
          'button',
          {
            type: 'button',
            class: 'primary wide',
            disabled:
              snapshot.phase === 'running' || snapshot.phase === 'finished' || blocked !== null,
            onclick: () => send({ name: snapshot.phase === 'paused' ? 'resume' : 'start' }),
          },
          snapshot.phase === 'lobby'
            ? 'Start the show'
            : snapshot.phase === 'paused'
              ? 'Resume'
              : 'Running',
        ),
      h(
        'div',
        { class: 'show-row' },
        h(
          'button',
          { type: 'button', disabled: !started, onclick: () => send({ name: 'back' }) },
          'Back',
        ),
        h(
          'button',
          {
            type: 'button',
            disabled: snapshot.phase !== 'running' || isPoll || isGate,
            onclick: () => send({ name: 'pause' }),
          },
          'Pause',
        ),
        h(
          'button',
          {
            type: 'button',
            disabled: !started || snapshot.phase === 'finished',
            onclick: () => send({ name: 'skip' }),
          },
          'Skip',
        ),
      ),
      h(
        'div',
        { class: 'show-row' },
        h(
          'button',
          {
            type: 'button',
            disabled: !isPoll,
            onclick: () => send({ name: 'extendPoll', seconds: 30 }),
          },
          '+30s',
        ),
        h(
          'button',
          { type: 'button', disabled: !isPoll, onclick: () => send({ name: 'closePoll' }) },
          'Close vote now',
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'danger',
          onclick: () => {
            // Putting the show back to the beginning in front of everyone is
            // not something to do by accident, which is also why the stage's
            // keyboard cannot send it: a key press has no confirm dialog.
            if (confirm('Reset the show to the very beginning? Everyone will see this.')) {
              send({ name: 'reset' });
            }
          },
        },
        'Reset to the beginning',
      ),
    ),

    // Last, and it grows as the show does. Above the transport it would push
    // the buttons somebody reaches for mid-sentence further down the page with
    // every question the room answers.
    recordPanel(snapshot),
  ];

  console_.replaceChildren(...parts.filter(Boolean));
}

// ---------------------------------------------------------------------------
// The header controls
// ---------------------------------------------------------------------------

export async function refreshShow() {
  try {
    state.status = await api('/api/show');
    state.link = state.status.link ?? { status: 'off' };
  } catch {
    // These routes live in this same process, so a failure means the process
    // is gone and every other control is about to fail too. Nothing useful to
    // say that the next click will not say better.
    state.status = null;
  }
  render();
}

/**
 * Keeps the link panel honest between clicks.
 *
 * Polled rather than pushed, and the reason is the same one the relay's own
 * status page gives: the thing being reported on is a connection, and a second
 * connection carrying the report is a second thing that can be broken at the
 * moment somebody is using it to find out what is broken. A retrying link has
 * to be able to say so, and it cannot say so down the wire it has lost.
 *
 * Only the diagnostics come from here. The room code, the phone count and the
 * tally all arrive on the snapshot, because they belong to the show.
 */
async function pollLink() {
  if (!state.status?.running) return;
  let next;
  try {
    next = (await api('/api/show')).link ?? { status: 'off' };
  } catch {
    return;
  }
  // Compared before rendering: this runs every couple of seconds for the whole
  // of a show, and a console that repaints on a timer loses a half-typed
  // number out of the Cast box.
  if (JSON.stringify(next) === JSON.stringify(state.link)) return;
  state.link = next;
  render();
}

/** Opens the projector window, or brings the one we already opened forward. */
function openStage() {
  // Named, so pressing this twice focuses the window rather than opening a
  // second projector showing the same show.
  state.stage = window.open('/stage/', 'is-stage', 'popup,width=1280,height=720');
  state.stage?.focus();
}

export function initShow({ getProject, onStatus, onTab }) {
  state.getProject = getProject;
  state.onStatus = onStatus;

  $('show-play').addEventListener('click', async () => {
    const project = state.getProject();
    if (!project) return;
    try {
      state.status = await api('/api/show/start', {
        method: 'POST',
        body: JSON.stringify({ project }),
      });
      render();
      openStage();
      // Straight to the console. Starting a show is the one action whose next
      // step is always in a different tab, and a Play button that leaves you
      // looking at a prompt box has hidden the thing it just created.
      onTab('show');
      const warnings = state.status.warnings?.length ?? 0;
      onStatus(
        warnings > 0 ? 'warn' : 'ok',
        warnings > 0
          ? `${state.status.scenario.title} is running — ${warnings} warning${warnings === 1 ? '' : 's'} from the checker`
          : `${state.status.scenario.title} is running`,
      );
    } catch (err) {
      onStatus('error', err.message);
    }
  });

  $('show-stage').addEventListener('click', openStage);

  $('show-stop').addEventListener('click', async () => {
    try {
      const result = await api('/api/show/stop', { method: 'POST' });
      state.status = result;
      state.snapshot = null;
      render();
      // The window goes with the show. A projector left showing the last frame
      // of something that has ended is worse than a black screen, because it
      // reads as a show that is still running.
      state.stage?.close();
      state.stage = null;
      onStatus('ok', result.stopped ? 'show stopped' : 'no show was running');
    } catch (err) {
      onStatus('error', err.message);
    }
  });

  connect();
  void refreshShow();

  // The poll clock is the one thing on this tab that changes with no message
  // behind it. A second is enough: the number is whole seconds, and a redraw
  // per frame would be a repaint of the console for a digit that has not moved.
  setInterval(() => {
    if (state.snapshot?.beatInfo.kind === 'poll') render();
  }, 1000);

  setInterval(() => void pollLink(), 2000);
}

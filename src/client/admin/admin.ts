/**
 * The admin console: what's running, and starting something new.
 *
 * This is the one page where tokens are visible, so it is also where we say in
 * plain words which link goes on the projector and which one stays in a pocket.
 */

import type {
  CreateRoomResponse,
  LiveSession,
  ScenarioListResponse,
  SessionListResponse,
} from '../../shared/protocol.ts';

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
};

/** Set when a request comes back 401, so polling stops rather than spinning. */
let signedIn = false;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

function show(which: 'login' | 'admin'): void {
  signedIn = which === 'admin';
  el('view-login').hidden = which !== 'login';
  el('view-admin').hidden = which !== 'admin';
}

/** Drops back to the sign-in screen when the cookie expires mid-session. */
function expired(): void {
  show('login');
  el('login-error').textContent = 'Your session expired. Sign in again.';
  stopRefresh();
}

// ---------------------------------------------------------------------------
// Live sessions
// ---------------------------------------------------------------------------

function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function countdown(endsAt: number, serverNow: number): string {
  const seconds = Math.max(0, Math.round((endsAt - serverNow) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

async function control(code: string, action: 'reset' | 'close'): Promise<void> {
  const response = await fetch(`/api/rooms/${encodeURIComponent(code)}/${action}`, {
    method: 'POST',
  });
  if (response.status === 401) return expired();
  if (!response.ok) {
    window.alert(`Could not ${action} ${code} — the server said ${response.status}.`);
  }
  await loadSessions();
}

function copyLink(button: HTMLButtonElement, url: string): void {
  void navigator.clipboard.writeText(url).then(
    () => {
      const original = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => {
        button.textContent = original;
      }, 1400);
    },
    // Clipboard access fails on an insecure origin, which is exactly the LAN
    // case this project supports — so fall back rather than failing silently.
    () => window.prompt('Copy the host link:', url),
  );
}

function sessionRow(session: LiveSession, serverNow: number): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'session';

  const head = document.createElement('div');
  head.className = 'session-head';

  const code = document.createElement('span');
  code.className = 'session-code';
  code.textContent = session.code;

  const phase = document.createElement('span');
  phase.className = `badge badge-${session.phase}`;
  phase.textContent =
    session.pollEndsAt !== undefined
      ? `voting · ${countdown(session.pollEndsAt, serverNow)}`
      : session.phase;

  const title = document.createElement('span');
  title.className = 'session-title';
  title.textContent = session.scenario.title;

  head.append(code, phase, title);

  const meta = document.createElement('p');
  meta.className = 'session-meta';
  const parts = [
    `at “${session.nodeId}”`,
    `${session.presence.players} phone${session.presence.players === 1 ? '' : 's'}`,
    session.presence.displays > 0
      ? session.displayReady
        ? 'display ready'
        : 'display loading'
      : 'no display',
    ago(serverNow - session.lastActivityAt),
  ];
  meta.textContent = parts.join(' · ');

  const actions = document.createElement('div');
  actions.className = 'session-actions';

  const hostLink = document.createElement('a');
  hostLink.className = 'chip';
  hostLink.href = session.urls.host;
  hostLink.target = '_blank';
  hostLink.rel = 'noopener';
  hostLink.textContent = 'Host console';

  const displayLink = document.createElement('a');
  displayLink.className = 'chip';
  displayLink.href = session.urls.display;
  displayLink.target = '_blank';
  displayLink.rel = 'noopener';
  displayLink.textContent = 'Display';

  const copy = document.createElement('button');
  copy.className = 'chip';
  copy.type = 'button';
  copy.textContent = 'Copy host link';
  copy.addEventListener('click', () => copyLink(copy, session.urls.host));

  const reset = document.createElement('button');
  reset.className = 'chip';
  reset.type = 'button';
  reset.textContent = 'Restart';
  reset.addEventListener('click', () => {
    if (!window.confirm(`Restart ${session.code} from the beginning?\n\nThe room code and everyone connected stay as they are.`)) return;
    void control(session.code, 'reset');
  });

  const end = document.createElement('button');
  end.className = 'chip danger';
  end.type = 'button';
  end.textContent = 'End';
  end.addEventListener('click', () => {
    if (!window.confirm(`End ${session.code} for good?\n\nEveryone is disconnected and the code stops working. This cannot be undone.`)) return;
    void control(session.code, 'close');
  });

  actions.append(hostLink, displayLink, copy, reset, end);
  item.append(head, meta, actions);
  return item;
}

async function loadSessions(): Promise<void> {
  const list = el('sessions');
  const meta = el('sessions-meta');

  let data: SessionListResponse;
  try {
    const response = await fetch('/api/rooms');
    if (response.status === 401) return expired();
    if (!response.ok) throw new Error(`Server said ${response.status}`);
    data = (await response.json()) as SessionListResponse;
  } catch {
    meta.textContent = 'could not reach the server';
    return;
  }

  meta.textContent =
    data.sessions.length === 0
      ? 'none running'
      : `${data.sessions.length} running`;

  list.innerHTML = '';
  if (data.sessions.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No sessions running.';
    list.appendChild(empty);
    return;
  }

  for (const session of data.sessions) {
    list.appendChild(sessionRow(session, data.serverNow));
  }
}

function startRefresh(): void {
  stopRefresh();
  // Cheap enough to poll: a handful of rooms and one small JSON body. A socket
  // would be tidier but would need its own auth path for no real gain here.
  refreshTimer = setInterval(() => {
    if (signedIn && !document.hidden) void loadSessions();
  }, 4000);
}

function stopRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = undefined;
}

// Coming back to the tab should show the truth immediately, not up to 4s late.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && signedIn) void loadSessions();
});

// ---------------------------------------------------------------------------
// Starting a session
// ---------------------------------------------------------------------------

async function createRoom(scenarioId: string, button: HTMLButtonElement): Promise<void> {
  const meta = button.querySelector('.scenario-meta')!;
  button.disabled = true;
  const original = meta.textContent;
  meta.textContent = 'creating…';

  try {
    const response = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenarioId }),
    });
    if (response.status === 401) return expired();
    if (!response.ok) throw new Error(`Server said ${response.status}`);

    const room = (await response.json()) as CreateRoomResponse;

    el('created-code').textContent = room.code;
    el<HTMLAnchorElement>('open-display').href = room.urls.display;
    el<HTMLAnchorElement>('open-host').href = room.urls.host;
    el('created-join').textContent = room.urls.join.replace(/^https?:\/\//, '');
    el('created').hidden = false;
    el('created').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    await loadSessions();
  } catch (error) {
    meta.textContent = 'failed';
    console.error(error);
    return;
  } finally {
    button.disabled = false;
    if (meta.textContent === 'creating…') meta.textContent = original;
  }
}

async function loadScenarios(): Promise<void> {
  const list = el('scenarios');

  let data: ScenarioListResponse;
  try {
    const response = await fetch('/api/scenarios');
    data = (await response.json()) as ScenarioListResponse;
  } catch {
    list.innerHTML = '<li class="empty">Could not reach the server.</li>';
    return;
  }

  list.innerHTML = '';

  if (data.scenarios.length === 0) {
    list.innerHTML =
      '<li class="empty">No scenarios found. Add a folder under <code>scenarios/</code>.</li>';
  }

  for (const scenario of data.scenarios) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'scenario';
    button.type = 'button';

    const main = document.createElement('span');
    main.className = 'scenario-main';

    const title = document.createElement('span');
    title.className = 'scenario-title';
    title.textContent = scenario.title;

    const description = document.createElement('span');
    description.className = 'scenario-desc';
    description.textContent = scenario.description ?? '';

    main.append(title, description);

    const meta = document.createElement('span');
    meta.className = 'scenario-meta';
    meta.textContent = `${scenario.polls} vote${scenario.polls === 1 ? '' : 's'}`;

    button.append(main, meta);
    button.addEventListener('click', () => void createRoom(scenario.id, button));
    item.appendChild(button);
    list.appendChild(item);
  }

  // A scenario that failed to load is surfaced rather than silently missing —
  // otherwise you discover it by not finding the one you wanted.
  if (data.failures.length > 0) {
    el('failures').hidden = false;
    const failureList = el('failure-list');
    failureList.innerHTML = '';
    for (const failure of data.failures) {
      const item = document.createElement('li');
      item.innerHTML = `<code>${failure.dir}</code> — ${failure.message}`;
      if (failure.problems.length > 0) {
        const sub = document.createElement('ul');
        for (const problem of failure.problems) {
          const line = document.createElement('li');
          line.textContent = problem;
          sub.appendChild(line);
        }
        item.appendChild(sub);
      }
      failureList.appendChild(item);
    }
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function enter(): Promise<void> {
  show('admin');
  await Promise.all([loadScenarios(), loadSessions()]);
  startRefresh();
}

async function signIn(password: string): Promise<void> {
  const error = el('login-error');
  error.textContent = '';

  const response = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });

  if (!response.ok) {
    error.textContent =
      response.status === 401
        ? 'That password is not right.'
        : `Sign-in failed (${response.status}).`;
    return;
  }

  await enter();
}

el('login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void signIn(el<HTMLInputElement>('password').value);
});

el('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  el<HTMLInputElement>('password').value = '';
  stopRefresh();
  show('login');
});

/** Decide which screen to show before painting, so neither flashes. */
async function boot(): Promise<void> {
  try {
    const { authenticated } = (await (await fetch('/api/session')).json()) as {
      authenticated: boolean;
    };
    if (authenticated) {
      await enter();
      return;
    }
  } catch {
    /* fall through to the sign-in screen */
  }
  show('login');
  el<HTMLInputElement>('password').focus();
}

void boot();

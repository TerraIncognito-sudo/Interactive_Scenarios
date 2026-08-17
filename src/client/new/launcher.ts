/**
 * The landing page: pick a scenario, get the three links.
 *
 * This is where the tokens are handed out, and the only place they appear
 * together — so it is also where we tell the operator, in plain words, which
 * link goes on the projector and which one stays in their pocket.
 */

import type { CreateRoomResponse, ScenarioListResponse } from '../../shared/protocol.ts';

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
};

async function createRoom(scenarioId: string, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  const original = button.querySelector('.scenario-meta')!.textContent;
  button.querySelector('.scenario-meta')!.textContent = 'creating…';

  try {
    const response = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenarioId }),
    });
    if (response.status === 401) {
      // The cookie expired while the page sat open.
      show('login');
      el('login-error').textContent = 'Your session expired. Sign in again.';
      return;
    }
    if (!response.ok) throw new Error(`Server said ${response.status}`);

    const room = (await response.json()) as CreateRoomResponse;

    el('created-code').textContent = room.code;
    el<HTMLAnchorElement>('open-display').href = room.urls.display;
    // Carry the display token through so the host console can show its link.
    el<HTMLAnchorElement>('open-host').href =
      `${room.urls.host}&displayToken=${encodeURIComponent(room.displayToken)}`;
    el('created-join').textContent = room.urls.join.replace(/^https?:\/\//, '');
    el('created').hidden = false;
    el('created').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    button.querySelector('.scenario-meta')!.textContent = 'failed';
    console.error(error);
    return;
  } finally {
    button.disabled = false;
    if (button.querySelector('.scenario-meta')!.textContent === 'creating…') {
      button.querySelector('.scenario-meta')!.textContent = original;
    }
  }
}

function show(which: 'login' | 'launcher'): void {
  el('view-login').hidden = which !== 'login';
  el('view-launcher').hidden = which !== 'launcher';
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
      response.status === 401 ? 'That password is not right.' : `Sign-in failed (${response.status}).`;
    return;
  }

  show('launcher');
  await load();
}

async function load(): Promise<void> {
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

el('login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void signIn(el<HTMLInputElement>('password').value);
});

el('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  el<HTMLInputElement>('password').value = '';
  show('login');
});

/** Decide which screen to show before painting, so neither flashes. */
async function boot(): Promise<void> {
  try {
    const { authenticated } = (await (await fetch('/api/session')).json()) as {
      authenticated: boolean;
    };
    if (authenticated) {
      show('launcher');
      await load();
      return;
    }
  } catch {
    /* fall through to the sign-in screen */
  }
  show('login');
  el<HTMLInputElement>('password').focus();
}

void boot();

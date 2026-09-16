/**
 * Where the keys are.
 *
 * The one place a passphrase exists in a form somebody can read out. Phrases
 * are listed in the clear on purpose — a key you can only see once is a key
 * that ends up on a sticky note — and `server/keys.ts` carries the argument
 * for why that is an acceptable trade behind this password.
 *
 * Two things this page has to say plainly, because getting them wrong is
 * expensive in opposite directions. Revoking does **not** stop a running show,
 * so somebody who revokes a key in an emergency and walks away has not done
 * what they think. And a revoked key stays on the list, greyed, because one
 * that vanished would be re-issued by accident to the machine it was taken
 * from.
 */

import { api, ago, el, requireSignIn, when } from '../console/session.ts';
import type { RelayKeysResponse, RelayKeyView } from '../../../shared/relay/protocol.ts';

const list = el('keys');
const issuedPanel = el('issued');
const tick = el('tick');

function card(key: RelayKeyView, now: number): HTMLElement {
  const node = document.createElement('section');
  node.className = key.revokedAt !== undefined ? 'card muted' : 'card';

  const head = document.createElement('div');
  head.className = 'card-head';

  const label = document.createElement('b');
  label.textContent = key.label;
  head.append(label);

  if (key.revokedAt !== undefined) {
    const pill = document.createElement('span');
    pill.className = 'pill gone';
    pill.textContent = `revoked ${when(key.revokedAt)}`;
    head.append(pill);
  } else if (key.openRooms > 0) {
    const pill = document.createElement('span');
    pill.className = 'pill live';
    pill.textContent = `${key.openRooms} room${key.openRooms === 1 ? '' : 's'} open`;
    head.append(pill);
  }
  node.append(head);

  const phrase = document.createElement('div');
  phrase.className = 'phrase';
  phrase.textContent = key.phrase;
  node.append(phrase);

  const facts = document.createElement('ul');
  facts.className = 'facts';
  const fact = (text: string): void => {
    const item = document.createElement('li');
    item.textContent = text;
    facts.append(item);
  };
  fact(`made ${when(key.createdAt)}`);
  // "Never used" is the fact that makes revoking safe to do rather than merely
  // possible: a key nobody has presented in four months can go without a phone
  // call first.
  fact(key.lastUsedAt !== undefined ? `last used ${ago(key.lastUsedAt, now)}` : 'never used');
  node.append(facts);

  if (key.revokedAt === undefined) {
    const actions = document.createElement('div');
    actions.className = 'actions';
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.className = 'danger';
    revoke.textContent = 'Revoke';
    revoke.addEventListener('click', async () => {
      const running =
        key.openRooms > 0
          ? `\n\n${key.openRooms} room${key.openRooms === 1 ? '' : 's'} opened with it will keep running. End ${key.openRooms === 1 ? 'it' : 'them'} on the Rooms page if that is what you want.`
          : '';
      if (!confirm(`Revoke "${key.label}"?\n\nIt will not open any more rooms.${running}`)) return;
      revoke.disabled = true;
      try {
        await api(`/api/keys/${key.id}/revoke`, { method: 'POST' });
      } finally {
        await refresh();
      }
    });
    actions.append(revoke);
    node.append(actions);
  }

  return node;
}

async function refresh(): Promise<void> {
  let keys: RelayKeysResponse;
  try {
    keys = await api<RelayKeysResponse>('/api/keys');
  } catch (err) {
    tick.textContent = (err as Error).message;
    return;
  }

  const now = Date.now();
  const live = keys.keys.filter((key) => key.revokedAt === undefined);
  const gone = keys.keys.filter((key) => key.revokedAt !== undefined);

  tick.textContent = live.length === 0 ? 'no keys — this relay opens no rooms' : '';

  const parts: HTMLElement[] = [];
  if (live.length === 0 && gone.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent =
      'No keys yet, so this relay will refuse every client. Generate one above and paste it into the client once.';
    parts.push(empty);
  }
  if (live.length > 0) {
    parts.push(heading('Active'), ...live.map((key) => card(key, now)));
  }
  if (gone.length > 0) {
    parts.push(heading('Revoked'), ...gone.map((key) => card(key, now)));
  }
  list.replaceChildren(...parts);
}

function heading(text: string): HTMLElement {
  const node = document.createElement('h2');
  node.textContent = text;
  return node;
}

el<HTMLFormElement>('issue').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = el<HTMLInputElement>('label');
  const error = el('issue-error');
  error.textContent = '';

  let made: { label: string; phrase: string };
  try {
    made = await api('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ label: input.value }),
    });
  } catch (err) {
    error.textContent = (err as Error).message;
    return;
  }

  input.value = '';
  // Shown large and on its own, because the next thing that happens is
  // somebody reading it down a phone line or typing it into another machine.
  const panel = document.createElement('section');
  panel.className = 'card issued';
  const head = document.createElement('div');
  head.className = 'card-head';
  head.append(Object.assign(document.createElement('b'), { textContent: `New key — ${made.label}` }));
  const phrase = document.createElement('div');
  phrase.className = 'phrase';
  phrase.textContent = made.phrase;
  const note = document.createElement('p');
  note.className = 'facts';
  note.textContent = 'Paste this into the client once. It stays listed below, so it is not lost.';
  panel.append(head, phrase, note);
  issuedPanel.replaceChildren(panel);

  await refresh();
});

await requireSignIn();
await refresh();

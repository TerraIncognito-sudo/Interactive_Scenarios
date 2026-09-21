/**
 * What is running right now.
 *
 * This page exists for one evening that has already happened: a room of forty
 * people say "it says no such room", and you are standing at the back holding
 * a phone. Without it the answer is `docker logs` over SSH from a venue.
 *
 * So it says the small number of things somebody in that position needs — the
 * code, whether anyone is connected to it, whether a question is open, and
 * which key opened it — and offers exactly one action, which is to end a room
 * that is stuck. It cannot start anything. It no longer lists scenarios,
 * because the relay has none, and it no longer hands out a token, because
 * there is no longer a link that could be lost.
 */

import { api, ago, el, requireSignIn, when } from '../console/session.ts';
import type { RelayRoomView, RelayStatusResponse } from '../../../shared/relay/protocol.ts';

const rooms = el('rooms');
const tick = el('tick');

function card(room: RelayRoomView, now: number): HTMLElement {
  const node = document.createElement('section');
  node.className = 'card';

  const head = document.createElement('div');
  head.className = 'card-head';

  const code = document.createElement('span');
  code.className = 'code';
  code.textContent = room.code;
  head.append(code);

  if (room.title) {
    const title = document.createElement('span');
    title.className = 'title-tag';
    title.textContent = room.title;
    head.append(title);
  }

  const client = document.createElement('span');
  // The distinction that matters at the back of a room: a room with no client
  // is not broken, it is waiting — and it is still taking votes.
  client.className = `pill ${room.clientConnected ? 'live' : 'away'}`;
  client.textContent = room.clientConnected ? 'client connected' : 'client away';
  head.append(client);

  if (room.poll) {
    const poll = document.createElement('span');
    poll.className = `pill ${room.poll.closed ? '' : 'live'}`.trim();
    poll.textContent = room.poll.closed
      ? `voting closed — ${room.poll.nodeId}`
      : `voting open — ${room.poll.nodeId}`;
    head.append(poll);
  }

  node.append(head);

  const facts = document.createElement('ul');
  facts.className = 'facts';
  const fact = (label: string, value: string): void => {
    const item = document.createElement('li');
    const strong = document.createElement('b');
    strong.textContent = value;
    item.append(strong, ` ${label}`);
    facts.append(item);
  };
  fact(room.players === 1 ? 'phone' : 'phones', String(room.players));
  fact('opened', when(room.createdAt));
  fact('active', ago(room.lastActivityAt, now));
  if (room.keyLabel) fact('key', room.keyLabel);
  node.append(facts);

  const join = document.createElement('p');
  join.className = 'facts';
  const link = document.createElement('a');
  link.href = room.joinUrl;
  link.textContent = room.joinUrl;
  join.append(link);
  node.append(join);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const end = document.createElement('button');
  end.type = 'button';
  end.className = 'danger';
  end.textContent = 'End this room';
  end.addEventListener('click', async () => {
    // A confirm naming the code, because the button is one row away from the
    // room next to it and this one cannot be undone.
    if (!confirm(`End room ${room.code}? Every phone in it will be told it has closed.`)) return;
    end.disabled = true;
    try {
      await api(`/api/rooms/${room.code}/close`, { method: 'POST' });
    } finally {
      await refresh();
    }
  });
  actions.append(end);
  node.append(actions);

  return node;
}

async function refresh(): Promise<void> {
  let status: RelayStatusResponse;
  try {
    status = await api<RelayStatusResponse>('/api/rooms');
  } catch (err) {
    tick.textContent = (err as Error).message;
    return;
  }

  tick.textContent = `updated ${new Date().toLocaleTimeString()}`;

  if (status.rooms.length === 0) {
    rooms.replaceChildren(
      Object.assign(document.createElement('p'), {
        className: 'empty',
        textContent:
          'No rooms are open. One appears here when a client goes live with a key from the Keys page.',
      }),
    );
    return;
  }

  rooms.replaceChildren(...status.rooms.map((room) => card(room, status.serverNow)));
}

await requireSignIn();
await refresh();
// Polled rather than pushed. A socket here would be a second thing that can be
// broken at the moment somebody is using this page to find out what is broken.
setInterval(() => void refresh(), 5000);

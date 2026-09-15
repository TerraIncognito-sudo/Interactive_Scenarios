/**
 * The Scenes tab: a place, and the four things that hang off it.
 *
 * A scene was the one part of a scenario with no way in but the text pane, and
 * the cost of that was not theoretical. `video:` on a scene is how a moving
 * background is declared; an author who could not see the field put the clip on
 * each node instead, which is legal, which is what the poster-frame warning is
 * for, and which is how one project ended up declaring the same clip six times.
 * A field nobody can see is a field nobody uses.
 *
 * Every asset box is the same datalist the Nodes tab uses, for the same reason
 * written down there: a scene is a place and a place gets several shots, so the
 * second shot wants the first one's still character for character — but an asset
 * is routinely declared before it exists, so the list offers without insisting.
 */

import { $, h } from './dom.js';

/** Injected by app.js so this module needs to know nothing about the rest. */
let ctx = null;

export function initScenes(context) {
  ctx = context;
}

/**
 * What the last render was given, so a control inside the list can redraw
 * without the caller handing it all back.
 */
let view = { scenario: null, assets: {} };

/** Which scene sheets are open. Ids, so a re-render keeps them open. */
const open = new Set();

/** The four fields, and which section's files each one offers. */
const FIELDS = [
  ['background', 'images', 'the still this place is painted with'],
  ['video', 'video', 'a looping clip over the still, which stays as its poster frame'],
  ['music', 'music', 'a bed that persists across every beat here'],
  ['ambience', 'ambience', 'room tone, also across every beat here'],
];

// ---------------------------------------------------------------------------
// Talking to the server
// ---------------------------------------------------------------------------

/** One edit, and everything that has to follow it — see `act` in nodes.js. */
async function act(action, body, method = 'POST') {
  const name = ctx.projectName();
  if (!name) return null;

  ctx.setStatus('', 'saving…');
  let response;
  try {
    response = await fetch(`/api/projects/${encodeURIComponent(name)}/${action}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    ctx.setStatus('bad', 'the editor server is not answering');
    return null;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    ctx.setStatus('bad', data.error ?? 'that edit was refused');
    if (Array.isArray(data.problems) && data.problems.length > 0) {
      ctx.showProblems(data.error ?? 'That edit was refused', data.problems);
    }
    return null;
  }

  await ctx.afterEdit(data);
  return data;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/**
 * A box that offers what the scenario already names, then what is on disk and
 * unclaimed. The second list is the way back for a picture somebody rendered
 * and never wired up, which the board otherwise only offers to delete.
 */
function assetField(label, value, section, hint, onCommit) {
  const used = view.assets?.[section] ?? [];
  const spare = (ctx.spareAssets?.() ?? {})[section] ?? [];
  const options = [...used, ...spare.filter((file) => !used.includes(file))];
  const listId = `scene-${label}-${Math.random().toString(36).slice(2, 7)}`;

  return h(
    'label',
    { class: 'nf wide' },
    h('span', {}, label),
    h('input', {
      list: listId,
      class: 'listed',
      value: value ?? '',
      placeholder: hint,
      onchange: (event) => {
        const raw = event.target.value.trim();
        // An emptied box clears the key rather than writing `''`. A scene that
        // paints nothing is a real choice and has to stay distinguishable from
        // one nobody has filled in yet — and the schema rejects the empty
        // string, so writing it would produce a file that will not load.
        onCommit(raw === '' ? null : raw);
      },
    }),
    h('datalist', { id: listId }, options.map((option) => h('option', { value: option }))),
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Which nodes play in a place, which is what makes a scene worth opening. */
function usersOf(scenario, id) {
  return (scenario.nodes ?? []).filter((node) => node.scene === id).map((node) => node.id);
}

function sheet(scenario, id, scene) {
  const users = usersOf(scenario, id);
  const isLobby = scenario.lobby === id;
  const expanded = open.has(id);

  const header = h(
    'div',
    { class: 'scene-head' },
    h(
      'button',
      {
        class: 'scene-name',
        onclick: () => {
          if (expanded) open.delete(id);
          else open.add(id);
          redraw();
        },
      },
      h('span', { class: 'twist' }, expanded ? '▾' : '▸'),
      h('code', {}, id),
    ),
    // The count is the answer to "can I delete this", so it is on the header
    // rather than inside the sheet somebody would have to open to find it.
    h(
      'span',
      { class: 'scene-uses' },
      users.length === 0 ? 'unused' : `${users.length} node${users.length === 1 ? '' : 's'}`,
    ),
    isLobby ? h('span', { class: 'badge' }, 'lobby') : null,
  );

  if (!expanded) return h('div', { class: 'scene' }, header);

  const fields = FIELDS.map(([field, section, hint]) =>
    assetField(field, scene?.[field], section, hint, (value) =>
      act('scene', { id, field, value }, 'PATCH'),
    ),
  );

  const actions = h(
    'div',
    { class: 'scene-actions' },
    h(
      'button',
      {
        onclick: async () => {
          const to = prompt(`Rename scene "${id}" to:`, id);
          if (!to || to === id) return;
          // Its own action, not a field edit: an id is the only value other
          // lines depend on by name, so the key, every node's `scene:` and the
          // lobby move together or not at all.
          await act('scene-id', { id, to });
        },
      },
      'Rename',
    ),
    h(
      'button',
      {
        // The lobby is what the room looks at while it fills up, which is the
        // longest anything in the show is on screen.
        onclick: () => act('lobby', { id: isLobby ? null : id }),
      },
      isLobby ? 'Not the lobby' : 'Use as lobby',
    ),
    h(
      'button',
      {
        class: 'danger',
        disabled: users.length > 0,
        title:
          users.length > 0
            ? `Still used by ${users.join(', ')}`
            : 'Remove this scene from the scenario',
        onclick: async () => {
          if (!confirm(`Remove scene "${id}"? Its files stay on disk.`)) return;
          await act('scene-delete', { id });
        },
      },
      'Remove',
    ),
  );

  return h(
    'div',
    { class: 'scene open' },
    header,
    h('div', { class: 'scene-body' }, h('div', { class: 'nf-grid' }, fields), actions),
    users.length > 0
      ? h(
          'p',
          { class: 'scene-users' },
          'Played by ',
          users.map((node, i) => [
            i > 0 ? ', ' : '',
            h('button', { class: 'linkish', onclick: () => ctx.jumpTo?.(node) }, node),
          ]),
        )
      : null,
  );
}

function redraw() {
  renderScenes(view.scenario, view.assets);
}

export function renderScenes(scenario, assets) {
  view = { scenario, assets: assets ?? {} };
  const panel = $('scenes-list');
  if (!panel) return;

  if (!scenario) {
    panel.replaceChildren(h('p', { class: 'empty' }, 'Open a project to see its scenes.'));
    return;
  }

  const scenes = Object.entries(scenario.scenes ?? {});
  const lobby = scenario.lobby;

  const head = h(
    'div',
    { class: 'scenes-bar' },
    h(
      'button',
      {
        onclick: async () => {
          const id = prompt('New scene id (lowercase letters, digits, underscores):', '');
          if (!id) return;
          await act('scene-add', { id: id.trim() });
          open.add(id.trim());
        },
      },
      'Add a scene',
    ),
    // Said here as well as on the sheet, because a lobby pointing nowhere is
    // invisible until a room is already sitting in front of it.
    h(
      'span',
      { class: 'scenes-lobby' },
      lobby
        ? ['Lobby: ', h('code', {}, lobby)]
        : 'No lobby scene — the projector shows a plain background before the show.',
    ),
  );

  if (scenes.length === 0) {
    panel.replaceChildren(
      head,
      h('p', { class: 'empty' }, 'This scenario declares no scenes yet.'),
    );
    return;
  }

  panel.replaceChildren(head, ...scenes.map(([id, scene]) => sheet(scenario, id, scene)));
}

/**
 * The Nodes tab: the story, editable.
 *
 * Every control here writes `scenario.yaml` through the editor's server, which
 * edits by source offset — so the author's comments and hand-wrapped folded
 * scalars survive a drag or a retyped line. Nothing in this file builds YAML.
 *
 * Two rules shape the whole view.
 *
 * **The list is the presentation order.** Dragging a node moves its block in
 * the file and splices the three `next` pointers around it, so what is on
 * screen top-to-bottom is what the room will see first-to-last. Poll options
 * and branch conditions are never touched by a drag: they are deliberate jumps,
 * and the server reports the ones it left alone rather than guessing.
 *
 * **A field commits on `change`, not on every keystroke.** Each commit is a
 * file write, a re-parse and an asset reconcile; per-keystroke would mean
 * writing a syntactically half-finished value dozens of times per sentence, and
 * the reconcile would mark clips stale against text nobody had finished typing.
 */

import { $, h, flowRow } from './dom.js';

/** Injected by app.js so this module needs to know nothing about the rest. */
let ctx = null;

export function initNodes(context) {
  ctx = context;
}

/** Which node cards are open. Ids, so a re-render keeps them open. */
const open = new Set();

/** The node being dragged, and where it would land. */
let dragging = null;

/**
 * The list entry being dragged, if any: `{ nodeId, path, index }`.
 *
 * Separate from `dragging` and checked by both, because an entry lives inside
 * the very element that handles node dragging. Without the guard, picking up a
 * line would also pick up its node and the drop would move the beat instead of
 * the words in it.
 */
let entryDrag = null;

/**
 * What the last render was given, so a control inside the list can redraw
 * without the caller handing it all back. `renderNodes` is called from the
 * analysis; opening a card, or dragging inside one, is not.
 */
let view = { analysis: null, scenario: null, assets: {} };

const TYPES = ['dialogue', 'gate', 'pause', 'poll', 'branch', 'end'];

const TYPE_BLURB = {
  dialogue: 'Lines of speech or narration, one beat each.',
  gate: 'Holds until the moderator presses the button. Nothing counts down.',
  pause: 'A silent beat of a fixed length.',
  poll: 'The audience votes; the winning option chooses what happens next.',
  branch: 'Invisible. Reads a variable and routes, taking no time at all.',
  end: 'A finish. The show stops here.',
};

// ---------------------------------------------------------------------------
// Talking to the server
// ---------------------------------------------------------------------------

/**
 * One structural edit, and everything that has to follow it.
 *
 * The source pane keeps its own copy of the file. Refresh it late and the
 * analysis overwrites this status line; do not refresh it at all and the next
 * Save quietly reverts whatever was just done here. So the new source goes
 * back into the pane before anything is reported.
 */
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

/** What an edit did, in the order a person cares about it. */
export function describeWork(data) {
  const parts = [];
  // Notes first: they are the ones that record something being lost, and a
  // dropped paragraph matters more than a pointer that moved one place.
  for (const note of data.notes ?? []) parts.push(note);
  for (const move of data.rewired ?? []) parts.push(`${move.nodeId} → ${move.to}`);
  const warnings = data.warnings ?? [];
  if (warnings.length > 0) {
    parts.push(`${warnings.length} pointer${warnings.length === 1 ? '' : 's'} left alone`);
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/**
 * One labelled input that writes itself back on commit.
 *
 * An emptied box clears the key rather than writing `''`: the schema rejects an
 * empty string, so "no text" and "the empty string" have to stay different
 * things or clearing a field would produce a file that will not load.
 */
function field(label, value, onCommit, opts = {}) {
  const input = h('input', {
    type: opts.type ?? 'text',
    value: value ?? '',
    placeholder: opts.placeholder ?? '',
    ...(opts.step ? { step: opts.step } : {}),
    onchange: (event) => {
      const raw = event.target.value.trim();
      if (raw === '') return void onCommit(null);
      onCommit(opts.type === 'number' ? Number(raw) : raw);
    },
  });
  return h('label', { class: `nf${opts.wide ? ' wide' : ''}` }, h('span', {}, label), input);
}

/**
 * A multi-line box, for the fields that are usually a paragraph.
 *
 * The value goes in as a child rather than as a `value` attribute: a textarea
 * has no such attribute, so setting one leaves the box silently empty — and an
 * empty box that commits on change is a field that erases the line it was
 * supposed to be editing the moment anybody tabs through it.
 */
function textArea(label, value, onCommit) {
  return h(
    'label',
    { class: 'nf wide' },
    h('span', {}, label),
    h(
      'textarea',
      {
        rows: '2',
        spellcheck: 'true',
        onchange: (event) => {
          const raw = event.target.value.trim();
          onCommit(raw === '' ? null : raw);
        },
      },
      value ?? '',
    ),
  );
}

function choice(label, value, options, onCommit) {
  const select = h(
    'select',
    { onchange: (event) => onCommit(event.target.value) },
    options.map((option) => h('option', { value: option, selected: option === value }, option)),
  );
  return h('label', { class: 'nf' }, h('span', {}, label), select);
}

/**
 * A field whose value is almost always one of a known set.
 *
 * A datalist rather than a `<select>`, and that is the whole design. Every one
 * of these fields is a name that has to match something else exactly — a node
 * id, a scene id, a file the display will open — so typing one by hand is how a
 * scenario ends up with a dangling pointer or a background that is one
 * character from a real file. But none of them is a *closed* set: a `next:` can
 * name a node about to be added, and an asset is routinely declared before it
 * has been made, which is what puts it on the board to be made in the first
 * place. A dropdown that refused a new name would break the pipeline's own
 * order of work, so this offers without insisting.
 */
function pickField(label, value, options, onCommit, opts = {}) {
  const listId = `pick-${label.replace(/\W/g, '')}-${Math.random().toString(36).slice(2, 7)}`;
  return h(
    'label',
    { class: `nf${opts.wide ? ' wide' : ''}` },
    h('span', {}, label),
    h('input', {
      list: listId,
      class: 'listed',
      value: value ?? '',
      placeholder: opts.placeholder ?? '',
      onchange: (event) => {
        const raw = event.target.value.trim();
        onCommit(raw === '' ? null : raw);
      },
    }),
    h('datalist', { id: listId }, options.map((option) => h('option', { value: option }))),
  );
}

/** A field naming another node. */
function nodeField(label, value, ids, onCommit) {
  return pickField(label, value, ids, onCommit);
}

/**
 * A field naming a file in one of the six sections.
 *
 * Two lists, in one: what the scenario already asks for, then what is sitting
 * in `assets/<section>/` unclaimed. The first is where reuse comes from — a
 * scene is a place and a place gets several shots, so the second shot wants the
 * first one's still, character for character. The second is the way back for a
 * picture somebody made and never wired up, which the board otherwise only
 * offers to delete.
 */
function assetField(label, value, section, onCommit, placeholder) {
  const used = view.assets?.[section] ?? [];
  const spare = (ctx.spareAssets?.() ?? {})[section] ?? [];
  const options = [...used, ...spare.filter((file) => !used.includes(file))];
  return pickField(label, value, options, onCommit, { placeholder });
}

/** A field naming one of the scenario's scenes. */
function sceneField(value, onCommit) {
  const scenes = Object.keys(view.scenario?.scenes ?? {});
  return pickField('scene', value, scenes, onCommit, { placeholder: 'scene id' });
}

// ---------------------------------------------------------------------------
// The per-type form
// ---------------------------------------------------------------------------

/**
 * What a retype is about to cost, or null when it costs nothing worth asking
 * about.
 *
 * The server is the authority on what actually gets dropped and reports it
 * afterwards; this is the question asked first, because the expensive half is
 * always the same half — the lines, options or conditions that are the node's
 * real content — and it is visible from the node itself. Erring towards asking:
 * a needless confirmation is a keystroke, and the other mistake is a paragraph.
 */
function retypeCost(node, to) {
  if (node.type === 'dialogue') {
    const count = node.lines?.length ?? 0;
    // One line's words survive into a `text:`; several have no one sentence to
    // become, so they go. Mirrors `carriedText`.
    const kept = count === 1 && (to === 'pause' || to === 'gate' || to === 'end');
    return kept ? null : `${count} line${count === 1 ? '' : 's'}`;
  }
  if (node.type === 'poll') return `the question and ${node.options.length} options`;
  if (node.type === 'branch') {
    const count = node.when.length;
    return `${count} condition${count === 1 ? '' : 's'}`;
  }
  return null;
}

/**
 * Changing what kind of beat a node is.
 *
 * Its own action rather than an edit to a `type` box: `type` is the schema's
 * discriminator, so writing it alone leaves a node holding fields its new type
 * rejects and a file that will not load. The server moves the type and the
 * shape together, supplies whatever the new type insists on, and says what it
 * had to drop.
 */
function typeField(node) {
  return h(
    'label',
    { class: 'nf' },
    h('span', {}, 'type'),
    h(
      'select',
      {
        onchange: (event) => {
          const to = event.target.value;
          if (to === node.type) return;
          const cost = retypeCost(node, to);
          if (cost && !confirm(`Turn "${node.id}" into ${to}? That loses ${cost}.`)) {
            event.target.value = node.type;
            return;
          }
          act('node-type', { id: node.id, to });
        },
      },
      TYPES.map((type) =>
        h('option', { value: type, selected: type === node.type, title: TYPE_BLURB[type] }, type),
      ),
    ),
  );
}

function formFor(node, ids) {
  const set = (path, value, after) => act('node', { id: node.id, path, value, after }, 'PATCH');
  const rows = [];

  // Identity first: it is the thing every other node points at.
  rows.push(
    field('id', node.id, (value) => {
      if (value && value !== node.id) act('node-id', { id: node.id, to: value });
    }),
  );
  rows.push(typeField(node));

  // A scene is a place; a background or clip is this shot's own picture.
  rows.push(sceneField(node.scene, (v) => set(['scene'], v, 'type')));
  rows.push(assetField('background', node.background, 'images', (v) => set(['background'], v), 'images/…'));
  rows.push(assetField('video', node.video, 'video', (v) => set(['video'], v), 'video/…'));

  switch (node.type) {
    case 'dialogue':
      rows.push(nodeField('next', node.next, ids, (v) => set(['next'], v)));
      break;

    case 'gate':
      rows.push(textArea('text', node.text, (v) => set(['text'], v)));
      rows.push(
        field('button', node.label, (v) => set(['label'], v), { placeholder: 'Continue' }),
      );
      rows.push(assetField('sfx', node.sfx, 'sfx', (v) => set(['sfx'], v), 'sfx/…'));
      rows.push(nodeField('next', node.next, ids, (v) => set(['next'], v)));
      break;

    case 'pause':
      rows.push(
        field('duration', node.duration, (v) => set(['duration'], v), { type: 'number', step: '0.1' }),
      );
      rows.push(textArea('text', node.text, (v) => set(['text'], v)));
      rows.push(assetField('sfx', node.sfx, 'sfx', (v) => set(['sfx'], v), 'sfx/…'));
      rows.push(nodeField('next', node.next, ids, (v) => set(['next'], v)));
      break;

    case 'poll':
      rows.push(textArea('question', node.question, (v) => set(['question'], v)));
      rows.push(textArea('prompt', node.prompt, (v) => set(['prompt'], v)));
      rows.push(
        field('duration', node.duration, (v) => set(['duration'], v), { type: 'number' }),
      );
      rows.push(field('default', node.default, (v) => set(['default'], v), { placeholder: 'option key' }));
      rows.push(choice('tiebreak', node.tiebreak ?? 'first', ['first', 'random', 'weighted'], (v) => set(['tiebreak'], v)));
      break;

    case 'branch':
      rows.push(nodeField('else', node.else, ids, (v) => set(['else'], v)));
      break;

    case 'end':
      rows.push(textArea('text', node.text, (v) => set(['text'], v)));
      break;
  }

  return h('div', { class: 'node-fields' }, ...rows);
}

// ---------------------------------------------------------------------------
// Lists inside a node
// ---------------------------------------------------------------------------

/**
 * The drag half of a list entry.
 *
 * A dialogue's lines are its running order, and finding the right one is
 * ordinary writing — a beat lands better before the reaction than after it, and
 * the only way to know is to try it. Retyping two boxes to swap them moves the
 * words and leaves `hold`, `voice` and `sfx` behind on the wrong line, which
 * costs a re-record and a mistimed beat for an edit that looked like nothing.
 * Dragging moves the whole entry, in the file, and never touches the spine:
 * lines play in the order they are written, so nothing outside the node can
 * notice.
 *
 * `draggable` is armed by the grip rather than set on the entry outright. An
 * always-draggable container swallows text selection inside its own inputs, so
 * selecting half a line to retype it would pick the line up instead.
 */
function entryProps(node, path, index, count) {
  const key = path.join('.');
  const mine = () => entryDrag && entryDrag.nodeId === node.id && entryDrag.key === key;
  const below = (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientY > box.top + box.height / 2;
  };

  return {
    class: 'entry',
    ondragstart: (event) => {
      if (event.currentTarget.draggable !== true) return void event.preventDefault();
      entryDrag = { nodeId: node.id, key, index };
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', `${key}:${index}`);
      // The node's own drag handler is on the <li> around this one, and a line
      // moving inside a node is not the node moving.
      event.stopPropagation();
    },
    ondragend: (event) => {
      event.currentTarget.draggable = false;
      entryDrag = null;
      clearDropMarks();
    },
    ondragover: (event) => {
      if (!mine() || entryDrag.index === index) return;
      event.preventDefault();
      event.stopPropagation();
      clearDropMarks();
      event.currentTarget.classList.add(below(event) ? 'drop-below' : 'drop-above');
    },
    ondrop: (event) => {
      if (!mine() || entryDrag.index === index) return;
      event.preventDefault();
      event.stopPropagation();
      const order = Array.from({ length: count }, (_, n) => n);
      const from = entryDrag.index;
      const to = landingIndex(order, from, index, below(event));
      entryDrag = null;
      clearDropMarks();
      act('node-list', { id: node.id, path, from, to });
    },
  };
}

/** The handle that arms a drag. Absent where there is nothing to reorder. */
function entryGrip(count) {
  if (count < 2) return null;
  const arm = (event, on) => {
    const entry = event.currentTarget.closest('.entry');
    if (entry) entry.draggable = on;
  };
  return h(
    'span',
    {
      class: 'grip small',
      title: 'Drag to reorder',
      onmousedown: (event) => arm(event, true),
      onmouseup: (event) => arm(event, false),
    },
    '⠿',
  );
}

function listBlock(node, ids) {
  const set = (path, value) => act('node', { id: node.id, path, value }, 'PATCH');
  const addTo = (path, fields) => act('node-list', { id: node.id, path, fields });
  const removeFrom = (path, index) => act('node-list', { id: node.id, path, index });

  if (node.type === 'dialogue') {
    return h(
      'div',
      { class: 'node-list' },
      h('div', { class: 'node-list-head' }, h('h4', {}, 'Lines'), h('span', { class: 'spacer' }),
        h('button', { class: 'ghost small', type: 'button', onclick: () => addTo(['lines'], { text: 'New line.' }) }, '+ line')),
      ...node.lines.map((line, i) =>
        h(
          'div',
          entryProps(node, ['lines'], i, node.lines.length),
          h('div', { class: 'entry-head' },
            entryGrip(node.lines.length),
            h('span', { class: 'entry-n' }, `${i + 1}`),
            h('span', { class: 'spacer' }),
            node.lines.length > 1 &&
              h('button', { class: 'ghost small danger', type: 'button', onclick: () => removeFrom(['lines'], i) }, 'remove')),
          textArea('text', line.text, (v) => v !== null && set(['lines', i, 'text'], v)),
          field('who', line.who, (v) => set(['lines', i, 'who'], v), { placeholder: 'narration' }),
          field('hold', line.hold, (v) => set(['lines', i, 'hold'], v), { type: 'number', step: '0.1' }),
          assetField('voice', line.voice, 'voice', (v) => set(['lines', i, 'voice'], v), 'voice/…'),
          assetField('sfx', line.sfx, 'sfx', (v) => set(['lines', i, 'sfx'], v), 'sfx/…'),
        ),
      ),
    );
  }

  if (node.type === 'poll') {
    return h(
      'div',
      { class: 'node-list' },
      h('div', { class: 'node-list-head' }, h('h4', {}, 'Options'), h('span', { class: 'spacer' }),
        node.options.length < 6 &&
          h('button', { class: 'ghost small', type: 'button',
            onclick: () => addTo(['options'], { key: `opt${node.options.length + 1}`, label: 'New option', next: node.options[0]?.next ?? '' }) }, '+ option')),
      ...node.options.map((option, i) =>
        h(
          'div',
          entryProps(node, ['options'], i, node.options.length),
          h('div', { class: 'entry-head' },
            entryGrip(node.options.length),
            h('span', { class: 'entry-n' }, `${i + 1}`),
            option.key === node.default && h('span', { class: 'type' }, 'default'),
            h('span', { class: 'spacer' }),
            // Two is the floor the schema sets: a vote with one answer is not a vote.
            node.options.length > 2 &&
              h('button', { class: 'ghost small danger', type: 'button', onclick: () => removeFrom(['options'], i) }, 'remove')),
          field('key', option.key, (v) => v !== null && set(['options', i, 'key'], v)),
          field('label', option.label, (v) => v !== null && set(['options', i, 'label'], v), { wide: true }),
          nodeField('next', option.next, ids, (v) => v !== null && set(['options', i, 'next'], v)),
        ),
      ),
      node.set &&
        h('div', { class: 'node-sets' },
          h('h4', {}, 'Writes'),
          ...Object.entries(node.set).map(([name, value]) =>
            field(name, value, (v) => v !== null && set(['set', name], v), { wide: true })),
          h('p', { class: 'hint' }, 'A poll writes these so a later branch can read them.')),
    );
  }

  if (node.type === 'branch') {
    return h(
      'div',
      { class: 'node-list' },
      h('div', { class: 'node-list-head' }, h('h4', {}, 'Conditions'), h('span', { class: 'spacer' }),
        h('button', { class: 'ghost small', type: 'button',
          onclick: () => addTo(['when'], { if: "var == 'value'", next: node.else }) }, '+ condition')),
      // Order is precedence here, not presentation: the first matching
      // condition wins, so dragging one above another is a real edit to how the
      // story routes rather than a tidy-up.
      ...node.when.map((condition, i) =>
        h(
          'div',
          entryProps(node, ['when'], i, node.when.length),
          h('div', { class: 'entry-head' },
            entryGrip(node.when.length),
            h('span', { class: 'entry-n' }, `${i + 1}`),
            h('span', { class: 'spacer' }),
            node.when.length > 1 &&
              h('button', { class: 'ghost small danger', type: 'button', onclick: () => removeFrom(['when'], i) }, 'remove')),
          field('if', condition.if, (v) => v !== null && set(['when', i, 'if'], v), { wide: true }),
          nodeField('next', condition.next, ids, (v) => v !== null && set(['when', i, 'next'], v)),
        ),
      ),
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Dragging
// ---------------------------------------------------------------------------

function clearDropMarks() {
  for (const el of document.querySelectorAll('.drop-above, .drop-below')) {
    el.classList.remove('drop-above', 'drop-below');
  }
}

/**
 * Where the dragged node would end up, as an index in the finished list.
 *
 * Computed by actually performing the move on a copy of the order rather than
 * by arithmetic on the drop position: the off-by-one between "insert before
 * index 3" and "end up at index 3" depends on whether the node came from above
 * or below, and getting it wrong moves a beat one place from where it was let
 * go, which is the kind of bug nobody reports because it looks like a slip.
 */
function landingIndex(order, dragId, targetId, below) {
  const without = order.filter((id) => id !== dragId);
  const at = without.indexOf(targetId) + (below ? 1 : 0);
  without.splice(at, 0, dragId);
  return without.indexOf(dragId);
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export function renderNodes(analysis, scenario, assets) {
  // Kept so that a control inside the list — opening a card, finishing a drag —
  // can redraw without the caller handing all of this back. The scenario is
  // where the scene ids come from and `assets` is what an asset box offers, so
  // a picker built from a stale copy would offer names the file no longer has.
  view = { analysis, scenario, assets: assets ?? {} };
  draw();
}

function draw() {
  const { analysis, scenario } = view;
  const minutes = analysis.nodes.reduce((total, n) => total + n.seconds, 0) / 60;
  $('overview').textContent =
    `${analysis.counts.nodes} nodes · ${analysis.counts.polls} polls · ` +
    `${analysis.counts.endings} endings · every node laid end to end ≈ ${Math.round(minutes)} min` +
    (analysis.counts.unreachable > 0 ? ` · ${analysis.counts.unreachable} unreachable` : '');

  const bar = $('nodes-bar');
  if (bar) bar.hidden = !scenario;

  const byId = new Map((scenario?.nodes ?? []).map((node) => [node.id, node]));
  const order = analysis.nodes.map((n) => n.id);

  $('nodes').replaceChildren(
    ...analysis.nodes.map((summary, index) => {
      const node = byId.get(summary.id);
      const classes = ['node'];
      if (!summary.reachable) classes.push('unreachable');
      if (summary.id === analysis.start) classes.push('start');
      if (open.has(summary.id)) classes.push('open');

      const flows = [];
      if (summary.enteredFrom.length > 0) {
        flows.push(
          flowRow(
            'in',
            summary.enteredFrom.map((from, i) => [
              i > 0 ? ', ' : '',
              h('button', { class: 'jump', type: 'button', onclick: () => ctx.jumpTo(from) }, from),
            ]),
          ),
        );
      }
      if (summary.reads.length > 0) {
        flows.push(flowRow('reads', summary.reads.map((name) => h('code', {}, ` ${name} `))));
      }
      if (summary.writes.length > 0) {
        flows.push(flowRow('writes', summary.writes.map((w) => h('code', {}, ` ${w.name} = ${w.value} `))));
      }
      for (const exit of summary.exits) {
        flows.push(
          flowRow('out', `${exit.label} → `,
            h('button', { class: 'jump', type: 'button', onclick: () => ctx.jumpTo(exit.to) }, exit.to)),
        );
      }

      return h(
        'li',
        {
          class: classes.join(' '),
          'data-node': summary.id,
          draggable: 'true',
          ondragstart: (event) => {
            dragging = summary.id;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', summary.id);
          },
          ondragend: () => {
            dragging = null;
            clearDropMarks();
          },
          ondragover: (event) => {
            if (!dragging || dragging === summary.id) return;
            event.preventDefault();
            const box = event.currentTarget.getBoundingClientRect();
            const below = event.clientY > box.top + box.height / 2;
            clearDropMarks();
            event.currentTarget.classList.add(below ? 'drop-below' : 'drop-above');
          },
          ondrop: (event) => {
            if (!dragging || dragging === summary.id) return;
            event.preventDefault();
            const box = event.currentTarget.getBoundingClientRect();
            const below = event.clientY > box.top + box.height / 2;
            const toIndex = landingIndex(order, dragging, summary.id, below);
            const id = dragging;
            dragging = null;
            clearDropMarks();
            act('node-move', { id, toIndex });
          },
        },
        h(
          'div',
          { class: 'node-head' },
          h('span', { class: 'grip', title: 'Drag to reorder' }, '⠿'),
          h('span', { class: 'node-id' }, summary.id),
          h('span', { class: `type type-${summary.type}` }, summary.type),
          summary.id === analysis.start && h('span', { class: 'type' }, 'start'),
          !summary.reachable && h('span', { class: 'type' }, 'unreachable'),
          summary.seconds > 0 && h('span', { class: 'node-secs' }, `${summary.seconds}s`),
          h('span', { class: 'spacer' }),
          node &&
            h('button', {
              class: 'ghost small', type: 'button',
              onclick: () => {
                if (open.has(summary.id)) open.delete(summary.id);
                else open.add(summary.id);
                draw();
              },
            }, open.has(summary.id) ? 'Close' : 'Edit'),
          h('button', {
            class: 'ghost small', type: 'button', title: 'Add a node below this one',
            onclick: () => addAfter(summary.id),
          }, '+'),
          h('button', {
            class: 'ghost small danger', type: 'button', title: 'Delete this node',
            onclick: () => {
              // Deleting a beat mends the chain across it, which is a change to
              // two other nodes as well as this one. Worth a question.
              if (confirm(`Delete "${summary.id}"? Whatever led here will lead to what it led to.`)) {
                act('node-delete', { id: summary.id });
              }
            },
          }, '✕'),
        ),
        summary.preview && h('p', { class: 'node-preview' }, summary.preview),
        flows.length > 0 && h('div', { class: 'flows' }, ...flows),
        open.has(summary.id) && node && formFor(node, order),
        open.has(summary.id) && node && listBlock(node, order),
      );
    }),
  );

  if (analysis.nodes.length === 0) {
    $('nodes').replaceChildren(h('li', { class: 'empty' }, 'This scenario has no nodes yet.'));
  }
}

/** A fresh id that is not taken, so adding never fails on a name collision. */
function freshId(type) {
  const taken = new Set((ctx.analysis()?.nodes ?? []).map((n) => n.id));
  for (let n = 1; ; n++) {
    const id = `${type}_${n}`;
    if (!taken.has(id)) return id;
  }
}

function addAfter(afterId) {
  const type = $('new-node-type')?.value ?? 'dialogue';
  const fields =
    type === 'dialogue'
      ? {}
      : type === 'pause'
        ? { duration: 3 }
        : type === 'poll'
          ? { question: 'A new question?', duration: 60, default: 'a' }
          : type === 'end'
            ? { text: 'The end.' }
            : type === 'gate'
              ? { label: 'Continue' }
              : {};
  return act('node-add', { id: freshId(type), nodeType: type, after: afterId, fields });
}

/**
 * The toolbar. Wired once — the list is replaced on every render, so anything
 * inside it would lose its listeners, and a control that silently stops working
 * after the first edit is worse than no control.
 */
export function initNodesBar() {
  const select = $('new-node-type');
  if (select && select.options.length === 0) {
    for (const type of TYPES) {
      select.append(h('option', { value: type, title: TYPE_BLURB[type] }, type));
    }
  }
  $('add-node')?.addEventListener('click', () => {
    const nodes = ctx.analysis()?.nodes ?? [];
    const last = nodes[nodes.length - 1];
    if (last) addAfter(last.id);
  });
}

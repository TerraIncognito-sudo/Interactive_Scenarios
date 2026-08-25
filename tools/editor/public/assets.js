/**
 * The workshop half of the editor: six sections, and what is made in each.
 *
 * Every row on this board exists because something in the scenario asks for it.
 * There is no separate list of assets to maintain and no way for one to drift
 * from the other — delete a line of dialogue and its voice clip leaves the
 * board with it.
 *
 * Nothing here generates anything yet. What it does is make the state of the
 * work visible, which is the part a checklist in a document cannot do: which
 * files exist, which were made before their prompt was last edited, and which
 * have takes waiting for someone to choose between them.
 */

import { $, h } from './dom.js';

const SECTION_LABELS = {
  images: 'Images',
  video: 'Video',
  voice: 'Voice',
  sfx: 'Sound effects',
  ambience: 'Ambience',
  music: 'Music',
};

const STATUS_LABELS = {
  missing: 'missing',
  unselected: 'pick a take',
  unmanaged: 'unmanaged',
  stale: 'stale',
  ready: 'ready',
};

const STATUS_ORDER = ['stale', 'unselected', 'missing', 'unmanaged', 'ready'];

const state = {
  name: null,
  data: null,
  /** Collapsed sections, so a long board stays navigable. */
  collapsed: new Set(),
  onScenario: () => {},
  onStoryboard: () => {},
};

// ---------------------------------------------------------------------------
// Talking to the server
// ---------------------------------------------------------------------------

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `${response.status}`);
  return data;
}

export async function openProject(name) {
  state.name = name;
  if (!name) {
    state.data = null;
    // The storyboard belongs to the project. Leaving it on screen means the
    // Storyboard tab describes a project that is no longer open, and its Save
    // button writes to it.
    state.onStoryboard(undefined, undefined);
    render();
    return;
  }

  try {
    const data = await api(`/api/projects/${encodeURIComponent(name)}`);
    state.data = data;
    // The project owns its scenario, so opening one takes over the source pane
    // rather than leaving the author editing a different file than the board
    // they are looking at.
    state.onScenario(data.scenarioSource, name, data.paths.scenario);
    state.onStoryboard(data.storyboardSource, data.paths.storyboard);
    render();
  } catch (err) {
    state.data = null;
    renderError(err.message);
  }
}

/** Re-reads the board without touching the source pane. */
export async function refreshAssets() {
  if (!state.name) return;
  try {
    state.data = await api(`/api/projects/${encodeURIComponent(state.name)}`);
    render();
  } catch (err) {
    renderError(err.message);
  }
}

async function editField(file, field, value) {
  state.data = await api(`/api/projects/${encodeURIComponent(state.name)}/asset`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file, field, value }),
  });
  render();
}

/**
 * Writes the project's first project.yaml, seeded from its storyboard.
 *
 * A folder with only a scenario in it is a perfectly good project — it simply
 * has nowhere to record prompts yet. This is the moment it gains one.
 */
async function initProject() {
  state.data = await api(`/api/projects/${encodeURIComponent(state.name)}/init`, {
    method: 'POST',
  });
  state.onScenario(state.data.scenarioSource, state.name);
  state.onStoryboard(state.data.storyboardSource, state.data.paths.storyboard);
  render();
}

export async function seedFromStoryboard() {
  if (!state.name) return null;
  const result = await api(`/api/projects/${encodeURIComponent(state.name)}/sync`, {
    method: 'POST',
  });
  state.data = result.project;
  render();
  return result;
}

/**
 * Declares a clip on every spoken line the scenario has not given one.
 *
 * This writes to `scenario.yaml`, not to the project file — the scenario is the
 * manifest, so nothing can be generated or tracked until it says the file
 * exists. Doing it anywhere but here is how the two start disagreeing.
 */
export async function wireVoice() {
  if (!state.name) return null;
  const result = await api(`/api/projects/${encodeURIComponent(state.name)}/voice`, {
    method: 'POST',
  });
  state.data = result.project;
  render();
  return result;
}

/** Drops recipes for files the scenario no longer references. */
export async function pruneOrphans() {
  if (!state.name) return null;
  const result = await api(`/api/projects/${encodeURIComponent(state.name)}/prune`, {
    method: 'POST',
  });
  state.data = result.project;
  render();
  return result;
}

async function selectTake(asset, take) {
  state.data = await api(`/api/projects/${encodeURIComponent(state.name)}/select`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ asset, take }),
  });
  render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderError(message) {
  $('totals').hidden = true;
  $('board-bar').hidden = true;
  $('sections').replaceChildren(h('p', { class: 'empty' }, message));
}

function describeOrigin(origin) {
  switch (origin.kind) {
    case 'sprite':
      return `portrait of ${origin.character}`;
    case 'background':
      return `background of ${origin.scene}`;
    case 'video':
      return `motion in ${origin.scene}`;
    case 'music':
      return `music in ${origin.scene}`;
    case 'ambience':
      return `ambience in ${origin.scene}`;
    case 'voice':
      return `${origin.node} line ${origin.line + 1}`;
    case 'sfx':
      return `sfx on ${origin.node} line ${origin.line + 1}`;
    default:
      return origin.kind;
  }
}

function statusPill(status) {
  return h('span', { class: `pill pill-${status}` }, STATUS_LABELS[status] ?? status);
}

function countPills(counts) {
  return STATUS_ORDER.filter((status) => counts[status] > 0).map((status) =>
    h('span', { class: `pill pill-${status}` }, `${counts[status]} ${STATUS_LABELS[status]}`),
  );
}

function takesStrip(asset) {
  if (asset.takes.length === 0) {
    return h(
      'p',
      { class: 'takes-empty' },
      'No takes yet. Drop files into the project’s generated folder and they will appear here.',
    );
  }

  return h(
    'div',
    { class: 'takes' },
    asset.takes.map((take) => {
      const chosen = take.id === asset.selected;
      const classes = ['take', chosen && 'chosen', take.orphaned && 'gone']
        .filter(Boolean)
        .join(' ');
      return h(
        'button',
        {
          type: 'button',
          class: classes,
          // A take recorded in the ledger but no longer on disk cannot be
          // chosen; saying so beats a button that silently does nothing.
          disabled: take.orphaned ? true : undefined,
          title: take.orphaned
            ? 'Recorded in the ledger but no longer on disk'
            : take.untracked
              ? 'Found in the folder, not made by the pipeline'
              : `${take.hash}${take.at ? ` · ${take.at}` : ''}`,
          onclick: () => void selectTake(asset.file, chosen ? null : take.id),
        },
        take.id,
        take.untracked ? h('span', { class: 'take-tag' }, 'manual') : null,
      );
    }),
  );
}

function assetRow(asset) {
  const isVoice = asset.section === 'voice';
  const promptField = isVoice ? 'text' : 'prompt';
  const promptValue = isVoice ? (asset.row.text ?? '') : (asset.row.prompt ?? '');

  const box = h('textarea', {
    class: 'prompt',
    rows: isVoice ? 2 : 4,
    spellcheck: 'false',
    placeholder: isVoice
      ? 'What this line says — the text handed to the voice model'
      : 'Prompt for this asset',
    // Saved on blur rather than on every keystroke: each save rewrites
    // project.yaml, and an author mid-sentence has not decided anything yet.
    onblur: (event) => {
      if (event.target.value === promptValue) return;
      void editField(asset.file, promptField, event.target.value);
    },
  });
  box.value = promptValue;

  return h(
    'article',
    { class: `asset asset-${asset.status}` },
    h(
      'header',
      { class: 'asset-head' },
      h('code', { class: 'asset-file' }, asset.file),
      statusPill(asset.status),
      asset.frozen ? h('span', { class: 'pill pill-frozen' }, 'frozen') : null,
      asset.published ? h('span', { class: 'pill pill-published' }, 'published') : null,
      h('span', { class: 'spacer' }),
      h('span', { class: 'asset-hash', title: 'Recipe hash' }, asset.hash),
    ),
    h(
      'p',
      { class: 'asset-origins' },
      asset.origins.map(describeOrigin).join(' · '),
    ),
    asset.notes.length > 0
      ? h(
          'ul',
          { class: 'asset-notes' },
          asset.notes.map((note) => h('li', {}, note)),
        )
      : null,
    box,
    takesStrip(asset),
  );
}

function sectionBlock(section) {
  const collapsed = state.collapsed.has(section.section);
  const model = section.model;
  const label = SECTION_LABELS[section.section] ?? section.section;

  const head = h(
    'header',
    {
      class: 'section-head',
      onclick: () => {
        if (collapsed) state.collapsed.delete(section.section);
        else state.collapsed.add(section.section);
        render();
      },
    },
    h('span', { class: 'section-caret' }, collapsed ? '▸' : '▾'),
    h('h3', {}, label),
    h('span', { class: 'section-count' }, `${section.assets.length}`),
    h('span', { class: 'spacer' }),
    countPills(section.counts),
  );

  // The model line is the first thing in a section on purpose: everything below
  // it was made by that model, and a section's style and negative prompt apply
  // to every row, which is what keeps a set of images looking like one set.
  const modelLine = h(
    'p',
    { class: 'section-model' },
    model?.file
      ? h('code', {}, model.file)
      : h('em', {}, 'no model selected'),
    model?.root ? h('span', { class: 'section-root' }, model.root) : null,
    h('span', { class: 'section-backend' }, model?.backend ?? 'manual'),
  );

  return h(
    'section',
    { class: `section${collapsed ? ' collapsed' : ''}` },
    head,
    collapsed ? null : modelLine,
    collapsed
      ? null
      : section.assets.length === 0
        ? h('p', { class: 'empty' }, 'Nothing in the scenario asks for this yet.')
        : section.assets.map(assetRow),
  );
}

function render() {
  const totals = $('totals');
  const container = $('sections');

  if (!state.data) {
    totals.hidden = true;
    $('board-bar').hidden = true;
    container.replaceChildren(
      h('p', { class: 'empty' }, 'No project open.'),
    );
    return;
  }

  const { overview, paths } = state.data;

  // Pruning is destructive and only ever the right answer when there is
  // something orphaned, so the button appears only when it applies.
  $('board-bar').hidden = state.data.projectSource === undefined;
  $('prune').hidden = overview.orphans.length === 0;
  $('prune').textContent =
    overview.orphans.length === 1
      ? 'Remove 1 orphaned recipe'
      : `Remove ${overview.orphans.length} orphaned recipes`;

  totals.hidden = false;
  totals.replaceChildren(
    h('div', { class: 'totals-row' }, countPills(overview.counts)),
    h('p', { class: 'totals-path' }, paths.dir),
    // Without a project.yaml there is nowhere to put a prompt, so every text
    // box on the board would silently fail to save. Offer the fix instead.
    state.data.projectSource === undefined
      ? h(
          'div',
          { class: 'setup' },
          h('span', {}, 'This folder has a scenario but no project file yet.'),
          h(
            'button',
            { type: 'button', class: 'primary', onclick: () => void initProject() },
            'Set up asset work',
          ),
        )
      : null,
  );

  const problems = overview.problems ?? [];
  // Spread rather than a null placeholder: `replaceChildren` is a raw DOM call
  // and stringifies null into a text node reading "null", which is exactly as
  // good as it sounds. `h()` filters nulls; this is not `h()`.
  container.replaceChildren(
    ...(problems.length > 0
      ? [
          h(
            'div',
            { class: 'problems warn' },
            h('strong', {}, `${problems.length} thing${problems.length === 1 ? '' : 's'} to look at`),
            h('ul', {}, problems.map((p) => h('li', {}, p.message))),
          ),
        ]
      : []),
    ...overview.sections.map(sectionBlock),
  );
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * Notes a new workspace and closes whatever was open.
 *
 * The picker itself is built in app.js, which is the only place that knows
 * about both projects and bundled scenarios — a list assembled in two files
 * is a list that can show two different truths.
 */
export function setProjects(projects, workspacePath) {
  $('assets-hint').textContent =
    projects.length === 0
      ? `No folders with a scenario.yaml in ${workspacePath ?? 'the chosen folder'}. ` +
        'Use Folder… to pick a different one.'
      : 'A row appears here because something in the scenario asks for it — ' +
        'which is why this list can never drift out of date.';

  state.name = null;
  state.data = null;
  render();
}

export function initAssets({ onScenario, onStoryboard }) {
  state.onScenario = onScenario ?? (() => {});
  state.onStoryboard = onStoryboard ?? (() => {});
  render();
}

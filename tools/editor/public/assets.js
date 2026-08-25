/**
 * The workshop half of the editor: six sections, and what is made in each.
 *
 * Every row on this board exists because something in the scenario asks for it.
 * There is no separate list of assets to maintain and no way for one to drift
 * from the other — delete a line of dialogue and its voice clip leaves the
 * board with it.
 *
 * What it does first is make the state of the work visible, which is the part
 * a checklist in a document cannot do: which files exist, which were made
 * before their prompt was last edited, and which have takes waiting for someone
 * to choose between them.
 *
 * Voice is the first section wired to a generator. Its shape is the one the
 * others will take: a cast to set up, a model to point at, and a button per row
 * that makes one take without touching what is already published.
 */

import { $, h } from './dom.js';
import { openPicker } from './picker.js';

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
  /** Model root and what is loaded, from /api/models. */
  models: null,
  /** Assets currently being generated, so a row can say so and not be clicked twice. */
  busy: new Set(),
  /** Collapsed sections, so a long board stays navigable. */
  collapsed: new Set(),
  onScenario: () => {},
  onStoryboard: () => {},
  onStatus: () => {},
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
  return runOnScenario('voice');
}

/**
 * Gives every storyboarded shot its own still and clip.
 *
 * Like wiring voice this writes to `scenario.yaml`, because a picture nothing
 * declares is a picture nothing can track. The server re-seeds afterwards, so
 * the prompts the board could not place land on the names it just declared.
 */
export async function migrateShots() {
  return runOnScenario('shots');
}

/**
 * Runs an action that rewrites `scenario.yaml`, and puts the result back in
 * the editor pane.
 *
 * The pane holds its own copy of the source. An action that writes the file
 * without refreshing it leaves the author looking at the version from before —
 * and the next Save writes that stale copy back over the change.
 */
async function runOnScenario(action) {
  if (!state.name) return null;
  const result = await api(
    `/api/projects/${encodeURIComponent(state.name)}/${action}`,
    { method: 'POST' },
  );
  state.data = result.project;
  // Awaited, because refreshing the pane re-analyses the scenario and the
  // analysis writes the status line. Reporting what the action did before that
  // settles means the caller's message is the one that gets overwritten.
  await state.onScenario(state.data.scenarioSource, state.name, state.data.paths.scenario);
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

/**
 * Makes one take of one asset.
 *
 * Deliberately per row. A button that generated a whole section would be a
 * button nobody dares press: ninety lines is most of an hour of GPU time, and
 * the first thing an author wants is to hear *one* line and decide whether the
 * voice is right at all.
 */
export async function generateAssets(section, files) {
  if (!state.name || files.length === 0) return null;
  for (const file of files) state.busy.add(file);
  render();
  try {
    const result = await api(`/api/projects/${encodeURIComponent(state.name)}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ section, files }),
    });
    state.data = result.project;
    return result;
  } finally {
    for (const file of files) state.busy.delete(file);
    render();
  }
}

/** Copies the selected take to the filename the scenario declares. */
export async function publishAssets(section, files) {
  if (!state.name || files.length === 0) return null;
  const result = await api(`/api/projects/${encodeURIComponent(state.name)}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ section, files }),
  });
  state.data = result.project;
  render();
  return result;
}

async function editVoice(voice, field, value) {
  state.data = await api(`/api/projects/${encodeURIComponent(state.name)}/voice`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ voice, field, value }),
  });
  render();
}

async function editSection(section, field, value) {
  state.data = await api(`/api/projects/${encodeURIComponent(state.name)}/section`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ section, field, value }),
  });
  render();
}

export async function refreshModels() {
  state.models = await api('/api/models');
  renderModelsBar();
  return state.models;
}

export async function stopModels() {
  state.models = await api('/api/models/stop', { method: 'POST' });
  await refreshModels();
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
    // Both of these come in two flavours now: the scene's default picture, and
    // one node's own shot overriding it.
    case 'background':
      return origin.node ? `still for ${origin.node}` : `background of ${origin.scene}`;
    case 'video':
      return origin.node ? `motion on ${origin.node}` : `motion in ${origin.scene}`;
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

/**
 * The models strip: where weights live on this machine, and what is loaded.
 *
 * Outside any one project on purpose. A project file is opened on other
 * machines and a year later, so it names a model rather than a path — this is
 * the one place the two are joined, and it belongs to the machine.
 */
function renderModelsBar() {
  const bar = $('models-bar');
  if (!bar) return;
  bar.hidden = !state.data;
  if (!state.data) return;

  const models = state.models;
  const root = models?.root;
  $('models-root').textContent = root ?? 'not set — generation is off until it is';
  $('models-root').className = root ? 'models-root' : 'models-root unset';

  const live = (models?.sidecars ?? []).filter((entry) => entry.running);
  const label = live
    .map((entry) => {
      const device = entry.info?.device;
      const gpu = entry.info?.gpu;
      return `${entry.backend} loaded${device ? ` on ${gpu ?? device}` : ''}`;
    })
    .join(', ');

  $('models-state').textContent = label;
  $('models-stop').hidden = live.length === 0;
}

/**
 * One character, and everything needed to give them a voice.
 *
 * A cloning model with no reference clip does not fail — it reads the line in
 * its own default voice, and does it for every character, and the result is a
 * cast that all sound like the same person. That is a mistake you notice after
 * generating ninety lines, so the panel says it before you generate one.
 */
function castMember(member, clones) {
  const missing = clones && !member.reference;
  const broken = Boolean(member.reference) && !member.referenceExists;

  return h(
    'article',
    { class: `cast${missing || broken ? ' cast-warn' : ''}` },
    h(
      'header',
      { class: 'cast-head' },
      h('strong', {}, member.name),
      h('code', { class: 'cast-id' }, member.id),
      h('span', { class: 'spacer' }),
      h(
        'span',
        { class: 'cast-count' },
        member.lines === 0 ? 'no lines' : `${member.ready}/${member.lines} ready`,
      ),
    ),
    h(
      'div',
      { class: 'cast-ref' },
      h(
        'button',
        {
          type: 'button',
          class: 'ghost',
          onclick: () =>
            openPicker({
              mode: 'file',
              extensions: ['.wav', '.mp3', '.flac', '.ogg'],
              label: `Reference clip for ${member.name}`,
              startAt: state.data?.paths?.dir,
              onPick: (path) => void editVoice(member.id, 'reference', path),
            }),
        },
        member.reference ? 'Change clip…' : 'Choose clip…',
      ),
      member.reference
        ? h(
            'code',
            { class: `cast-file${broken ? ' gone' : ''}` },
            member.reference,
            broken ? h('span', { class: 'pill pill-stale' }, 'not found') : null,
          )
        : h(
            'em',
            { class: 'cast-none' },
            clones
              ? 'no reference — this character will use the model’s default voice'
              : 'this model does not clone; no clip needed',
          ),
      member.reference
        ? h(
            'button',
            {
              type: 'button',
              class: 'ghost small',
              title: 'Clear the reference clip',
              onclick: () => void editVoice(member.id, 'reference', ''),
            },
            '✕',
          )
        : null,
    ),
    (() => {
      const box = h('input', {
        type: 'text',
        class: 'cast-direction',
        placeholder: 'Direction — “tired, precise, never raises her voice”',
        onblur: (event) => {
          if (event.target.value === (member.direction ?? '')) return;
          void editVoice(member.id, 'direction', event.target.value);
        },
      });
      box.value = member.direction ?? '';
      return box;
    })(),
  );
}

/** The cast, above the voice rows, because it is what has to be set up first. */
function castPanel(clones) {
  const cast = state.data?.overview?.cast ?? [];
  if (cast.length === 0) return null;

  return h(
    'div',
    { class: 'cast-panel' },
    h(
      'p',
      { class: 'hint' },
      'Every character who speaks. A voice is set once here and used by every line ',
      'they have — which is also why changing one makes all of their clips stale.',
    ),
    h('div', { class: 'cast-list' }, cast.map((member) => castMember(member, clones))),
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

/**
 * Generating one line, and saying what came back.
 *
 * The interesting part of the reply is not that it worked — it is the clip's
 * length against the line's `hold:`. Nothing on the server opens the audio,
 * so a beat ends when the scenario says it does; a clip longer than its hold
 * is a narrator cut off mid-sentence in front of a room, and this is the only
 * moment anyone is in a position to notice.
 */
async function onGenerate(asset) {
  try {
    const result = await generateAssets(asset.section, [asset.file]);
    if (!result) return;

    const failure = result.failed?.[0];
    if (failure) return state.onStatus('bad', failure.error);

    const made = result.made?.[0];
    if (!made) return state.onStatus('warn', 'nothing was made');

    const parts = [`${made.take} · ${made.seconds}s`];
    if (made.holdWas !== undefined) {
      parts.push(
        `this line holds for ${made.holdWas}s but the clip runs ${made.seconds}s — ` +
          `set hold: ${made.hold}`,
      );
    }
    state.onStatus(made.holdWas === undefined ? 'ok' : 'warn', parts.join(' · '));
  } catch (err) {
    state.onStatus('bad', err.message);
  }
}

async function onPublish(asset) {
  try {
    const result = await publishAssets(asset.section, [asset.file]);
    if (!result) return;
    const failure = result.failed?.[0];
    if (failure) return state.onStatus('bad', failure.error);
    state.onStatus('ok', `published ${asset.file}`);
  } catch (err) {
    state.onStatus('bad', err.message);
  }
}

/**
 * What can be done to one row, right now.
 *
 * Generate is always offered when the section has a generator, including for a
 * row that is already ready — that is how you get a second reading to choose
 * between, and it is the whole reason takes exist. Publish only appears once
 * something is selected, because publishing is the moment a take becomes the
 * file the show opens and there is nothing to copy until one is picked.
 */
function assetActions(asset, generable) {
  const busy = state.busy.has(asset.file);
  const actions = [];

  if (generable) {
    actions.push(
      h(
        'button',
        {
          type: 'button',
          class: 'ghost small',
          disabled: busy ? true : undefined,
          title: busy ? 'Working…' : 'Make another take of this line',
          onclick: () => void onGenerate(asset),
        },
        busy ? 'Generating…' : asset.takes.length > 0 ? 'Another take' : 'Generate',
      ),
    );
  }

  if (asset.selected) {
    actions.push(
      h(
        'button',
        {
          type: 'button',
          class: 'ghost small',
          title: 'Copy the selected take to the name the scenario asks for',
          onclick: () => void onPublish(asset),
        },
        asset.published ? 'Re-publish' : 'Publish',
      ),
    );
  }

  return actions.length > 0 ? h('div', { class: 'asset-actions' }, actions) : null;
}

function assetRow(asset, generable = false) {
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
    assetActions(asset, generable),
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
  const available = (state.models?.models ?? []).filter(
    (entry) => entry.section === section.section,
  );
  const chosen = available.find((entry) => entry.id === model?.file);

  const picker = h(
    'select',
    {
      class: 'section-picker',
      onchange: (event) => {
        const id = event.target.value;
        void (async () => {
          // Backend and model move together. A section pointed at a model with
          // its backend left on `manual` looks configured and generates
          // nothing, which is a confusing way to spend an afternoon.
          await editSection(section.section, 'file', id);
          await editSection(section.section, 'backend', id ? 'sidecar' : 'manual');
        })();
      },
    },
    h('option', { value: '' }, 'made by hand'),
    available.map((entry) =>
      h(
        'option',
        { value: entry.id, selected: entry.id === model?.file ? true : undefined },
        `${entry.title}${entry.installed ? '' : ' — not downloaded'}`,
      ),
    ),
  );
  if (model?.file) picker.value = model.file;

  const modelLine = h(
    'p',
    { class: 'section-model' },
    available.length > 0 ? picker : h('em', {}, 'no generator for this section yet'),
    chosen && !chosen.installed
      ? h(
          'span',
          { class: 'pill pill-missing' },
          `${chosen.title} is not downloaded yet`,
        )
      : null,
    chosen?.clones === false && chosen.id === 'placeholder'
      ? h(
          'span',
          { class: 'section-note' },
          'a tone the length of the line — for rehearsing timing, not for the show',
        )
      : null,
    h('span', { class: 'spacer' }),
    h('span', { class: 'section-backend' }, model?.backend ?? 'manual'),
  );

  // Generation needs three things agreed: a model root on this machine, a
  // model chosen for the section, and a backend that is not "made by hand".
  const generable =
    Boolean(state.models?.root) && Boolean(chosen) && (model?.backend ?? 'manual') !== 'manual';

  return h(
    'section',
    { class: `section${collapsed ? ' collapsed' : ''}` },
    head,
    collapsed ? null : modelLine,
    collapsed || section.section !== 'voice' ? null : castPanel(chosen?.clones === true),
    collapsed
      ? null
      : section.assets.length === 0
        ? h('p', { class: 'empty' }, 'Nothing in the scenario asks for this yet.')
        : section.assets.map((asset) => assetRow(asset, generable)),
  );
}

function render() {
  const totals = $('totals');
  const container = $('sections');
  renderModelsBar();

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

export function initAssets({ onScenario, onStoryboard, onStatus }) {
  state.onStatus = onStatus ?? (() => {});
  state.onScenario = onScenario ?? (() => {});
  state.onStoryboard = onStoryboard ?? (() => {});
  render();
}

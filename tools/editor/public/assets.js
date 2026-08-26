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
  /** Rows whose composed-prompt preview is open. */
  expanded: new Set(),
  /**
   * A section-wide generate in flight: which section, how far, and whether the
   * author has asked it to stop. One at a time — there is one GPU, and two runs
   * would take the same total time while making it impossible to say which line
   * is being worked on.
   */
  run: null,
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

/**
 * Declares a portrait for every character the storyboard drew a sheet for.
 *
 * `scenario.yaml` again: the display has drawn portraits since the beginning
 * and no scenario ever declared one, so the feature has been there and
 * invisible. This is the line that connects them.
 */
export async function wireSprites() {
  return runOnScenario('sprites');
}

/**
 * Files every asset under a folder named for its media type.
 *
 * Writes to `scenario.yaml` like the other two, because the folder is part of
 * the name the show opens — a layout the display worked out for itself would
 * be a rule living in three programs, and the first time they disagreed the
 * audience would see it.
 */
export async function sortFolders() {
  return runOnScenario('folders');
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
 * One asset is the primitive, and everything else is built on it — including
 * the section-wide run, which loops here rather than asking the server for
 * ninety at once. The first thing an author wants is to hear *one* line and
 * decide whether the voice is right at all; the batch is what happens after
 * that decision, and it stays a loop over this so it can be watched and
 * stopped.
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

/**
 * The takes folder's leaf name for an asset.
 *
 * Mirrors `takesDir` on the server: a name that already carries its section —
 * `voice/tran-d5-01.mp3` — does not repeat it inside the section's own folder.
 */
/** The separator the server's own paths use, rather than the browser's guess. */
function sepOf(path) {
  return path.includes('\\') ? '\\' : '/';
}

/** The folder this asset's takes live in, spelled the way the server spells it. */
function takesFolder(asset) {
  const root = state.data?.paths?.generated ?? '';
  return [root, asset.section, leafOf(asset)].join(sepOf(root));
}

function leafOf(asset) {
  const prefix = `${asset.section}/`;
  const inside = asset.file.startsWith(prefix) ? asset.file.slice(prefix.length) : asset.file;
  return inside.replaceAll('/', '_');
}

/** Records a reference clip for one character, in one of a palette model's voices. */
export async function recordReference(voice, preset) {
  if (!state.name) return null;
  state.busy.add(`voice:${voice}`);
  render();
  try {
    const result = await api(`/api/projects/${encodeURIComponent(state.name)}/reference`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice, preset }),
    });
    state.data = result.project;
    return result;
  } finally {
    state.busy.delete(`voice:${voice}`);
    render();
  }
}

export async function downloadModel(id) {
  const result = await api(`/api/models/${encodeURIComponent(id)}/download`, { method: 'POST' });
  await refreshModels();
  render();
  return result;
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
function castMember(member, model) {
  const clones = model?.clones === true;
  const palette = model?.voices ?? [];
  const busy = state.busy.has(`voice:${member.id}`);

  const missing = clones ? !member.reference : !member.preset;
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

    // A palette model casts from a list. It is also how a reference clip gets
    // made for a cloning model, so the list is offered either way — the only
    // difference is what the button beside it does with the choice.
    palette.length > 0
      ? (() => {
          const select = h(
            'select',
            {
              class: 'cast-preset',
              onchange: (event) => {
                const preset = event.target.value;
                if (!preset) return void editVoice(member.id, 'preset', '');
                // For a palette model the choice *is* the voice. For a cloning
                // one it is only the raw material, and nothing changes until a
                // clip has actually been recorded from it.
                if (clones) void onRecord(member, preset);
                else void editVoice(member.id, 'preset', preset);
              },
            },
            h('option', { value: '' }, clones ? 'record a clip from…' : 'choose a voice…'),
            palette.map((voice) =>
              h(
                'option',
                { value: voice.id, selected: voice.id === member.preset ? true : undefined },
                voice.label,
              ),
            ),
          );
          if (member.preset) select.value = member.preset;
          return h(
            'div',
            { class: 'cast-ref' },
            select,
            busy ? h('span', { class: 'cast-working' }, 'recording…') : null,
          );
        })()
      : null,

    // The reference clip itself, for a model that clones.
    clones
      ? h(
          'div',
          { class: 'cast-ref' },
          h(
            'button',
            {
              type: 'button',
              class: 'ghost small',
              onclick: () =>
                openPicker({
                  mode: 'file',
                  extensions: ['.wav', '.mp3', '.flac', '.ogg'],
                  label: `Reference clip for ${member.name}`,
                  startAt: state.data?.paths?.dir,
                  onPick: (path) => void editVoice(member.id, 'reference', path),
                }),
            },
            member.reference ? 'Use another file…' : 'Use a recording…',
          ),
          member.reference && !broken
            ? playButton(
                mediaUrl({ reference: member.id }),
                `Play the reference clip for ${member.name}`,
              )
            : null,
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
                palette.length > 0
                  ? 'no clip yet — record one above, or point at your own'
                  : 'no clip yet',
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
        )
      : null,

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
function castPanel(model) {
  const cast = state.data?.overview?.cast ?? [];
  if (cast.length === 0) return null;

  const clones = model?.clones === true;
  const palette = (state.models?.models ?? []).find((entry) => (entry.voices ?? []).length > 0);

  return h(
    'div',
    { class: 'cast-panel' },
    h(
      'p',
      { class: 'hint' },
      'Every character who speaks. A voice is set once here and used by every line ',
      'they have — which is also why changing one makes all of their clips stale.',
    ),

    // The way out of the chicken-and-egg a cloning model creates: it wants a
    // recording of a voice that does not exist yet. A palette model has thirty
    // that do, so one of them reads the character's own lines and the result
    // becomes the reference.
    clones && palette && !palette.installed
      ? h(
          'p',
          { class: 'cast-offer' },
          `No recordings? ${palette.title} can make them — about ${palette.sizeGb} GB, no GPU needed. `,
          h(
            'button',
            {
              type: 'button',
              class: 'ghost small',
              onclick: (event) => void onDownload(palette.id, event.target),
            },
            `Download ${palette.title}`,
          ),
        )
      : null,

    h(
      'div',
      { class: 'cast-list' },
      cast.map((member) =>
        castMember(member, {
          clones,
          voices: palette?.installed ? (palette.voices ?? []) : model?.voices ?? [],
        }),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Hearing it
// ---------------------------------------------------------------------------

/**
 * One player for the whole board.
 *
 * Not one `<audio>` per take. Forty of them is forty elements that can all be
 * playing at once, and the first time an author clicks down a column of takes
 * they are listening to six readings of the same line on top of each other.
 * One element means starting a clip stops the last one, which is the behaviour
 * anybody comparing two takes actually wants.
 */
const player = new Audio();

/** Which media url is playing, so the button that started it can say so. */
let playing = null;

player.addEventListener('ended', () => {
  playing = null;
  render();
});
player.addEventListener('error', () => {
  const failed = playing;
  playing = null;
  render();
  if (failed) state.onStatus('bad', 'could not play that file — is it still on disk?');
});

function mediaUrl(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) query.set(key, value);
  }
  return `/api/projects/${encodeURIComponent(state.name)}/media?${query}`;
}

function toggle(url) {
  if (playing === url) {
    player.pause();
    playing = null;
    return render();
  }
  player.pause();
  player.src = url;
  playing = url;
  render();
  player.play().catch(() => {
    // Autoplay policy does not apply to a click, so a rejection here is a file
    // the browser cannot decode. The error listener has the message.
    playing = null;
    render();
  });
}

/**
 * The play control that appears wherever there is something to hear.
 *
 * A single glyph rather than a labelled button: it sits inline beside a take id
 * and a filename, and a row of "Play" buttons would push the names it is meant
 * to be annotating off the end of the line.
 */
function playButton(url, label) {
  const active = playing === url;
  return h(
    'button',
    {
      type: 'button',
      class: `play${active ? ' playing' : ''}`,
      title: active ? 'Stop' : label,
      'aria-label': active ? 'Stop' : label,
      onclick: (event) => {
        event.stopPropagation();
        toggle(url);
      },
    },
    active ? '\u25A0' : '\u25B6',
  );
}

function takesStrip(asset) {
  if (asset.takes.length === 0) {
    const folder = state.data?.paths?.generated;
    return h(
      'p',
      { class: 'takes-empty' },
      'No takes yet. Anything dropped into ',
      // The real path, not "the generated folder". Where the takes went is the
      // question every author asks first, and it is one the project file can
      // already answer.
      folder ? h('code', {}, takesFolder(asset)) : 'the project’s generated folder',
      ' shows up here.',
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
      // Play and select are separate controls on purpose. Listening has to be
      // free of consequence — an author auditions six takes to pick one, and a
      // click that both played and selected would leave the last one they
      // happened to hear as the one that ships.
      const url = mediaUrl({ section: asset.section, file: asset.file, take: take.id });
      return h(
        'div',
        { class: 'take-row' },
        take.orphaned ? null : playButton(url, `Play ${take.id}`),
        h(
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
        ),
      );
    }),
  );
}

/**
 * Records a reference clip for a character and reports what was said.
 *
 * The text is worth echoing back: the clip is the character's own lines, and
 * hearing which ones is how an author decides whether the voice fits the part
 * rather than merely whether it sounds nice.
 */
async function onRecord(member, preset) {
  try {
    const clip = await recordReference(member.id, preset);
    if (!clip) return;
    state.onStatus(
      'ok',
      `${member.name}: ${clip.seconds}s recorded as ${clip.file} — "${clip.text.slice(0, 60)}…"`,
    );
  } catch (err) {
    state.onStatus('bad', err.message);
  }
}

async function onDownload(id, button) {
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'Downloading…';
  }
  state.onStatus('warn', `downloading ${id} — this takes a minute`);
  try {
    const result = await downloadModel(id);
    state.onStatus(
      'ok',
      result.fetched.length > 0
        ? `${id}: fetched ${result.fetched.join(', ')} into ${result.path}`
        : `${id} was already downloaded`,
    );
  } catch (err) {
    state.onStatus('bad', err.message);
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
  }
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

  // Where to put a picture made somewhere else. Only for a section with no
  // generator wired up, because that is the section where this is the workflow
  // rather than a fallback — and hunting for a nested path under a folder named
  // for a filename is not something to do twenty-six times by hand.
  if (!generable) {
    actions.push(
      h(
        'button',
        {
          type: 'button',
          class: 'ghost small',
          title: 'Copy the folder to drop a finished file into',
          onclick: () => void copyText(takesFolder(asset), 'takes folder'),
        },
        'Copy folder',
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

/**
 * What the model is actually handed, under the box where the prompt is typed.
 *
 * A row shows `STYLE. SHIP. Pre-dawn at a working naval jetty…` because that is
 * what the storyboard wrote, and it is the right thing to keep editing — but it
 * is not what any generator receives, and an author judging their prompts by
 * that line is judging something else. Collapsed by default: expanded it is
 * nine hundred characters of palette that would bury the twenty-six rows around
 * it.
 */
/**
 * The size this picture is supposed to be, and what is actually on disk.
 *
 * A text box rather than a dropdown of presets. Every model has its own set of
 * shapes it is happiest at, and a list that did not contain the one somebody
 * needed would send them to hand-edit `project.yaml` — which is the hole this
 * whole editor exists to close.
 */
function sizeField(asset) {
  const size = asset.size;
  if (!size) return null;

  const box = h('input', {
    type: 'text',
    class: `size-box${size.mismatched ? ' bad' : ''}`,
    size: 11,
    spellcheck: 'false',
    placeholder: size.suggested ?? '1920x1080',
    title: 'What to generate this at, e.g. 1920x1080',
    onblur: (event) => {
      const next = event.target.value.trim();
      if (next === (size.declared ?? '')) return;
      void editField(asset.file, 'size', next);
    },
  });
  box.value = size.declared ?? '';

  return h(
    'div',
    { class: 'size-row' },
    h('span', { class: 'size-label' }, 'size'),
    box,
    // What is really there, when it can be read. This is the whole reason the
    // field exists: art made in another program arrives at whatever shape that
    // program opened on, and nothing else here would ever say so.
    size.actual
      ? h(
          'span',
          { class: `size-actual${size.mismatched ? ' bad' : ''}` },
          size.mismatched ? `on disk: ${size.actual} — wrong shape` : `on disk: ${size.actual}`,
        )
      : null,
    !size.declared && size.suggested
      ? h('span', { class: 'size-hint' }, `${size.suggested} suits the stage`)
      : null,
    // A portrait is drawn over the scene with a shadow following its outline,
    // so the file has to have an outline. Said on the row rather than only once
    // the wrong file has arrived: this is what somebody needs to know before
    // they go and draw it.
    size.cutout
      ? h(
          'span',
          { class: `size-actual${size.flat ? ' bad' : ''}` },
          size.flat ? 'no transparency — matte it out and save as PNG' : 'transparent PNG',
        )
      : null,
  );
}

function promptPreview(asset) {
  const composed = asset.composed;
  if (!composed) return null;

  const key = `preview:${asset.file}`;
  const open = state.expanded.has(key);

  return h(
    'div',
    { class: 'preview' },
    h(
      'button',
      {
        type: 'button',
        class: 'preview-toggle',
        onclick: () => {
          if (open) state.expanded.delete(key);
          else state.expanded.add(key);
          render();
        },
      },
      open ? '▾' : '▸',
      ' what the model gets',
      h('span', { class: 'preview-size' }, `${composed.positive.length} chars`),
      // A name nothing defines reaches the model as a word, and this is the
      // row it belongs to. The board says it too, but a warning about a prompt
      // is most useful next to the prompt.
      composed.unresolved.length > 0
        ? h(
            'span',
            { class: 'pill pill-stale' },
            `${composed.unresolved.join(', ')} undefined`,
          )
        : null,
    ),
    open
      ? h(
          'div',
          { class: 'preview-body' },
          asset.size?.declared
            ? h(
                'p',
                { class: 'preview-text preview-meta' },
                h('span', { class: 'preview-label' }, 'size '),
                asset.size.declared,
              )
            : null,
          h('p', { class: 'preview-text' }, composed.positive),
          composed.negative
            ? h(
                'p',
                { class: 'preview-text preview-negative' },
                h('span', { class: 'preview-label' }, 'negative '),
                composed.negative,
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              class: 'ghost small',
              // Until an image generator is wired up, the way art gets made is
              // somebody pasting this into one. Making them select nine hundred
              // characters by hand is the difference between a tool and a demo.
              onclick: (event) => {
                event.stopPropagation();
                void copyText(composed.positive, 'prompt');
              },
            },
            'Copy prompt',
          ),
          composed.negative
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'ghost small',
                  onclick: (event) => {
                    event.stopPropagation();
                    void copyText(composed.negative, 'negative');
                  },
                },
                'Copy negative',
              )
            : null,
        )
      : null,
  );
}

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    state.onStatus('ok', `${what} copied — ${text.length} characters`);
  } catch {
    state.onStatus('bad', 'the browser would not let the page write to the clipboard');
  }
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
      // The published file rather than the selected take. They are usually the
      // same clip, and the times they are not are exactly when it matters —
      // a selection changed after the last publish plays the old reading in
      // front of the room.
      asset.published
        ? playButton(
            mediaUrl({ section: asset.section, file: asset.file }),
            `Play ${asset.file} as the show will`,
          )
        : null,
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
    sizeField(asset),
    promptPreview(asset),
    takesStrip(asset),
    assetActions(asset, generable),
  );
}

/**
 * Making everything in a section that has nothing yet.
 *
 * One request per asset rather than one request for ninety, which costs a few
 * round trips and buys the two things that make a long run usable: the board
 * fills in as it goes, and it can be stopped. A batch of ninety inside a single
 * POST is five minutes of GPU time with no output and no way out of it but
 * killing the editor.
 *
 * Missing only. A row with a take already had somebody listen to it, and
 * re-rolling the whole act to get at the eleven that were never made is how an
 * afternoon of auditioning gets thrown away.
 */
function said(file, message) {
  // Most generator errors open with the filename, because a row-level failure
  // has to say which row. Prefixing it again reads as a stutter in a report
  // that may list a dozen of them.
  return message.startsWith(file) ? message : `${file}: ${message}`;
}

async function onGenerateMissing(section, files) {
  if (files.length === 0) return;
  if (
    files.length > 1 &&
    !confirm(
      `Generate ${files.length} missing ${SECTION_LABELS[section].toLowerCase()} ` +
        `asset${files.length === 1 ? '' : 's'}?\n\nThis runs one at a time and can take a ` +
        `while. You can stop it partway; anything already made is kept.`,
    )
  ) {
    return;
  }

  state.run = { section, done: 0, total: files.length, stop: false, failed: [] };
  render();

  const started = Date.now();
  for (const file of files) {
    if (state.run.stop) break;
    state.onStatus('warn', `${state.run.done + 1}/${files.length} · ${file}`);
    try {
      const result = await generateAssets(section, [file]);
      const made = result?.made?.[0];
      const failure = result?.failed?.[0];
      if (failure) state.run.failed.push(said(failure.file, failure.error));
      else if (made) {
        state.onStatus(
          'warn',
          `${state.run.done + 1}/${files.length} · ${file} · ${made.seconds}s`,
        );
      }
    } catch (err) {
      // A run that stopped on the first em dash the model choked on would lose
      // the other eighty-nine. Collect and carry on.
      state.run.failed.push(said(file, err.message));
    }
    state.run.done += 1;
    render();
  }

  const { done, stop, failed } = state.run;
  state.run = null;
  render();

  const seconds = Math.round((Date.now() - started) / 1000);
  const parts = [
    `${stop ? 'stopped after' : 'made'} ${done} of ${files.length} in ${seconds}s`,
  ];
  if (failed.length > 0) parts.push(`${failed.length} failed: ${failed.join(' · ')}`);
  state.onStatus(failed.length > 0 ? 'bad' : 'ok', parts.join(' · '));
}

/**
 * The section-level generate, and the way out of it.
 *
 * Only when something is actually missing: a button offering to make nothing is
 * a button that teaches people it does nothing.
 */
function sectionActions(section, generable) {
  if (!generable) return null;
  const running = state.run?.section === section.section;

  if (running) {
    const { done, total, stop } = state.run;
    return h(
      'span',
      { class: 'section-run' },
      h('span', { class: 'section-progress' }, `${done}/${total}`),
      h(
        'button',
        {
          type: 'button',
          class: 'ghost small',
          disabled: stop ? true : undefined,
          // Stops after the clip in flight. Killing a model mid-write leaves a
          // truncated file in the takes folder that looks like a take.
          onclick: () => {
            state.run.stop = true;
            state.onStatus('warn', 'stopping after this one…');
            render();
          },
        },
        stop ? 'Stopping…' : 'Stop',
      ),
    );
  }

  // `missing` rather than "has no takes": an *unmanaged* row has a published
  // file somebody made by hand and dropped in, and offering to generate over it
  // is offering work nobody asked for. This is the same count the pill shows.
  const missing = section.assets
    .filter((asset) => asset.status === 'missing')
    .map((asset) => asset.file);
  if (missing.length === 0) return null;

  return h(
    'button',
    {
      type: 'button',
      class: 'ghost small',
      disabled: state.run ? true : undefined,
      title: state.run
        ? 'Another section is generating'
        : 'Make one take of everything in this section that has none',
      onclick: (event) => {
        event.stopPropagation();
        void onGenerateMissing(section.section, missing);
      },
    },
    `Generate ${missing.length} missing`,
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

  // Generation needs three things agreed: a model root on this machine, a
  // model chosen for the section, and a backend that is not "made by hand".
  const generable =
    Boolean(state.models?.root) && Boolean(chosen) && (model?.backend ?? 'manual') !== 'manual';

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
    // Only for a model whose library will not fetch its own weights. The
    // others download on first load, and a button promising to do it now
    // would be lying about where the wait happens.
    chosen && !chosen.installed && (chosen.files ?? []).length > 0
      ? h(
          'button',
          {
            type: 'button',
            class: 'ghost small',
            onclick: (event) => void onDownload(chosen.id, event.target),
          },
          `Download (${chosen.sizeGb} GB)`,
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
    sectionActions(section, generable),
    h('span', { class: 'section-backend' }, model?.backend ?? 'manual'),
  );

  return h(
    'section',
    { class: `section${collapsed ? ' collapsed' : ''}` },
    head,
    collapsed ? null : modelLine,
    collapsed || section.section !== 'voice' ? null : castPanel(chosen),
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

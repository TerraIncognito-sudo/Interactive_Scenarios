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

/** Matches `DEFAULT_GAP` in timing.ts — the placeholder every gap box shows. */
const DEFAULT_GAP = 1;

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
  /** Which half of a character's sheet is showing: their voice or their face. */
  sub: new Map(),
  /**
   * Character sheets the author has opened.
   *
   * Open rather than closed, so the default is folded. A sheet is a voice, a
   * face and every line the part has — six of them unfolded is a page you
   * scroll through to find the one you wanted, which is what made working
   * through a cast painful. Folded, the whole cast is one screen.
   */
  sheetOpen: new Set(),
  /** Command-centre groups the author has unfolded past the first few. */
  commandOpen: new Set(),
  /**
   * The scenario validator's own result, pushed in from app.js.
   *
   * The source pane owns validation and the board owns assets; the command
   * centre is the one place that has to show both, so it is handed the half it
   * does not own rather than running the validator a second time.
   */
  analysis: null,
  /**
   * A section-wide generate in flight: which section, how far, and whether the
   * author has asked it to stop. One at a time — there is one GPU, and two runs
   * would take the same total time while making it impossible to say which line
   * is being worked on.
   */
  run: null,
  onScenario: () => {},
  onTab: () => {},
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
    // 'cast' rather than the board: opening a project is not an action, and
    // the first question anybody has about a show is who is in it.
    state.onScenario(data.scenarioSource, name, data.paths.scenario, 'cast');
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
async function runOnScenario(action, body) {
  if (!state.name) return null;
  const result = await api(`/api/projects/${encodeURIComponent(state.name)}/${action}`, {
    method: 'POST',
    ...(body
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  state.data = result.project;
  // Awaited, because refreshing the pane re-analyses the scenario and the
  // analysis writes the status line. Reporting what the action did before that
  // settles means the caller's message is the one that gets overwritten.
  //
  // `null` is "leave me where I am". These used to land on the Assets tab
  // because that is where the buttons were; the command centre has its own
  // now, and being thrown onto another tab by a button you pressed reads as
  // the button having failed — which is how a Set all that worked would still
  // have looked broken.
  await state.onScenario(state.data.scenarioSource, state.name, state.data.paths.scenario, null);
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

/**
 * Records a file nothing generated against the recipe it answers.
 *
 * The way out of `unmanaged`, which until now had none: importing a take wrote
 * the bytes and no record, so the row stayed unmanaged with the file sitting in
 * its own takes folder, and the board's advice was to import it again.
 */
export async function adoptTakes(files) {
  if (!state.name) return null;
  const result = await api(`/api/projects/${encodeURIComponent(state.name)}/adopt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files }),
  });
  state.data = result.project;
  render();

  const n = result.adopted?.length ?? 0;
  const copied = (result.adopted ?? []).filter((entry) => entry.copied).length;
  const parts = [];
  if (n > 0) parts.push(`adopted ${n} file${n === 1 ? '' : 's'}`);
  if (copied > 0) {
    parts.push(`${copied} copied out of the publish folder into its takes folder`);
  }
  // A skip is always a decision somebody has to make, never a failure to
  // report quietly — several unchosen files in one folder is the common one.
  for (const entry of result.skipped ?? []) parts.push(`${entry.file}: ${entry.why}`);
  state.onStatus(
    result.skipped?.length ? 'warn' : n > 0 ? 'ok' : 'warn',
    parts.length > 0 ? parts.join(' · ') : 'nothing waiting to be adopted',
  );
  return result;
}

/**
 * Deletes the disk left behind by assets the scenario stopped referencing.
 *
 * Filenames, never paths. The server recomputes the stray list and refuses a
 * name that is not on it, so this cannot ask for anything the board is not
 * already showing as rubbish.
 */
export async function discardStrays(files) {
  if (!state.name) return null;
  const result = await api(`/api/projects/${encodeURIComponent(state.name)}/discard`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files }),
  });
  state.data = result.project;
  render();

  const n = result.removed?.length ?? 0;
  const freed = result.bytes ? ` · ${(result.bytes / 1_000_000).toFixed(1)} MB freed` : '';
  state.onStatus(
    n > 0 ? 'ok' : 'warn',
    n > 0 ? `deleted the files for ${n} asset${n === 1 ? '' : 's'}${freed}` : 'nothing to delete',
  );
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

/**
 * The system file dialog, and what comes back from it.
 *
 * One `<input type="file">` reused for the whole board, created once and never
 * attached to a row: `render()` replaces the tree on every state change, and an
 * input inside it would be destroyed the moment the picker opened — taking the
 * change event with it and doing nothing at all, silently.
 *
 * The dialog is the operating system's, and it hands the page a `File` and
 * never a path. That is the safer half of the trade as well as the easier one:
 * the bytes come over the wire, so no route here opens a location somebody
 * typed.
 */
const chooser = (() => {
  const input = document.createElement('input');
  input.type = 'file';
  input.hidden = true;
  document.body.append(input);
  return input;
})();

/** What a section will take, so the dialog does not offer the rest of the disk. */
const ACCEPTS = {
  images: 'image/*,.png,.jpg,.jpeg,.webp',
  video: 'video/*,.mp4,.webm',
  voice: 'audio/*,.mp3,.wav,.m4a,.ogg,.opus,.flac,.aac',
  music: 'audio/*,.mp3,.wav,.m4a,.ogg,.opus,.flac,.aac',
  ambience: 'audio/*,.mp3,.wav,.m4a,.ogg,.opus,.flac,.aac',
  sfx: 'audio/*,.mp3,.wav,.m4a,.ogg,.opus,.flac,.aac',
};

function importInto(asset) {
  chooser.accept = ACCEPTS[asset.section] ?? '';
  chooser.value = '';
  // Re-bound each time rather than dispatched from a shared handler, because
  // the row it belongs to is the only thing that changes between uses.
  chooser.onchange = () => {
    const file = chooser.files?.[0];
    chooser.onchange = null;
    if (file) void onImport(asset, file);
  };
  chooser.click();
}

async function onImport(asset, file) {
  state.busy.add(asset.file);
  render();
  state.onStatus('warn', `importing ${file.name}…`);
  try {
    const query = new URLSearchParams({
      section: asset.section,
      file: asset.file,
      name: file.name,
    });
    const result = await api(
      `/api/projects/${encodeURIComponent(state.name)}/import?${query}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      },
    );
    state.data = result.project;
    state.onStatus(
      'ok',
      `${asset.file}: imported ${result.take} (${Math.round(result.bytes / 1024)} KB)` +
        // Said out loud, because it is the one thing an import changes beyond
        // adding a file — and only ever when there was nothing to overrule.
        (result.selected ? ' · selected, nothing else was' : ' · not selected') +
        // The half that used to be missing entirely. Without it the row stayed
        // "not reproducible" after an import, which read as the import having
        // failed.
        (result.tracked ? ' · recorded against the current recipe' : ''),
    );
  } catch (err) {
    state.onStatus('bad', said(asset.file, err.message));
  } finally {
    state.busy.delete(asset.file);
    render();
  }
}

async function deleteTake(section, asset, take) {
  state.data = await api(`/api/projects/${encodeURIComponent(state.name)}/delete-take`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ section, asset, take }),
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

/**
 * The control for auditioning one take, whichever sense that takes.
 *
 * A picture handed to an `<audio>` element is a decode error, and the message
 * it produces \u2014 "could not play that file, is it still on disk?" \u2014 sends the
 * author to look for a file that is right there. Every take carried a play
 * button because for months every take was a sound; the first image on the
 * board is what found it.
 */
function auditionButton(asset, url, name) {
  if (AUDIBLE.has(asset.section)) return playButton(url, `Play ${name}`);
  if (VISIBLE.has(asset.section)) return viewButton(asset, url, name);
  return null;
}

/** Sections you hear, and sections you look at. */
const AUDIBLE = new Set(['voice', 'music', 'ambience', 'sfx']);
const VISIBLE = new Set(['images', 'video']);

function viewButton(asset, url, name) {
  return h(
    'button',
    {
      type: 'button',
      class: 'play',
      title: `Look at ${name}`,
      'aria-label': `Look at ${name}`,
      onclick: (event) => {
        event.stopPropagation();
        openViewer(asset, url, name);
      },
    },
    '\u25C9',
  );
}

/**
 * Shows a still or a clip full size.
 *
 * The same argument as the play button, and a stronger one: choosing between
 * six readings of a line by their filenames is hard, and choosing between six
 * jetties that way is impossible. A board that can only name a picture is a
 * board whose selection step is a coin toss.
 */
function openViewer(asset, url, name) {
  player.pause();
  playing = null;

  const dialog = $('viewer');
  const image = $('viewer-image');
  const video = $('viewer-video');
  const clip = asset.section === 'video';

  video.pause();
  image.hidden = clip;
  video.hidden = !clip;
  // Cleared before it is set, so the previous take is not what is on screen
  // while a two-megabyte still decodes.
  image.removeAttribute('src');
  video.removeAttribute('src');
  if (clip) video.src = url;
  else image.src = url;

  $('viewer-name').textContent = name;
  $('viewer-name').title = name;
  $('viewer-meta').textContent = asset.size?.actual
    ? `${asset.size.actual}${asset.size.mismatched ? ` \u2014 the row asks for ${asset.size.declared}` : ''}`
    : (asset.size?.declared ?? '');
  dialog.showModal();
  render();
}

/** The one way out, so a clip can never keep playing behind a closed dialog. */
function closeViewer() {
  const dialog = $('viewer');
  const video = $('viewer-video');
  video.pause();
  video.removeAttribute('src');
  $('viewer-image').removeAttribute('src');
  if (dialog.open) dialog.close();
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
        take.orphaned ? null : auditionButton(asset, url, take.id),
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
                : `${take.hash}${take.at ? ` · ${take.at}` : ''}` +
                  (take.from ? ` · brought in from ${take.from}` : ''),
            onclick: () => void selectTake(asset.file, chosen ? null : take.id),
          },
          take.id,
          // Recorded but not generated. Said on the row, because the hash
          // beside it is a claim about which recipe this answers and not a
          // claim that a model produced it — and there is no seed to re-roll.
          take.untracked
            ? h('span', { class: 'take-tag' }, 'manual')
            : take.from
              ? h('span', { class: 'take-tag' }, 'by hand')
              : null,
        ),
        // Re-rolling is free, so a folder fills up with readings rejected on
        // the first listen — and finding the good one among nine becomes the
        // work. The published file is never touched by this; un-shipping a
        // line has to be a thing somebody meant to do.
        h(
          'button',
          {
            type: 'button',
            class: 'take-drop',
            title: chosen
              ? `Delete ${take.id} — it is the selected take, so nothing will be selected after`
              : `Delete ${take.id}`,
            'aria-label': `Delete ${take.id}`,
            onclick: (event) => {
              event.stopPropagation();
              void onDeleteTake(asset, take, chosen);
            },
          },
          '✕',
        ),
      );
    }),
  );
}

async function onDeleteTake(asset, take, chosen) {
  const warning = chosen
    ? '\n\nThis is the selected take. Nothing will be selected for this line ' +
      'afterwards — the published file stays as it is.'
    : '';
  if (!confirm(`Delete take ${take.id}?${warning}\n\nThis cannot be undone.`)) return;
  try {
    await deleteTake(asset.section, asset.file, take.id);
    state.onStatus('ok', `deleted ${take.id}`);
  } catch (err) {
    state.onStatus('bad', said(asset.file, err.message));
  }
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

  // The way out of `unmanaged`, on the row it is about. The command centre has
  // the same button over the whole group; this is the one you reach by looking
  // at the picture and deciding it is the one.
  if (asset.status === 'unmanaged') {
    actions.push(
      h(
        'button',
        {
          type: 'button',
          class: 'ghost small',
          title:
            'Record this file against the recipe as it stands. It stops being ' +
            '"not reproducible", and editing the prompt afterwards marks it stale.',
          onclick: () => void adoptTakes([asset.file]),
        },
        'Adopt',
      ),
    );
  }

  // A file made somewhere else, brought in as a take. On every row: there is
  // no asset for which "I already have this one" is the wrong answer, and a
  // recorded line is as real a take as a generated one.
  actions.push(
    h(
      'button',
      {
        type: 'button',
        class: 'ghost small',
        disabled: busy ? true : undefined,
        title: 'Pick a finished file and copy it in as a take',
        onclick: () => importInto(asset),
      },
      'Import…',
    ),
  );

  // The folder, for dropping several in at once — which a file dialog is worse
  // at than a paste into an explorer window. Only where nothing generates,
  // because that is where this is the workflow rather than the fallback.
  //
  // Named for what lands on the clipboard rather than for the gesture. "Copy
  // folder" read as though it copied the folder somewhere, and the status line
  // it produced counted characters, which is a fact about a path nobody wanted
  // — so neither end of it said what it was for.
  if (!generable) {
    actions.push(
      h(
        'button',
        {
          type: 'button',
          class: 'ghost small',
          title:
            `Copy this asset's takes folder — ${takesFolder(asset)} — so you can paste it ` +
            `into Explorer and drop finished files in. Anything in there shows up as a take.`,
          onclick: () =>
            void copyText(
              takesFolder(asset),
              'takes folder path copied — paste it into Explorer and drop finished files in',
            ),
        },
        'Copy takes path',
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
/**
 * The gap after this clip, and the beat that follows from it.
 *
 * Only where there is a runtime to add it to. A gap box on a clip nobody can
 * measure is a control whose effect cannot be shown, and the number it would
 * produce is one the retime button will refuse to write.
 */
function gapField(asset) {
  if (asset.section !== 'voice' || asset.seconds === undefined) return null;
  const matches = asset.timed;
  return h(
    'div',
    { class: 'gap-field' },
    h('label', {}, 'Gap after'),
    gapBox(asset),
    h('span', { class: 'gap-sum' }, `${asset.seconds.toFixed(1)}s clip → hold ${asset.targetHold}s`),
    matches
      ? h('span', { class: 'gap-ok' }, 'the scenario agrees')
      : h(
          'button',
          {
            type: 'button',
            class: 'ghost small',
            title: 'Write this beat into scenario.yaml',
            onclick: () => void onRetime([asset.file]),
          },
          asset.hold === undefined ? 'Set the hold' : `Change hold ${asset.hold}s → ${asset.targetHold}s`,
        ),
  );
}
/**
 * What the file is, when that is not what its name says.
 *
 * Silent otherwise. A row that announced "this .mp3 is an MP3" on all ninety
 * clips would be ninety lines of nothing, and the one line that mattered would
 * be indistinguishable from them.
 */
function formatField(asset) {
  const format = asset.format;
  if (!format?.rename) return null;
  return h(
    'div',
    { class: 'format-row' },
    h(
      'span',
      { class: 'format-warn' },
      `This is ${format.actual}, not .${format.declared}. The show asks for the name in ` +
        `scenario.yaml and the server labels it from the extension.`,
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'ghost small',
        title:
          'Rename it everywhere — the scenario, the recipe, the takes folder and the ' +
          'published file. Nothing is re-encoded.',
        onclick: () => void onRetype([asset.file]),
      },
      `Rename to ${format.rename.split('/').pop()}`,
    ),
  );
}

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

/**
 * How much bigger what the model gets is than what the row says.
 *
 * `268 → 1223 chars` is the evidence. A storyboard writes `STYLE. SHIP.` and
 * means four hundred characters of palette and three hundred of hull; the row
 * keeps the shorthand because that is what one edit has to change all of, and
 * without a number beside it the expansion is invisible from the board.
 */
function expansion(asset) {
  const from = (asset.row?.prompt ?? '').trim().length;
  const to = asset.composed?.positive?.length ?? 0;
  return from && to > from ? `${from} → ${to} chars` : `${to} chars`;
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
      h(
        'span',
        { class: 'preview-size' },
        // Both numbers, because one of them is the whole point. The box above
        // still holds the storyboard's shorthand and always will — it is what
        // gets edited — so a row that only said "1223 chars" left the author
        // looking at `STYLE. SHIP.` with no evidence anything had expanded.
        expansion(asset),
      ),
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
    // Collapsed still shows it. The invariant is that the board shows the
    // composed prompt — every complaint about the art this pipeline makes has
    // started with not being able to see what the model was given — and a
    // disclosure triangle under a textarea full of `STYLE. SHIP.` reads as a
    // footnote about the thing above it rather than as the thing itself.
    !open ? h('p', { class: 'preview-peek' }, composed.positive) : null,
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
                void copyText(composed.positive, `prompt copied — ${composed.positive.length} characters`);
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
                    void copyText(composed.negative, `negative copied — ${composed.negative.length} characters`);
                  },
                },
                'Copy negative',
              )
            : null,
        )
      : null,
  );
}

/**
 * Puts something on the clipboard and says what to do with it.
 *
 * `what` is the whole message, not a noun. It used to be a noun with
 * "copied — 121 characters" after it, which is the one fact about a path that
 * helps nobody: the question a person has at that moment is what they are
 * supposed to paste it into.
 */
async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    state.onStatus('ok', what);
  } catch {
    state.onStatus('bad', 'the browser would not let the page write to the clipboard');
  }
}

/**
 * How long the clip runs, against the beat it has to fit in.
 *
 * Shown together or not at all: either number alone is trivia, and the pair is
 * the check. Silent when the runtime could not be read, because being sent to
 * re-cut a line that was already right is worse than not being told.
 */
function timingPill(asset) {
  if (asset.seconds === undefined) return null;
  const runs = `${asset.seconds.toFixed(1)}s`;
  const hold = asset.hold;
  if (hold === undefined) {
    return h('span', { class: 'pill pill-timing', title: 'Clip runtime' }, runs);
  }
  const spare = hold - asset.seconds;
  const tone = spare < 0 ? ' bad' : spare < 1 ? ' tight' : '';
  return h(
    'span',
    {
      class: `pill pill-timing${tone}`,
      title:
        spare < 0
          ? `The beat ends ${Math.abs(spare).toFixed(1)}s before the line does`
          : `${spare.toFixed(1)}s of headroom after the words stop`,
    },
    `${runs} / hold ${hold}s`,
  );
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
    { class: `asset asset-${asset.status}`, id: rowId(asset.file) },
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
        ? auditionButton(
            asset,
            mediaUrl({ section: asset.section, file: asset.file }),
            asset.file,
          )
        : null,
      // The two numbers that decide whether a line survives to the projector.
      // The show never opens the clip: the beat ends when `hold` says it does,
      // so a hold under the runtime cuts the reading off mid-word and nothing
      // else on the board would ever mention it.
      timingPill(asset),
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
    gapField(asset),
    sizeField(asset),
    formatField(asset),
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

  await runBatch(section, files, `missing ${SECTION_LABELS[section].toLowerCase()}`);
}

/**
 * The loop itself, shared by the section run and the per-actor one.
 *
 * One `state.run` for the whole board, so the Stop button and the progress
 * count belong to whichever started it. Two concurrent batches would be two
 * queues into one sidecar, which serialises them anyway — with no way to tell
 * which of them the count on screen is describing.
 */
async function runBatch(section, files, what) {
  if (files.length === 0) return;

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
    `${what}: ${stop ? 'stopped after' : 'made'} ${done} of ${files.length} in ${seconds}s`,
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
  const shown = rowsFor(section);

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
    collapsed ? null : elsewhere(section),
    collapsed
      ? null
      : shown.length > 0
        ? shown.map((asset) => assetRow(asset, generable))
        : // Only when the section is *actually* empty. A voice section holding
          // ninety-two clips that live on another tab is not "nobody speaks
          // yet", and the note above has already said where they went.
          section.assets.length === 0
          ? h('p', { class: 'empty' }, emptyNote(section))
          : null,
  );
}

/**
 * The rows this section still shows here.
 *
 * Voice and portraits belong to a part, and a part has a sheet of its own now.
 * Listing them in both places would be two views of one thing that can disagree
 * about what is selected the moment either is a click behind — so each row has
 * exactly one home, and the section says where.
 */
function rowsFor(section) {
  if (section.section === 'voice') return [];
  if (section.section === 'images') return section.assets.filter((asset) => !isPortraitAsset(asset));
  return section.assets;
}

function elsewhere(section) {
  const moved =
    section.section === 'voice'
      ? section.assets.length
      : section.section === 'images'
        ? section.assets.filter(isPortraitAsset).length
        : 0;
  if (moved === 0) return null;

  return h(
    'p',
    { class: 'section-moved' },
    section.section === 'voice'
      ? `All ${moved} clip${moved === 1 ? '' : 's'} are on the `
      : `${moved} portrait${moved === 1 ? '' : 's'} ${moved === 1 ? 'is' : 'are'} on the `,
    h(
      'button',
      {
        type: 'button',
        class: 'linkish',
        onclick: (event) => {
          event.stopPropagation();
          state.onTab('cast');
        },
      },
      'Characters',
    ),
    ' tab, with the part they belong to. The model and the section-wide run stay here.',
  );
}

function emptyNote(section) {
  if (section.section === 'voice') return 'Nobody in this scenario speaks yet.';
  return 'Nothing in the scenario asks for this yet.';
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

/**
 * A portrait is a picture of a person, which is not the same job as a picture
 * of a place.
 *
 * They share a *section* deliberately — same model, same style, same negative,
 * because a face that does not match the film reads as clip art the moment it
 * slides in — so this is a split in where they are shown, not in how they are
 * made. `origins` is the scenario's own answer to which is which, so the board
 * and the generator cannot disagree about it.
 */
function isPortraitAsset(asset) {
  return (asset.origins ?? []).some((origin) => origin.kind === 'sprite');
}

/** The portrait row belonging to one character, if the scenario declares one. */
function portraitFor(id) {
  for (const view of state.data?.overview?.sections ?? []) {
    for (const asset of view.assets) {
      if ((asset.origins ?? []).some((o) => o.kind === 'sprite' && o.character === id)) {
        return asset;
      }
    }
  }
  return undefined;
}

/** The picture to show for a portrait: the take being auditioned, else the shipped one. */
function portraitUrl(asset) {
  if (!asset) return null;
  if (asset.selected) {
    return mediaUrl({ section: asset.section, file: asset.file, take: asset.selected });
  }
  return asset.published ? mediaUrl({ section: asset.section, file: asset.file }) : null;
}

/** What the voice section is set to, which the cast controls all depend on. */
function voiceModel() {
  const section = (state.data?.overview?.sections ?? []).find((view) => view.section === 'voice');
  const available = (state.models?.models ?? []).filter((entry) => entry.section === 'voice');
  const chosen = available.find((entry) => entry.id === section?.model?.file);
  const generable =
    Boolean(state.models?.root) &&
    Boolean(chosen) &&
    (section?.model?.backend ?? 'manual') !== 'manual';
  return { section, chosen, generable };
}

export function renderCast() {
  const container = $('cast-sheets');
  if (!container) return;

  if (!state.data) {
    return void container.replaceChildren(h('p', { class: 'empty' }, 'No project open.'));
  }

  const { section, chosen, generable } = voiceModel();
  const groups = section ? byActor(section) : [];
  if (groups.length === 0) {
    return void container.replaceChildren(
      h('p', { class: 'empty' }, 'Nobody in this scenario speaks yet.'),
    );
  }

  const clones = chosen?.clones === true;
  const palette = (state.models?.models ?? []).find((entry) => (entry.voices ?? []).length > 0);

  container.replaceChildren(
    ...groups.map((group) =>
      characterSheet(group, { clones, palette, chosen, generable, section }),
    ),
  );

  collapseBar($('cast-collapse'), {
    open: groups.filter((group) => state.sheetOpen.has(group.id)).length,
    total: groups.length,
    what: 'sheet',
    expandAll: () => {
      for (const group of groups) state.sheetOpen.add(group.id);
    },
    collapseAll: () => state.sheetOpen.clear(),
  });
}

/**
 * Expand all / Collapse all, over whatever is foldable on a tab.
 *
 * One function for the cast and for the board because the two are the same
 * control over two different sets, and the count is what makes it a control
 * rather than a pair of guesses — "3 of 7 open" is the answer to the question
 * you are pressing it to find out.
 */
function collapseBar(host, { open, total, what, expandAll, collapseAll }) {
  if (!host) return;
  if (total === 0) return void (host.hidden = true);
  host.hidden = false;

  const button = (label, disabled, run) =>
    h(
      'button',
      {
        type: 'button',
        class: 'ghost small',
        disabled: disabled ? true : undefined,
        onclick: () => {
          run();
          render();
        },
      },
      label,
    );

  host.replaceChildren(
    button('Expand all', open === total, expandAll),
    button('Collapse all', open === 0, collapseAll),
    h(
      'span',
      { class: 'collapse-count' },
      `${open} of ${total} ${what}${total === 1 ? '' : 's'} open`,
    ),
  );
}

/**
 * One character, whole.
 *
 * The two halves are made weeks apart by different models and were, until now,
 * in two different places on the board — a voice under Voice, a face under
 * Images, joined only by an id the author had to carry in their head. What a
 * part actually is is both at once, so the sheet is both at once, and the
 * thumbnail is there because a face is the one thing on this board you cannot
 * check by reading.
 */
function characterSheet(group, context) {
  const which = state.sub.get(group.id) ?? 'voice';
  const portrait = group.id === UNCAST ? undefined : portraitFor(group.id);
  const url = portraitUrl(portrait);
  const ready = group.assets.filter((asset) => asset.status === 'ready').length;

  const tab = (key, label, note) =>
    h(
      'button',
      {
        type: 'button',
        class: `subtab${which === key ? ' on' : ''}`,
        role: 'tab',
        'aria-selected': String(which === key),
        onclick: () => {
          state.sub.set(group.id, key);
          render();
        },
      },
      label,
      note ? h('span', { class: 'subtab-note' }, note) : null,
    );

  // Folded unless somebody opened it. What the head says is chosen for the
  // folded case, because that is the one it is read in most: how many lines,
  // how many are done, and whether the face exists — enough to decide whether
  // this is the part you came for without opening it.
  const open = state.sheetOpen.has(group.id);
  const fold = () => {
    if (open) state.sheetOpen.delete(group.id);
    else state.sheetOpen.add(group.id);
    render();
  };

  return h(
    'section',
    { class: `sheet${open ? '' : ' folded'}`, id: sheetId(group.id) },
    h(
      'header',
      { class: 'sheet-head', onclick: fold },
      h(
        'div',
        { class: `sheet-face${url ? '' : ' empty'}` },
        url
          ? h('img', {
              src: url,
              alt: `${group.name}'s portrait`,
              // The board's own answer to "did that come out right" — clicking
              // it opens the same viewer every other picture uses. Stopped
              // here so looking at a face is not also a fold.
              onclick: (event) => {
                event.stopPropagation();
                openViewer(portrait, url, portrait.file);
              },
            })
          : h('span', { class: 'sheet-noface' }, portrait ? '—' : ''),
      ),
      h(
        'div',
        { class: 'sheet-who' },
        h('h3', {}, group.id === UNCAST ? 'no voice set' : group.name),
        h('code', { class: 'sheet-id' }, group.id),
        h(
          'p',
          { class: 'sheet-tally' },
          `${group.assets.length} line${group.assets.length === 1 ? '' : 's'} · ${ready} ready`,
          portrait ? ` · portrait ${portrait.status}` : ' · no portrait',
        ),
      ),
      h('span', { class: 'spacer' }),
      h(
        'button',
        {
          type: 'button',
          class: 'sheet-fold',
          'aria-expanded': String(open),
          title: open ? 'Fold this part away' : 'Open this part',
          onclick: (event) => {
            event.stopPropagation();
            fold();
          },
        },
        open ? '▾ Close' : '▸ Open',
      ),
    ),
    open
      ? h(
          'div',
          { class: 'subtabs', role: 'tablist' },
          tab('voice', 'Voice', `${ready}/${group.assets.length}`),
          tab('portrait', 'Portrait', portrait ? portrait.status : 'none'),
        )
      : null,
    open
      ? which === 'voice'
        ? voiceSheet(group, context)
        : portraitSheet(group, portrait, context)
      : null,
  );
}

function voiceSheet(group, context) {
  const member = group.member;
  const work = actorWork(group);

  return h(
    'div',
    { class: 'sheet-body' },
    member
      ? castMember(member, {
          clones: context.clones,
          voices: context.palette?.installed
            ? (context.palette.voices ?? [])
            : (context.chosen?.voices ?? []),
        })
      : h(
          'p',
          { class: 'hint' },
          'These lines have no voice set, so nothing can read them. ' +
            'Declare a voice: on them — the Give every line a voice button does it.',
        ),
    group.id === UNCAST
      ? null
      : h(
          'div',
          { class: 'sheet-actions' },
          actorActions(group, context.section, context.generable, work),
        ),
    h(
      'div',
      { class: 'sheet-lines' },
      group.assets.map((asset) => assetRow(asset, context.generable)),
    ),
  );
}

/**
 * The half nothing generates yet.
 *
 * Which makes the folder the important thing on it: a portrait is made in
 * another program and dropped in, so the row's takes strip, its size check and
 * the path to put a file in are the whole workflow.
 */
function portraitSheet(group, portrait, context) {
  if (group.id === UNCAST) {
    return h(
      'div',
      { class: 'sheet-body' },
      h('p', { class: 'hint' }, 'Lines with no voice set belong to no character, so no face.'),
    );
  }

  if (!portrait) {
    return h(
      'div',
      { class: 'sheet-body' },
      h(
        'p',
        { class: 'hint' },
        `The scenario declares no sprite: for ${group.name}, so the display shows no face `,
        'while they speak. Who gets a portrait is the storyboard’s decision — it is the ',
        'characters it drew a character sheet for. If it drew one for them, ',
        h('strong', {}, 'Give speakers a portrait'),
        ' on the Assets tab will declare it.',
      ),
    );
  }

  return h('div', { class: 'sheet-body' }, assetRow(portrait, false));
}

// ---------------------------------------------------------------------------
// Voice, by who reads it
// ---------------------------------------------------------------------------

/**
 * The voice section grouped by the part rather than by the filename.
 *
 * A show's clips sort as `beau-a4-01`, `beau-c2-03`, `narr-a1-01` — which is
 * alphabetical, which is nearly the right answer and not the right answer. The
 * unit of work here is a *voice*: it is set once, it belongs to one person, and
 * changing it makes every line they speak stale at once. Ninety rows in filename
 * order means finding those lines is a scroll, and re-doing them is ninety
 * clicks.
 *
 * Order is the cast's, not the alphabet's — `buildCast` already sorts it, and
 * two orderings of the same people is one of them being wrong.
 */
function byActor(section) {
  const cast = state.data?.overview?.cast ?? [];
  const groups = new Map();
  const place = (id) => {
    if (!groups.has(id)) groups.set(id, { id, name: id, assets: [] });
    return groups.get(id);
  };

  for (const member of cast) {
    const group = place(member.id);
    group.name = member.name;
    group.member = member;
  }

  for (const asset of section.assets) {
    // A row with no `voice:` has never been wired. It still has to appear, or a
    // line nobody can generate is a line nobody can see is missing.
    place(asset.row?.voice ?? UNCAST).assets.push(asset);
  }

  return [...groups.values()].filter((group) => group.assets.length > 0);
}

const UNCAST = '—';

/** What each of the three actor-level actions has to work on. */
function actorWork(group) {
  const files = group.assets.map((asset) => asset.file);
  // Every clip, not the missing ones. Re-voicing a character is the case this
  // exists for, and after it every line they have needs saying again — the
  // section-level button's "missing only" rule would skip all of them.
  const stale = group.assets.filter((asset) => asset.status === 'stale');
  // A take newer than the chosen one is what a regenerate leaves behind:
  // generating never steals a selection, so the row still points at a reading
  // made by a voice that no longer exists.
  const superseded = group.assets.filter((asset) => {
    const last = asset.takes?.[asset.takes.length - 1];
    return last && asset.selected && asset.selected !== last.id;
  });
  // Everything with a selection, not "everything that looks like it needs it".
  // `ready` means the selected take matches the recipe — it says nothing about
  // whether that take was ever copied to the name the show opens, and nothing
  // on this board knows. Publishing is a file copy and it is idempotent, so the
  // honest filter is the one the author asked for: the selected clips.
  // `unselected` is what a selection pointing at a deleted take reads as, and
  // publishing that is an error rather than a copy.
  const publishable = group.assets.filter(
    (asset) => asset.selected && asset.status !== 'unselected',
  );
  return { files, stale, superseded, publishable };
}

/**
 * The three things you do to a whole part at once.
 *
 * Each appears only when it has work, and each says how much. A row of buttons
 * that are always there teaches nobody what state the part is in; a row that
 * says "Regenerate 34 · Use newest 34 · Publish 34" is the re-voicing job,
 * written down in the order it has to happen.
 */
function actorActions(group, section, generable, work) {
  if (group.id === UNCAST) return null;
  const busy = Boolean(state.run);
  const buttons = [];

  if (generable) {
    // Stale first when there are any: changing a voice marks exactly the lines
    // that need saying again, and re-rolling the eleven that were already right
    // is GPU time spent to replace readings somebody had approved. The label
    // says which of the two it is, because "Regenerate 3" next to fourteen rows
    // is otherwise a number with no explanation.
    const stale = work.stale.length > 0;
    const files = stale ? work.stale.map((asset) => asset.file) : work.files;
    buttons.push(
      h(
        'button',
        {
          type: 'button',
          class: 'ghost small',
          disabled: busy ? true : undefined,
          title: stale
            ? 'Make a new take of every line of theirs whose voice has changed since it was made'
            : 'Make a new take of every line they have',
          onclick: (event) => {
            event.stopPropagation();
            void onRegenerateActor(section.section, group, files);
          },
        },
        stale ? `Regenerate ${files.length} stale` : `Regenerate ${files.length}`,
      ),
    );
  }

  if (work.superseded.length > 0) {
    buttons.push(
      h(
        'button',
        {
          type: 'button',
          class: 'ghost small',
          disabled: busy ? true : undefined,
          // Separate from generating on purpose. Generating never steals a
          // selection, because the first acceptable reading of every line is
          // otherwise the one that ships — so moving the selection is its own
          // act, and this is it, said out loud with a count.
          title: 'Select the newest take for every line of theirs that has one waiting',
          onclick: (event) => {
            event.stopPropagation();
            void onUseNewest(group, work.superseded);
          },
        },
        `Use newest ${work.superseded.length}`,
      ),
    );
  }

  if (work.publishable.length > 0) {
    buttons.push(
      h(
        'button',
        {
          type: 'button',
          class: 'ghost small',
          disabled: busy ? true : undefined,
          title: 'Copy the selected take of every line of theirs to the name the show opens',
          onclick: (event) => {
            event.stopPropagation();
            void onPublishActor(section.section, group, work.publishable);
          },
        },
        `Publish ${work.publishable.length}`,
      ),
    );
  }

  return buttons.length > 0 ? buttons : null;
}

async function onRegenerateActor(section, group, files) {
  if (
    !confirm(
      `Make a new take of ${files.length} line${files.length === 1 ? '' : 's'} for ${group.name}?` +
        `\n\nNothing is replaced — each one is added beside the takes already there, and ` +
        `nothing is published. You can stop it partway.`,
    )
  ) {
    return;
  }
  await runBatch(section, files, `${group.name}`);
}

async function onUseNewest(group, assets) {
  let moved = 0;
  for (const asset of assets) {
    const last = asset.takes[asset.takes.length - 1];
    try {
      await selectTake(asset.file, last.id);
      moved += 1;
    } catch (err) {
      state.onStatus('bad', said(asset.file, err.message));
      return;
    }
  }
  state.onStatus('ok', `${group.name}: ${moved} now on their newest take`);
}

async function onPublishActor(section, group, assets) {
  const files = assets.map((asset) => asset.file);
  try {
    const result = await publishAssets(section, files);
    const failed = result?.failed ?? [];
    const done = result?.published?.length ?? 0;
    state.onStatus(
      failed.length > 0 ? 'bad' : 'ok',
      failed.length > 0
        ? `${group.name}: published ${done}, ${failed.length} failed: ` +
            failed.map((entry) => said(entry.file, entry.error)).join(' · ')
        : `${group.name}: published ${done}`,
    );
  } catch (err) {
    state.onStatus('bad', err.message);
  }
}

// ---------------------------------------------------------------------------
// Command centre
// ---------------------------------------------------------------------------

/**
 * The one question the board could not answer: am I done?
 *
 * Everything here is a projection of `state.data.outstanding`, which the server
 * builds from the same `Overview` the other tabs render. Nothing is recomputed
 * client-side — a second opinion about what is finished would be a second
 * opinion nobody could see, since both would look like a full list.
 *
 * Every line is a link to the row it describes and every heading acts on the
 * whole group, because a list of forty things to fix that cannot fix any of
 * them is a list you read once.
 */

/** How many of a group to show before it folds. Enough to see the shape of it. */
const COMMAND_PEEK = 6;

function rowId(file) {
  return `row-${String(file).replace(/[^A-Za-z0-9]+/g, '-')}`;
}

function sheetId(character) {
  return `sheet-${String(character).replace(/[^A-Za-z0-9]+/g, '-')}`;
}

/** Every asset view on the board, by filename. */
function assetsByFile() {
  const found = new Map();
  for (const section of state.data?.overview?.sections ?? []) {
    for (const asset of section.assets) found.set(asset.file, asset);
  }
  return found;
}

/**
 * Where a row actually lives on the board.
 *
 * Not every asset is on the Assets tab, and the two that are not are the two
 * this list talks about most. A voice clip belongs to the part that speaks it
 * and renders inside that character's sheet; a portrait is the same character's
 * face on the other sub-tab. `rowsFor` gives them away, so sending somebody to
 * Assets for either lands them on a tab that does not contain the row — which
 * is worse than not linking at all, because it looks like the row is gone.
 */
function homeOf(asset) {
  if (!asset) return { tab: 'assets' };
  if (isPortraitAsset(asset)) {
    const origin = (asset.origins ?? []).find((entry) => entry.kind === 'sprite');
    return { tab: 'cast', character: origin?.character, sub: 'portrait' };
  }
  if (asset.section === 'voice') {
    // The same fallback `byActor` uses, so the sheet this opens is the sheet
    // the row is really in — including the unwired ones.
    return { tab: 'cast', character: asset.row?.voice ?? UNCAST, sub: 'voice' };
  }
  return { tab: 'assets' };
}

/**
 * Hands somebody to the thing itself.
 *
 * The digest deliberately says very little about each item — the row already
 * says all of it, and repeating half of it here is two places to keep true. So
 * the item is a link, and it opens the tab the row lives on, unfolds whatever
 * is hiding it, and scrolls it into the middle of the view.
 */
function jumpTo(item) {
  if (item.character && !item.file) {
    state.onTab('cast');
    // Sheets are folded by default, so scrolling to one without opening it
    // lands on a header — which reads as the part having no work in it.
    state.sheetOpen.add(item.character);
    render();
    scrollToId(sheetId(item.character));
    return;
  }
  if (!item.file) return;

  const asset = assetsByFile().get(item.file);
  const home = homeOf(asset);

  if (home.tab === 'cast') {
    state.onTab('cast');
    // A sheet shows one half at a time, and the row is on the other one often
    // enough that not switching is the same bug in a smaller place.
    if (home.character) state.sub.set(home.character, home.sub);
    if (home.character) state.sheetOpen.add(home.character);
    render();
    scrollToId(rowId(item.file), home.character ? sheetId(home.character) : undefined);
    return;
  }

  state.onTab('assets');
  // A collapsed section would scroll to a row that is not rendered.
  if (item.section) state.collapsed.delete(item.section);
  render();
  scrollToId(rowId(item.file));
}

/**
 * Scrolls to a row once the render that creates it has landed.
 *
 * `render()` replaces the tree, so the element does not exist until the frame
 * after. The fallback matters for a portrait whose row is real but whose sheet
 * is the thing worth looking at.
 */
function scrollToId(id, fallback) {
  requestAnimationFrame(() => {
    const el = document.getElementById(id) ?? (fallback ? document.getElementById(fallback) : null);
    el?.scrollIntoView({ block: 'center' });
    if (!el) return;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  });
}

function bySection(items) {
  const found = new Map();
  for (const item of items) {
    if (!item.section || !item.file) continue;
    const list = found.get(item.section);
    if (list) list.push(item.file);
    else found.set(item.section, [item.file]);
  }
  return found;
}

async function onCommandGenerate(items) {
  const groups = [...bySection(items)];
  const total = items.length;
  if (
    total > 1 &&
    !confirm(
      `Generate ${total} asset${total === 1 ? '' : 's'}?\n\nThis runs one at a time and can ` +
        `take a while. You can stop it partway; anything already made is kept.`,
    )
  ) {
    return;
  }
  // Sequential across sections as well as within one: there is one GPU, and
  // two runs would take the same total time while making it impossible to say
  // which line the count on screen is describing.
  for (const [section, files] of groups) {
    if (state.run?.stop) break;
    await runBatch(section, files, `${SECTION_LABELS[section].toLowerCase()} from the command centre`);
  }
  await refreshAssets();
}

async function onCommandUseNewest(items) {
  const byFile = assetsByFile();
  let moved = 0;
  for (const item of items) {
    const asset = byFile.get(item.file);
    if (!asset) continue;
    // The one that matches the recipe, when there is one. Newest is only a
    // guess at that, and after a regenerate it is the wrong guess as soon as
    // anything else was rolled afterwards.
    const usable = (asset.takes ?? []).filter((take) => !take.orphaned);
    const wanted =
      usable.find((take) => take.id === asset.matchingTake) ??
      usable.find((take) => take.hash === asset.hash) ??
      usable[usable.length - 1];
    if (!wanted) continue;
    try {
      await selectTake(asset.file, wanted.id);
      moved += 1;
    } catch (err) {
      state.onStatus('bad', said(item.file, err.message));
      return;
    }
  }
  state.onStatus('ok', `${moved} now on their newest take`);
}

async function onCommandPublish(items) {
  let done = 0;
  const failed = [];
  for (const [section, files] of bySection(items)) {
    try {
      const result = await publishAssets(section, files);
      done += result?.published?.length ?? 0;
      for (const entry of result?.failed ?? []) failed.push(said(entry.file, entry.error));
    } catch (err) {
      failed.push(err.message);
    }
  }
  state.onStatus(
    failed.length > 0 ? 'bad' : 'ok',
    failed.length > 0
      ? `published ${done}, ${failed.length} failed: ${failed.join(' · ')}`
      : `published ${done}`,
  );
}

async function onCommandPrune(items) {
  if (
    !confirm(
      `Remove ${items.length} recipe${items.length === 1 ? '' : 's'} the scenario no longer ` +
        `references?\n\nThe prompts on them are thrown away. Takes already generated stay ` +
        `on disk.`,
    )
  ) {
    return;
  }
  await pruneOrphans();
}

/**
 * Takes responsibility for a file nothing generated.
 *
 * No confirm. It writes a ledger line and touches no bytes except in the one
 * case where there is nothing in the takes folder to record, and that is a
 * copy rather than a move — nothing is lost either way, and a dialog in front
 * of twelve of them is a dialog nobody reads by the fourth.
 */
async function onCommandAdopt(items) {
  await adoptTakes(items.map((item) => item.file));
}

/**
 * Deletes the files an asset the story dropped left behind.
 *
 * Named for what it does rather than for what it tidies. The confirm spells
 * out both halves — the shipped clip and every take of it — because a take
 * folder can hold six readings somebody chose between, and the fact that the
 * scenario no longer plays any of them is not the same as nobody wanting them.
 * There is no undo: the files go.
 */
async function onCommandDiscard(items) {
  const files = items.map((item) => item.file);
  const shown = files.slice(0, 8);
  const rest = files.length - shown.length;
  const named = shown.join('\n') + (rest > 0 ? `\n…and ${rest} more` : '');
  if (
    !confirm(
      `Delete the files for ${files.length} asset${files.length === 1 ? '' : 's'} the ` +
        `scenario no longer references?\n\n${named}\n\n` +
        `This removes the published file and every take. It cannot be undone.`,
    )
  ) {
    return;
  }
  await discardStrays(files);
}

const COMMAND_RUNNERS = {
  retime: onRetime,
  generate: onCommandGenerate,
  'use-newest': onCommandUseNewest,
  publish: onCommandPublish,
  prune: onCommandPrune,
  discard: onCommandDiscard,
  adopt: onCommandAdopt,
  retype: onRetype,
};

const ACTION_LABELS = {
  retime: 'Set',
  generate: 'Generate',
  'use-newest': 'Use newest',
  publish: 'Publish',
  prune: 'Remove',
  discard: 'Delete',
  adopt: 'Adopt',
  retype: 'Rename',
};

/** The button on a group heading, when the group is something a machine can do. */
function commandGroupButton(group) {
  const run = COMMAND_RUNNERS[group.action];
  if (!run) return null;
  return h(
    'button',
    {
      type: 'button',
      class: 'ghost small',
      disabled: state.run ? true : undefined,
      onclick: (event) => {
        event.stopPropagation();
        void run(group.items);
      },
    },
    `${ACTION_LABELS[group.action]} all ${group.items.length}`,
  );
}

/**
 * True when there is somewhere to send somebody.
 *
 * A recipe the story dropped and a file the story dropped have no row on any
 * tab — that is what makes them orphans. Linking them anyway opens a tab that
 * does not contain them, which reads as the row having been deleted already,
 * which is worse than not linking at all.
 */
function reachable(item) {
  if (item.character && !item.file) return true;
  return Boolean(item.file) && assetsByFile().has(item.file);
}

function commandItem(group, item) {
  const run = COMMAND_RUNNERS[group.action];
  return h(
    'li',
    { class: 'command-item' },
    reachable(item)
      ? h(
          'button',
          {
            type: 'button',
            class: 'command-link',
            title: 'Show me',
            onclick: () => jumpTo(item),
          },
          item.label,
        )
      : h('code', { class: 'command-gone' }, item.label),
    item.detail ? h('span', { class: 'command-detail' }, item.detail) : null,
    h('span', { class: 'spacer' }),
    run
      ? h(
          'button',
          {
            type: 'button',
            class: 'ghost small',
            disabled: state.run ? true : undefined,
            onclick: (event) => {
              event.stopPropagation();
              void run([item]);
            },
          },
          ACTION_LABELS[group.action],
        )
      : null,
  );
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/**
 * Sets beats to the length of the clips that play in them.
 *
 * `runOnScenario` rather than a plain POST, because this writes the scenario
 * and the pane holds its own copy: refresh it late and the analysis overwrites
 * the status line, do not refresh it at all and the next Save reverts every
 * beat this just set.
 *
 * The numbers are never sent. The server computes each one from the runtime it
 * measured and the gap the row declares, so the board and the file cannot end
 * up disagreeing about arithmetic done in two places.
 */
async function onRetime(items) {
  if (!state.name) return;
  // Two callers hand over two shapes, and they used to be taken as one. A row
  // sends its own filename; a group heading sends the group's *items*, which
  // are objects. The objects went to a route that matches on filename, matched
  // nothing, wrote nothing and reported nothing — a Set all button that
  // prompted, navigated away and left every beat exactly as it was.
  const files = items?.map((entry) => (typeof entry === 'string' ? entry : entry.file));
  const many = !files || files.length > 1;
  const count = files ? files.length : (timingGroup()?.items.length ?? 0);
  if (count === 0) return;
  if (
    many &&
    !confirm(
      `Set ${count} beat${count === 1 ? '' : 's'} to match ${count === 1 ? 'its' : 'their'} ` +
        `clip${count === 1 ? '' : 's'}?\n\nThis rewrites hold: in scenario.yaml. Any comment ` +
        `beside one that changes is reported, not edited.`,
    )
  ) {
    return;
  }

  try {
    const result = await runOnScenario('retime', files ? { files } : undefined);
    if (!result) return;
    const changed = result.changed?.length ?? 0;
    const parts = [`${changed} beat${changed === 1 ? '' : 's'} set`];
    if (result.skipped?.length) parts.push(`${result.skipped.length} had no line to write to`);
    if (result.comments?.length) {
      // The house rule: report the prose, never rewrite it.
      parts.push(
        `comments beside a beat at line${result.comments.length === 1 ? '' : 's'} ` +
          `${result.comments.join(', ')} may now be wrong`,
      );
    }
    state.onStatus(result.comments?.length ? 'warn' : 'ok', parts.join(' · '));
  } catch (err) {
    state.onStatus('bad', err.message);
  }
}

/**
 * Makes a name say what the file is.
 *
 * `runOnScenario`, because it rewrites `scenario.yaml` — the asset is renamed
 * in every place the story names it, and the recipe, the takes folder and the
 * published file follow. Confirmed for the same reason filing by media type is:
 * the filenames an author has been reading for weeks are about to change.
 */
async function onRetype(items) {
  if (!state.name) return;
  const files = items?.map((entry) => (typeof entry === 'string' ? entry : entry.file));
  const count = files?.length ?? 0;
  if (count === 0) return;
  if (
    count > 1 &&
    !confirm(
      `Rename ${count} asset${count === 1 ? '' : 's'} so the extension matches the file?\n\n` +
        `This changes the name in scenario.yaml, in the recipe, on the takes folder and on ` +
        `the published file. Nothing is re-encoded — the name follows the bytes.`,
    )
  ) {
    return;
  }

  try {
    const result = await runOnScenario('extensions', { files });
    if (!result) return;
    const n = result.renamed?.length ?? 0;
    const parts = [];
    if (n > 0) {
      parts.push(
        `renamed ${n} asset${n === 1 ? '' : 's'} — ` +
          result.renamed
            .slice(0, 4)
            .map((move) => `${move.from} → .${move.to.split('.').pop()}`)
            .join(', ') +
          (n > 4 ? `, and ${n - 4} more` : ''),
      );
    }
    for (const entry of result.skipped ?? []) parts.push(`${entry.file}: ${entry.why}`);
    if (result.comments?.length) {
      // The house rule: report the prose, never rewrite it.
      parts.push(
        `comments mentioning a renamed file at line${result.comments.length === 1 ? '' : 's'} ` +
          `${result.comments.join(', ')} may now be wrong`,
      );
    }
    state.onStatus(
      result.skipped?.length || result.comments?.length ? 'warn' : n > 0 ? 'ok' : 'warn',
      parts.length > 0 ? parts.join(' · ') : 'every extension already matches its file',
    );
  } catch (err) {
    state.onStatus('bad', err.message);
  }
}

function timingGroup() {
  return (state.data?.outstanding?.groups ?? []).find((group) => group.group === 'timing');
}

/**
 * The gap after one clip, in seconds.
 *
 * Saved on change rather than on every keystroke — each save rewrites
 * `project.yaml` — and an empty box clears the field rather than writing zero,
 * because a gap of nothing is a real choice and has to stay distinguishable
 * from never having made one.
 */
function gapBox(asset, extra = {}) {
  const box = h('input', {
    type: 'number',
    class: 'gap-box',
    step: '0.1',
    min: '0',
    max: '60',
    title:
      'Seconds after this clip before the beat ends. Blank is the one-second default. ' +
      'Changing it does not make the clip stale — it is timing, not audio.',
    placeholder: String(DEFAULT_GAP),
    onchange: (event) => {
      const raw = event.target.value.trim();
      const value = raw === '' ? '' : Number(raw);
      if (value !== '' && !Number.isFinite(value)) return;
      void editField(asset.file, 'gap', value);
    },
    ...extra,
  });
  // Only when the row has actually set one, so the placeholder can say what
  // the default is rather than the box asserting it as a choice.
  box.value = asset.row?.gap ?? asset.gap ?? '';
  if (asset.row?.gap === undefined) box.value = '';
  return box;
}

/** One mistimed beat, with the two ways of fixing it side by side. */
function timingItem(item) {
  const asset = assetsByFile().get(item.file);
  return h(
    'li',
    { class: 'command-item timing-item' },
    h(
      'button',
      { type: 'button', class: 'command-link', title: 'Show me', onclick: () => jumpTo(item) },
      item.label,
    ),
    h(
      'span',
      { class: 'timing-sum' },
      h('span', { class: 'timing-clip' }, `${(item.seconds ?? 0).toFixed(1)}s`),
      h('span', { class: 'timing-op' }, '+'),
      asset ? gapBox(asset) : null,
      h('span', { class: 'timing-op' }, '='),
      h('span', { class: 'timing-target' }, `${item.target}s`),
    ),
    h(
      'span',
      { class: 'timing-now' },
      item.hold === undefined ? 'no hold' : `now ${item.hold}s`,
    ),
    h('span', { class: 'spacer' }),
    h(
      'button',
      {
        type: 'button',
        class: 'ghost small',
        disabled: state.run ? true : undefined,
        onclick: (event) => {
          event.stopPropagation();
          void onRetime([item.file]);
        },
      },
      'Set',
    ),
  );
}

function commandGroup(group) {
  const open = state.commandOpen.has(group.group);
  const shown = open ? group.items : group.items.slice(0, COMMAND_PEEK);
  const hidden = group.items.length - shown.length;

  return h(
    'section',
    { class: `command-group command-${group.level}` },
    h(
      'header',
      { class: 'command-head' },
      h('span', { class: `pill pill-${group.level}` }, String(group.items.length)),
      h('h3', {}, group.label),
      h('span', { class: 'spacer' }),
      commandGroupButton(group),
    ),
    h('p', { class: 'command-hint' }, group.hint),
    h(
      'ul',
      { class: 'command-list' },
      // Timing rows are editable rather than merely actionable: the gap is the
      // number the author is deciding, and making them open a row to change it
      // is making them leave the list they are working down.
      shown.map((item) =>
        group.group === 'timing' ? timingItem(item) : commandItem(group, item),
      ),
    ),
    hidden > 0 || open
      ? h(
          'button',
          {
            type: 'button',
            class: 'command-more',
            onclick: () => {
              if (open) state.commandOpen.delete(group.group);
              else state.commandOpen.add(group.group);
              render();
            },
          },
          open ? 'Show fewer' : `Show all ${group.items.length}`,
        )
      : null,
  );
}

/**
 * The scenario's own complaints, which do not come from the board.
 *
 * They are validated in the source pane and live in `state.analysis` on the
 * other side of the app, so they are passed in rather than read from here —
 * but they belong at the top of this list, because a scenario that does not
 * load has no assets to be missing.
 */
function scenarioTrouble() {
  const problems = state.analysis?.problems ?? [];
  if (problems.length === 0) return null;
  const errors = problems.filter((problem) => problem.level === 'error').length;
  return h(
    'section',
    { class: `command-group command-${errors > 0 ? 'error' : 'warning'}` },
    h(
      'header',
      { class: 'command-head' },
      h('span', { class: `pill pill-${errors > 0 ? 'error' : 'warning'}` }, String(problems.length)),
      h('h3', {}, 'The scenario itself'),
      h('span', { class: 'spacer' }),
      h(
        'button',
        { type: 'button', class: 'ghost small', onclick: () => state.onTab('nodes') },
        'Open Nodes',
      ),
    ),
    h(
      'p',
      { class: 'command-hint' },
      'Reported by the validator against the source on the left. Nothing downstream is ' +
        'trustworthy until these are clear.',
    ),
    h(
      'ul',
      { class: 'command-list' },
      problems
        .slice(0, COMMAND_PEEK)
        .map((problem) => h('li', { class: 'command-item' }, h('span', {}, problem.message))),
    ),
  );
}

function renderCommand() {
  const host = $('command');
  const badge = $('command-badge');
  if (!host) return;

  const scenario = scenarioTrouble();
  const outstanding = state.data?.outstanding;
  const total = (outstanding?.total ?? 0) + (state.analysis?.problems?.length ?? 0);

  if (badge) {
    badge.hidden = total === 0;
    badge.textContent = String(total);
    badge.className = `tab-badge${outstanding?.groups?.some((g) => g.level === 'error') || scenario ? ' bad' : ''}`;
  }

  if (!state.data) {
    host.replaceChildren(h('p', { class: 'empty' }, 'No project open.'));
    return;
  }

  if (total === 0) {
    host.replaceChildren(
      h(
        'div',
        { class: 'command-done' },
        h('h3', {}, 'Nothing outstanding'),
        h(
          'p',
          {},
          'Every asset the scenario asks for has been made, chosen and published, and ' +
            'every part has a voice. The show is ready to run.',
        ),
      ),
    );
    return;
  }

  host.replaceChildren(
    ...(scenario ? [scenario] : []),
    ...(outstanding?.groups ?? []).map(commandGroup),
  );
}

function render() {
  const totals = $('totals');
  const container = $('sections');
  renderModelsBar();
  // Drawn with everything else, and before the early return: the badge has to
  // be right when no project is open too, which is the one case where the
  // honest answer is nothing rather than zero.
  renderCommand();
  // Both panels come off one `state.data`, so they are drawn together. Drawing
  // the cast only when its tab is showing would leave a stale sheet behind
  // every action taken from the other one.
  renderCast();

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

  const sections = overview.sections.map((view) => view.section);
  collapseBar($('assets-collapse'), {
    open: sections.filter((name) => !state.collapsed.has(name)).length,
    total: sections.length,
    what: 'section',
    expandAll: () => state.collapsed.clear(),
    collapseAll: () => {
      for (const name of sections) state.collapsed.add(name);
    },
  });
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
/**
 * Takes the validator's verdict from the source pane.
 *
 * Re-renders, because the command centre's badge counts these alongside the
 * asset work and a badge that is one analysis behind is a badge that says the
 * show is ready while the scenario does not load.
 */
export function setAnalysis(analysis) {
  state.analysis = analysis;
  renderCommand();
}

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

export function initAssets({ onScenario, onStoryboard, onStatus, onTab }) {
  state.onStatus = onStatus ?? (() => {});
  state.onTab = onTab ?? (() => {});
  state.onScenario = onScenario ?? (() => {});
  state.onStoryboard = onStoryboard ?? (() => {});

  const viewer = $('viewer');
  $('viewer-close').addEventListener('click', closeViewer);
  // Clicking the backdrop, which is the gesture everybody tries first. The
  // target is the dialog itself only when the click missed its contents.
  viewer.addEventListener('click', (event) => {
    if (event.target === viewer) closeViewer();
  });
  // Escape, handled here rather than left to the dialog.
  //
  // `showModal()` and `close()` toggle the open attribute in every browser, but
  // the `close` event does not arrive in all of them — it does not fire in the
  // preview browser this was built against. Hanging the cleanup off it left a
  // clip playing behind a dialog that had visibly gone, so nothing here depends
  // on it: every route out calls the same function.
  viewer.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeViewer();
  });
  viewer.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeViewer();
    }
  });

  render();
}

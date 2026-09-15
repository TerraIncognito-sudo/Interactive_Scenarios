/**
 * The editor's browser half.
 *
 * Plain ES modules with no build step, on purpose: this tool has to stay easy
 * to open and change. All the real work — parsing, validating, simulating —
 * happens on the local server using the project's actual engine, so nothing
 * here can drift from what the game server will do with the same file.
 */

import { $, h, flowRow } from './dom.js';
import {
  initAssets,
  openProject,
  refreshAssets,
  setAnalysis,
  spareAssets,
  setProjects,
  seedFromStoryboard,
  wireVoice,
  migrateShots,
  wireSprites,
  sortFolders,
  pruneOrphans,
  refreshModels,
  stopModels,
} from './assets.js';
import { initPicker, openPicker } from './picker.js';
import { initNodes, initNodesBar, renderNodes, describeWork } from './nodes.js';
import { initScenes, renderScenes } from './scenes.js';

const state = {
  /** The open project. Null means nothing is open and Save has no target. */
  projectName: null,
  /** What is on disk for the storyboard, so its Save button means something. */
  storySaved: '',
  /** What is on disk, so "unsaved" is a fact rather than a guess. */
  saved: '',
  analysis: null,
  choices: {},
  projects: [],
  /** The picker's value, kept in step with what is actually open. */
  selected: '',
  workspacePath: null,
};

// ---------------------------------------------------------------------------
// Loading and saving
// ---------------------------------------------------------------------------

/**
 * The one control that says which project is open.
 *
 * Projects only. The editor cannot see the repo's `scenarios/` folder at all —
 * that is the live server's, and an editor able to write into it will
 * eventually do so by accident. Deploying is copying a finished folder across
 * by hand, deliberately, when the show is ready.
 */
function renderPicker() {
  $('picker').replaceChildren(
    h(
      'option',
      { value: '' },
      state.projects.length === 0 ? 'no projects in this folder' : '— nothing open —',
    ),
    ...state.projects.map((p) =>
      h(
        'option',
        { value: p.name },
        // A trailing dot marks a folder with a scenario but no project.yaml —
        // one the editor can open but not yet track assets for.
        p.ok ? `${p.title}${p.hasProjectFile ? '' : ' ·'}` : `${p.name} (broken)`,
      ),
    ),
  );
  $('picker').value = state.selected ?? '';
}

/** Keeps the box showing what is actually open, however it came to be open. */
function markSelected(value) {
  state.selected = value;
  $('picker').value = value;
}

async function save() {
  // Nothing else is openable, so there is nothing else to save to. The editor
  // has no path that writes outside the workspace.
  if (!state.projectName) return;

  const source = $('source').value;
  $('save').disabled = true;
  try {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(state.projectName)}/scenario`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source }),
      },
    );
    const data = await response.json();
    if (!response.ok) {
      setStatus('bad', data.error ?? 'save failed');
      return;
    }
    state.saved = source;
    markClean();
    await analyze();
    await refreshAssets();

    // Saving the story rewrites the recipes it owns. Editing one line of
    // dialogue quietly re-records a clip, and finding that out from a status
    // line beats finding it out from the board three days later.
    reportReconcile(data.reconciled);
  } finally {
    $('save').disabled = false;
  }
}

/**
 * Says out loud what saving the scenario did to the recipes.
 *
 * The whole reason the join exists is that this used to happen silently and
 * wrongly: a line was edited, the row kept the old words, and the clip in the
 * show went on reading a sentence that had been deleted. Now it is corrected —
 * and a correction that marks clips stale without saying so is its own kind of
 * surprise.
 *
 * Orphans are counted, never acted on. Removing one throws away a prompt.
 */
function reportReconcile(plan) {
  if (!plan) return;
  const added = Object.keys(plan.added ?? {}).length;
  const orphans = plan.orphans?.length ?? 0;
  // Counted as clips rather than fields: one line moving rewrites its text, its
  // node and its index, and reporting that as "3 changes" reads like three
  // problems rather than one edit.
  const clips = new Set((plan.updates ?? []).map((update) => update.file));
  if (clips.size === 0 && added === 0 && orphans === 0) return;

  const said = [];
  if (clips.size > 0) {
    said.push(`${clips.size} recipe${clips.size === 1 ? '' : 's'} re-derived`);
  }
  if (added > 0) said.push(`${added} new asset${added === 1 ? '' : 's'} seeded`);
  if (orphans > 0) said.push(`${orphans} now orphaned — see the command centre`);
  setStatus(orphans > 0 ? 'warn' : 'ok', `saved · ${said.join(' · ')}`);
}

function markClean() {
  $('dirty').hidden = $('source').value === state.saved;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function setStatus(kind, text) {
  const pill = $('status');
  pill.className = `status ${kind}`;
  pill.textContent = text;
}

let analyzeTimer;
function scheduleAnalyze() {
  markClean();
  clearTimeout(analyzeTimer);
  // Long enough not to fire mid-word, short enough that a mistake is caught
  // while you still remember making it.
  analyzeTimer = setTimeout(analyze, 400);
}

async function analyze() {
  const response = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: $('source').value }),
  });
  apply(await response.json());
}

/** Renders a validation result, valid or not. */
function apply(result) {
  const problems = $('problems');

  if (!result.ok) {
    state.analysis = null;
    setStatus('bad', 'invalid');
    problems.hidden = false;
    problems.className = 'problems';
    problems.replaceChildren(
      h('strong', {}, result.message ?? 'Could not read this scenario'),
      h('ul', {}, (result.problems ?? []).map((p) => h('li', {}, p))),
    );
    $('nodes').replaceChildren(h('li', { class: 'empty' }, 'Fix the errors above to see the graph.'));
    $('vars').replaceChildren();
    $('choices').replaceChildren();
    $('overview').textContent = '';
    setAnalysis({
      problems: [
        { level: 'error', message: result.message ?? 'Could not read this scenario' },
        ...(result.problems ?? []).map((message) => ({ level: 'error', message })),
      ],
    });
    return;
  }

  state.analysis = result.analysis;
  const warnings = result.warnings ?? [];

  if (warnings.length > 0) {
    setStatus('warn', `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`);
    problems.hidden = false;
    problems.className = 'problems warn';
    problems.replaceChildren(
      h('strong', {}, 'Loads, but worth a look'),
      h(
        'ul',
        {},
        warnings.map((w) => h('li', {}, `${w.nodeId ? `[${w.nodeId}] ` : ''}${w.message}`)),
      ),
    );
  } else {
    setStatus('ok', 'valid');
    problems.hidden = true;
  }

  // Handed on rather than re-derived: the command centre counts these next to
  // the asset work, and two validators would eventually disagree.
  setAnalysis({
    problems: warnings.map((w) => ({
      level: 'warning',
      message: `${w.nodeId ? `[${w.nodeId}] ` : ''}${w.message}`,
    })),
  });

  renderNodes(result.analysis, result.scenario, result.assets);
  renderScenes(result.scenario, result.assets);
  renderVars(result.analysis);
  renderChoices(result.analysis);
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

function jumpTo(id) {
  const target = document.querySelector(`[data-node="${CSS.escape(id)}"]`);
  if (!target) return;
  showTab('nodes');
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.remove('flash');
  // Re-trigger the animation on a repeat jump to the same node.
  void target.offsetWidth;
  target.classList.add('flash');
}

function renderVars(analysis) {
  if (analysis.variables.length === 0) {
    $('vars').replaceChildren(
      h('li', { class: 'empty' }, 'No variables. Add a set: block to a poll to give the story memory.'),
    );
    return;
  }

  $('vars').replaceChildren(
    ...analysis.variables.map((variable) => {
      // Written but never read means a vote is being recorded and then ignored;
      // read but never written is always a typo.
      const orphan = variable.writtenBy.length === 0 || variable.readBy.length === 0;
      return h(
        'li',
        { class: `var${orphan ? ' orphan' : ''}` },
        h('div', { class: 'var-name' }, variable.name),
        h(
          'div',
          { class: 'flows' },
          flowRow(
            'set by',
            variable.writtenBy.length > 0
              ? variable.writtenBy.map((id, i) => [
                  i > 0 ? ', ' : '',
                  h('button', { class: 'jump', type: 'button', onclick: () => jumpTo(id) }, id),
                ])
              : 'nothing — it will always be undefined',
          ),
          flowRow(
            'read by',
            variable.readBy.length > 0
              ? variable.readBy.map((id, i) => [
                  i > 0 ? ', ' : '',
                  h('button', { class: 'jump', type: 'button', onclick: () => jumpTo(id) }, id),
                ])
              : 'nothing — this vote is recorded but never changes the story',
          ),
        ),
      );
    }),
  );
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

function renderChoices(analysis) {
  const polls = analysis.nodes.filter((n) => n.type === 'poll');
  if (polls.length === 0) {
    $('choices').replaceChildren(h('p', { class: 'empty' }, 'This scenario has no polls.'));
    return;
  }

  $('choices').replaceChildren(
    ...polls.map((poll) => {
      const select = h(
        'select',
        {
          onchange: (event) => {
            const value = event.target.value;
            if (value) state.choices[poll.id] = value;
            else delete state.choices[poll.id];
          },
        },
        h('option', { value: '' }, 'no votes — use the default'),
        ...poll.exits.map((exit) => {
          const key = exit.label.split(' — ')[0];
          return h(
            'option',
            { value: key, selected: state.choices[poll.id] === key },
            exit.label,
          );
        }),
      );

      return h(
        'div',
        { class: 'choice' },
        h('label', {}, `${poll.id} — ${poll.preview}`),
        select,
      );
    }),
  );
}

async function run() {
  const response = await fetch('/api/simulate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: $('source').value, choices: state.choices }),
  });
  const result = await response.json();

  if (!response.ok) {
    $('trace').replaceChildren(
      h('div', { class: 'trace-summary bad' }, result.error ?? 'Could not run this scenario'),
    );
    return;
  }
  renderTrace(result);
}

function renderTrace(result) {
  const parts = [];

  if (result.error) {
    parts.push(h('div', { class: 'trace-summary bad' }, result.error));
  } else {
    const minutes = Math.floor(result.seconds / 60);
    const vars = Object.entries(result.vars);
    parts.push(
      h(
        'div',
        { class: 'trace-summary' },
        result.truncated
          ? 'Stopped early — this story never reaches an end node.'
          : `Ends at “${result.endedAt}” after ${minutes}m ${result.seconds % 60}s.`,
        h(
          'div',
          { class: 'flows' },
          // Endings often converge on one final node, so the node the story
          // stopped at says little. The route is what actually differs.
          flowRow('route', h('code', {}, result.path.join(' → '))),
          vars.length > 0 &&
            flowRow('vars', vars.map(([k, v]) => h('code', {}, ` ${k} = ${v} `))),
        ),
      ),
    );
  }

  for (const step of result.steps) {
    let body;
    if (step.kind === 'dialogue') {
      body = h(
        'div',
        { class: 'step-body' },
        step.speaker && h('span', { class: 'step-speaker' }, `${step.speaker}: `),
        step.text,
      );
    } else if (step.kind === 'pause') {
      body = h('div', { class: 'step-body' }, h('em', {}, step.text ?? `hold ${step.seconds}s`));
    } else if (step.kind === 'poll') {
      body = h(
        'div',
        { class: 'step-body' },
        step.question,
        h(
          'span',
          { class: `step-note${step.usedDefault ? ' default' : ''}` },
          step.usedDefault
            ? `nobody voted → default: ${step.chosenLabel}`
            : `→ ${step.chosenLabel}`,
          Object.keys(step.sets).length > 0 &&
            ` · sets ${Object.entries(step.sets)
              .map(([k, v]) => `${k}=${v}`)
              .join(', ')}`,
        ),
      );
    } else {
      body = h('div', { class: 'step-body' }, step.text ?? 'The end.');
    }

    parts.push(
      h(
        'div',
        { class: `step step-${step.kind}` },
        h('span', { class: 'step-node' }, step.nodeId),
        body,
      ),
    );
  }

  $('trace').replaceChildren(...parts);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function showTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  }
  for (const panel of document.querySelectorAll('.tab-panel')) {
    panel.hidden = panel.id !== `panel-${name}`;
  }
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => showTab(tab.dataset.tab));
}

$('source').addEventListener('input', scheduleAnalyze);
$('picker').addEventListener('change', (event) => {
  const name = event.target.value;
  markSelected(name);
  if (!name) {
    // Nothing open means nothing to save. Leaving the last project's text in
    // the pane invites edits that Save will silently decline to write.
    state.projectName = null;
    state.saved = '';
    $('source').value = '';
    $('source-path').textContent = state.workspacePath ?? '';
    markClean();
  }
  void openProject(name);
});
$('save').addEventListener('click', () => void save());
$('revert').addEventListener('click', () => {
  $('source').value = state.saved;
  markClean();
  void analyze();
});
$('run').addEventListener('click', () => void run());

// Ctrl/Cmd-S is muscle memory in anything with a text area.
window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 's') {
    event.preventDefault();
    void save();
  }
});

// Closing the tab on unsaved changes loses work with no way back.
window.addEventListener('beforeunload', (event) => {
  if ($('source').value !== state.saved || $('story').value !== state.storySaved) {
    event.preventDefault();
  }
});

$('story-save').addEventListener('click', () => {
  void (async () => {
    if (!state.projectName) return;
    const source = $('story').value;
    const response = await fetch(
      `/api/projects/${encodeURIComponent(state.projectName)}/storyboard`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source }),
      },
    );
    const data = await response.json();
    if (!response.ok) return setStatus('bad', data.error ?? 'could not save storyboard');
    state.storySaved = source;
    setStatus('ok', 'storyboard saved');
    await refreshAssets();
  })();
});

$('wire-voice').addEventListener('click', () => {
  void (async () => {
    const result = await wireVoice();
    if (!result) return;
    // Reported as clips, not lines: a clip is the thing that now has to be
    // made, and the number is what the voice section just grew by.
    const n = result.wired.length;
    setStatus(
      n > 0 ? 'ok' : 'warn',
      n > 0
        ? `declared ${n} voice clip${n === 1 ? '' : 's'} in scenario.yaml`
        : 'every spoken line already has a clip',
    );
  })();
});

$('migrate-shots').addEventListener('click', () => {
  void (async () => {
    const result = await migrateShots();
    if (!result) return;

    const done = [];
    if (result.moved.length > 0) {
      const n = result.moved.length;
      done.push(`${n} shot${n === 1 ? '' : 's'} now paint their own picture`);
    }
    if (result.folded.length > 0) {
      done.push(`folded ${result.folded.map((entry) => entry.scene).join(', ')}`);
    }
    const placed = result.seeded?.added?.length ?? 0;
    if (placed > 0) done.push(`${placed} prompt${placed === 1 ? '' : 's'} placed`);

    // Two things the author has to decide and no button should decide for
    // them: a fold that was refused, and prose that has gone stale. Both are
    // said out loud rather than buried, because neither will announce itself.
    const attention = (result.skipped ?? []).map((entry) => `${entry.what}: ${entry.why}`);
    if (result.stale?.length > 0) {
      const lines = result.stale.map((entry) => entry.line);
      attention.push(
        `${lines.length} comment line${lines.length === 1 ? '' : 's'} still describe ` +
          `scenes that are now gone (line ${lines.join(', ')})`,
      );
    }

    if (done.length === 0 && attention.length === 0) {
      return setStatus('warn', 'every shot already has its own picture');
    }
    setStatus(
      attention.length > 0 ? 'warn' : 'ok',
      [...done, ...attention].join(' · '),
    );
  })();
});

$('wire-sprites').addEventListener('click', () => {
  void (async () => {
    const result = await wireSprites();
    if (!result) return;

    const parts = [];
    const moved = result.moved ?? [];
    const fresh = result.wired.filter((entry) => !moved.some((move) => move.to === entry.file));
    if (fresh.length > 0) {
      parts.push(
        `${fresh.length} portrait${fresh.length === 1 ? '' : 's'} declared — ` +
          fresh.map((entry) => entry.character).join(', '),
      );
    }
    // Worth its own line rather than folded into the count. A rename carries
    // the recipe row and the takes with it, and somebody looking at the board
    // afterwards should know why the filenames changed.
    if (moved.length > 0) {
      parts.push(
        `${moved.length} re-pointed to transparent PNG — ` +
          moved.map((move) => move.to).join(', '),
      );
    }
    const placed = result.seeded?.filled?.length ?? result.seeded?.added?.length ?? 0;
    if (placed > 0) parts.push(`${placed} sheet prompt${placed === 1 ? '' : 's'} placed`);
    if (result.untouched.length > 0) {
      parts.push(`${result.untouched.join(', ')} already had one`);
    }
    // A sheet with nobody to attach to is the author's to resolve: a label the
    // scenario has no character for is either a typo or a part that was cut.
    const stuck = (result.skipped ?? []).map((entry) => `${entry.sheet}: ${entry.why}`);

    if (parts.length === 0 && stuck.length === 0) {
      return setStatus('warn', 'every character the storyboard drew already has a portrait');
    }
    setStatus(stuck.length > 0 ? 'warn' : 'ok', [...parts, ...stuck].join(' · '));
  })();
});

$('sort-folders').addEventListener('click', () => {
  void (async () => {
    const result = await sortFolders();
    if (!result) return;

    const n = result.moved.length;
    if (n === 0) {
      return setStatus(
        'warn',
        result.kept.length > 0
          ? 'every asset is already filed by media type'
          : 'nothing to file',
      );
    }

    const by = {};
    for (const move of result.moved) by[move.section] = (by[move.section] ?? 0) + 1;
    const parts = [
      `filed ${n} asset${n === 1 ? '' : 's'} — ` +
        Object.entries(by)
          .map(([section, count]) => `${count} into ${section}/`)
          .join(', '),
    ];
    if (result.republished.length > 0) {
      const m = result.republished.length;
      parts.push(`moved ${m} published file${m === 1 ? '' : 's'} to match`);
    }
    // A name this could not file is a decision for the author, not something
    // to pick a winner for quietly.
    const stuck = (result.skipped ?? []).map((entry) => `${entry.file}: ${entry.why}`);
    setStatus(stuck.length > 0 ? 'warn' : 'ok', [...parts, ...stuck].join(' · '));
  })();
});

$('prune').addEventListener('click', () => {
  void (async () => {
    const result = await pruneOrphans();
    if (!result) return;
    const n = result.removed.length;
    setStatus(n > 0 ? 'ok' : 'warn', n > 0 ? `removed ${n} orphaned recipe${n === 1 ? '' : 's'}` : 'nothing orphaned');
  })();
});

$('story-sync').addEventListener('click', () => {
  void (async () => {
    const result = await seedFromStoryboard();
    if (!result) return;
    // Nothing is ever overwritten, so the honest report counts what appeared
    // and what was filled in — never "synced", which would imply the storyboard
    // had won an argument with the project file.
    const filled = result.filled?.length ?? 0;
    const parts = [];
    if (result.added.length > 0) {
      parts.push(`added ${result.added.length} asset${result.added.length === 1 ? '' : 's'}`);
    }
    if (filled > 0) parts.push(`filled gaps in ${filled} row${filled === 1 ? '' : 's'}`);
    setStatus(
      parts.length > 0 ? 'ok' : 'warn',
      parts.length > 0 ? parts.join(', ') : 'nothing new in the storyboard',
    );
  })();
});

// Where model weights live on this machine. Asked once, kept in the editor's
// own config rather than in project.yaml — a project file travels to other
// machines, and a path to a folder of weights means nothing when it gets there.
$('models-change').addEventListener('click', () => {
  openPicker({
    mode: 'models',
    label: 'Where do model weights live?',
    startAt: state.modelsRoot,
    onPick: (root) => {
      state.modelsRoot = root;
      void refreshModels().then(() => setStatus('ok', `models: ${root}`));
    },
  });
});

$('models-stop').addEventListener('click', () => {
  void (async () => {
    await stopModels();
    setStatus('ok', 'model unloaded — the GPU is free again');
  })();
});

/**
 * What has to happen after the Nodes tab rewrites the file.
 *
 * The source pane holds its own copy, so it is refreshed *before* anything is
 * reported: refresh it late and the re-analysis overwrites the status line,
 * and skipping it entirely means the next Save writes the stale copy back and
 * silently undoes the edit.
 */
async function afterNodeEdit(data) {
  $('source').value = data.source;
  state.saved = data.source;
  markClean();
  await analyze();
  await refreshAssets();

  // The recipes first, because a re-derived clip is the consequence somebody
  // most needs to hear about; the rewiring is appended so one edit reads as
  // one sentence rather than two competing status lines.
  reportReconcile(data.reconciled);
  const moved = describeWork(data);
  if (moved.length > 0) {
    const warned = (data.warnings ?? []).length > 0;
    setStatus(warned ? 'warn' : 'ok', moved.join(' · '));
  }
}

async function boot() {
  initNodes({
    projectName: () => state.projectName,
    analysis: () => state.analysis,
    setStatus,
    showProblems: (message, problems) => {
      const box = $('problems');
      box.hidden = false;
      box.className = 'problems';
      box.replaceChildren(h('strong', {}, message), h('ul', {}, problems.map((p) => h('li', {}, p))));
    },
    jumpTo,
    // What is on disk but unclaimed, so an asset box can offer a picture
    // somebody made and never wired up. Read from the board rather than walked
    // again here — see `spareAssets`.
    spareAssets,
    afterEdit: afterNodeEdit,
  });
  initScenes({
    projectName: () => state.projectName,
    setStatus,
    showProblems: (message, problems) => {
      const box = $('problems');
      box.hidden = false;
      box.className = 'problems';
      box.replaceChildren(h('strong', {}, message), h('ul', {}, problems.map((p) => h('li', {}, p))));
    },
    jumpTo,
    spareAssets,
    afterEdit: afterNodeEdit,
  });

  initNodesBar();

  initAssets({
    onStatus: (kind, text) => setStatus(kind, text),
    // So a section that has given its rows away can hand somebody to where
    // they went, rather than only telling them the name of another tab.
    onTab: (name) => showTab(name),
    // Returns the analysis it kicks off, so an action that rewrites the
    // scenario can wait for it before saying what it did.
    onScenario: (source, name, path, tab = 'assets') => {
      state.projectName = name;
      markSelected(name);
      // The pane header names the file being edited, not a folder the editor
      // merely knows about. There is only one file it can write.
      $('source-path').textContent = path ?? '';
      state.saved = source;
      $('source').value = source;
      markClean();
      // Where an action leaves you is where it was pressed. `null` says so:
      // an action that rewrites the scenario refreshes this pane as a side
      // effect, and a side effect must not move the tab out from under the
      // person who pressed the button. Opening a project *is* a move, and the
      // first thing anybody wants to see is the cast.
      if (tab !== null) showTab(tab);
      return analyze();
    },
    onStoryboard: (source, path) => {
      state.storySaved = source ?? '';
      $('story').value = source ?? '';
      $('story').disabled = source === undefined;
      $('story-path').textContent = path ?? 'no storyboard in this project';
      $('story-sync').disabled = source === undefined;
      $('story-save').disabled = source === undefined;
    },
  });

  const applyWorkspace = (next) => {
    state.projects = next.projects;
    state.workspacePath = next.workspace;
    $('source-path').textContent = next.workspace ?? '';
    // Whatever was open lived in the old folder.
    state.selected = '';
    state.projectName = null;
    setProjects(next.projects, next.workspace);
    renderPicker();
  };

  const workspaceState = await initPicker({ onWorkspace: applyWorkspace });
  applyWorkspace(workspaceState);

  // First run: no folder has ever been chosen, so there is nothing to show and
  // no way to guess. Ask before the editor looks broken.
  const models = await refreshModels().catch(() => null);
  state.modelsRoot = models?.root;

  if (!workspaceState.workspace) {
    openPicker({ mode: 'workspace', label: 'Where do your scenarios live?' });
  }
}

void boot();

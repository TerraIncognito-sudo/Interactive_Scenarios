/**
 * The editor's browser half.
 *
 * Plain ES modules with no build step, on purpose: this tool has to stay easy
 * to open and change. All the real work — parsing, validating, simulating —
 * happens on the local server using the project's actual engine, so nothing
 * here can drift from what the game server will do with the same file.
 */

import { $, h } from './dom.js';
import {
  initAssets,
  refreshAssets,
  setProjects,
  seedFromStoryboard,
  wireVoice,
  pruneOrphans,
} from './assets.js';
import { initPicker, openPicker } from './picker.js';

const state = {
  folder: null,
  /** Set when a project is open; its scenario takes over the source pane. */
  projectName: null,
  /** What is on disk for the storyboard, so its Save button means something. */
  storySaved: '',
  /** What is on disk, so "unsaved" is a fact rather than a guess. */
  saved: '',
  analysis: null,
  choices: {},
};

// ---------------------------------------------------------------------------
// Loading and saving
// ---------------------------------------------------------------------------

async function loadList() {
  const response = await fetch('/api/scenarios');
  const { scenarios, dir } = await response.json();
  $('source-path').textContent = dir;

  const picker = $('picker');
  picker.replaceChildren(
    ...scenarios.map((s) =>
      h('option', { value: s.folder }, s.ok ? s.title : `${s.folder} (broken)`),
    ),
  );
  return scenarios;
}

async function openFolder(folder) {
  state.folder = folder;
  state.projectName = null;
  const response = await fetch(`/api/scenarios/${encodeURIComponent(folder)}/source`);
  if (!response.ok) {
    setStatus('bad', 'could not open');
    return;
  }
  const data = await response.json();
  state.saved = data.source;
  state.choices = {};
  $('source').value = data.source;
  markClean();
  apply(data);
}

async function save() {
  const source = $('source').value;
  $('save').disabled = true;
  try {
    // A project owns its own scenario, which lives outside this repo. Saving
    // has to follow the file the board is showing, not the folder picker.
    if (state.projectName) {
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
      return;
    }

    if (!state.folder) return;
    const response = await fetch(`/api/scenarios/${encodeURIComponent(state.folder)}/source`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source }),
    });
    const data = await response.json();
    if (!response.ok) {
      setStatus('bad', data.error ?? 'save failed');
      return;
    }
    state.saved = source;
    markClean();
    apply(data);
  } finally {
    $('save').disabled = false;
  }
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

  renderNodes(result.analysis);
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

function flowRow(key, ...content) {
  return h('div', { class: 'flow' }, h('span', { class: 'flow-key' }, key), h('span', { class: 'flow-val' }, ...content));
}

function renderNodes(analysis) {
  const minutes = analysis.nodes.reduce((total, n) => total + n.seconds, 0) / 60;
  $('overview').textContent =
    `${analysis.counts.nodes} nodes · ${analysis.counts.polls} polls · ` +
    `${analysis.counts.endings} endings · every node laid end to end ≈ ${Math.round(minutes)} min` +
    (analysis.counts.unreachable > 0 ? ` · ${analysis.counts.unreachable} unreachable` : '');

  $('nodes').replaceChildren(
    ...analysis.nodes.map((node) => {
      const classes = ['node'];
      if (!node.reachable) classes.push('unreachable');
      if (node.id === analysis.start) classes.push('start');

      const flows = [];

      if (node.enteredFrom.length > 0) {
        flows.push(
          flowRow(
            'in',
            node.enteredFrom.map((from, i) => [
              i > 0 ? ', ' : '',
              h('button', { class: 'jump', type: 'button', onclick: () => jumpTo(from) }, from),
            ]),
          ),
        );
      }

      if (node.reads.length > 0) {
        flows.push(flowRow('reads', node.reads.map((name) => h('code', {}, ` ${name} `))));
      }

      if (node.writes.length > 0) {
        flows.push(
          flowRow(
            'writes',
            node.writes.map((w) => h('code', {}, ` ${w.name} = ${w.value} `)),
          ),
        );
      }

      for (const exit of node.exits) {
        flows.push(
          flowRow(
            'out',
            `${exit.label} → `,
            h('button', { class: 'jump', type: 'button', onclick: () => jumpTo(exit.to) }, exit.to),
          ),
        );
      }

      return h(
        'li',
        { class: classes.join(' '), 'data-node': node.id },
        h(
          'div',
          { class: 'node-head' },
          h('span', { class: 'node-id' }, node.id),
          h('span', { class: `type type-${node.type}` }, node.type),
          node.id === analysis.start && h('span', { class: 'type' }, 'start'),
          !node.reachable && h('span', { class: 'type' }, 'unreachable'),
          node.seconds > 0 && h('span', { class: 'node-secs' }, `${node.seconds}s`),
        ),
        node.preview && h('p', { class: 'node-preview' }, node.preview),
        flows.length > 0 && h('div', { class: 'flows' }, ...flows),
      );
    }),
  );
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
$('picker').addEventListener('change', (event) => void openFolder(event.target.value));
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

async function boot() {
  initAssets({
    onScenario: (source, name) => {
      state.projectName = name;
      state.saved = source;
      $('source').value = source;
      markClean();
      void analyze();
      showTab('assets');
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

  const workspaceState = await initPicker({
    onWorkspace: (next) => setProjects(next.projects, next.workspace),
  });

  setProjects(workspaceState.projects, workspaceState.workspace);

  // First run: no folder has ever been chosen, so there is nothing to show and
  // no way to guess. Ask before the editor looks broken.
  if (!workspaceState.workspace) openPicker();

  await loadList();
}

void boot();

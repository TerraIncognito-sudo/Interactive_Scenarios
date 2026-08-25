/**
 * The folder picker.
 *
 * The editor holds no opinion about where scenarios live, so on first run it
 * asks and then remembers. The listing comes from the editor's own process:
 * the browser's `showDirectoryPicker()` deliberately never reveals a path, and
 * a path is exactly what the server needs in order to open the files.
 */

import { $, h } from './dom.js';

let onChosen = () => {};
let current = null;

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `${response.status}`);
  return data;
}

function renderWarn(browse) {
  const warn = $('picker-warn');
  // Not a refusal — it is the author's machine. But takes accumulate into tens
  // of gigabytes, and a sync client finding them is a slow, silent problem.
  warn.hidden = !browse.synced;
  warn.textContent = browse.synced
    ? 'This folder is inside a cloud-synced drive. That is fine for scenarios and ' +
      'storyboards; generated takes will be kept outside it automatically.'
    : '';
}

async function show(path) {
  let browse;
  try {
    browse = await api(`/api/browse?path=${encodeURIComponent(path ?? '')}`);
  } catch (err) {
    $('picker-list').replaceChildren(h('li', { class: 'picker-empty' }, err.message));
    return;
  }

  current = browse.path;
  $('picker-input').value = browse.path;
  $('picker-here').textContent = browse.path;
  renderWarn(browse);

  $('picker-roots').replaceChildren(
    ...browse.roots.map((root) =>
      h('button', { type: 'button', class: 'chip', onclick: () => void show(root) }, root),
    ),
  );

  const rows = [];
  if (browse.parent) {
    rows.push(
      h(
        'li',
        {},
        h('button', { type: 'button', class: 'picker-row up', onclick: () => void show(browse.parent) }, '⬑ up'),
      ),
    );
  }

  for (const entry of browse.entries) {
    rows.push(
      h(
        'li',
        {},
        h(
          'button',
          { type: 'button', class: 'picker-row', onclick: () => void show(entry.path) },
          h('span', { class: 'picker-name' }, entry.name),
          // Marking projects in the listing is what turns "browse the disk"
          // into "find the folder you meant" — the right parent is the one
          // whose children are tagged.
          entry.isProject
            ? h('span', { class: 'pill pill-ready' }, entry.hasProjectFile ? 'project' : 'scenario')
            : null,
        ),
      ),
    );
  }

  if (rows.length === 0) {
    rows.push(h('li', { class: 'picker-empty' }, 'No folders in here.'));
  }

  $('picker-list').replaceChildren(...rows);
}

export function openPicker(startAt) {
  $('picker-dialog').showModal();
  void show(startAt);
}

export async function initPicker({ onWorkspace }) {
  onChosen = onWorkspace ?? (() => {});

  const state = await api('/api/workspace');

  $('picker-recent').replaceChildren(
    ...state.recent.map((path) =>
      h('button', { type: 'button', class: 'chip', onclick: () => void show(path) }, path),
    ),
  );

  $('picker-go').addEventListener('click', () => void show($('picker-input').value));
  $('picker-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void show($('picker-input').value);
  });

  $('picker-cancel').addEventListener('click', () => $('picker-dialog').close());

  $('picker-use').addEventListener('click', () => {
    void (async () => {
      try {
        const next = await api('/api/workspace', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: current ?? $('picker-input').value }),
        });
        $('picker-dialog').close();
        onChosen(next);
      } catch (err) {
        $('picker-warn').hidden = false;
        $('picker-warn').textContent = err.message;
      }
    })();
  });

  $('change-workspace').addEventListener('click', () => openPicker(state.workspace));

  return state;
}

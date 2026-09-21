/**
 * The picker: one dialog, three jobs.
 *
 * The editor holds no opinion about where anything lives, so it asks — for the
 * workspace on first run, for the folder that holds model weights, and for the
 * clip that gives a character their voice. The listing comes from the editor's
 * own process: the browser's `showDirectoryPicker()` deliberately never reveals
 * a path, and a path is exactly what the server needs to open the files.
 *
 * It picks a folder or a file depending on how it was opened. Those are the
 * same act of browsing and it would be strange to build two of them, but they
 * end differently — a folder is confirmed with a button because you are
 * standing in it, while a file is chosen by clicking the file.
 */

import { $, h } from './dom.js';

/** How the currently-open dialog should finish. */
let session = { mode: 'folder', onPick: () => {}, extensions: [] };
let current = null;

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `${response.status}`);
  return data;
}

function warn(message) {
  $('picker-warn').hidden = !message;
  $('picker-warn').textContent = message ?? '';
}

function syncNote(browse) {
  if (!browse.synced) return '';
  // Not a refusal — it is the author's machine. But takes and weights run to
  // tens of gigabytes, and a sync client finding them is a slow, silent
  // problem that surfaces as a full disk.
  return session.mode === 'models'
    ? 'This folder is inside a cloud-synced drive. Model weights must not go here — ' +
        'they run to tens of gigabytes and syncing them will fill the drive.'
    : 'This folder is inside a cloud-synced drive. That is fine for scenarios and ' +
        'storyboards; generated takes will be kept outside it automatically.';
}

function bytes(size) {
  if (size > 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size > 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

async function show(path) {
  let browse;
  const query = new URLSearchParams({ path: path ?? '' });
  if (session.extensions.length > 0) query.set('files', session.extensions.join(','));

  try {
    browse = await api(`/api/browse?${query}`);
  } catch (err) {
    $('picker-list').replaceChildren(h('li', { class: 'picker-empty' }, err.message));
    return;
  }

  current = browse.path;
  $('picker-input').value = browse.path;
  $('picker-here').textContent = browse.path;
  warn(syncNote(browse));

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
        h(
          'button',
          { type: 'button', class: 'picker-row up', onclick: () => void show(browse.parent) },
          '⬑ up',
        ),
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

  for (const file of browse.files ?? []) {
    rows.push(
      h(
        'li',
        {},
        h(
          'button',
          {
            type: 'button',
            class: 'picker-row file',
            onclick: () => {
              $('picker-dialog').close();
              session.onPick(file.path);
            },
          },
          h('span', { class: 'picker-name' }, file.name),
          h('span', { class: 'picker-size' }, bytes(file.size)),
        ),
      ),
    );
  }

  if (rows.length === 0) {
    rows.push(
      h(
        'li',
        { class: 'picker-empty' },
        session.extensions.length > 0
          ? `Nothing here matching ${session.extensions.join(', ')}.`
          : 'No folders in here.',
      ),
    );
  }

  $('picker-list').replaceChildren(...rows);
}

/**
 * Opens the dialog.
 *
 * `mode` is one of `workspace`, `models` or `file`. The first two confirm a
 * folder with the Use button; the third finishes when a file is clicked, so
 * the button is hidden rather than left there doing nothing.
 */
export function openPicker({ startAt, mode = 'workspace', extensions = [], label, onPick }) {
  session = { mode, extensions, onPick: onPick ?? (() => {}) };
  $('picker-title').textContent =
    label ?? (mode === 'models' ? 'Where do model weights live?' : 'Choose a folder');
  $('picker-use').hidden = mode === 'file';
  $('picker-use').textContent = mode === 'models' ? 'Use for models' : 'Use this folder';
  warn('');
  $('picker-dialog').showModal();
  void show(startAt);
}

export async function initPicker({ onWorkspace }) {
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
      const chosen = current ?? $('picker-input').value;
      if (session.mode === 'models') {
        try {
          const next = await api('/api/models', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: chosen }),
          });
          $('picker-dialog').close();
          session.onPick(next.root, next);
        } catch (err) {
          warn(err.message);
        }
        return;
      }

      try {
        const next = await api('/api/workspace', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: chosen }),
        });
        $('picker-dialog').close();
        (onWorkspace ?? (() => {}))(next);
      } catch (err) {
        warn(err.message);
      }
    })();
  });

  $('change-workspace').addEventListener('click', () =>
    openPicker({ startAt: state.workspace, mode: 'workspace', label: 'Where do scenarios live?' }),
  );

  return state;
}

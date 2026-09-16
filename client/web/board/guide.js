/**
 * Start here: the walkthrough from an idea to a room full of people voting.
 *
 * Every other tab in this editor assumes a project. Open one, edit it, fill its
 * asset board, put it on a projector — all things you do to something, and the
 * something used to be made by a command-line script from a storyboard that
 * already existed. The step before all of that had no surface at all, and the
 * two formats it needs are written down in a markdown parser and a Zod schema,
 * neither of which is a thing to hand somebody who wants to make a show.
 *
 * So this tab is one list, in order, and it is honest about which parts of the
 * work it can do for you. Three kinds of step, and the difference matters:
 *
 * **Copy this into a chat window.** The briefs are long documents kept in
 * `docs/prompts/`, served rather than inlined so the repository and the editor
 * are looking at the same copy. What comes back is pasted into the box below
 * the button. Nothing here calls a model — there is no key in this program and
 * no opinion about which model you use.
 *
 * **Press this.** Creating the project is the one thing that had no route at
 * all, and it is here rather than on the Assets tab because it is the moment
 * the project starts existing.
 *
 * **Go and do this.** The pipeline steps link to the button that does the work
 * rather than offering a second copy of it. Two buttons that call one route are
 * two things to keep in step, and the one that falls behind is the one nobody
 * is looking at.
 *
 * The ticks are the person's own, and they are not derived. Whether a
 * storyboard is *good enough* is not a fact this program has any access to.
 * What it does have access to is whether one exists, so both are on the row,
 * side by side, and neither pretends to be the other — a checklist that ticked
 * itself would be a checklist that disagreed with somebody about their own
 * work.
 */

import { $, h } from './dom.js';

const state = {
  /** `{ draft, done }` from the server. Null before the first answer. */
  guide: null,
  /** Which step the operator is looking at. One open at a time. */
  open: null,
  /** Set while a create is in flight, so the button cannot be pressed twice. */
  creating: false,
  getProject: () => null,
  getFacts: () => null,
  onStatus: () => {},
  onTab: () => {},
  onCreated: async () => {},
};

async function api(path, options) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `${response.status}`);
  return body;
}

/**
 * Puts text on the clipboard, and says so when it cannot.
 *
 * The briefs run to several thousand words, which is exactly the length nobody
 * selects by hand. A loopback origin is a secure context so the clipboard API
 * is available — but it is also refused outright by a browser whose window is
 * not focused, and a button that fails in silence is a button people press
 * four times.
 */
async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    state.onStatus('ok', `${what} copied — paste it into a chat window.`);
  } catch {
    state.onStatus(
      'error',
      'The browser would not let this page write to the clipboard. Select the text and copy it.',
    );
  }
}

/** The briefs are files on disk; fetched when asked for rather than held here. */
async function briefText(name) {
  const response = await fetch(`/api/guide/brief/${name}`);
  if (!response.ok) throw new Error('Could not read the brief');
  return response.text();
}

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

let pending;

/**
 * Saves the draft a beat after typing stops.
 *
 * Debounced rather than saved per keystroke, and rather than saved on blur:
 * these boxes hold a whole storyboard and a whole scenario file, which is an
 * afternoon of somebody's work sitting in a browser tab, and blur never
 * happens to a tab that is closed.
 */
function scheduleDraftSave(patch) {
  state.guide.draft = { ...state.guide.draft, ...patch };
  clearTimeout(pending);
  pending = setTimeout(() => {
    void api('/api/guide/draft', { method: 'PUT', body: JSON.stringify(patch) }).catch(() => {
      state.onStatus('error', 'Could not save the draft.');
    });
  }, 600);
}

function draftBox(field, placeholder, rows = 8) {
  return h('textarea', {
    class: 'guide-box',
    rows: String(rows),
    spellcheck: field === 'description' ? 'true' : 'false',
    placeholder,
    oninput: (event) => scheduleDraftSave({ [field]: event.target.value }),
  });
}

/** `h` sets attributes; a textarea's text is a child. One place, so it is right. */
function filled(node, text) {
  node.value = text ?? '';
  return node;
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

/**
 * What the program can see, per step, or null when it has nothing to add.
 *
 * Deliberately never the same sentence as the tick beside it. "There is a
 * storyboard in this project" is a fact; "the storyboard is finished" is a
 * judgement, and only one of them is the program's to make.
 */
function observed(key, facts) {
  const draft = state.guide?.draft ?? {};
  switch (key) {
    case 'describe':
      return draft.description?.trim() ? `${words(draft.description)} words written` : null;
    case 'storyboard':
      return draft.storyboard?.trim() ? `${words(draft.storyboard)} words pasted back` : null;
    case 'scenario':
      return draft.scenario?.trim() ? `${draft.scenario.split('\n').length} lines pasted back` : null;
    case 'create':
      return facts ? `${facts.name} is open` : null;
    case 'init':
      if (!facts) return null;
      return facts.hasProjectFile ? 'project.yaml is there' : 'no project.yaml yet';
    case 'voice':
      if (!facts) return null;
      return facts.voiceAssets > 0
        ? `${facts.voiceAssets} voice clips declared`
        : 'no voice clips declared yet';
    case 'seed':
      if (!facts) return null;
      return facts.hasStoryboard ? 'a storyboard is in the project' : 'no storyboard in this project';
    case 'make':
      if (!facts) return null;
      return facts.assets > 0
        ? `${facts.ready} of ${facts.assets} assets ready · ${facts.outstanding} outstanding`
        : 'nothing on the board yet';
    default:
      return null;
  }
}

function words(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** A button that switches tabs, for a step whose work is done elsewhere. */
function goTo(tab, label) {
  return h(
    'button',
    { type: 'button', class: 'ghost', onclick: () => state.onTab(tab) },
    label,
  );
}

function copyRow(brief, label, extra) {
  return h(
    'div',
    { class: 'guide-row' },
    h(
      'button',
      {
        type: 'button',
        class: 'primary',
        onclick: async () => {
          try {
            const text = await briefText(brief);
            const tail = extra();
            await copy(tail ? `${text}\n\n---\n\n${tail}\n` : text, 'The brief');
          } catch (err) {
            state.onStatus('error', err.message);
          }
        },
      },
      label,
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'ghost',
        onclick: async () => {
          try {
            // The brief alone, for reading rather than for pasting. It is the
            // document that says what the format is, and somebody will want to
            // read it before they trust a model with it.
            const text = await briefText(brief);
            const window_ = window.open('', '_blank');
            if (!window_) return state.onStatus('error', 'The browser blocked that window.');
            window_.document.write(
              `<pre style="white-space:pre-wrap;font:14px/1.5 ui-monospace,monospace;padding:2rem;max-width:44rem;margin:auto">${
                text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
              }</pre>`,
            );
            window_.document.close();
          } catch (err) {
            state.onStatus('error', err.message);
          }
        },
      },
      'Read it',
    ),
  );
}

async function createProject() {
  const draft = state.guide.draft;
  state.creating = true;
  render();
  try {
    const created = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: draft.name,
        scenario: draft.scenario,
        storyboard: draft.storyboard,
      }),
    });
    state.onStatus('ok', `${created.name} created — it is open now.`);
    await state.onCreated(created.name);
    // Opening a project normally moves you to the cast, because opening one is
    // a move. Creating one from here is not: the next thing this person needs
    // is step five, and it is on this tab.
    state.onTab('guide');
    await tick('create', true);
  } catch (err) {
    // The whole message, newlines and all. A scenario is refused with a list of
    // the keys and nodes that are wrong, and the headline on its own — "does
    // not match the expected format" — is not something anybody can act on.
    state.onStatus('error', err.message);
  } finally {
    state.creating = false;
    render();
  }
}

/**
 * The walkthrough, in order.
 *
 * `scope: 'draft'` steps happen before a project exists and are keyed to
 * nothing; the rest are keyed to whichever project is open, so two shows in one
 * workspace keep their own progress.
 */
function steps(facts) {
  const draft = state.guide?.draft ?? {};
  const project = state.getProject();

  return [
    {
      key: 'describe',
      scope: 'draft',
      title: 'Say what the show is',
      body: () => [
        h(
          'p',
          {},
          'In your own words: what happens, who is in it, and — the part that matters most — ',
          h('strong', {}, 'what the room argues about afterwards'),
          '. A scenario is a delivery mechanism for a decision, so the votes are the design. ',
          'Two or three paragraphs is plenty; the next step turns this into a storyboard.',
        ),
        filled(
          draftBox('description', 'A ship with no crew loses contact with the people responsible for it…', 7),
          draft.description,
        ),
      ],
    },
    {
      key: 'storyboard',
      scope: 'draft',
      title: 'Turn it into a storyboard',
      body: () => [
        h(
          'p',
          {},
          'Copy the brief below — it carries your description with it — and paste the whole ',
          'thing into a chat with a capable model. What comes back is a shot-by-shot document: ',
          'the cast, the visual style, every picture, every line, and the polls written out.',
        ),
        h(
          'p',
          { class: 'hint' },
          'It is a long document and it is meant to be read. Go through it before moving on — ',
          'this is the last point at which changing your mind is cheap.',
        ),
        copyRow('storyboard', 'Copy the brief + your description', () => draft.description ?? ''),
        filled(draftBox('storyboard', 'Paste the storyboard back here…', 10), draft.storyboard),
      ],
    },
    {
      key: 'scenario',
      scope: 'draft',
      title: 'Turn the storyboard into a scenario.yaml',
      body: () => [
        h(
          'p',
          {},
          'The same move again, with the second brief. This one describes the file format ',
          'exactly — every node type, what a poll must declare, what the checker will refuse — ',
          'and carries your storyboard with it.',
        ),
        h(
          'p',
          { class: 'hint' },
          'The file is validated the moment you press Create below, so a mistake here comes ',
          'back as a list of what is wrong rather than as a broken project. If it is refused, ',
          'paste the complaint back to the model and ask it to fix it.',
        ),
        copyRow('scenario', 'Copy the brief + your storyboard', () => draft.storyboard ?? ''),
        filled(draftBox('scenario', 'Paste the scenario.yaml back here…', 12), draft.scenario),
      ],
    },
    {
      key: 'create',
      scope: 'draft',
      title: 'Create the project',
      body: () => [
        h(
          'p',
          {},
          'Makes a folder in your workspace holding the scenario and the storyboard, checks ',
          'the file loads, and opens it. From here the rest of the editor is about this project.',
        ),
        h(
          'div',
          { class: 'guide-row' },
          h('input', {
            class: 'guide-name',
            type: 'text',
            placeholder: 'folder name, e.g. arctic-sentinel',
            value: draft.name ?? '',
            spellcheck: 'false',
            oninput: (event) => scheduleDraftSave({ name: event.target.value }),
          }),
          h(
            'button',
            {
              type: 'button',
              class: 'primary',
              disabled: state.creating || !draft.scenario?.trim(),
              onclick: () => void createProject(),
            },
            state.creating ? 'Creating…' : 'Create the project',
          ),
        ),
        !draft.scenario?.trim() &&
          h('p', { class: 'hint' }, 'Nothing to create yet — the scenario box above is empty.'),
        h(
          'div',
          { class: 'guide-row' },
          h(
            'button',
            {
              type: 'button',
              class: 'ghost',
              onclick: async () => {
                if (!confirm('Clear the description, storyboard and scenario from this tab?')) return;
                // Offered rather than done on a successful create. The draft is
                // the only copy of a storyboard until somebody has checked the
                // project actually opens.
                state.guide = await api('/api/guide/draft', { method: 'DELETE' });
                render();
              },
            },
            'Clear the draft',
          ),
          h(
            'span',
            { class: 'hint' },
            'The three boxes above are kept on this machine until you clear them.',
          ),
        ),
      ],
    },

    // --- from here on, the work is on the other tabs ------------------------
    {
      key: 'init',
      scope: 'project',
      title: 'Set the project up for asset work',
      body: () => [
        h(
          'p',
          {},
          'Writes the project’s first ',
          h('code', {}, 'project.yaml'),
          ' — the file that holds a row per asset: the prompt, the size, the direction a line ',
          'is read in. The scenario says what the show needs; this is where the record of ',
          'making it lives.',
        ),
        goTo('assets', 'Open the Assets tab'),
      ],
    },
    {
      key: 'voice',
      scope: 'project',
      title: 'Declare the voice clips',
      body: () => [
        h(
          'p',
          {},
          'On the Assets tab, press ',
          h('strong', {}, 'Declare voice clips'),
          '. Every spoken line gets a ',
          h('code', {}, 'voice:'),
          ' file and the ',
          h('code', {}, 'hold:'),
          ' one needs. Nothing on the server ever opens an audio file, so a beat lasts exactly ',
          'as long as its hold says — which is why the clips have to be declared before anyone ',
          'can check the timings.',
        ),
        goTo('assets', 'Open the Assets tab'),
      ],
    },
    {
      key: 'seed',
      scope: 'project',
      title: 'Seed the pictures from the storyboard',
      body: () => [
        h(
          'p',
          {},
          'On the Storyboard tab, press ',
          h('strong', {}, 'Seed missing assets'),
          ' to fill in each row’s prompt from the document. Then, on Assets: ',
          h('strong', {}, 'Give each shot its own picture'),
          ', ',
          h('strong', {}, 'Give speakers a portrait'),
          ', and ',
          h('strong', {}, 'File assets by media type'),
          '. All three are safe to press twice.',
        ),
        h(
          'p',
          { class: 'hint' },
          'Seeding only ever adds. Once a prompt has been tuned, the document that suggested ' +
            'it does not overwrite it.',
        ),
        h('div', { class: 'guide-row' }, goTo('story', 'Open the Storyboard tab'), goTo('assets', 'Open the Assets tab')),
      ],
    },
    {
      key: 'make',
      scope: 'project',
      title: 'Make the art and the voices',
      body: () => [
        h(
          'p',
          {},
          'The long part. Pictures are made in whatever program you like and dropped into the ',
          'takes folder; voices are generated from the Characters tab, one part at a time, ',
          'against a reference clip. Choose a take, then publish it — generating never ',
          'publishes, so re-rolling a line is free.',
        ),
        h(
          'p',
          { class: 'hint' },
          'The Command centre is the list of what is left, in the order it has to happen. ' +
            'When it is empty the show is ready to run.',
        ),
        h('div', { class: 'guide-row' }, goTo('cast', 'Open Characters'), goTo('command', 'Open the Command centre')),
      ],
    },
    {
      key: 'rehearse',
      scope: 'project',
      title: 'Rehearse it',
      body: () => [
        h(
          'p',
          {},
          'Press ',
          h('strong', {}, 'Play'),
          ' at the top of the window. A projector window opens — drag it to the second screen, ',
          'press F11, and ',
          h('strong', {}, 'click it once'),
          ': the browser will not play a sound in a window nobody has touched, and the show ',
          'will not start until it has been.',
        ),
        h(
          'p',
          {},
          'Then, on the Show tab, use ',
          h('strong', {}, 'Cast'),
          ' to try a split and watch the vote resolve. That is the only thing that proves a ',
          'poll’s default and its tie-break work before an audience is the thing testing them.',
        ),
        goTo('show', 'Open the Show tab'),
      ],
    },
    {
      key: 'live',
      scope: 'project',
      title: 'Go live',
      body: () => [
        h(
          'p',
          {},
          'On the Show tab, give the room a code you can read out — ',
          h('code', {}, 'ARCTIC-SENTINEL'),
          ' rather than six characters the relay picked — and press ',
          h('strong', {}, 'Go live'),
          '. Phones join at the address on the screen.',
        ),
        h(
          'p',
          { class: 'hint' },
          'Worth naming it: a named room can be walked back into if this machine crashes ' +
            'mid-vote, with the open question and every ballot still there. A code the relay ' +
            'picked cannot, because nothing can ask for it again.',
        ),
        goTo('show', 'Open the Show tab'),
      ],
    },
  ].map((step) => ({ ...step, project: step.scope === 'project' ? (project ?? '') : '' }));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

async function tick(key, done) {
  const step = steps(state.getFacts()).find((entry) => entry.key === key);
  state.guide = await api('/api/guide/step', {
    method: 'POST',
    body: JSON.stringify({ project: step?.project ?? '', step: key, done }),
  });
  render();
}

function isDone(step) {
  return (state.guide?.done?.[step.project] ?? []).includes(step.key);
}

function render() {
  const list = $('guide-list');
  if (!list) return;
  if (!state.guide) {
    list.replaceChildren(h('p', { class: 'empty' }, 'Loading…'));
    return;
  }

  const facts = state.getFacts();
  const project = state.getProject();
  const all = steps(facts);

  // Open the first thing not yet ticked, until somebody clicks something else.
  // A walkthrough that opened at the top every time would be a walkthrough
  // whose ninth step is four scrolls away for the whole of the afternoon it
  // takes to get there.
  if (state.open === null) state.open = (all.find((step) => !isDone(step)) ?? all[0]).key;

  list.replaceChildren(
    ...all.map((step, index) => {
      const done = isDone(step);
      const open = state.open === step.key;
      const note = observed(step.key, facts);
      const needsProject = step.scope === 'project' && !project;

      return h(
        'li',
        { class: `guide-step${done ? ' done' : ''}${open ? ' open' : ''}` },
        h(
          'div',
          { class: 'guide-head' },
          h('input', {
            type: 'checkbox',
            class: 'guide-tick',
            checked: done,
            'aria-label': `Mark "${step.title}" done`,
            onchange: (event) => void tick(step.key, event.target.checked),
          }),
          h(
            'button',
            {
              type: 'button',
              class: 'guide-title',
              onclick: () => {
                state.open = open ? '' : step.key;
                render();
              },
            },
            h('span', { class: 'guide-number' }, String(index + 1)),
            step.title,
          ),
          note && h('span', { class: 'guide-seen' }, note),
        ),
        open &&
          h(
            'div',
            { class: 'guide-body' },
            needsProject
              ? h(
                  'p',
                  { class: 'hint' },
                  'Open a project first — the picker is at the top left, or finish step 4 above.',
                )
              : step.body(),
          ),
      );
    }),
  );
}

export async function refreshGuide() {
  try {
    state.guide = await api('/api/guide');
  } catch {
    state.guide = { draft: { name: '', description: '', storyboard: '', scenario: '' }, done: {} };
  }
  render();
}

export function renderGuide() {
  render();
}

export function initGuide(options) {
  Object.assign(state, options);
  void refreshGuide();
}

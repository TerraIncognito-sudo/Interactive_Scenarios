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
 * **It is step one, and that is a correction.** The project used to be made at
 * step four, out of the boxes above it, which meant the first three steps ran
 * against whatever project happened to be open — so the pipeline links below
 * pointed at somebody else's show, and the storyboard and the scenario had
 * nowhere of their own to be written until the create. Making the folder first
 * costs nothing: a project with nothing in it is the starter scenario, which
 * runs. Everything after it writes into a folder that exists, which is what
 * lets the storyboard land in the project and the scenario replace the starter
 * rather than both waiting in a box for a create that may never come.
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
  /** Which box is being written into the project, so its button can say so. */
  applying: null,
  getProject: () => null,
  getFacts: () => null,
  onStatus: () => {},
  onTab: () => {},
  onCreated: async () => {},
  onApplyStoryboard: async () => false,
  onApplyScenario: async () => false,
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
let waiting = {};

/**
 * Saves the draft a beat after typing stops.
 *
 * Debounced rather than saved per keystroke, and rather than saved on blur:
 * these boxes hold a whole storyboard and a whole scenario file, which is an
 * afternoon of somebody's work sitting in a browser tab, and blur never
 * happens to a tab that is closed.
 *
 * The waiting patch accumulates rather than being replaced. One timer serves
 * every box, so typing a name within the debounce of a paste used to cancel
 * the paste's write and send the name instead — and the box that was not
 * touched last was the one that never reached disk, silently, which is exactly
 * the loss the draft exists to prevent.
 */
function scheduleDraftSave(patch) {
  state.guide.draft = { ...state.guide.draft, ...patch };
  waiting = { ...waiting, ...patch };
  syncButtons();
  clearTimeout(pending);
  pending = setTimeout(() => void flushDraft(), 600);
}

/**
 * Enables the buttons whose input has just arrived.
 *
 * Typing deliberately does not re-render: `render()` replaces the whole list,
 * and a textarea replaced mid-paragraph takes the caret and the undo history
 * with it. But the buttons under these boxes are disabled until their box has
 * something in it, and nothing was updating them — so Create stayed greyed
 * with a name typed into the field beside it, and the tab looked like it had
 * simply refused. It is the reason a walkthrough that could create a project
 * went a whole release without anybody managing to.
 *
 * One attribute says which box a button is waiting for, so this cannot drift
 * out of step with the conditions the buttons are built with.
 */
function syncButtons() {
  const list = $('guide-list');
  if (!list) return;
  const busy = state.creating || state.applying !== null;
  for (const button of list.querySelectorAll('[data-needs]')) {
    button.disabled = busy || !(state.guide?.draft?.[button.dataset.needs] ?? '').trim();
  }
}

/** Writes whatever is waiting, now. Awaited before anything reads the draft. */
async function flushDraft() {
  clearTimeout(pending);
  const patch = waiting;
  waiting = {};
  if (Object.keys(patch).length === 0) return;
  try {
    await api('/api/guide/draft', { method: 'PUT', body: JSON.stringify(patch) });
  } catch {
    state.onStatus('error', 'Could not save the draft.');
  }
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
    case 'storyboard': {
      if (!draft.storyboard?.trim()) return null;
      // Two facts, not one: what is in the box, and whether it has reached the
      // folder. The box was the whole of this once, and a storyboard that sat
      // in it for an afternoon while the project went on having none is the
      // failure that put a Save button underneath it.
      const pasted = `${words(draft.storyboard)} words pasted back`;
      if (!facts) return pasted;
      return `${pasted} · ${facts.hasStoryboard ? 'saved into the project' : 'not saved yet'}`;
    }
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

/**
 * A brief, and the thing it carries with it.
 *
 * `extra` returning empty is a real case rather than a degenerate one: the
 * short scenario brief goes into the chat that has the storyboard in it
 * already, so what it carries is nothing at all.
 */
function copyRow(brief, label, extra, variant = 'primary') {
  return h(
    'div',
    { class: 'guide-row' },
    h(
      'button',
      {
        type: 'button',
        class: variant,
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

/**
 * Makes the folder, out of nothing but a name.
 *
 * It used to carry the pasted scenario, and that was the wrong way round. A
 * scenario a model got slightly wrong refused the whole create, which left the
 * person with no project at all and a refusal to read — at the one moment they
 * had nothing else to work with. The starter scenario is a show that runs, so
 * a folder can exist before there is anything to put in it, and the scenario
 * is written into it at step four where being refused costs a fix rather than
 * a project.
 */
async function createProject() {
  const draft = state.guide.draft;
  state.creating = true;
  render();
  try {
    await flushDraft();
    const created = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: draft.name }),
    });
    // Opening a project normally moves you to the cast, because opening one is
    // a move. Creating one from here is not: the next thing this person needs
    // is step two, and it is on this tab.
    await state.onCreated(created.name);
    state.onTab('guide');
    await tick('create', true);
    // Open what comes next rather than leaving the finished step open. The
    // checklist opens at the first unticked step on a fresh load, and this is
    // the same idea applied to the moment one of them stops being unticked.
    state.open = 'describe';
    // Last, because opening the project runs the analysis and the analysis has
    // its own opinion about the status line. Said first, this sentence lasted
    // until the validator answered and was replaced by the word "valid".
    state.onStatus('ok', `${created.name} created — everything below now writes into it.`);
  } catch (err) {
    state.onStatus('error', err.message);
  } finally {
    state.creating = false;
    render();
  }
}

/**
 * Hands one of the boxes to the project it belongs to.
 *
 * The box is where a paste lands and the project is where the document lives,
 * and keeping them separate is the point: a scenario a model got slightly
 * wrong comes back refused with a list naming the node, and the text has to
 * still be here when it does — otherwise the fix is another round trip through
 * a chat window for a missing `default:`.
 *
 * Neither write is this tab's own route. Both are the functions behind the
 * Save buttons on the panes that own those two files.
 */
async function applyToProject(field, what, apply) {
  const text = state.guide?.draft?.[field] ?? '';
  if (!text.trim()) return state.onStatus('error', `Nothing in the ${what} box to save yet.`);
  if (!state.getProject()) {
    return state.onStatus('error', 'No project is open — step 1 makes one.');
  }
  const project = state.getProject();
  state.applying = field;
  render();
  try {
    await flushDraft();
    // Last word, and only on success. Writing the scenario runs the validator
    // behind it, and the validator's own report — the single word "valid" —
    // arrives after this button's and is not an answer to the question the
    // button asked, which was whether the file reached the folder.
    if (await apply(text)) state.onStatus('ok', `${what} saved into ${project}.`);
  } catch (err) {
    state.onStatus('error', err.message);
  } finally {
    state.applying = null;
    render();
  }
}

/** The button both of those steps end with. */
function applyRow(field, what, label, apply) {
  return h(
    'button',
    {
      type: 'button',
      class: 'primary',
      'data-needs': field,
      disabled: state.applying !== null || !(state.guide?.draft?.[field] ?? '').trim(),
      onclick: () => void applyToProject(field, what, apply),
    },
    state.applying === field ? 'Saving…' : label,
  );
}

/**
 * The walkthrough, in order.
 *
 * `scope: 'draft'` is the one step that happens before a project exists, keyed
 * to nothing because there is nothing to key it to. Everything else is keyed to
 * whichever project is open, so two shows in one workspace keep their own
 * progress — and, more to the point, so the work each step describes has a
 * folder to happen in.
 */
function steps(facts) {
  const draft = state.guide?.draft ?? {};
  const project = state.getProject();

  return [
    {
      key: 'create',
      scope: 'draft',
      title: 'Make the project',
      body: () => [
        h(
          'p',
          {},
          'A folder in your workspace with a working show in it — a title card, a couple of ',
          'lines and a vote. Press Play and it runs. Everything in it is meant to be ',
          'replaced, and the next three steps are how.',
        ),
        h(
          'p',
          { class: 'hint' },
          'First, on purpose. Every step below writes into the project that is open, so ',
          'making it now is what stops the rest of this walkthrough happening to whichever ',
          'show you had open when you started.',
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
              'data-needs': 'name',
              disabled: state.creating || !draft.name?.trim(),
              onclick: () => void createProject(),
            },
            state.creating ? 'Creating…' : 'Create the project',
          ),
        ),
        h(
          'p',
          { class: 'hint' },
          'Letters, numbers, spaces, hyphens and underscores. It is the folder name, and it ',
          'is what the picker at the top left will call the show.',
        ),
      ],
    },
    {
      key: 'describe',
      scope: 'project',
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
      scope: 'project',
      title: 'Turn it into a storyboard',
      body: () => [
        h(
          'p',
          {},
          'Copy the brief below — it carries your description with it — and paste the whole ',
          'thing into a chat with a capable model. What comes back is a shot-by-shot document: ',
          'the cast, the visual style, every picture, every line, and the polls written out. ',
          h('strong', {}, 'Keep that chat open'),
          ' — the next step goes back to it.',
        ),
        h(
          'p',
          { class: 'hint' },
          'It is a long document and it is meant to be read. Go through it before moving on — ',
          'this is the last point at which changing your mind is cheap.',
        ),
        copyRow('storyboard', 'Copy the brief + your description', () => draft.description ?? ''),
        filled(draftBox('storyboard', 'Paste the storyboard back here…', 10), draft.storyboard),
        h(
          'div',
          { class: 'guide-row' },
          applyRow('storyboard', 'storyboard', 'Save it into the project', (text) =>
            state.onApplyStoryboard(text),
          ),
          h(
            'span',
            { class: 'hint' },
            'Writes it beside the scenario, where the Storyboard tab reads it and the asset ' +
              'rows are seeded from it.',
          ),
        ),
      ],
    },
    {
      key: 'scenario',
      scope: 'project',
      title: 'Turn the storyboard into a scenario.yaml',
      body: () => [
        h(
          'p',
          {},
          'Back in the same chat, paste the short brief. It is the file format and nothing ',
          'else — the storyboard is already up there, and sending it again is ninety thousand ',
          'characters of room the model needs for the answer instead.',
        ),
        copyRow('scenario-short', 'Copy the short brief (same chat)', () => ''),
        h(
          'p',
          { class: 'hint' },
          'Started a fresh chat instead? Use the full brief — it carries your storyboard ' +
            'with it, and spells out everything the short one assumes you have just read.',
        ),
        copyRow('scenario', 'Copy the full brief + your storyboard', () => draft.storyboard ?? '', 'ghost'),
        filled(draftBox('scenario', 'Paste the scenario.yaml back here…', 12), draft.scenario),
        h(
          'div',
          { class: 'guide-row' },
          applyRow('scenario', 'scenario', 'Save it into the project', (text) =>
            state.onApplyScenario(text),
          ),
          h(
            'span',
            { class: 'hint' },
            'Replaces the starter. It is checked first, so a mistake comes back as a list of ' +
              'what is wrong — paste that back to the model and ask it to fix it.',
          ),
        ),
        h(
          'p',
          { class: 'hint' },
          'If the model stopped partway, ask it to carry on from where it left off and add ' +
            'the rest to the end of the box. A scenario that ends in the middle still loads; ' +
            'it simply stops the show there.',
        ),
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
                // Offered rather than done on a successful save. The boxes are
                // the only copy of a storyboard until somebody has checked the
                // project actually opens.
                state.guide = await api('/api/guide/draft', { method: 'DELETE' });
                render();
              },
            },
            'Clear the boxes',
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
                  'Make the project first — step 1 above, or pick one at the top left.',
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

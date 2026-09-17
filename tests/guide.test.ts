/**
 * The walkthrough: the briefs it hands out, the draft it keeps, and the one
 * thing this program could not do until it existed.
 *
 * Creating a project had no route. A folder with a `scenario.yaml` in it was
 * made by a command-line script from a storyboard that already existed, so the
 * first step of using the editor happened outside it — and a walkthrough whose
 * fourth step is "open a terminal" is a walkthrough that loses the person it
 * was written for.
 *
 * The briefs are checked against the formats they describe rather than merely
 * for existing. They are prose, and prose drifts: the scenario schema gains a
 * node type, the storyboard parser learns a heading, and the document that
 * tells somebody what to write goes on describing last year's file. What is
 * asserted here is the part a reader would be misled by.
 */

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

const configDir = mkdtempSync(join(tmpdir(), 'is-guide-config-'));
process.env.EDITOR_CONFIG_DIR = configDir;

const { buildEditorServer } = await import('../client/app/server.ts');
const { setWorkspace } = await import('../client/app/workspace.ts');
const { ScenarioNodeSchema } = await import('../shared/scenario/schema.ts');

const ROOT = join(import.meta.dirname, '..');

let workspace: string;
let server: Server;
let baseUrl: string;

before(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'is-guide-workspace-'));
  server = await buildEditorServer();
  await setWorkspace(workspace);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(configDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

afterEach(async () => {
  await fetch(`${baseUrl}/api/guide/draft`, { method: 'DELETE' });
});

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: init.body !== undefined ? { 'content-type': 'application/json' } : {},
  });
}

const A_SCENARIO = `
id: guided
title: Guided
start: only
nodes:
  - id: only
    type: end
    text: Done.
`.trimStart();

// ---------------------------------------------------------------------------

describe('the briefs', () => {
  test('all of them are served as text, because what happens next is a paste', async () => {
    for (const name of ['storyboard', 'scenario', 'scenario-short']) {
      const response = await api(`/api/guide/brief/${name}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/plain/);
      assert.ok((await response.text()).length > 2000, `${name} brief is suspiciously short`);
    }
  });

  test('the route names its briefs rather than taking a filename', async () => {
    // It reads from a folder in the repository. A route that took a path would
    // be a route that reads any file on the machine.
    assert.equal((await api('/api/guide/brief/passwd')).status, 404);
  });

  test('both scenario briefs describe every node type the schema has', async () => {
    // The failure this catches is quiet and slow: a node type is added, the
    // brief goes on listing five, and every scenario a model writes from it is
    // missing the sixth for as long as nobody notices.
    //
    // Both, because the short one is not a summary of the long one — it is the
    // same reference for the chat that already holds the storyboard, and it is
    // the one most people will use. A format reference that has quietly become
    // the less complete of the two is worse than not having it.
    const types = ScenarioNodeSchema.options.map(
      (option) => (option.shape.type as { value: string }).value,
    );
    assert.ok(types.length >= 6, 'the schema walk found nothing');

    for (const name of ['scenario', 'scenario-short']) {
      const brief = await (await api(`/api/guide/brief/${name}`)).text();
      for (const type of types) {
        assert.ok(
          new RegExp(`^### ${type}$`, 'm').test(brief),
          `the ${name} brief has no section for a "${type}" node`,
        );
      }
      // The rules with no second chance. A poll missing its default is refused
      // at the editor, which is recoverable; a file that will not load because
      // an unknown key was invented is the round trip this brief exists to
      // avoid.
      assert.match(brief, /default:/, `${name} never mentions a poll's default`);
      assert.match(brief, /unknown key/i, `${name} never says an unknown key is an error`);
    }
  });

  test('the short brief does not ask for the storyboard it is sent after', async () => {
    // Its whole reason for existing: the chat it goes into wrote the storyboard
    // a moment ago, and pasting ninety thousand characters of it back is the
    // room the model needed for the answer. A short brief that still said "the
    // storyboard is below this brief" would be describing something that is
    // not there.
    const brief = await (await api('/api/guide/brief/scenario-short')).text();
    assert.ok(
      !/storyboard is below/i.test(brief),
      'the short brief still expects the storyboard to be pasted under it',
    );
    assert.match(brief, /earlier in this conversation/i);
    // And it says what to do about the one failure a long show actually hits.
    assert.match(brief, /continue in the\s+next reply/i);
  });

  test('the storyboard brief spells the labels its parser actually matches', async () => {
    // Every one of these is a literal in `client/app/storyboard.ts`. A brief
    // that taught somebody to write `**Shot:**` would produce a document that
    // parses to nothing, and the first sign of it would be an empty asset
    // board.
    const brief = await (await api('/api/guide/brief/storyboard')).text();
    for (const label of ['**Hold:**', '**Scene:**', '**Node:**', '**IMAGE**', '**MOTION**', '*Delivery:']) {
      assert.ok(brief.includes(label), `the storyboard brief never mentions ${label}`);
    }
    assert.match(brief, /### Shot A\.1/, 'no example of a shot heading');
  });

  test('neither brief teaches the shorthand nothing expands any more', async () => {
    // `composePrompt` used to turn `STYLE.` into the four hundred characters a
    // storyboard defines once. It went with the generators it fed, so a prompt
    // saying `STYLE.` now reaches an image model as the word STYLE — and the
    // brief is the only place anybody would learn to write it.
    const storyboard = await (await api('/api/guide/brief/storyboard')).text();
    assert.match(storyboard, /Each prompt must\s*\n?\s*stand alone/);
    assert.ok(
      !/^STYLE\. /m.test(storyboard),
      'the storyboard brief still writes prompts in the shorthand',
    );
  });
});

describe('the draft', () => {
  test('it survives a restart, because it is the only copy of an afternoon', async () => {
    await api('/api/guide/draft', {
      method: 'PUT',
      body: JSON.stringify({ description: 'A ship with no crew.', storyboard: '# Shots' }),
    });

    const back = (await (await api('/api/guide')).json()) as {
      draft: { description: string; storyboard: string; scenario: string };
    };
    assert.equal(back.draft.description, 'A ship with no crew.');
    assert.equal(back.draft.storyboard, '# Shots');
    // A patch, not a replacement: the three boxes are saved independently as
    // each stops being typed in, and a whole-object write would lose whichever
    // one was not the last one touched.
    assert.equal(back.draft.scenario, '');

    // On disk rather than in memory, which is the whole claim.
    const file = JSON.parse(readFileSync(join(configDir, 'guide.json'), 'utf8')) as {
      draft: { description: string };
    };
    assert.equal(file.draft.description, 'A ship with no crew.');
  });

  test('a tick is kept per project, so two shows do not share a checklist', async () => {
    await api('/api/guide/step', {
      method: 'POST',
      body: JSON.stringify({ project: 'one', step: 'voice', done: true }),
    });
    await api('/api/guide/step', {
      method: 'POST',
      body: JSON.stringify({ project: 'two', step: 'seed', done: true }),
    });
    const state = (await (await api('/api/guide')).json()) as { done: Record<string, string[]> };
    assert.deepEqual(state.done.one, ['voice']);
    assert.deepEqual(state.done.two, ['seed']);

    // And unticking removes the key rather than leaving an empty list, so a
    // project nobody has started is absent rather than present-and-empty.
    await api('/api/guide/step', {
      method: 'POST',
      body: JSON.stringify({ project: 'one', step: 'voice', done: false }),
    });
    const after = (await (await api('/api/guide')).json()) as { done: Record<string, string[]> };
    assert.equal(after.done.one, undefined);
  });
});

describe('creating a project', () => {
  test('a folder appears with the scenario and the storyboard in it', async () => {
    const response = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: 'guided-show',
        scenario: A_SCENARIO,
        storyboard: '# Guided\n\n### Shot A.1 — Only\n',
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      name: string;
      storyboard?: string;
      projects: { name: string }[];
    };

    assert.equal(body.name, 'guided-show');
    assert.equal(body.storyboard, 'storyboard.md');
    // The picker's list comes back with it, because the window it is created
    // from has to catch up before the create can report success.
    assert.ok(body.projects.some((project) => project.name === 'guided-show'));

    const dir = join(workspace, 'guided-show');
    assert.equal(readFileSync(join(dir, 'scenario.yaml'), 'utf8'), A_SCENARIO);
    assert.ok(existsSync(join(dir, 'storyboard.md')));

    // And it opens, which is the only claim that matters.
    assert.equal((await api('/api/projects/guided-show')).status, 200);
  });

  test('a scenario that will not load writes nothing, and says what is wrong', async () => {
    // A folder holding a file that will not load is a project the picker
    // offers and the editor then refuses to open, and the first thing anybody
    // would do about it is delete the folder and lose the paste.
    const response = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: 'broken-show',
        scenario: 'id: broken\ntitle: Broken\nstart: nowhere\nnodes:\n  - id: here\n    type: end\n',
      }),
    });
    assert.equal(response.status, 400);
    const { error } = (await response.json()) as { error: string };
    // The problems and not merely the headline: a list naming the node is
    // something a person can paste back to whatever wrote the file.
    assert.match(error, /nowhere/);
    assert.equal(existsSync(join(workspace, 'broken-show')), false);
  });

  test('a storyboard is optional, because a hand-written scenario is a whole project', async () => {
    const response = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'bare-show', scenario: A_SCENARIO }),
    });
    assert.equal(response.status, 200);
    assert.equal(existsSync(join(workspace, 'bare-show', 'storyboard.md')), false);
  });

  test('it will not take a name that is a path', async () => {
    for (const name of ['../escape', 'a/b', '..', '.hidden', 'x']) {
      const response = await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name, scenario: A_SCENARIO }),
      });
      assert.equal(response.status, 400, `"${name}" was accepted`);
    }
    assert.equal(existsSync(join(workspace, '..', 'escape')), false);
  });

  test('it refuses to write over a project that is already there', async () => {
    const body = JSON.stringify({ name: 'twice-show', scenario: A_SCENARIO });
    assert.equal((await api('/api/projects', { method: 'POST', body })).status, 200);

    const second = await api('/api/projects', { method: 'POST', body });
    assert.equal(second.status, 400);
    assert.match(((await second.json()) as { error: string }).error, /already exists/);
  });
});

describe('a storyboard that arrives after the project file does', () => {
  test('the project records where it is, or nothing can find it', async () => {
    // The walkthrough now makes the folder first and pastes the storyboard into
    // it afterwards, which is an order `project.yaml` had never been written
    // for: `pathsOf` reads the `storyboard:` key and nothing re-scans the
    // folder once the file exists. So `storyboard.md` landed on disk, the
    // Storyboard tab went on reporting the document as absent, and seeding went
    // on refusing to read it. The file was there; the only record of what it
    // was had never been written.
    await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'late-story', scenario: A_SCENARIO }),
    });
    await api('/api/projects/late-story/init', { method: 'POST' });

    const before = (await (await api('/api/projects/late-story')).json()) as {
      storyboardSource?: string;
    };
    assert.equal(before.storyboardSource, undefined, 'it started with a storyboard somehow');

    const saved = await api('/api/projects/late-story/storyboard', {
      method: 'PUT',
      body: JSON.stringify({ source: '# Late\n\n### Shot A.1 — Only\n' }),
    });
    assert.equal(saved.status, 200);

    const dir = join(workspace, 'late-story');
    assert.ok(existsSync(join(dir, 'storyboard.md')), 'nothing was written');
    assert.match(
      readFileSync(join(dir, 'project.yaml'), 'utf8'),
      /^storyboard: storyboard\.md$/m,
      'the project file still does not say where the storyboard is',
    );

    // The claim that matters, and the one the board reads: reopening it finds
    // the document.
    const after = (await (await api('/api/projects/late-story')).json()) as {
      storyboardSource?: string;
    };
    assert.match(after.storyboardSource ?? '', /Shot A\.1/);
  });

  test('a storyboard the author already named keeps its name', async () => {
    // `storyboard: script.md` is somebody saying where their document lives.
    // Writing `storyboard.md` beside it and re-pointing the key would split one
    // document into two, and the one the board read would be the empty one.
    await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'named-story', scenario: A_SCENARIO }),
    });
    await api('/api/projects/named-story/init', { method: 'POST' });

    const dir = join(workspace, 'named-story');
    const file = join(dir, 'project.yaml');
    writeFileSync(file, `${readFileSync(file, 'utf8')}storyboard: script.md\n`, 'utf8');

    await api('/api/projects/named-story/storyboard', {
      method: 'PUT',
      body: JSON.stringify({ source: '# Named\n' }),
    });

    assert.ok(existsSync(join(dir, 'script.md')), 'it wrote somewhere else');
    assert.equal(existsSync(join(dir, 'storyboard.md')), false);
    assert.match(readFileSync(file, 'utf8'), /^storyboard: script\.md$/m);
  });
});

describe('the tab itself', () => {
  test('every step the page draws has somewhere to keep its tick', () => {
    // The two halves of one decision written in two files: the step keys live
    // in `guide.js`, and `''` versus the project name is decided by the
    // `scope` beside each one. A step with neither would be a checkbox that
    // forgets itself on every reload, silently.
    const source = readFileSync(join(ROOT, 'client', 'web', 'board', 'guide.js'), 'utf8');
    const keys = [...source.matchAll(/^\s{6}key: '([a-z]+)',\n\s{6}scope: '(draft|project)',/gm)];
    assert.ok(keys.length >= 10, `only found ${keys.length} steps — the walk is broken`);

    // Exactly one step happens before a project exists: the one that makes it.
    // It used to be the fourth, with the description, the storyboard and the
    // scenario ahead of it keyed to nothing — which meant the first three steps
    // of a new show ran against whichever project happened to be open, and the
    // two documents had nowhere of their own to be written until a create that
    // might never come.
    const drafts = keys.filter((match) => match[2] === 'draft').map((match) => match[1]);
    assert.deepEqual(drafts, ['create']);
    assert.equal(keys[0]![1], 'create', 'the project is no longer made first');
  });

  test('the pipeline steps send people to a button rather than offering a second one', () => {
    // Two buttons that call one route are two things to keep in step, and the
    // one that falls behind is the one nobody is looking at.
    const source = readFileSync(join(ROOT, 'client', 'web', 'board', 'guide.js'), 'utf8');
    assert.ok(source.includes("goTo('assets'"));
    assert.ok(source.includes("goTo('story'"));
    assert.ok(source.includes("goTo('show'"));
    assert.ok(
      !/fetch\(`?\/api\/projects\/\$\{[^}]*\}\/(wire|sync|init)/.test(source),
      'the walkthrough is calling a pipeline route of its own',
    );
    // The two boxes that hold a document go to disk through the functions
    // behind the Save buttons on the panes that own those files, handed in as
    // `onApplyStoryboard` and `onApplyScenario`. A second fetch here would be a
    // second thing to keep in step with the storyboard pane and the source
    // pane, and it would be the one nobody was looking at.
    assert.ok(source.includes('state.onApplyStoryboard('), 'no storyboard hand-off');
    assert.ok(source.includes('state.onApplyScenario('), 'no scenario hand-off');
    assert.ok(
      !/\/storyboard`|\/scenario`/.test(source),
      'the walkthrough writes a project file through a route of its own',
    );
  });

  test('the create sends a name and nothing else', () => {
    // It used to carry the pasted scenario, which meant a scenario a model got
    // slightly wrong refused the whole create — leaving somebody with no
    // project at all at the one moment they had nothing else to work with. The
    // folder is made from the starter and the scenario is saved into it a step
    // later, where being refused costs a fix rather than a project.
    const source = readFileSync(join(ROOT, 'client', 'web', 'board', 'guide.js'), 'utf8');
    const call = /await api\('\/api\/projects', \{\s*method: 'POST',\s*body: JSON\.stringify\(([^)]*)\)/.exec(
      source,
    );
    assert.ok(call, 'the walkthrough no longer creates a project');
    assert.match(call[1]!, /^\{ name: draft\.name \}$/);
  });
});

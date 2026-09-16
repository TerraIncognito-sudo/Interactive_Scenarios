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
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
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
  test('both are served as text, because what happens to them next is a paste', async () => {
    for (const name of ['storyboard', 'scenario']) {
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

  test('the scenario brief describes every node type the schema has', async () => {
    // The failure this catches is quiet and slow: a node type is added, the
    // brief goes on listing five, and every scenario a model writes from it is
    // missing the sixth for as long as nobody notices.
    const brief = await (await api('/api/guide/brief/scenario')).text();
    const types = ScenarioNodeSchema.options.map(
      (option) => (option.shape.type as { value: string }).value,
    );
    assert.ok(types.length >= 6, 'the schema walk found nothing');
    for (const type of types) {
      assert.ok(
        new RegExp(`^### ${type}$`, 'm').test(brief),
        `the scenario brief has no section for a "${type}" node`,
      );
    }
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

describe('the tab itself', () => {
  test('every step the page draws has somewhere to keep its tick', () => {
    // The two halves of one decision written in two files: the step keys live
    // in `guide.js`, and `''` versus the project name is decided by the
    // `scope` beside each one. A step with neither would be a checkbox that
    // forgets itself on every reload, silently.
    const source = readFileSync(join(ROOT, 'client', 'web', 'board', 'guide.js'), 'utf8');
    const keys = [...source.matchAll(/^\s{6}key: '([a-z]+)',\n\s{6}scope: '(draft|project)',/gm)];
    assert.ok(keys.length >= 10, `only found ${keys.length} steps — the walk is broken`);

    // The four that happen before a project exists are keyed to nothing,
    // because there is nothing to key them to.
    const drafts = keys.filter((match) => match[2] === 'draft').map((match) => match[1]);
    assert.deepEqual(drafts, ['describe', 'storyboard', 'scenario', 'create']);
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
  });
});

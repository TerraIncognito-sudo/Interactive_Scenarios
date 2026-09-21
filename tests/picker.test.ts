/**
 * The two things the picker could not do: add to itself, and point at a folder.
 *
 * Making a new scenario meant a terminal — `project:new` against a storyboard
 * that already existed — or the walkthrough, a language model and a paste.
 * Neither is what somebody wants at the moment they have decided to start a
 * second show, and "there is no way to do this in the program" is a gap a
 * picker full of projects makes look like a bug.
 *
 * Opening the folder is the other half of the same complaint. Dropping a
 * rendered still into a takes folder is ordinary file work and always will be;
 * what was avoidable was reading a path off the screen and typing it into
 * Explorer.
 *
 * **The spawn is deliberately not exercised here.** A test that proved the
 * file manager opens would open a file manager window on whatever machine ran
 * `npm test`. What is tested is everything up to it — which folder was chosen,
 * and that a name cannot name one outside the workspace — plus a read of the
 * source for the one property that has no observable behaviour until the day
 * it bites: that nothing here goes through a shell.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';

const configDir = mkdtempSync(join(tmpdir(), 'is-picker-config-'));
process.env.EDITOR_CONFIG_DIR = configDir;

const { buildEditorServer } = await import('../client/app/server.ts');
const { setWorkspace } = await import('../client/app/workspace.ts');
const { starterScenario, scenarioIdFor } = await import('../client/app/scaffold.ts');
const { revealTarget, openerFor } = await import('../client/app/reveal.ts');
const { parseScenarioSource } = await import('../shared/scenario/load.ts');

const ROOT = join(import.meta.dirname, '..');

let workspace: string;
let server: Server;
let baseUrl: string;

before(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'is-picker-workspace-'));
  server = await buildEditorServer();
  await setWorkspace(workspace);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(configDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------

describe('the scenario a new project starts life as', () => {
  test('it loads, which is the only claim that matters', () => {
    // Written as a string with its comments in it rather than serialised, so
    // nothing but a parse can tell us it is still a valid file. If this fails
    // the New button writes a folder the editor then refuses to open.
    const parsed = parseScenarioSource(starterScenario({ name: 'Harbour Watch' }));
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.problems.join('\n'));
  });

  test('it has no warnings either, because a first run should be clean', () => {
    // A declared-but-missing asset is a warning by design — it is what puts a
    // row on the board. On a brand-new project it is something unexplained
    // going wrong before a word has been written, so the starter declares none.
    const parsed = parseScenarioSource(starterScenario({ name: 'Harbour Watch' }));
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.deepEqual(parsed.warnings, []);
  });

  test('it is a show rather than a stub', () => {
    // The point of a starter is that Play works before anything is written.
    // One `end` node would load and teach nothing.
    const parsed = parseScenarioSource(starterScenario({ name: 'Harbour Watch' }));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const types = parsed.scenario.nodes.map((node) => node.type);
    for (const type of ['gate', 'dialogue', 'poll', 'end']) {
      assert.ok(types.includes(type as never), `the starter has no ${type} node`);
    }
    assert.equal(types.filter((type) => type === 'end').length, 2, 'a poll with one outcome');
  });

  test('it keeps its comments, because teaching the format is most of its job', () => {
    const source = starterScenario({ name: 'Harbour Watch' });
    assert.match(source, /^#/, 'no header comment');
    assert.ok(source.includes('default:'), 'no default on the poll');
    // The three rules a first-time author trips over. A serialiser would have
    // thrown all of this away, which is why this file is a template literal.
    assert.match(source, /hold/i);
    assert.match(source, /scene is a \*place\*/);
    assert.match(source, /stall in front of an audience/);
  });

  test('a folder name is not a scenario id, and is not used as one', () => {
    // `NEW_PROJECT_NAME` allows spaces; `idPattern` does not. Miss this and
    // naming a project "My Show" writes a file that will not load.
    assert.equal(scenarioIdFor('My Show'), 'my-show');
    assert.equal(scenarioIdFor('  Arctic  Sentinel  '), 'arctic-sentinel');
    assert.equal(scenarioIdFor('Q3_review'), 'q3-review');
    assert.equal(scenarioIdFor('Ünicode Ω'), 'nicode');
    assert.equal(scenarioIdFor('-'), 'scenario', 'a name with nothing left in it');
  });
});

describe('creating one from the picker', () => {
  test('a name alone is enough, and what lands is openable', async () => {
    const response = await post('/api/projects', { name: 'Harbour Watch' });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { name: string; projects: { name: string }[] };
    assert.equal(body.name, 'Harbour Watch');
    assert.ok(body.projects.some((project) => project.name === 'Harbour Watch'));

    const source = readFileSync(join(workspace, 'Harbour Watch', 'scenario.yaml'), 'utf8');
    assert.match(source, /^id: harbour-watch$/m, 'the id did not follow the folder name');

    // The claim that matters: the picker offers it and the editor opens it.
    const opened = await fetch(`${baseUrl}/api/projects/${encodeURIComponent('Harbour Watch')}`);
    assert.equal(opened.status, 200);
  });

  test('an explicit title beats the folder name', async () => {
    await post('/api/projects', { name: 'sea-state', title: 'Sea State: a rehearsal' });
    const source = readFileSync(join(workspace, 'sea-state', 'scenario.yaml'), 'utf8');
    // Parsed rather than matched as text, because a title holding a colon has
    // to come back out as the words that went in however it had to be quoted
    // to survive the trip.
    const parsed = parseScenarioSource(source);
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.problems.join(' | '));
    if (!parsed.ok) return;
    assert.equal(parsed.scenario.title, 'Sea State: a rehearsal');
    // The id still comes off the folder, because that is the name other lines
    // and other folders agree on.
    assert.equal(parsed.scenario.id, 'sea-state');
  });

  test('a title full of punctuation still writes a file that loads', async () => {
    // The bug this is here for: `title: ${x}` written straight into the
    // template, and a title with a colon in it writing a scenario the picker
    // offers and the editor refuses to open.
    for (const [name, title] of [
      ['colon-show', 'Ethics: in practice'],
      ['hash-show', '#1 in the series'],
      ['quote-show', 'The "Sentinel" problem'],
      ['dash-show', '- a leading dash'],
    ]) {
      const response = await post('/api/projects', { name, title });
      assert.equal(response.status, 200, `${title} was refused`);
      const parsed = parseScenarioSource(
        readFileSync(join(workspace, name!, 'scenario.yaml'), 'utf8'),
      );
      assert.equal(parsed.ok, true, `${title} wrote a file that will not load`);
      if (parsed.ok) assert.equal(parsed.scenario.title, title);
    }
  });

  test('a body still wins when there is one, so the walkthrough is unchanged', async () => {
    const pasted = 'id: pasted\ntitle: Pasted\nstart: only\nnodes:\n  - id: only\n    type: end\n';
    const response = await post('/api/projects', { name: 'pasted-show', scenario: pasted });
    assert.equal(response.status, 200);
    assert.equal(readFileSync(join(workspace, 'pasted-show', 'scenario.yaml'), 'utf8'), pasted);
  });

  test('a name that is a path is refused before anything is written', async () => {
    for (const name of ['../escape', 'a/b', '..', '.hidden', 'x']) {
      assert.equal((await post('/api/projects', { name })).status, 400, `"${name}" was accepted`);
    }
  });
});

describe('opening the folder', () => {
  test('a project name gives that project, and nothing gives the workspace', async () => {
    mkdirSync(join(workspace, 'has-a-folder'), { recursive: true });
    assert.equal(await revealTarget('has-a-folder'), resolve(workspace, 'has-a-folder'));
    // Pressing it with nothing open is not a no-op: "where is this" has an
    // answer whether or not a project is selected.
    assert.equal(await revealTarget(), resolve(workspace));
    assert.equal(await revealTarget(''), resolve(workspace));
  });

  test('a name cannot name a folder outside the workspace', async () => {
    // The board sends a name and the server makes the path. This is the reason
    // it is done that way round.
    for (const name of ['..', '../..', join('..', 'elsewhere')]) {
      await assert.rejects(() => revealTarget(name), /inside the workspace|not there/, name);
    }
  });

  test('a folder that has been deleted under us says so, with the path', async () => {
    await assert.rejects(() => revealTarget('never-existed'), /is not there any more/);
  });

  test('the route refuses the same names, and refuses them before it spawns', async () => {
    const response = await post('/api/reveal', { project: '../escape' });
    assert.equal(response.status, 400);
    const { error } = (await response.json()) as { error: string };
    assert.match(error, /workspace|not there/);
  });

  test('every platform has an opener, and none of them is a guess', () => {
    assert.equal(openerFor('win32'), 'explorer.exe');
    assert.equal(openerFor('darwin'), 'open');
    assert.equal(openerFor('linux'), 'xdg-open');
    assert.equal(openerFor('freebsd'), 'xdg-open', 'the fallback is the freedesktop one');
  });

  test('nothing here runs through a shell', () => {
    // The property with no observable behaviour until the day somebody has a
    // project folder called `Q3 & review`, at which point a shell would run
    // `review` as a command. A folder name is not ours to control — it is
    // whatever is already on the author's disk — so the argv array is the
    // whole defence and it has to stay.
    const source = readFileSync(join(ROOT, 'client', 'app', 'reveal.ts'), 'utf8');
    assert.ok(source.includes('spawn(opener, [dir]'), 'the spawn is no longer an argv array');
    assert.ok(!/shell\s*:/.test(source), 'reveal.ts mentions a shell option');
    assert.ok(!source.includes('exec('), 'exec runs a command line, which is the thing to avoid');
  });
});

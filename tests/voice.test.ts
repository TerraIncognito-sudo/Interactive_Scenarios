/**
 * The voice pathway: a cast, a model, and one clip at a time.
 *
 * What is guarded here is the part that fails quietly. A character's reference
 * clip is not a property of any one line, so it would be easy to leave out of
 * the recipe — and then re-recording a voice would leave ninety clips of the
 * old one looking finished. A take that steals the selection would undo a
 * choice somebody made by listening. Neither announces itself.
 *
 * The generator process itself is not exercised: it needs Python, a GPU and in
 * one case several gigabytes of weights, none of which belong in a test run.
 * Everything up to the moment of handing off is, including every refusal —
 * which is most of what an author actually meets.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScenarioSchema } from '../src/scenario/schema.ts';
import {
  ProjectSchema,
  recipeHash,
  resolveRecipe,
  pathsOf,
  EMPTY_LEDGER,
} from '../tools/editor/project.ts';
import { generateAsset, publishAsset, GenerateError } from '../tools/editor/generate.ts';
import { modelById, modelsFor, modelStatus } from '../tools/editor/models.ts';
import { buildOverview } from '../tools/editor/sections.ts';

const SCENARIO = ScenarioSchema.parse({
  id: 'demo',
  title: 'Demo',
  start: 'a',
  characters: { narr: { name: 'Narrator' }, tran: { name: 'Petty Officer Tran' } },
  scenes: { room: { background: 'room.jpg' } },
  nodes: [
    {
      id: 'a',
      type: 'dialogue',
      scene: 'room',
      lines: [
        { who: 'narr', text: 'Zero four hundred.', hold: 3, voice: 'narr-a-01.mp3' },
        { who: 'tran', text: 'Link is good.', hold: 2, voice: 'tran-a-01.mp3' },
      ],
      next: 'z',
    },
    { id: 'z', type: 'end', text: 'Done' },
  ],
});

function project(overrides: Record<string, unknown> = {}) {
  return ProjectSchema.parse({
    project: 'demo',
    scenario: 'scenario.yaml',
    publish: 'assets',
    generated: 'generated',
    sections: { voice: { backend: 'sidecar', file: 'placeholder' } },
    voices: {},
    assets: {
      'narr-a-01.mp3': { text: 'Zero four hundred.', voice: 'narr', source: { node: 'a', line: 0 } },
      'tran-a-01.mp3': { text: 'Link is good.', voice: 'tran', source: { node: 'a', line: 1 } },
    },
    ...overrides,
  });
}

describe('a voice belongs to a character, not to a line', () => {
  test('the reference clip is part of every line that character speaks', () => {
    const silent = project();
    const cast = project({ voices: { tran: { reference: 'voices/tran.wav' } } });

    // Tran's line changes; the narrator's does not. That is the whole point of
    // hanging a voice off the cast rather than off ninety rows.
    const before = recipeHash(resolveRecipe(silent, 'voice', 'tran-a-01.mp3'));
    const after = recipeHash(resolveRecipe(cast, 'voice', 'tran-a-01.mp3'));
    assert.notEqual(before, after);

    assert.equal(
      recipeHash(resolveRecipe(silent, 'voice', 'narr-a-01.mp3')),
      recipeHash(resolveRecipe(cast, 'voice', 'narr-a-01.mp3')),
    );
  });

  test('direction counts as part of the recipe too', () => {
    const plain = project({ voices: { tran: { reference: 'voices/tran.wav' } } });
    const directed = project({
      voices: { tran: { reference: 'voices/tran.wav', direction: 'tired, precise' } },
    });
    assert.notEqual(
      recipeHash(resolveRecipe(plain, 'voice', 'tran-a-01.mp3')),
      recipeHash(resolveRecipe(directed, 'voice', 'tran-a-01.mp3')),
    );
  });

  test('a voice setting is overridden by the line, and overrides the section', () => {
    const layered = project({
      sections: { voice: { backend: 'sidecar', file: 'placeholder', defaults: { temperature: 0.1 } } },
      voices: { tran: { params: { temperature: 0.5, exaggeration: 0.9 } } },
      assets: {
        'tran-a-01.mp3': { text: 'Link is good.', voice: 'tran', params: { temperature: 0.9 } },
      },
    });
    const recipe = resolveRecipe(layered, 'voice', 'tran-a-01.mp3');
    // Widest first: the section is how this kind of asset is made, the voice is
    // how this character sounds, the row is this one clip.
    assert.equal(recipe.params.temperature, 0.9);
    assert.equal(recipe.params.exaggeration, 0.9);
  });
});

describe('what generation refuses to do', () => {
  const base = (overrides: Record<string, unknown> = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'is-voice-'));
    const paths = pathsOf(join(root, 'project.yaml'), project(overrides));
    return {
      root,
      args: {
        scenario: SCENARIO,
        project: project(overrides),
        paths,
        ledger: structuredClone(EMPTY_LEDGER),
        section: 'voice' as const,
        file: 'tran-a-01.mp3',
        modelsRoot: root,
      },
    };
  };

  const failsWith = async (pattern: RegExp, overrides?: Record<string, unknown>) => {
    const { root, args } = base(overrides);
    try {
      await assert.rejects(() => generateAsset(args), (err: Error) => {
        assert.ok(err instanceof GenerateError, err.message);
        assert.match(err.message, pattern);
        return true;
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  test('a section with no generator says so instead of failing obscurely', async () => {
    await failsWith(/no generator/i, { sections: { voice: { backend: 'manual' } } });
  });

  test('a line with no text is refused before a model is ever loaded', async () => {
    await failsWith(/no text to say/i, {
      assets: { 'tran-a-01.mp3': { voice: 'tran' } },
    });
  });

  test('a line that names no character is refused', async () => {
    await failsWith(/which character speaks/i, {
      assets: { 'tran-a-01.mp3': { text: 'Link is good.' } },
    });
  });

  test('a cloning model with nothing to clone is refused, not silently defaulted', async () => {
    // The failure this prevents: chatterbox with no reference reads the line in
    // its own default voice, does it for every character, and the whole cast
    // comes back sounding like one person after ninety generations.
    await failsWith(/reference clip/i, {
      sections: { voice: { backend: 'sidecar', file: 'chatterbox' } },
    });
  });

  test('a section that is not voice is refused, rather than half-attempted', async () => {
    const { root, args } = base();
    try {
      await assert.rejects(
        () => generateAsset({ ...args, section: 'images', file: 'room.jpg' }),
        /made by hand/i,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('publishing', () => {
  test('copies the selected take to the name the scenario asks for', async () => {
    const root = mkdtempSync(join(tmpdir(), 'is-voice-'));
    try {
      const paths = pathsOf(join(root, 'project.yaml'), project());
      const takes = join(paths.generated, 'voice', 'tran-a-01.mp3');
      mkdirSync(takes, { recursive: true });
      writeFileSync(join(takes, 'abc123-01.mp3'), 'take one');
      writeFileSync(join(takes, 'abc123-02.mp3'), 'take two');

      const ledger = structuredClone(EMPTY_LEDGER);
      ledger.assets['tran-a-01.mp3'] = {
        selected: 'abc123-02.mp3',
        takes: [
          { id: 'abc123-01.mp3', hash: 'abc123', at: '', params: {} },
          { id: 'abc123-02.mp3', hash: 'abc123', at: '', params: {} },
        ],
      };

      await publishAsset({ paths, ledger, section: 'voice', file: 'tran-a-01.mp3' });

      // The chosen one, under the canonical name — and the takes folder is
      // untouched, because it is the record of what was tried.
      assert.equal(readFileSync(join(paths.publish, 'tran-a-01.mp3'), 'utf8'), 'take two');
      assert.equal(readFileSync(join(takes, 'abc123-02.mp3'), 'utf8'), 'take two');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('publishing nothing is an error with a reason', async () => {
    const root = mkdtempSync(join(tmpdir(), 'is-voice-'));
    try {
      const paths = pathsOf(join(root, 'project.yaml'), project());
      await assert.rejects(
        () =>
          publishAsset({
            paths,
            ledger: structuredClone(EMPTY_LEDGER),
            section: 'voice',
            file: 'tran-a-01.mp3',
          }),
        /Nothing is selected/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the model registry', () => {
  test('the placeholder needs no download, so the pathway works before one', async () => {
    const spec = modelById('placeholder')!;
    const status = await modelStatus(undefined, spec);
    // Not a convenience: it is what lets the wiring be proved separately from
    // the model, which is the difference between a five-minute fix and an
    // evening when a real generate fails.
    assert.equal(status.installed, true);
  });

  test('a model with weights is not installed until they are on disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'is-models-'));
    try {
      const spec = modelById('chatterbox')!;
      assert.equal((await modelStatus(root, spec)).installed, false);

      mkdirSync(join(root, spec.folder!), { recursive: true });
      // An empty folder is not an install — a cancelled download leaves one.
      assert.equal((await modelStatus(root, spec)).installed, false);

      writeFileSync(join(root, spec.folder!, 'weights.safetensors'), 'x');
      assert.equal((await modelStatus(root, spec)).installed, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('every voice model the picker offers is one the sidecar can load', () => {
    // The registry is a fixed list rather than a scan of a folder precisely so
    // this holds: a generator is weights plus an adapter, and offering a model
    // with no adapter is offering a button that cannot work.
    const adapters = new Set(['placeholder', 'chatterbox']);
    for (const model of modelsFor('voice')) {
      assert.ok(adapters.has(model.id), 'no adapter for ' + model.id);
    }
  });
});

describe('the cast', () => {
  test('is who speaks, with the state of each voice', async () => {
    const root = mkdtempSync(join(tmpdir(), 'is-cast-'));
    try {
      mkdirSync(join(root, 'voices'), { recursive: true });
      writeFileSync(join(root, 'voices', 'tran.wav'), 'not really audio');

      const withVoices = project({
        voices: {
          tran: { reference: 'voices/tran.wav' },
          narr: { reference: 'voices/missing.wav' },
        },
      });
      const paths = pathsOf(join(root, 'project.yaml'), withVoices);
      const overview = await buildOverview(
        SCENARIO,
        withVoices,
        structuredClone(EMPTY_LEDGER),
        paths,
      );

      const cast = new Map(overview.cast.map((member) => [member.id, member]));
      assert.deepEqual([...cast.keys()].sort(), ['narr', 'tran']);
      assert.equal(cast.get('tran')!.name, 'Petty Officer Tran');
      assert.equal(cast.get('tran')!.lines, 1);
      assert.equal(cast.get('tran')!.referenceExists, true);

      // A reference that is not there is worse than none: it looks configured.
      assert.equal(cast.get('narr')!.referenceExists, false);
      assert.ok(
        overview.problems.some((problem) => /reference clip that is not there/.test(problem.message)),
        JSON.stringify(overview.problems),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

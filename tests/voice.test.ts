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
import { ScenarioSchema } from '../shared/scenario/schema.ts';
import {
  ProjectSchema,
  recipeHash,
  resolveRecipe,
  pathsOf,
  EMPTY_LEDGER,
} from '../client/app/project.ts';
import {
  generateAsset,
  publishAsset,
  referenceTextFor,
  GenerateError,
} from '../client/app/generate.ts';
import { modelById, modelsFor, modelStatus } from '../client/app/models.ts';
import { isConsoleNoise } from '../client/app/sidecar.ts';
import { buildOverview } from '../client/app/sections.ts';

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
  test('the chosen preset is part of the recipe too', () => {
    // Same argument as the reference clip: swapping a character's voice has to
    // make every line they speak stale, or the board calls clips finished that
    // were made by a voice no longer in the file.
    const before = project({ voices: { tran: { preset: 'am_michael' } } });
    const after = project({ voices: { tran: { preset: 'bm_george' } } });
    assert.notEqual(
      recipeHash(resolveRecipe(before, 'voice', 'tran-a-01.mp3')),
      recipeHash(resolveRecipe(after, 'voice', 'tran-a-01.mp3')),
    );
  });

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

  test('a palette model with no voice chosen is refused for the same reason', async () => {
    // The mirror image, and the same silent failure: kokoro without a preset
    // falls back to one default voice for the whole cast.
    await failsWith(/No voice chosen/i, {
      sections: { voice: { backend: 'sidecar', file: 'kokoro' } },
      voices: { tran: { reference: 'voices/tran.wav' } },
    });
  });

  test('a preset satisfies a palette model, and a clip satisfies a cloning one', () => {
    // Neither field is required in general — what is required is the one the
    // chosen model can actually use.
    const withPreset = project({ voices: { tran: { preset: 'am_michael' } } });
    assert.equal(resolveRecipe(withPreset, 'voice', 'tran-a-01.mp3').preset, 'am_michael');

    const withClip = project({ voices: { tran: { reference: 'voices/tran.wav' } } });
    assert.equal(resolveRecipe(withClip, 'voice', 'tran-a-01.mp3').reference, 'voices/tran.wav');
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

describe('making a reference clip when you have no recordings', () => {
  const talkative = ScenarioSchema.parse({
    id: 'demo',
    title: 'Demo',
    start: 'a',
    characters: { narr: { name: 'Narrator' }, tran: { name: 'Tran' } },
    scenes: { room: { background: 'room.jpg' } },
    nodes: [
      {
        id: 'a',
        type: 'dialogue',
        scene: 'room',
        lines: [
          { who: 'tran', text: 'Link is good.' },
          { who: 'narr', text: 'Eleven days north, through the Labrador Sea and the Davis Strait.' },
          { who: 'tran', text: 'Two-second round trip, sometimes four when the satellite is low.' },
          { who: 'narr', text: 'Two seconds is a long time in a fight.' },
          {
            who: 'tran',
            text: 'Autonomy stack is green, navigation is nominal, and collision-avoidance has the ice at four hundred metres.',
          },
          { who: 'tran', text: 'This line is past the minimum and should not be reached.' },
        ],
        next: 'z',
      },
      { id: 'z', type: 'end', text: 'Done' },
    ],
  });

  test('a reference is the character own lines, in order', () => {
    const text = referenceTextFor(talkative, 'tran')!;
    // Their words, not a pangram: a reference is copied in register as much as
    // in timbre, and a voice sampled reading filler comes back as filler.
    assert.match(text, /^Link is good\./);
    assert.match(text, /Two-second round trip/);
    assert.ok(!text.includes('Two seconds is a long time'), 'took another character line');
  });

  test('it stops once there is enough to clone from', () => {
    const text = referenceTextFor(talkative, 'tran')!;
    const words = text.split(/\s+/).length;
    assert.ok(words >= 25, `only ${words} words`);
    // And does not run on: everything they ever say would be a minute of audio
    // to characterise a voice that needs fifteen seconds.
    assert.ok(!text.includes('should not be reached'), 'kept going past the minimum');
  });

  test('a character who never speaks has nothing to record', () => {
    assert.equal(referenceTextFor(talkative, 'nobody'), undefined);
  });

  test('a character with only a line or two still gets one', () => {
    const terse = ScenarioSchema.parse({
      id: 'x',
      title: 'X',
      start: 'a',
      characters: { rus: { name: 'Russian officer' } },
      scenes: {},
      nodes: [
        {
          id: 'a',
          type: 'dialogue',
          lines: [{ who: 'rus', text: 'Canadian vessel, you are standing into danger.' }],
          next: 'z',
        },
        { id: 'z', type: 'end', text: 'Done' },
      ],
    });
    // Below the minimum the clone is poorer, but a poor clone an author can
    // hear beats a refusal they cannot do anything about.
    assert.match(referenceTextFor(terse, 'rus')!, /standing into danger/);
  });
});

/**
 * What the editor's terminal shows while a model loads.
 *
 * The failure this guards is not a crash. A model's dependency tree prints a
 * paragraph of somebody else's deprecation notices on every load, and an author
 * who reads a screen ending in a warning concludes their clip failed — while a
 * filter tuned one notch too wide throws away the traceback that was the whole
 * reason to look.
 */
describe('the noise between a model and a traceback', () => {
  const real = [
    'loading weights from Hugging Face (cache: C:\\ML Models\\huggingface)',
    'loaded PerthNet (Implicit) at step 250,000',
    'Traceback (most recent call last):',
    '  File "C:\\voice\\server.py", line 98, in main',
    '    backend = load(args.backend)',
    'RuntimeError: CUDA error: no kernel image is available for execution on the device',
  ];

  test('a traceback survives in full, source lines included', () => {
    // Indented source lines look exactly like the line Python prints under a
    // warning. Suppressing them by shape would delete the middle of every
    // traceback — and a traceback missing its middle is how a two-minute fix
    // becomes an evening.
    let afterWarning = false;
    const shown = real.filter((line) => {
      const noise = isConsoleNoise(line, afterWarning);
      afterWarning = noise;
      return !noise;
    });
    assert.deepEqual(shown, real);
  });

  test('a library deprecation notice and its source line both go', () => {
    const noisy = [
      'C:\\voice-env\\Lib\\site-packages\\perth\\__init__.py:1: UserWarning: pkg_resources is deprecated',
      '  from pkg_resources import resource_filename',
      'loaded PerthNet (Implicit) at step 250,000',
    ];
    let afterWarning = false;
    const shown = noisy.filter((line) => {
      const noise = isConsoleNoise(line, afterWarning);
      afterWarning = noise;
      return !noise;
    });
    // The warning, and the source line printed under it. What is left is the
    // one line that says something happened.
    assert.deepEqual(shown, ['loaded PerthNet (Implicit) at step 250,000']);
  });

  test('the two notices that do not announce themselves as warnings', () => {
    // Neither carries Python's `file:line: SomeWarning:` prefix — one is
    // huggingface_hub writing straight to stderr, the other transformers'
    // logger — so neither is caught by shape, and both appear on every load.
    assert.equal(
      isConsoleNoise('Warning: You are sending unauthenticated requests to the HF Hub.', false),
      true,
    );
    assert.equal(
      isConsoleNoise('\`sdpa\` attention does not support \`output_attentions=True\`.', false),
      true,
    );
  });

  test('the one chatterbox repeats once per clip', () => {
    // A mel spectrogram is framed at twice the token rate, so the two line up
    // only when the reference clip's length lands exactly on a frame boundary.
    // A recording of somebody talking never does. The model trims a frame and
    // carries on — and says so ninety times during a run of ninety lines.
    assert.equal(
      isConsoleNoise(
        'WARNING:root:Reference mel length is not equal to 2 * reference token length.',
        false,
      ),
      true,
    );
  });

  test('an ordinary line after a swallowed warning still shows', () => {
    // Only *indented* lines belong to the warning above them. A flush-left line
    // has moved on to something else, and that something else may be the error.
    assert.equal(isConsoleNoise('RuntimeError: out of memory', true), false);
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

describe('downloading a model', () => {
  test('a model that fetches its own weights offers nothing to download', async () => {
    const { downloadModel } = await import('../client/app/download.ts');
    // chatterbox pulls from Hugging Face on first load. Offering a Download
    // button for it would be a button that cannot do anything.
    await assert.rejects(() => downloadModel('chatterbox', '/tmp', undefined), /fetches its own/i);
  });

  test('downloading without a models folder says so rather than guessing', async () => {
    const { downloadModel } = await import('../client/app/download.ts');
    await assert.rejects(() => downloadModel('kokoro', undefined, undefined), /No models folder/i);
  });

  test('every downloadable file has a name, a URL and a size', () => {
    for (const model of modelsFor('voice')) {
      for (const file of model.files ?? []) {
        assert.match(file.url, /^https:\/\//, model.id);
        // The size is what tells an interrupted download from a finished one,
        // and what stops someone starting a 300 MB fetch unawares.
        assert.ok(file.mb > 0, `${model.id}/${file.name} has no size`);
        assert.ok(file.name.length > 0);
      }
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

  test('a palette model offers voices, a cloning model does not', () => {
    const kokoro = modelById('kokoro')!;
    const chatterbox = modelById('chatterbox')!;

    // A model without cloning has to say which voices it has, or there is no
    // way to cast it. One that clones takes its voice from the recording.
    assert.equal(kokoro.clones, false);
    assert.ok((kokoro.voices ?? []).length > 10);
    assert.equal(chatterbox.clones, true);
    assert.equal(chatterbox.voices, undefined);
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
    const adapters = new Set(['placeholder', 'kokoro', 'chatterbox']);
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

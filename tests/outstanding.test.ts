/**
 * The list that has to reach zero.
 *
 * The command centre makes one promise — when it is empty the show is ready —
 * and that promise is only as good as its coverage. So the tests here are
 * mostly about the two ways it could lie: a thing that should appear and does
 * not, and a thing that appears twice and makes the total meaningless.
 *
 * `republish` is the one worth reading twice. `ready` has always meant "the
 * selected take matches the recipe", which says nothing about whether anyone
 * ever copied it to the name the player opens — so a project could be entirely
 * green while the audience heard the previous reading of every re-recorded
 * line. Nothing on the board could see it, because nothing recorded what had
 * been published.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { outstandingOf, OUTSTANDING_GROUPS } from '../client/app/outstanding.ts';
import type { AssetView, Overview, SectionView } from '../client/app/sections.ts';

function asset(over: Partial<AssetView> & Pick<AssetView, 'file' | 'status'>): AssetView {
  return {
    section: 'voice',
    hash: 'aaaa',
    frozen: false,
    hasPrompt: true,
    row: { refs: [], params: {}, freeze: false } as AssetView['row'],
    origins: [],
    takes: [],
    published: true,
    notes: [],
    ...over,
  } as AssetView;
}

/** A voice section with a model picked, which is what a set-up project has. */
const SIDECAR = { backend: 'sidecar', defaults: {} } as SectionView['model'];

/**
 * A section with no model picked — which every section of a brand new project
 * is, because `createProject` scaffolds them all that way.
 *
 * Load-bearing in the voice tests below. The backend is the author's setting
 * and says nothing about whether a generator for that kind of file exists, and
 * confusing the two put a new show's ninety voice clips under "nothing here
 * can make them" with the one button that could have made them taken away.
 */
const MANUAL = { backend: 'manual', defaults: {} } as SectionView['model'];

function sectionOf(
  section: SectionView['section'],
  assets: AssetView[],
  model: SectionView['model'],
): SectionView {
  return {
    section,
    model,
    assets,
    counts: { missing: 0, unselected: 0, unmanaged: 0, stale: 0, ready: 0 },
  };
}

function withSections(sections: SectionView[], over: Partial<Overview> = {}): Overview {
  return {
    sections,
    cast: [],
    orphans: [],
    strays: [],
    counts: { missing: 0, unselected: 0, unmanaged: 0, stale: 0, ready: 0 },
    problems: [],
    ...over,
  };
}

function overview(assets: AssetView[], over: Partial<Overview> = {}): Overview {
  const section: SectionView = {
    section: 'voice',
    model: SIDECAR,
    assets,
    counts: { missing: 0, unselected: 0, unmanaged: 0, stale: 0, ready: 0 },
  };
  return {
    sections: [section],
    cast: [],
    orphans: [],
    strays: [],
    counts: { missing: 0, unselected: 0, unmanaged: 0, stale: 0, ready: 0 },
    problems: [],
    ...over,
  };
}

const groupsOf = (result: ReturnType<typeof outstandingOf>) =>
  Object.fromEntries(result.groups.map((group) => [group.group, group.items.length]));

describe('a finished project', () => {
  test('has nothing left in it', async () => {
    const result = outstandingOf(
      overview([
        asset({ file: 'voice/a.mp3', status: 'ready', selected: 't1', publishedTake: 't1' }),
        asset({ file: 'voice/b.mp3', status: 'ready', selected: 't2', publishedTake: 't2' }),
      ]),
    );
    assert.deepEqual(result.groups, []);
    assert.equal(result.total, 0);
  });

  test('a frozen asset counts as finished, because freezing is the point', async () => {
    const result = outstandingOf(
      overview([
        asset({
          file: 'voice/a.mp3',
          status: 'ready',
          frozen: true,
          selected: 't1',
          publishedTake: 't1',
        }),
      ]),
    );
    assert.equal(result.total, 0);
  });
});

describe('every unfinished asset appears exactly once', () => {
  test('the pipeline stages do not double-count', async () => {
    // A file that was never made is not also waiting to be published. Listing
    // it in both would make the total useless as a measure of what is left.
    const result = outstandingOf(
      overview([
        asset({ file: 'voice/missing.mp3', status: 'missing', published: false }),
        asset({ file: 'voice/pick.mp3', status: 'unselected', published: false, takes: [
          { id: 't1', hash: 'x', at: '', params: {} },
          { id: 't2', hash: 'x', at: '', params: {} },
        ] }),
        asset({ file: 'voice/stale.mp3', status: 'stale', selected: 't1', publishedTake: 't1' }),
        asset({ file: 'voice/hand.mp3', status: 'unmanaged' }),
        asset({ file: 'voice/unshipped.mp3', status: 'ready', selected: 't1', published: false }),
        asset({
          file: 'voice/older.mp3',
          status: 'ready',
          selected: 't2',
          publishedTake: 't1',
          republish: true,
        }),
      ]),
    );

    assert.deepEqual(groupsOf(result), {
      missing: 1,
      unselected: 1,
      stale: 1,
      republish: 1,
      publish: 1,
      unmanaged: 1,
    });
    assert.equal(result.total, 6, 'six assets, six items');
  });

  test('the ordering is the order the work has to happen in', async () => {
    const result = outstandingOf(
      overview([
        asset({ file: 'voice/unshipped.mp3', status: 'ready', selected: 't1', published: false }),
        asset({ file: 'voice/missing.mp3', status: 'missing', published: false }),
      ]),
    );
    assert.deepEqual(
      result.groups.map((group) => group.group),
      ['missing', 'publish'],
      'you cannot publish a file that was never made',
    );
  });
});

describe('a clip that was regenerated but never chosen', () => {
  test('asks to be selected, not generated again', async () => {
    // The failure this exists for. Generating never steals a selection, which
    // is what keeps re-rolling free — but it left the asset reporting `stale`
    // with the answer already sitting in its own takes folder, under a heading
    // whose button made a third take of a line that already had the right one.
    const result = outstandingOf(
      overview([
        asset({
          file: 'voice/narr-a2-02.mp3',
          status: 'stale',
          hash: 'ee5ba907870c86dc',
          selected: '01ba494b923beda5-01.mp3',
          matchingTake: 'ee5ba907870c86dc-01.mp3',
        }),
      ]),
    );

    assert.deepEqual(groupsOf(result), { reselect: 1 }, 'not stale');
    const group = result.groups[0]!;
    assert.equal(group.action, 'use-newest');
    assert.match(group.items[0]!.detail!, /ee5ba907870c86dc-01\.mp3 matches the recipe/);
  });

  test('one with no matching take is still simply stale', async () => {
    const result = outstandingOf(
      overview([asset({ file: 'voice/old.mp3', status: 'stale' })]),
    );
    assert.deepEqual(groupsOf(result), { stale: 1 });
    assert.equal(result.groups[0]!.action, 'generate');
  });

  test('choosing it moves it to the publish bin, which is the next thing to do', async () => {
    // What the author should see after pressing the button: the work moves one
    // stage down the list rather than disappearing.
    const chosen = outstandingOf(
      overview([
        asset({
          file: 'voice/narr-a2-02.mp3',
          status: 'ready',
          selected: 'ee5ba907870c86dc-01.mp3',
          publishedTake: '01ba494b923beda5-01.mp3',
          republish: true,
        }),
      ]),
    );
    assert.deepEqual(groupsOf(chosen), { republish: 1 });
  });
});

describe('a beat that does not match its clip', () => {
  const clip = (over: Partial<AssetView>) =>
    asset({
      file: 'voice/a.mp3',
      status: 'ready',
      selected: 't1',
      publishedTake: 't1',
      ...over,
    } as Partial<AssetView> & Pick<AssetView, 'file' | 'status'>);

  test('is its own group, with the number it should be', async () => {
    const result = outstandingOf(
      overview([clip({ seconds: 4.2, hold: 4, gap: 1, targetHold: 5.2 })]),
    );
    assert.deepEqual(groupsOf(result), { timing: 1 });
    const group = result.groups[0]!;
    assert.equal(group.action, 'retime');
    assert.equal(group.level, 'error');
    // The client draws the sum from these rather than looking the row up
    // again, so they have to travel with the item.
    assert.deepEqual(
      { seconds: group.items[0]!.seconds, hold: group.items[0]!.hold, gap: group.items[0]!.gap, target: group.items[0]!.target },
      { seconds: 4.2, hold: 4, gap: 1, target: 5.2 },
    );
  });

  test('says so plainly when the clip is being cut off', async () => {
    const result = outstandingOf(
      overview([clip({ seconds: 7.4, hold: 6, gap: 1, targetHold: 8.4 })]),
    );
    assert.match(result.groups[0]!.items[0]!.detail!, /cutting it off — should be 8.4s/);
  });

  test('a beat that is merely long is still wrong, because exactly is the rule', async () => {
    // The point of the whole group: a hold of 9 on a 4.2s clip is not 'safe',
    // it is four and a half seconds of dead air in front of a room.
    const result = outstandingOf(
      overview([clip({ seconds: 4.2, hold: 9, gap: 1, targetHold: 5.2 })]),
    );
    assert.deepEqual(groupsOf(result), { timing: 1 });
    assert.match(result.groups[0]!.items[0]!.detail!, /holds 9s, should be 5.2s/);
  });

  test('a line with no hold at all names the number to write', async () => {
    const result = outstandingOf(
      overview([clip({ seconds: 3, gap: 1, targetHold: 4 })]),
    );
    assert.match(result.groups[0]!.items[0]!.detail!, /no hold — should be 4s/);
  });

  test('a custom gap moves the target, and nothing else', async () => {
    const result = outstandingOf(
      overview([clip({ seconds: 4.2, hold: 6.7, gap: 2.5, targetHold: 6.7, timed: true })]),
    );
    assert.equal(result.total, 0, 'two and a half seconds is a choice, not a fault');
  });

  test('a matching beat is silent', async () => {
    const result = outstandingOf(
      overview([clip({ seconds: 4.2, hold: 5.2, gap: 1, targetHold: 5.2, timed: true })]),
    );
    assert.equal(result.total, 0);
  });

  test('a clip nobody could measure is never flagged', async () => {
    // Sending somebody to re-cut a line that was already right is worse than
    // not telling them.
    const result = outstandingOf(overview([clip({ hold: 4 })]));
    assert.equal(result.total, 0);
  });

  test('timing is additive: a shipped clip can still be mistimed', async () => {
    const result = outstandingOf(
      overview([
        clip({ file: 'voice/b.mp3', status: 'missing', published: false, seconds: 3, gap: 1, targetHold: 4 }),
      ]),
    );
    assert.deepEqual(groupsOf(result), { missing: 1, timing: 1 }, 'both, and they are different jobs');
  });
});
describe('a take chosen after the last publish', () => {
  test('is called out, because the room would still hear the old one', async () => {
    const result = outstandingOf(
      overview([
        asset({
          file: 'voice/beau-a4-01.mp3',
          status: 'ready',
          selected: 't3',
          publishedTake: 't1',
          republish: true,
        }),
      ]),
    );
    const group = result.groups.find((entry) => entry.group === 'republish')!;
    assert.equal(group.level, 'error');
    assert.equal(group.action, 'publish');
    assert.match(group.items[0]!.detail!, /published t1, selected t3/);
  });
});

describe('quality is additive', () => {
  test('a clip can be finished, shipped, and still the wrong shape', async () => {
    const result = outstandingOf(
      overview([
        asset({
          file: 'images/a1.jpg',
          section: 'images',
          status: 'ready',
          selected: 't1',
          publishedTake: 't1',
          size: { declared: '1920x1080', actual: '1024x1024', mismatched: true },
        }),
      ]),
    );
    assert.deepEqual(groupsOf(result), { quality: 1 });
    assert.match(result.groups[0]!.items[0]!.detail!, /1024x1024 but the row asks for 1920x1080/);
  });

  test('a voiced line with no hold reaches the list through its row note', async () => {
    const result = outstandingOf(
      overview([
        asset({
          file: 'voice/a.mp3',
          status: 'ready',
          selected: 't1',
          publishedTake: 't1',
          notes: ['a line 1 has no hold — the beat will end on a reading-speed estimate'],
        }),
      ]),
    );
    assert.equal(result.total, 1);
    assert.match(result.groups[0]!.items[0]!.detail!, /has no hold/);
  });
});

describe('parts and orphans', () => {
  test('a character with lines and no reference clip is an error', async () => {
    const result = outstandingOf(
      overview([], {
        cast: [
          { id: 'beau', name: 'LCdr Beaudoin', lines: 14, ready: 0, referenceExists: false },
          { id: 'silent', name: 'Extra', lines: 0, ready: 0, referenceExists: false },
        ],
      }),
    );
    assert.deepEqual(groupsOf(result), { cast: 1 });
    assert.equal(result.groups[0]!.items[0]!.character, 'beau');
    assert.match(result.groups[0]!.items[0]!.detail!, /14 lines and no reference clip/);
  });

  test('a reference clip that is not on disk says so differently', async () => {
    const result = outstandingOf(
      overview([], {
        cast: [
          {
            id: 'beau',
            name: 'LCdr Beaudoin',
            lines: 3,
            ready: 0,
            reference: 'voices/beau.wav',
            referenceExists: false,
          },
        ],
      }),
    );
    assert.match(result.groups[0]!.items[0]!.detail!, /not on disk: voices\/beau\.wav/);
  });

  test('orphans are listed with a button that removes them, and never sooner', async () => {
    const result = outstandingOf(overview([], { orphans: ['voice/gone.mp3', 'images/old.jpg'] }));
    const group = result.groups.find((entry) => entry.group === 'orphan')!;
    assert.equal(group.action, 'prune');
    assert.equal(group.level, 'todo', 'not a failure — the show runs fine with a stray recipe');
    assert.equal(group.items.length, 2);
  });
});

describe('the contract', () => {
  test('every declared group has a spec and can be produced', async () => {
    // A group in the list with no way to reach it is a promise the tab cannot
    // keep; one produced with no spec would render blank.
    const produced = outstandingOf(
      withSections(
        [
          sectionOf('images', [
            // The two groups a section with no generator produces. They exist
            // precisely because the section they are in cannot answer them.
            asset({
              file: 'images/jetty.png',
              section: 'images',
              status: 'missing',
              published: false,
              size: { declared: '1920x1080' },
            }),
            asset({ file: 'images/rook.png', section: 'images', status: 'stale' }),
          ], MANUAL),
          sectionOf('voice', [
          asset({ file: 'voice/missing.mp3', status: 'missing', published: false }),
          asset({ file: 'voice/pick.mp3', status: 'unselected', published: false }),
          asset({ file: 'voice/stale.mp3', status: 'stale' }),
          asset({ file: 'voice/rerolled.mp3', status: 'stale', matchingTake: 'aaaa-02.mp3' }),
          asset({ file: 'voice/hand.mp3', status: 'unmanaged' }),
          asset({ file: 'voice/unshipped.mp3', status: 'ready', selected: 't1', published: false }),
          asset({
            file: 'voice/older.mp3',
            status: 'ready',
            selected: 't2',
            publishedTake: 't1',
            republish: true,
          }),
          asset({
            file: 'voice/mistimed.mp3',
            status: 'ready',
            selected: 't1',
            publishedTake: 't1',
            seconds: 4.2,
            hold: 4,
            gap: 1,
            targetHold: 5.2,
          }),
          asset({
            file: 'voice/note.mp3',
            status: 'ready',
            selected: 't1',
            publishedTake: 't1',
            notes: ['something to look at'],
          }),
          asset({
            file: 'images/lying.jpg',
            section: 'images',
            status: 'ready',
            selected: 't1',
            publishedTake: 't1',
            format: { actual: 'PNG', declared: 'jpg', rename: 'images/lying.png' },
          }),
          ], SIDECAR),
        ],
        {
          cast: [{ id: 'beau', name: 'Beau', lines: 2, ready: 0, referenceExists: false }],
          orphans: ['voice/gone.mp3'],
          strays: [
            { section: 'voice', file: 'voice/cut.mp3', published: true, takes: 2, bytes: 90_000 },
          ],
        },
      ),
    );

    assert.deepEqual(
      produced.groups.map((group) => group.group),
      [...OUTSTANDING_GROUPS],
      'every one of them, in declaration order',
    );
    for (const group of produced.groups) {
      assert.ok(group.label && group.hint, `${group.group} is described`);
      assert.ok(group.level, `${group.group} has a severity`);
    }
  });
});

describe('a section nothing here can generate', () => {
  test('its unmade rows are a separate group with no button on it', async () => {
    // The complaint this answers: "Generate all 9" over nine stills, in a
    // section whose backend is `manual` and whose generator has never existed.
    // Pressing it would fail nine times and make nothing.
    const result = outstandingOf(
      withSections([
        sectionOf('images', [
          asset({ file: 'images/jetty.png', section: 'images', status: 'missing', published: false }),
          asset({ file: 'images/deck.png', section: 'images', status: 'stale' }),
        ], MANUAL),
      ]),
    );

    assert.deepEqual(groupsOf(result), { 'missing-manual': 1, 'stale-manual': 1 });
    for (const group of result.groups) {
      assert.equal(group.action, 'open', `${group.group} offers nothing to press`);
    }
  });

  test('voice keeps its Generate even before a model is picked', async () => {
    // The regression this is here for. A brand new project scaffolds every
    // section on `backend: manual`, including voice — so keying the split on
    // the backend put a hundred and nine voice clips in the hand-made list and
    // removed the only working generator on the board from the one tab that
    // exists to list unfinished work.
    //
    // Whether a generator *exists* is a fact about the kind of file and is
    // permanent. Whether it is *configured* is a separate question the route
    // answers by name, telling you to pick a model — which is a better answer
    // than a hidden button.
    for (const model of [SIDECAR, MANUAL]) {
      const result = outstandingOf(
        withSections([
          sectionOf('voice', [asset({ file: 'voice/a.mp3', status: 'missing', published: false })], model),
        ]),
      );
      assert.deepEqual(groupsOf(result), { missing: 1 }, `backend ${model!.backend}`);
      assert.equal(result.groups[0]!.action, 'generate');
    }
  });

  test('a picture is in the hand-made list whatever the section says', async () => {
    // And the other direction: no backend setting can conjure an image
    // generator, because there has never been one to configure.
    for (const model of [SIDECAR, MANUAL]) {
      const result = outstandingOf(
        withSections([
          sectionOf('images', [asset({ file: 'images/a.png', section: 'images', status: 'missing', published: false })], model),
        ]),
      );
      assert.deepEqual(groupsOf(result), { 'missing-manual': 1 }, `backend ${model!.backend}`);
      assert.equal(result.groups[0]!.action, 'open');
    }
  });

  test('each line says the shape and the format, so the trip out is one trip', async () => {
    const result = outstandingOf(
      withSections([
        sectionOf('images', [
          asset({
            file: 'images/rook.png',
            section: 'images',
            status: 'missing',
            published: false,
            size: { suggested: '832x1216', cutout: true },
          }),
        ], MANUAL),
      ]),
    );
    assert.equal(result.groups[0]!.items[0]!.detail, '832x1216 PNG cutout');
  });

  test('a row with no brief says so, because the copy buttons cannot help it', async () => {
    const result = outstandingOf(
      withSections([
        sectionOf('images', [
          asset({
            file: 'images/jetty.png',
            section: 'images',
            status: 'missing',
            published: false,
            hasPrompt: false,
          }),
        ], MANUAL),
      ]),
    );
    assert.match(result.groups[0]!.items[0]!.detail!, /no brief/);
  });
});

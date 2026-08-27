/**
 * Fetching a show's artwork a few files at a time.
 *
 * The projector prefetches every asset before it reports ready, so the show
 * cannot open on a black screen. It used to start all of them at once and race
 * each against its own twenty-second limit — but a browser opens about six
 * connections to a host, so the other eighty waited in a queue with their
 * clocks already running. At twenty seconds the whole queue timed out
 * together: the counter jumped from about halfway straight to the end and the
 * display said "Ready." while it was still downloading, which is the failure
 * that made a working server look broken.
 *
 * A pool is the fix, and the property that matters is the cap — with it, an
 * item's deadline measures its own download rather than its wait for a turn.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pooled } from '../src/client/shared/pool.ts';

/** Resolves after a turn of the event loop, a few times over. */
function tick(times = 3): Promise<void> {
  let done = Promise.resolve();
  for (let n = 0; n < times; n += 1) done = done.then(() => undefined);
  return done;
}

describe('the prefetch pool', () => {
  test('never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const release: (() => void)[] = [];

    const work = pooled(Array.from({ length: 40 }, (_, n) => n), 6, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => release.push(resolve));
      running -= 1;
    });

    // Let the first wave start, then let them go one at a time so a new one
    // takes each freed slot.
    await tick();
    assert.equal(peak, 6, 'six started, not forty');
    while (release.length > 0) {
      release.shift()!();
      await tick();
    }
    await work;
    assert.equal(peak, 6, 'and it never went above six');
    assert.equal(running, 0);
  });

  test('every item runs, exactly once', async () => {
    const seen: number[] = [];
    await pooled(Array.from({ length: 25 }, (_, n) => n), 4, async (n) => {
      await tick(1);
      seen.push(n);
    });
    assert.equal(seen.length, 25);
    assert.deepEqual([...seen].sort((a, b) => a - b), Array.from({ length: 25 }, (_, n) => n));
  });

  test('a slow item does not hold up the others', async () => {
    // The behaviour a queue of six connections actually needs: one asset
    // stalling must cost one slot, not the whole run.
    const order: string[] = [];
    let releaseSlow = () => {};
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const work = pooled(['slow', 'a', 'b', 'c'], 2, async (name) => {
      if (name === 'slow') await slow;
      order.push(name);
    });

    await tick(6);
    assert.deepEqual(order, ['a', 'b', 'c'], 'the rest finished while it was stuck');
    releaseSlow();
    await work;
    assert.deepEqual(order, ['a', 'b', 'c', 'slow']);
  });

  test('an empty list and a limit of zero are both fine', async () => {
    let ran = 0;
    await pooled([], 6, async () => void (ran += 1));
    assert.equal(ran, 0);

    // Zero would mean no workers and a promise that never settles, which as a
    // hang in front of an audience is worse than being one slower than asked.
    await pooled([1, 2, 3], 0, async () => void (ran += 1));
    assert.equal(ran, 3);
  });

  test('a limit above the item count does not spawn idle workers', async () => {
    let peak = 0;
    let running = 0;
    await pooled([1, 2], 50, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await tick(1);
      running -= 1;
    });
    assert.equal(peak, 2);
  });
});

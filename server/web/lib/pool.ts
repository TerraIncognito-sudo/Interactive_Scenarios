/**
 * Doing a lot of things a few at a time.
 *
 * Written for the projector's prefetch, where doing them all at once was not
 * merely wasteful but actively dishonest. Every asset was started together and
 * raced against its own twenty-second limit; a browser opens about six
 * connections to a host, so the rest sat in a queue with their clocks already
 * running. At twenty seconds the whole queue timed out at once, the counter
 * jumped from about halfway straight to the end, and the display announced
 * itself ready while it was still downloading.
 *
 * A pool fixes the reporting as much as the load: work starts when its turn
 * comes, so a per-item deadline measures the item rather than the wait.
 */
export async function pooled<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  // One shared iterator is what makes the workers cooperate: each takes the
  // next item when it is free, so a slow one never holds up the others' turns.
  const queue = items[Symbol.iterator]();
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (let next = queue.next(); !next.done; next = queue.next()) {
      await work(next.value);
    }
  });
  await Promise.all(workers);
}

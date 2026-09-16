/**
 * A copy, on purpose, and it must stay one.
 *
 * `server/web/lib/` holds the same four files and the phone page imports those.
 * The two halves are in different workspaces behind different bundlers, and
 * they are about to stop talking the same protocol: this side speaks the show
 * protocol to a Room in the operator's own process, and that side will speak
 * the relay protocol to a container holding no scenario at all. Factoring them
 * back together would mean one file trying to be both, which is the shape that
 * makes a change for the phone arrive on the projector unannounced.
 *
 * So the divergence is the design rather than the debt. Neither copy is the
 * original.
 */

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

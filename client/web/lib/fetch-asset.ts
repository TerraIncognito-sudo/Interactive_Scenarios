/**
 * A copy, on purpose, and it must stay one.
 *
 * `server/web/lib/` holds a `connection.ts` and a `base.css`, which the phone
 * page imports instead.
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
 * Prefetching is a download, not a rehearsal.
 *
 * This used to hand each URL to an `Image`, `Audio` or `video` element and wait
 * for `onload`/`canplaythrough`. Both halves of that were wrong in the same way,
 * and only over a real network — which is why it survived every local run.
 *
 * `canplaythrough` is not "arrived", it is the browser's *estimate* that it
 * could play to the end at the current rate. Measured against this show it fired
 * on a 12.6-second clip with 1.6 seconds buffered, about 6% of a 29 MB file. The
 * pool then freed its slot and moved on while the element went on pulling the
 * other 94% in the background, holding a connection nothing was counting. By the
 * end of a 64-asset scenario some fifty elements were streaming at once, so the
 * concurrency limit bounded starts and nothing else, and assets queued behind
 * that wall never got a socket. They died at the flat twenty-second deadline
 * having never been given a chance to begin: two PNGs timed out at 20 s in a run
 * where, fetched alone, they arrive in 0.23 s and 0.5 s. Which assets lost the
 * race varied per run, which is exactly why the failures looked random and the
 * count was never the same twice.
 *
 * `fetch` fixes the mechanism rather than the symptom. It resolves when the last
 * byte lands, so a freed slot means a freed connection and the limit is real; it
 * reports a status, so a 502 is distinguishable from a 404; and it aborts, so a
 * timeout cancels the request instead of leaking one that competes with the
 * retry. The bytes land in the HTTP cache, which is what the media elements play
 * from later — the assets are served `public, max-age=…` with `Accept-Ranges`,
 * so a range request during the show is answered without touching the network.
 */

/**
 * Give up on a stall, never on a large file.
 *
 * The old clock was twenty seconds flat from the moment a file started, which is
 * lavish for a 30 KB portrait and a coin-flip for a 29 MB clip on a venue link —
 * so the biggest assets, the ones a scenario can least afford to lose, were the
 * likeliest to be dropped. Slowness is worth waiting out; silence is not. This
 * deadline resets on every chunk that arrives, so it measures whether anything
 * is still coming rather than how much there is to come.
 */
export const STALL_TIMEOUT_MS = 15_000;

/**
 * A remote show reaches the audience through somebody else's proxy, and the
 * failures that proxy produces are overwhelmingly transient — this run drew two
 * 502s out of 64 assets on a link that was otherwise delivering 16 MB/s. With no
 * retry a single hiccup was a permanent hole in the show, and at 64 assets the
 * odds of getting none of them were poor enough that a clean load was the rare
 * case rather than the normal one.
 *
 * A 404 is not retried: a file that is not there will still not be there in four
 * hundred milliseconds, and spending three attempts to prove it costs a presenter
 * time in front of a room to learn what the first attempt already said.
 */
export const RETRY_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = 400;

/** What we got, and whether asking again could plausibly do better. */
export type Attempt = { ok: true; bytes: number } | { ok: false; retry: boolean; why: string };

function retriable(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/**
 * One try. Streams rather than awaiting `blob()` so the watchdog can tell a slow
 * download from a dead one, and so progress is real bytes rather than a file
 * counted whole the moment it finishes.
 */
async function attempt(url: string, onBytes: (n: number) => void, stallMs: number): Promise<Attempt> {
  const control = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Rearmed by every chunk. A download making progress is never interrupted;
  // one that has gone quiet for the timeout is abandoned and its socket with it.
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => control.abort(), stallMs);
  };

  try {
    arm();
    const response = await fetch(url, { signal: control.signal, credentials: 'omit' });
    if (!response.ok) {
      return { ok: false, retry: retriable(response.status), why: `HTTP ${response.status}` };
    }

    // No body to stream (a 204, or a browser that gave us none) still counts as
    // arrived — the request succeeded, and inventing a failure here would report
    // a hole in a show that has none.
    if (!response.body) {
      const whole = await response.arrayBuffer();
      onBytes(whole.byteLength);
      return { ok: true, bytes: whole.byteLength };
    }

    const reader = response.body.getReader();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      bytes += value.byteLength;
      onBytes(value.byteLength);
    }
    return { ok: true, bytes };
  } catch {
    // An abort is this function's own watchdog firing; anything else is the
    // network refusing. Both are worth another go, and both are worth naming,
    // because "could not be fetched" over a stall and over a DNS failure sends
    // whoever reads it to look in two different places.
    const why = control.signal.aborted ? 'stalled' : 'network error';
    return { ok: false, retry: true, why };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One asset, with its own clock and its own second chances.
 *
 * The knobs are arguments with defaults rather than constants read from scope so
 * a test can pin the retry and the stall without sitting through either.
 */
export async function fetchAsset(
  url: string,
  onBytes: (n: number) => void = () => {},
  opts: { attempts?: number; stallMs?: number; backoffMs?: number } = {},
): Promise<Attempt> {
  const attempts = opts.attempts ?? RETRY_ATTEMPTS;
  const stallMs = opts.stallMs ?? STALL_TIMEOUT_MS;
  const backoffMs = opts.backoffMs ?? RETRY_BACKOFF_MS;
  let last: Attempt = { ok: false, retry: true, why: 'never started' };
  for (let tries = 1; tries <= attempts; tries += 1) {
    // Bytes from a failed attempt are not progress: counting them would run the
    // total past 100% on a link bad enough to need the retries.
    let credited = 0;
    const result = await attempt(
      url,
      (n) => {
        credited += n;
        onBytes(n);
      },
      stallMs,
    );
    if (result.ok) return result;
    onBytes(-credited);
    last = result;
    if (!result.retry || tries === attempts) break;
    // Backing off further each time, because the failure this exists for is a
    // proxy under load, and three immediate retries are three more requests it
    // is already failing to answer.
    await new Promise((resolve) => setTimeout(resolve, backoffMs * tries));
  }
  return last;
}

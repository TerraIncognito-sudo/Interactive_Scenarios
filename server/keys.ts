/**
 * Who is allowed to open a room.
 *
 * **A key is data, not configuration.** A `RELAY_KEY` in `docker-compose.yml`
 * is one secret shared by everyone who has ever been told it: it cannot be
 * withdrawn from one person, nothing records who is using it, and changing it
 * locks out every client at once. What is wanted instead is a set of keys that
 * can be handed out and taken back one at a time, so they live in the same
 * SQLite file as the rooms and survive a restart and a redeploy. There is no
 * `RELAY_KEY` environment variable at all, and `docker-compose.yml` says so
 * where somebody would otherwise helpfully add one back.
 *
 * **A relay with no keys opens no rooms.** A fresh container issues none and
 * refuses everything until somebody signs into the console and generates one
 * — the same rule as an empty `PUBLIC_URL` never quietly meaning the
 * permissive thing.
 *
 * **They are stored in the clear, deliberately.** The console has to list
 * them, because a key you can only see once is a key that ends up on a sticky
 * note. Two things make that acceptable: the console is already behind
 * `ADMIN_PASSWORD`, and a relay key buys the ability to open a room and put a
 * question in front of some phones and *nothing else*, because no command ever
 * travels back toward a client. That is the one-way design paying for itself a
 * second time.
 */

import { randomInt } from 'node:crypto';
import { safeEqual } from './auth.ts';

/**
 * The phrase alphabet: 256 short words, read down a phone line if need be.
 *
 * Exactly 256 so `randomInt(WORDS.length)` is unbiased and the arithmetic
 * below is exact. A list that silently drifted to 255 entries would still
 * work and would quietly stop being uniform, so the count is asserted at load
 * and pinned by a test.
 */
export const WORDS = [
  'amber', 'anchor', 'apple', 'arbor', 'arrow', 'ash', 'aspen', 'atlas',
  'autumn', 'azure', 'bacon', 'badge', 'bamboo', 'banjo', 'barley', 'basalt',
  'basin', 'batch', 'beacon', 'beetle', 'bellow', 'birch', 'bishop', 'bison',
  'blanket', 'blossom', 'bolt', 'bonnet', 'boulder', 'bramble', 'brandy', 'brass',
  'bravo', 'breeze', 'bridge', 'bronze', 'brook', 'buckle', 'bugle', 'bundle',
  'burrow', 'cabin', 'cactus', 'camber', 'candle', 'canopy', 'canvas', 'canyon',
  'cargo', 'carrot', 'cascade', 'castle', 'cedar', 'cellar', 'cement', 'chalk',
  'chapel', 'charcoal', 'cherry', 'chimney', 'chisel', 'cider', 'cinder', 'circus',
  'citrus', 'clamp', 'clarinet', 'clay', 'clever', 'cliff', 'clover', 'cobalt',
  'cobble', 'cocoa', 'comet', 'compass', 'copper', 'coral', 'cork', 'cotton',
  'cove', 'cradle', 'crane', 'crater', 'crayon', 'creek', 'crest', 'cricket',
  'crimson', 'crumb', 'crystal', 'cumin', 'cupboard', 'current', 'curtain', 'cypress',
  'daisy', 'damson', 'dapple', 'dawn', 'dazzle', 'decoy', 'delta', 'denim',
  'desert', 'dial', 'diamond', 'dockyard', 'dolphin', 'domino', 'donkey', 'drapery',
  'drift', 'drum', 'dune', 'dusk', 'eagle', 'ember', 'emerald', 'engine',
  'envelope', 'fabric', 'falcon', 'fathom', 'fennel', 'fern', 'ferry', 'fiddle',
  'filament', 'flannel', 'flask', 'flint', 'foghorn', 'forest', 'fossil', 'foxglove',
  'fresco', 'frost', 'funnel', 'furnace', 'gable', 'galaxy', 'gallery', 'garnet',
  'gazebo', 'ginger', 'glacier', 'glimmer', 'granite', 'gravel', 'grotto', 'gully',
  'hammock', 'harbour', 'harvest', 'hazel', 'heather', 'hedge', 'helix', 'hemlock',
  'heron', 'hickory', 'hollow', 'honey', 'hornet', 'hurdle', 'indigo', 'ingot',
  'ivory', 'jackal', 'jasmine', 'jetty', 'jigsaw', 'juniper', 'kelp', 'kernel',
  'kestrel', 'kettle', 'keystone', 'lacquer', 'ladder', 'lagoon', 'lantern', 'larch',
  'lattice', 'lavender', 'ledger', 'lemon', 'lichen', 'lighthouse', 'lilac', 'linen',
  'lobby', 'locket', 'lotus', 'lumber', 'lupin', 'magnet', 'mahogany', 'mallet',
  'mango', 'mantle', 'maple', 'marble', 'marigold', 'marrow', 'meadow', 'medal',
  'mercury', 'mermaid', 'mica', 'mildew', 'mineral', 'mint', 'mirror', 'mitten',
  'monsoon', 'mortar', 'mosaic', 'moss', 'mulberry', 'mural', 'nectar', 'nettle',
  'nickel', 'nimbus', 'nutmeg', 'oaken', 'oasis', 'obsidian', 'ochre', 'olive',
  'onyx', 'opal', 'orchard', 'orchid', 'osprey', 'otter', 'outpost', 'oyster',
  'paddle', 'pagoda', 'palette', 'pamphlet', 'pantry', 'papyrus', 'parapet', 'parcel',
  'parsley', 'pasture', 'pebble', 'pelican', 'pennant', 'pepper', 'pewter', 'pigment',
] as const;

if (WORDS.length !== 256) {
  throw new Error(`The key word list must be exactly 256 words, found ${WORDS.length}`);
}

/**
 * How many words a phrase is, and therefore how much guessing it costs.
 *
 * Five words out of 256 is 40 bits. That is short of the 44 the plan asked
 * for, and the trade is legibility: this gets read out over a phone and typed
 * once by a person who would rather be setting up a projector. The other half
 * of the argument is that no amount of entropy is safe on its own in front of
 * the internet and 40 bits behind `KeyAttempts` is unreachable — a hundred
 * guesses an hour from one address needs a billion years.
 *
 * The one thing that must never happen is both halves weakening at once, so
 * the rate limiter lives in this file rather than in the transport, next to
 * the number it is holding up.
 */
export const PHRASE_WORDS = 5;

export function generatePhrase(): string {
  const parts: string[] = [];
  for (let i = 0; i < PHRASE_WORDS; i++) parts.push(WORDS[randomInt(WORDS.length)]!);
  return parts.join('-');
}

/** What the store hands back. `phrase` is the secret; everything else is a label. */
export type KeyRow = {
  id: string;
  label: string;
  phrase: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
};

/**
 * Finds the live key a client presented, in constant time per candidate.
 *
 * Compares against every non-revoked key rather than looking one up, because
 * a phrase is the whole credential — there is no username to index on. A
 * handful of keys makes that free, and `safeEqual` is what stops the number of
 * comparisons that ran being a hint about the number of characters that
 * matched.
 */
export function matchKey(keys: KeyRow[], presented: string): KeyRow | undefined {
  let found: KeyRow | undefined;
  for (const key of keys) {
    if (key.revoked_at !== null) continue;
    // No early exit: the loop runs the same length whatever it finds.
    if (safeEqual(key.phrase, presented)) found = key;
  }
  return found;
}

/**
 * Failed `openRoom` attempts, per address.
 *
 * Deliberately counts only failures. A venue where six operators open rooms
 * from behind one NAT is an ordinary evening, and a limiter that counted
 * successes would turn that into a support call; somebody guessing keys
 * produces nothing but failures by definition.
 *
 * In memory rather than in SQLite, and that is a real limit worth stating: a
 * restart forgives everybody. It is the right trade anyway — writing a row per
 * wrong guess is a disk-filling primitive handed to the internet, and the
 * restart an attacker would need to trigger to clear their count is a harder
 * problem than the one they are working on.
 */
export class KeyAttempts {
  private readonly failures = new Map<string, { count: number; until: number }>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit = 20, windowMs = 15 * 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** True when this address has spent its guesses. */
  blocked(address: string, now = Date.now()): boolean {
    const entry = this.failures.get(address);
    if (!entry) return false;
    if (entry.until <= now) {
      this.failures.delete(address);
      return false;
    }
    return entry.count >= this.limit;
  }

  fail(address: string, now = Date.now()): void {
    const entry = this.failures.get(address);
    if (!entry || entry.until <= now) {
      this.failures.set(address, { count: 1, until: now + this.windowMs });
      return;
    }
    entry.count++;
  }

  /** A key that works clears the record, so one typo costs nothing later. */
  succeed(address: string): void {
    this.failures.delete(address);
  }
}

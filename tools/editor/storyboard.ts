/**
 * Reading a storyboard back out of the markdown a human wrote.
 *
 * The alternative to this file is retyping twenty-six image prompts and forty
 * lines of dialogue into a form, which nobody would do twice. The cost is that
 * the storyboard becomes semi-structured: the shot heading and the labelled
 * blocks below it are a contract this parser depends on.
 *
 * That contract is deliberately loose about everything else. Prose between
 * shots, tables, notes to self and whole sections the parser has never heard of
 * are skipped rather than rejected — a storyboard is a document for people
 * first, and it must stay editable in any text editor without breaking import.
 *
 * Import runs once, at project creation. After that the project file owns the
 * prompts; re-importing offers a diff rather than overwriting weeks of tuning.
 */

export type StoryboardLine = {
  /** Character id as written in the storyboard, e.g. `narr`. */
  who: string;
  text: string;
  /** The *Delivery: …* note that follows a line, kept as a prompt hint. */
  delivery?: string;
};

export type StoryboardShot = {
  /** As written: `A.1`, `D.5`. */
  id: string;
  title: string;
  act?: string;
  /** Seconds from `**Hold:** 8 s`. */
  hold?: number;
  scene?: string;
  /**
   * The scenario node this shot plays on, from `**Node:** \`p1_defend\``.
   *
   * Optional because most shots do not need it: a node id normally carries its
   * own shot, so `a1_jetty` is Shot A.1 and no one has to say so. It exists for
   * the ones that cannot — `E.1a` is the beat that runs when `defend` wins the
   * poll, and its node is named for the poll rather than for the shot. Stated
   * explicitly it beats the naming convention; left out, the convention still
   * applies.
   */
  node?: string;
  /** The fenced block under `**IMAGE**`. */
  image?: string;
  motion?: string;
  sfx?: string;
  lines: StoryboardLine[];
};

export type StoryboardParse = {
  shots: StoryboardShot[];
  /**
   * Named blocks the document defines once and the shots refer to by name:
   * `STYLE`, `NEGATIVE`, `SHIP`.
   *
   * A storyboard writes `STYLE. SHIP. Pre-dawn at a working naval jetty…`
   * rather than pasting four hundred characters of palette into every shot, and
   * it is right to — the style belongs to the production, not to the shot. But
   * a prompt that reaches a model still saying `STYLE.` has none of it, and
   * `STYLE` is not a word any model knows. This is where the definitions come
   * from; `prompt.ts` is where they go back in.
   */
  tokens: Record<string, string>;
  /**
   * Character reference sheets, keyed by the label the document uses —
   * `Beaudoin`, `Tran`. A neutral portrait per character, generated first and
   * reused as the reference for every later shot so faces do not drift.
   *
   * Keyed by label rather than by character id because a storyboard writes
   * "Beaudoin sheet" and the scenario calls her `beau`. Joining the two is a
   * guess, so it happens once, out loud, in `sprites.ts` — and what it cannot
   * match is reported rather than attached to the wrong face.
   */
  sheets: Record<string, string>;
  /** Things the parser understood but that look like mistakes. */
  warnings: string[];
};

/**
 * A fenced block that opens `NAME: …` and sits outside any shot.
 *
 * Narrow deliberately. A storyboard is full of fenced blocks — YAML samples,
 * shell commands, the beat sheet — and a rule that took all of them would fill
 * the project file with furniture. Capitals, a colon and prose after it is what
 * a definition looks like in this document and in every storyboard modelled on
 * it, and anything else stays furniture.
 */
const TOKEN_DEFINITION = /^([A-Z][A-Z0-9_]{2,}):\s*([\s\S]*)$/;

/**
 * `- **Beaudoin sheet:** \`STYLE. Character reference sheet…\``
 *
 * The prompt runs past the line it starts on — these are the longest single
 * prompts in a storyboard — so the opening backtick is all this matches and
 * `readInlineCode` finds the close.
 */
const SHEET = /^[-*]\s+\*\*(.+?)\s+sheets?:\*\*\s*`/i;

const SHOT_HEADING = /^###\s+Shot\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:[—–-]\s*(.*))?$/;
/**
 * The beats a storyboard writes out instead of numbering: `### ENDING A —
 * \`end_strike\``, `### DEBRIEF END NODE — \`debrief\``.
 *
 * A separate pattern rather than a looser `SHOT_HEADING`, because a document
 * for people is full of `###` headings that are furniture — `### 3.1 The style
 * token`, `### Media fields` — and a parser that swallowed those would fill the
 * asset board with sections of prose. The named labels are the whole allowance;
 * anything else stays furniture.
 *
 * These carry no shot number, so nothing can be inferred from their id. They
 * have to state their node with `**Node:**`, and are reported unmatched when
 * they do not — which is still better than the alternative, where an ending's
 * artwork was skipped in silence and appeared on no list at all.
 */
const BEAT_HEADING =
  /^###\s+((?:ENDING|EPILOGUE|PROLOGUE|CODA|DEBRIEF)(?:\s+[A-Z0-9][A-Z0-9._-]*)*)\s*(?:(?:[—–]|\s-)\s*(.*))?$/;
const ACT_HEADING = /^##\s+(?:ACT\s+)?(.+)$/i;
const HOLD = /\*\*Hold:\*\*\s*([\d.]+)\s*s/i;
const SCENE = /\*\*Scene:\*\*\s*`?([A-Za-z0-9_-]+)`?/i;
const NODE = /\*\*Node:\*\*\s*`?([A-Za-z0-9_-]+)`?/i;
/**
 * `**IMAGE**`, `**MOTION** inline text`, and `**VO — \`narr\`**`.
 *
 * The speaker sits *inside* the bold on a VO heading, which is how a person
 * writing markdown naturally types it. Reading it as `**VO**` followed by a
 * dash silently produces a shot with no dialogue at all.
 */
const LABEL = /^\*\*([A-Z]+)(?:\s*[—–-]\s*`?([A-Za-z0-9_-]+)`?)?\*\*\s*(.*)$/;
const SPEAKER = /^`([A-Za-z0-9_-]+)`\s*:\s*$/;
const DELIVERY = /^\*Delivery:\s*(.*)$/i;

/** `A.1` -> `a1`, so it can be part of a filename. */
export function shotSlug(id: string): string {
  return id.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
}

function dedent(lines: string[]): string {
  return lines.join('\n').trim();
}

/**
 * Collects a `>` blockquote starting at `index`, returning the text and where
 * it ended. Blank lines inside a quote continue it; anything else stops it.
 */
function readQuote(lines: string[], index: number): { text: string; next: number } {
  const collected: string[] = [];
  let i = index;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('>')) {
      collected.push(line.replace(/^>\s?/, ''));
      i += 1;
    } else if (line.trim() === '' && collected.length > 0) {
      // Only continue past a blank if the quote resumes right after it.
      if (lines[i + 1]?.startsWith('>')) {
        collected.push('');
        i += 1;
      } else break;
    } else break;
  }
  return { text: dedent(collected), next: i };
}

/**
 * Collects a `*Delivery: …*` note, which may run past the line it starts on.
 *
 * Hand-wrapped prose is the normal case in a document written for people — the
 * longest and most useful notes in a storyboard are exactly the ones that do
 * not fit on one line. Requiring the closing `*` on the opening line drops them
 * silently, which is worse than rejecting them: the import looks like it worked
 * and the direction never reaches the model.
 */
function readDelivery(lines: string[], index: number): { text: string; next: number } | undefined {
  const first = DELIVERY.exec(lines[index]!.trim());
  if (!first) return undefined;

  const collected = [first[1]!.trim()];
  let i = index;
  while (!collected[collected.length - 1]!.endsWith('*')) {
    i += 1;
    const next = lines[i]?.trim();
    // An unterminated note is a typo, not a note. Stopping at the first thing
    // that is plainly something else keeps it from swallowing the next shot.
    if (!next || next.startsWith('**') || next.startsWith('#') || next.startsWith('>')) {
      return undefined;
    }
    collected.push(next);
  }

  const text = collected.join(' ').replace(/\*$/, '').trim();
  return text ? { text, next: i + 1 } : undefined;
}

/**
 * Collects a single-backtick span that may be wrapped across lines.
 *
 * Hand-wrapped prose is the normal case in a document for people, and a
 * character sheet is four lines of it. Requiring the closing backtick on the
 * opening line drops exactly the longest and most useful prompts, silently —
 * the import looks like it worked and three portraits never reach the board.
 */
function readInlineCode(lines: string[], index: number, from: number): { text: string; next: number } {
  const first = lines[index]!.slice(from);
  const close = first.indexOf('`');
  if (close >= 0) return { text: first.slice(0, close).trim(), next: index + 1 };

  const collected = [first.trim()];
  let i = index + 1;
  while (i < lines.length) {
    const line = lines[i]!;
    const end = line.indexOf('`');
    if (end >= 0) {
      collected.push(line.slice(0, end).trim());
      return { text: dedent(collected).replaceAll(/\s*\n\s*/g, ' '), next: i + 1 };
    }
    // An unterminated span is a typo, not a prompt. Stopping at the first thing
    // that is plainly something else keeps it from swallowing the document.
    if (!line.trim() || line.trimStart().startsWith('#')) break;
    collected.push(line.trim());
    i += 1;
  }
  return { text: '', next: index + 1 };
}

/** Collects a ``` fenced block starting at the fence line. */
function readFence(lines: string[], index: number): { text: string; next: number } {
  const collected: string[] = [];
  let i = index + 1;
  while (i < lines.length && !lines[i]!.trimStart().startsWith('```')) {
    collected.push(lines[i]!);
    i += 1;
  }
  return { text: dedent(collected), next: i + 1 };
}

export function parseStoryboard(source: string): StoryboardParse {
  const lines = source.split(/\r?\n/);
  const shots: StoryboardShot[] = [];
  const tokens: Record<string, string> = {};
  const sheets: Record<string, string> = {};
  const warnings: string[] = [];

  let act: string | undefined;
  let shot: StoryboardShot | undefined;
  /** Which labelled block we are inside, so a fence or quote knows its owner. */
  let label: string | undefined;
  let pendingWho: string | undefined;

  for (let i = 0; i < lines.length; ) {
    const raw = lines[i]!;
    const line = raw.trim();

    const shotMatch = SHOT_HEADING.exec(line) ?? BEAT_HEADING.exec(line);
    if (shotMatch) {
      shot = {
        id: shotMatch[1]!.replace(/\s+/g, ' ').trim(),
        title: (shotMatch[2] ?? '').trim(),
        act,
        lines: [],
      };
      shots.push(shot);
      label = undefined;
      pendingWho = undefined;
      i += 1;
      continue;
    }

    // Checked after the shot heading because `### Shot` also matches nothing
    // here; act headings are `##` and would otherwise swallow the document.
    const actMatch = line.startsWith('## ') ? ACT_HEADING.exec(line) : null;
    if (actMatch) {
      act = actMatch[1]!.trim();
      shot = undefined;
      label = undefined;
      i += 1;
      continue;
    }

    if (!shot) {
      // Before the first shot is where a storyboard states its style, its
      // negative and its design bibles. The parser used to skip all of it,
      // which is how twenty-six prompts reached the board with `STYLE.` in
      // them and nothing anywhere that said what STYLE was.
      const sheet = SHEET.exec(line);
      if (sheet) {
        const opened = raw.indexOf('`', raw.indexOf('**', raw.indexOf('**') + 2));
        const span = readInlineCode(lines, i, opened + 1);
        if (span.text) sheets[sheet[1]!.trim()] = span.text;
        else warnings.push(`The ${sheet[1]} sheet's prompt is never closed with a backtick`);
        i = span.next;
        continue;
      }

      if (line.startsWith('```')) {
        const fence = readFence(lines, i);
        const defined = TOKEN_DEFINITION.exec(fence.text);
        if (defined) {
          const [, name, body] = defined;
          if (tokens[name!] === undefined) tokens[name!] = body!.trim();
          else warnings.push(`${name} is defined more than once; the first one is used`);
        }
        i = fence.next;
        continue;
      }
      i += 1;
      continue;
    }

    if (HOLD.test(line)) shot.hold = Number(HOLD.exec(line)![1]);
    if (SCENE.test(line)) shot.scene = SCENE.exec(line)![1];
    if (NODE.test(line)) shot.node = NODE.exec(line)![1];

    const labelMatch = line.startsWith('**') ? LABEL.exec(line) : null;
    if (labelMatch) {
      const [, name, who, rest] = labelMatch;
      label = name;
      pendingWho = who;
      // `**MOTION** Slow parallax push…` carries its content on the same line;
      // `**IMAGE**` puts it in a fence underneath. Both spellings are common in
      // a document written for humans, so both are accepted.
      const inline = (rest ?? '').trim();
      if (inline) {
        if (name === 'MOTION') shot.motion = inline;
        else if (name === 'SFX') shot.sfx = inline;
        else if (name === 'IMAGE') shot.image = inline;
      }
      i += 1;
      continue;
    }

    if (line.startsWith('```')) {
      const fence = readFence(lines, i);
      if (label === 'IMAGE') shot.image = fence.text;
      else if (label === 'MOTION') shot.motion = fence.text;
      i = fence.next;
      continue;
    }

    const speakerMatch = SPEAKER.exec(line);
    if (speakerMatch) {
      pendingWho = speakerMatch[1];
      i += 1;
      continue;
    }

    if (line.startsWith('>')) {
      const quote = readQuote(lines, i);
      const who = pendingWho ?? (label === 'VO' ? undefined : undefined);
      if (who && quote.text) {
        shot.lines.push({ who, text: quote.text });
      } else if (quote.text) {
        warnings.push(`Shot ${shot.id}: a quoted line has no speaker and was skipped`);
      }
      // A `**VO — narr**` heading names one speaker for one quote; a DIALOGUE
      // block names a speaker per quote. Clearing here makes both work.
      pendingWho = undefined;
      i = quote.next;
      continue;
    }

    if (line.startsWith('*Delivery:') || line.startsWith('*delivery:')) {
      const delivery = readDelivery(lines, i);
      if (delivery && shot.lines.length > 0) {
        shot.lines[shot.lines.length - 1]!.delivery = delivery.text;
        i = delivery.next;
        continue;
      }
      if (!delivery) warnings.push(`Shot ${shot.id}: a *Delivery:* note is never closed with *`);
    }

    i += 1;
  }

  for (const entry of shots) {
    if (!entry.scene) warnings.push(`Shot ${entry.id} has no **Scene:** and cannot be placed`);
    if (!entry.image) warnings.push(`Shot ${entry.id} has no **IMAGE** prompt`);
  }

  return { shots, tokens, sheets, warnings };
}

// ---------------------------------------------------------------------------
// Proposing assets
// ---------------------------------------------------------------------------

import type { AssetSection } from '../../src/scenario/load.ts';

export type ProposedAsset = {
  file: string;
  section: AssetSection;
  prompt?: string;
  text?: string;
  voice?: string;
  source: { shot: string; line?: number };
  /** Suggested `hold:` in seconds, from the storyboard's own timing. */
  hold?: number;
  scene?: string;
};

/**
 * Filenames follow the storyboard's own convention — `tran-d5-01.mp3` is
 * lifted straight from its engine-mapping section — extended to stills and
 * clips, which it names only by shot.
 *
 * Stills are named per *shot*, not per scene, because a storyboard calls for
 * far more distinct images than it has places — and a node carries its own
 * `background:`, so each of them has somewhere to hang. The scene keeps the
 * establishing shot's picture; every other shot in that place brings its own.
 */
export function shotMediaName(
  shot: StoryboardShot,
  section: AssetSection,
  extension: string,
): string {
  const slug = shotSlug(shot.id);
  return filed(section, `${shot.scene ? `${shot.scene}-${slug}` : slug}.${extension}`);
}

/**
 * A name with its media type in front of it: `voice/tran-d5-01.mp3`.
 *
 * The folder is part of the name the scenario declares rather than a layout
 * the display works out for itself, so that reading `scenario.yaml` tells you
 * where a file is. See `folders.ts` — this is the same rule applied at the one
 * point in the pipeline that is allowed to invent a filename, which is here,
 * because what happens next is writing the scenario that references it.
 */
export function filed(section: AssetSection, name: string): string {
  return `${section}/${name}`;
}

export function proposeAssets(shots: StoryboardShot[]): ProposedAsset[] {
  const proposed: ProposedAsset[] = [];
  const perShotVoiceCount = new Map<string, number>();

  for (const shot of shots) {
    const slug = shotSlug(shot.id);

    if (shot.image) {
      proposed.push({
        file: shotMediaName(shot, 'images', 'jpg'),
        section: 'images',
        prompt: shot.image,
        source: { shot: shot.id },
        scene: shot.scene,
      });
    }

    if (shot.motion) {
      proposed.push({
        file: shotMediaName(shot, 'video', 'mp4'),
        section: 'video',
        prompt: shot.motion,
        source: { shot: shot.id },
        scene: shot.scene,
      });
    }

    if (shot.sfx) {
      proposed.push({
        file: filed('sfx', `${shot.scene ? `${shot.scene}-${slug}` : slug}-sfx.mp3`),
        section: 'sfx',
        prompt: shot.sfx,
        source: { shot: shot.id },
        scene: shot.scene,
      });
    }

    shot.lines.forEach((line, index) => {
      const n = (perShotVoiceCount.get(`${line.who}-${slug}`) ?? 0) + 1;
      perShotVoiceCount.set(`${line.who}-${slug}`, n);
      proposed.push({
        file: filed('voice', `${line.who}-${slug}-${String(n).padStart(2, '0')}.mp3`),
        section: 'voice',
        text: line.text,
        voice: line.who,
        prompt: line.delivery,
        source: { shot: shot.id, line: index },
        hold: shot.hold,
        scene: shot.scene,
      });
    });
  }

  return proposed;
}

// ---------------------------------------------------------------------------
// Matching a storyboard onto a scenario that already exists
// ---------------------------------------------------------------------------

import { assetReferencesOf } from '../../src/scenario/load.ts';
import type { Scenario } from '../../src/scenario/schema.ts';
import { defaultSizeFor, formatSize } from './size.ts';
import { NARRATION_VOICE } from './project.ts';

export type SeedRow = {
  /** A filename the scenario actually references. Never an invented one. */
  file: string;
  section: AssetSection;
  prompt?: string;
  /** `1920x1080`, from where the scenario uses the picture. Absent for audio. */
  size?: string;
  text?: string;
  voice?: string;
  /**
   * Where the row came from. A voice row cites the scenario line it speaks;
   * everything else cites the shot it was drawn from. Either can be absent: a
   * spoken line the storyboard never described still belongs on the board.
   */
  source: { shot?: string; node?: string; line?: number };
};

export type SeedResult = {
  rows: SeedRow[];
  /** Storyboard prompts with no file in the scenario to attach them to. */
  unmatched: { shot: string; kind: string; why: string }[];
};

/**
 * Which shot a node came from.
 *
 * Two answers, in order. A shot that names its node with `**Node:**` claims
 * that node outright. Everything else falls back to the id-prefix convention:
 * shot `A.1` becomes `a1`, and the node is `a1_jetty`, with a separator check
 * so `a1` cannot claim `a10_something`. The convention is the storyboard's own
 * — its engine-mapping section says node ids match shot ids — and it covers
 * most of a document, which is why stating a node is the exception rather than
 * a requirement. Where neither answers, the shot goes unmatched and is
 * reported, rather than being attached to the wrong picture.
 */
export type ShotIndex = {
  stated: Map<string, StoryboardShot>;
  bySlug: Map<string, StoryboardShot>;
};

/**
 * Exported because more than one part of the editor has to answer "which shot
 * is this node?", and two answers to that question is how a prompt ends up on
 * a file the player never opens. The asset board, the voice wiring and the
 * shot migration all resolve it here.
 */
export function shotsByNode(shots: StoryboardShot[]): ShotIndex {
  const stated = new Map<string, StoryboardShot>();
  const bySlug = new Map<string, StoryboardShot>();
  for (const shot of shots) {
    bySlug.set(shotSlug(shot.id), shot);
    if (shot.node) stated.set(shot.node, shot);
  }
  return { stated, bySlug };
}

export function shotForNode(index: ShotIndex, nodeId: string): StoryboardShot | undefined {
  const stated = index.stated.get(nodeId);
  if (stated) return stated;

  const exact = index.bySlug.get(nodeId);
  if (exact) return exact;

  // Longest first, so `e1a` beats `e1` for a node called `e1a_something`.
  const slugs = [...index.bySlug.keys()].sort((a, b) => b.length - a.length);
  for (const slug of slugs) {
    if (!nodeId.startsWith(slug)) continue;
    const next = nodeId.charAt(slug.length);
    if (next === '' || next === '_' || next === '-') return index.bySlug.get(slug);
  }
  return undefined;
}

/** The scenario line a `voice:` file was hung off, if the node still has one. */
function lineIn(
  nodes: Map<string, Scenario['nodes'][number]>,
  nodeId: string,
  index: number,
): { who?: string; text: string } | undefined {
  const node = nodes.get(nodeId);
  if (node?.type !== 'dialogue') return undefined;
  return node.lines[index];
}

/**
 * The *Delivery:* note for one speaker in a shot.
 *
 * Matched by speaker rather than by position, because a shot names a delivery
 * once per block and the scenario may split that block across several lines —
 * all of which want the same note.
 */
function deliveryFor(shot: StoryboardShot, who: string | undefined): string | undefined {
  for (const line of shot.lines) {
    if (line.who === who && line.delivery) return line.delivery;
  }
  return undefined;
}

/**
 * Seeds prompts onto the filenames the scenario declares.
 *
 * This is the half of the pipeline where the editor and the player have to
 * agree. The player opens exactly the filenames in `scenario.yaml`; if seeding
 * invented its own, every prompt an author wrote would belong to a file nothing
 * would ever load. So the manifest leads: rows are keyed by
 * `assetReferencesOf`, and a storyboard prompt with nowhere to go is reported
 * rather than written under a name of the editor's choosing.
 *
 * The opposite case — a storyboard and no scenario — is `scaffold.ts`, which is
 * free to invent names precisely because it writes the scenario that references
 * them. Both routes end with the two files agreeing; neither guesses.
 */
export function seedRowsFor(
  scenario: Scenario,
  shots: StoryboardShot[],
  sheets: Record<string, string> = {},
): SeedResult {
  // Keyed by character rather than by the document's label, so the walk below
  // can look one up by the id the scenario uses. The join itself belongs to
  // `sprites.ts`, which is the file that had to make it to declare the sprite
  // in the first place — doing it twice would be two chances to disagree.
  const sheetFor = new Map<string, string>();
  for (const [label, prompt] of Object.entries(sheets)) {
    for (const [id, character] of Object.entries(scenario.characters)) {
      const words = character.name.toLowerCase().split(/[^\p{L}\p{N}]+/u);
      if (id.toLowerCase() === label.toLowerCase() || words.includes(label.toLowerCase())) {
        sheetFor.set(id, prompt);
      }
    }
  }

  const byNode = shotsByNode(shots);
  const rows: SeedRow[] = [];
  const used = new Set<string>();

  // A scene's still is its establishing shot: the first node that plays there.
  // Later shots in the same room carry their own picture on their own node, and
  // reach this walk as a node-scoped reference rather than a scene-scoped one.
  //
  // Where the establishing node was never storyboarded, the first node in the
  // scene that *was* is used instead. That is not a guess: a scene has exactly
  // one background, so any shot playing in it is describing that background.
  // `debrief` is the case in point — the scene opens on the fiction notice,
  // which no shot describes, and is then reused by the debrief itself, which
  // has a full image prompt sitting unused.
  const nodesOfScene = new Map<string, string[]>();
  for (const node of scenario.nodes) {
    if (!node.scene) continue;
    const seen = nodesOfScene.get(node.scene);
    if (seen) seen.push(node.id);
    else nodesOfScene.set(node.scene, [node.id]);
  }
  const nodeForScene = (scene: string): string | undefined => {
    const candidates = nodesOfScene.get(scene) ?? [];
    return candidates.find((id) => shotForNode(byNode, id)) ?? candidates[0];
  };

  const nodeById = new Map(scenario.nodes.map((node) => [node.id, node]));

  for (const ref of assetReferencesOf(scenario)) {
    if (used.has(ref.file)) continue;

    // Narrowed by shape rather than by `kind`: two of the origin variants carry
    // a union of literals as their discriminant, which equality checks cannot
    // fully narrow. A character portrait belongs to no shot; a line reaches its
    // shot through its own node, and scene media through the node that first
    // plays that scene.
    const origin = ref.origin;
    let nodeId: string | undefined;
    if ('node' in origin) nodeId = origin.node;
    else if ('scene' in origin) nodeId = nodeForScene(origin.scene);

    const shot = nodeId ? shotForNode(byNode, nodeId) : undefined;
    const row: SeedRow = { file: ref.file, section: ref.section, source: {} };
    if (shot) row.source.shot = shot.id;

    // The display's own geometry, written into the file the author reads. Art
    // is made in another program and dropped in here, and the one thing that
    // program cannot know is what shape the show is.
    const size = defaultSizeFor(ref.section, [ref.origin]);
    if (size) row.size = formatSize(size);

    if (ref.section === 'voice' && 'line' in origin) {
      // The spoken text is the scenario's, never the storyboard's. A storyboard
      // quotes a whole delivery in one blockquote where the scenario splits it
      // into the lines the display actually shows, so the two do not index
      // against each other — reading the storyboard by position would put
      // another line's words in this clip's mouth. What gets spoken has to be
      // what the audience is reading; the storyboard contributes only the note
      // on how to say it, and where it has none the row starts without one.
      const spoken = lineIn(nodeById, origin.node, origin.line);
      if (!spoken) continue;
      row.text = spoken.text;
      // A line with no `who:` still has to be spoken. Left undefined the row
      // reaches the generator with no voice to use and refuses — which is how
      // a fiction notice ends up as the only silent beat in a finished show.
      row.voice = spoken.who ?? NARRATION_VOICE;
      row.source.node = origin.node;
      row.source.line = origin.line;
      const note = shot ? deliveryFor(shot, spoken.who) : undefined;
      if (note) row.prompt = note;
    } else if (origin.kind === 'sprite') {
      // A portrait has no shot: it is generated before any of them, and every
      // shot the character appears in is matched to it rather than the other
      // way round.
      const sheet = sheetFor.get(origin.character);
      if (sheet) row.prompt = sheet;
    } else if (shot) {
      // A node's own still or clip belongs to that node, not merely to the
      // place — record it so the board can click through to the right beat.
      if ('node' in origin) row.source.node = origin.node;
      if (ref.section === 'images' && shot.image) row.prompt = shot.image;
      else if (ref.section === 'video' && shot.motion) row.prompt = shot.motion;
      else if (ref.section === 'sfx' && shot.sfx) row.prompt = shot.sfx;
    }

    // Ambience and music have no per-shot prompt in a storyboard — they are
    // described once, per scene family. The row still belongs on the board;
    // it simply starts empty. A picture always gets a row, because even one the
    // storyboard never described has a size somebody has to generate it at.
    if (row.prompt || row.text || row.size || ref.section === 'ambience' || ref.section === 'music') {
      rows.push(row);
      used.add(ref.file);
    }
  }

  const unmatched: SeedResult['unmatched'] = [];
  const claimed = new Set(
    rows.filter((row) => row.source.shot).map((row) => `${row.source.shot}:${row.section}`),
  );

  for (const shot of shots) {
    // A stated node is the one part of a storyboard that can be wrong in a way
    // the convention cannot: a typo'd `**Node:**` silently maps to nothing and
    // takes the shot's prompts down with it, quietly, forever.
    if (shot.node && !nodeById.has(shot.node)) {
      unmatched.push({
        shot: shot.id,
        kind: 'node',
        why: `**Node:** names \`${shot.node}\`, which is not a node in the scenario`,
      });
    }

    if (shot.image && !claimed.has(`${shot.id}:images`)) {
      unmatched.push({
        shot: shot.id,
        kind: 'image',
        why:
          'no node or scene in the scenario takes its background from this shot — ' +
          'give the shot its own picture to place it',
      });
    }
    if (shot.motion && !claimed.has(`${shot.id}:video`)) {
      unmatched.push({
        shot: shot.id,
        kind: 'video',
        why:
          'no node or scene in the scenario takes its clip from this shot — ' +
          'give the shot its own picture to place it',
      });
    }
    if (shot.lines.length > 0 && !claimed.has(`${shot.id}:voice`)) {
      unmatched.push({
        shot: shot.id,
        kind: 'voice',
        why:
          `${shot.lines.length} spoken line(s) — no node id maps to this shot, so its ` +
          `delivery notes have nowhere to attach`,
      });
    }
  }

  return { rows, unmatched };
}

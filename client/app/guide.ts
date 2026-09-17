/**
 * The walkthrough: the briefs it hands out, and the little state it keeps.
 *
 * Everything else in this program assumes a project already exists. Opening a
 * folder, editing a scenario, filling an asset board and running a show are all
 * things you do to something, and the something was made by a command-line
 * script from a storyboard somebody had already written. The step before all of
 * that — *I have an idea and no idea what shape the file should be* — had no
 * surface at all, and the format it needs is written down in a parser and a Zod
 * schema, neither of which is a thing to hand somebody.
 *
 * So the briefs are documents, in `docs/prompts/`, kept as files rather than as
 * strings in a page. They are long, they are prose, and they are the sort of
 * thing that gets improved by reading it and editing it — which is a thing you
 * do to a markdown file and not to a template literal. They are served rather
 * than inlined so the editor and anybody reading the repo are looking at one
 * copy.
 *
 * The draft is kept because the alternative is losing it. Steps one to three
 * happen before any project exists, so there is no project folder to write
 * into, and the three boxes hold a description, a whole storyboard and a whole
 * scenario file — an afternoon of work that would otherwise live in a browser
 * tab until something reloaded it.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { configDir } from './workspace.ts';

/**
 * The briefs, by the name the route asks for.
 *
 * A closed list rather than a filename off the request. This reads from a
 * folder in the repository, and a route that took a path would be a route that
 * reads any file on the machine — the editor already browses the whole disk for
 * the folder picker, but that is a picker a person drives.
 */
const BRIEFS = {
  storyboard: 'storyboard-brief.md',
  scenario: 'scenario-brief.md',
  // The same format reference, for the chat that has just written the
  // storyboard and still has it in front of it. Pasting the full brief *plus*
  // ninety thousand characters of storyboard into a conversation that already
  // contains the storyboard is how a model runs out of room to answer in —
  // and the answer is the whole show.
  'scenario-short': 'scenario-brief-short.md',
} as const;

export type BriefName = keyof typeof BRIEFS;

const BRIEF_DIR = join(import.meta.dirname, '..', '..', 'docs', 'prompts');

export function isBriefName(value: string): value is BriefName {
  return value in BRIEFS;
}

export async function brief(name: BriefName): Promise<string> {
  return readFile(join(BRIEF_DIR, BRIEFS[name]), 'utf8');
}

// ---------------------------------------------------------------------------
// The draft, and what has been ticked off
// ---------------------------------------------------------------------------

const GuideSchema = z.strictObject({
  /**
   * The one seed in progress. One rather than many, because seeding a project
   * is a thing somebody does over an afternoon and then finishes — a list of
   * half-started shows would be a second place projects live, competing with
   * the workspace, which is the place they live.
   */
  draft: z
    .strictObject({
      name: z.string().prefault(''),
      description: z.string().prefault(''),
      storyboard: z.string().prefault(''),
      scenario: z.string().prefault(''),
    })
    .prefault({}),
  /**
   * Which steps have been ticked, keyed by project — and by `''` for the ones
   * that happen before there is a project to key them to.
   *
   * Ticks rather than derived state, for the steps where nothing on disk can
   * answer the question. Whether a storyboard is *good enough* is not a fact
   * the program has any access to; whether one exists is, and the tab shows
   * both side by side rather than pretending the second answers the first.
   */
  done: z.record(z.string(), z.array(z.string())).prefault({}),
});

export type GuideState = z.infer<typeof GuideSchema>;

const EMPTY: GuideState = {
  draft: { name: '', description: '', storyboard: '', scenario: '' },
  done: {},
};

let state: GuideState = EMPTY;
let loaded = false;

function file(): string {
  return join(configDir(), 'guide.json');
}

export async function loadGuide(): Promise<GuideState> {
  if (loaded) return state;
  try {
    state = GuideSchema.parse(JSON.parse(await readFile(file(), 'utf8')));
  } catch {
    // No file, or one written by a different version. Either is a first run as
    // far as anybody using this is concerned.
    state = structuredClone(EMPTY);
  }
  loaded = true;
  return state;
}

/** Temp file plus rename, like every other write in this program. */
async function save(): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  const temp = `${file()}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temp, file());
}

export async function saveDraft(patch: Partial<GuideState['draft']>): Promise<GuideState> {
  await loadGuide();
  state.draft = { ...state.draft, ...patch };
  await save();
  return state;
}

/**
 * Ticks or unticks one step.
 *
 * `project` is `''` for the steps that come before a project exists, which is
 * the same key the draft belongs to — so a walkthrough half-finished before the
 * folder was made keeps its ticks, and the ones after it hang off the folder.
 */
export async function setStep(project: string, step: string, done: boolean): Promise<GuideState> {
  await loadGuide();
  const current = new Set(state.done[project] ?? []);
  if (done) current.add(step);
  else current.delete(step);
  if (current.size > 0) state.done[project] = [...current];
  else delete state.done[project];
  await save();
  return state;
}

/**
 * Forgets the draft, which is what finishing looks like.
 *
 * Offered rather than done automatically when a project is created. The draft
 * is the only copy of a storyboard until somebody checks the project actually
 * opens, and a program that threw it away on the strength of one successful
 * write would be a program that threw it away.
 */
export async function clearDraft(): Promise<GuideState> {
  await loadGuide();
  state.draft = { name: '', description: '', storyboard: '', scenario: '' };
  await save();
  return state;
}

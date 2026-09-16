/**
 * Choosing where the work lives.
 *
 * The editor ships with the game, but the scenarios it builds do not belong to
 * the game's repository — they are content, they get large, and they have their
 * own life. So the editor holds no opinion about where they are: on first run it
 * asks, and it remembers the answer.
 *
 * The browser cannot answer that question for us. `showDirectoryPicker()` hands
 * the *page* a handle and deliberately never reveals a path, which is no use to
 * a Node process that has to open the files. So the picker is served by this
 * process instead: it lists real directories and returns real paths.
 *
 * That makes the editor able to enumerate any folder on the machine, which is
 * why it binds to loopback and always has. It is a desk tool with the same reach
 * as the person sitting at the desk.
 */

import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { z } from 'zod';

/**
 * Overridable so tests can choose a workspace without writing into the real
 * config — a test run must never change which folder the editor opens next.
 */
const CONFIG_DIR = process.env.EDITOR_CONFIG_DIR ?? join(homedir(), '.interactive-scenario');
const CONFIG_FILE = join(CONFIG_DIR, 'editor.json');

const ConfigSchema = z.strictObject({
  workspace: z.string().min(1).optional(),
  /** Most recent first. Offered as shortcuts on the picker. */
  recent: z.array(z.string().min(1)).prefault([]),
  /**
   * Where model weights live on this machine.
   *
   * Config rather than `project.yaml` on purpose. A project file is opened on
   * other machines and a year later; a path to a folder of weights means
   * nothing there, while the model *id* it names still does. This is the one
   * place the two are joined, and it is per-machine by construction.
   */
  models: z.string().min(1).optional(),
  /**
   * The relay this machine goes live through, and the key it was given.
   *
   * Here for the same reason the models root is here, and it matters more.
   * `project.yaml` travels to other machines and is opened a year later, so a
   * key living there would be a key handed to whoever the folder was sent to —
   * and the point of the key being revocable is that it belongs to one person
   * and one machine. Typed once, then every later show just links.
   *
   * In the clear, because it is a file in the operator's own home directory on
   * the machine that runs their shows, and because the alternative is an
   * encryption key stored beside it. What it buys is the ability to open a
   * room and publish a poll to some phones: no command travels back toward a
   * client, which is what makes that a small thing to lose.
   */
  relay: z
    .strictObject({
      url: z.string().min(1),
      key: z.string().min(1),
    })
    .optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

let config: Config = { recent: [] };

export async function loadConfig(): Promise<Config> {
  try {
    config = ConfigSchema.parse(JSON.parse(await readFile(CONFIG_FILE, 'utf8')));
  } catch {
    // No config, or one written by a different version. Either way the editor
    // simply asks again rather than refusing to start.
    config = { recent: [] };
  }
  return config;
}

async function saveConfig(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  const temp = `${CONFIG_FILE}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await rename(temp, CONFIG_FILE);
}

/** The folder projects are read from, or undefined until one is chosen. */
export function workspace(): string | undefined {
  return config.workspace;
}

export function recentWorkspaces(): string[] {
  return config.recent;
}

export async function setWorkspace(path: string): Promise<string> {
  const resolved = resolve(path);
  const info = await stat(resolved).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`${resolved} is not a folder`);

  config.workspace = resolved;
  config.recent = [resolved, ...config.recent.filter((entry) => entry !== resolved)].slice(0, 8);
  await saveConfig();
  return resolved;
}

/** Where model weights live on this machine, or undefined until chosen. */
export function modelsRoot(): string | undefined {
  return config.models;
}

/**
 * Chooses the models folder, creating it if it is not there yet.
 *
 * Created rather than refused, unlike the workspace: a workspace that does not
 * exist is almost always a typo in a path to work that does, while a models
 * folder is empty by definition until the first download lands in it.
 */
export async function setModelsRoot(path: string): Promise<string> {
  const resolved = resolve(path);
  const info = await stat(resolved).catch(() => null);
  if (info && !info.isDirectory()) throw new Error(`${resolved} is not a folder`);
  if (!info) await mkdir(resolved, { recursive: true });

  if (looksSynced(resolved)) {
    throw new Error(
      `${resolved} is inside a cloud-synced folder. Model weights run to tens of ` +
        `gigabytes and syncing them will fill the drive — choose a local path.`,
    );
  }

  config.models = resolved;
  await saveConfig();
  return resolved;
}

/** The relay and key this machine links with, or undefined until one works. */
export function relayConfig(): { url: string; key: string } | undefined {
  return config.relay;
}

/**
 * Remembers a relay and key that were actually accepted.
 *
 * Only ever called after the relay has opened a room with them. Saving a
 * phrase that was refused would make the one thing the operator has to fix
 * the one thing the config keeps handing back to them.
 */
export async function setRelay(url: string, key: string): Promise<void> {
  if (config.relay?.url === url && config.relay.key === key) return;
  config.relay = { url, key };
  await saveConfig();
}

/** Cloud-sync folders a multi-gigabyte takes tree must not land in. */
export function looksSynced(path: string): boolean {
  return /[\\/](OneDrive|Dropbox|Google Drive|iCloud ?Drive)([\\/]|$)/i.test(path);
}

/**
 * Keeps a path from escaping its root.
 *
 * Folder names come from the client, and a project called `..` would otherwise
 * be a way to read and write anywhere. Compared as resolved paths with a
 * trailing separator so `/work/site` cannot pass as being inside `/work/si`.
 */
export function within(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = resolve(candidate);
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

export type BrowseEntry = {
  name: string;
  path: string;
  /** Holds a scenario.yaml — a project, whether or not it has a project.yaml yet. */
  isProject: boolean;
  /** Already set up for asset work. */
  hasProjectFile: boolean;
};

export type Browse = {
  path: string;
  parent?: string;
  entries: BrowseEntry[];
  /**
   * Files in this folder, when the caller asked for some.
   *
   * Only ever the extensions requested. The picker is used to choose a
   * character's reference clip as well as a folder, and listing an entire
   * Downloads directory to find one wav helps nobody.
   */
  files: { name: string; path: string; size: number }[];
  /** Drive roots on Windows, so the picker can leave the current tree. */
  roots: string[];
  synced: boolean;
};

async function driveRoots(): Promise<string[]> {
  if (process.platform !== 'win32') return ['/'];
  const found: string[] = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:${sep}`;
    if (await stat(root).catch(() => null)) found.push(root);
  }
  return found;
}

/** Lists the folders inside `path`, marking which ones are projects. */
export async function browse(path?: string, extensions?: string[]): Promise<Browse> {
  const target = resolve(path && path.trim() ? path : (config.workspace ?? homedir()));
  const wanted = extensions?.map((ext) => (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase());

  const entries: BrowseEntry[] = [];
  const files: Browse['files'] = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const full = join(target, entry.name);

    if (entry.isFile()) {
      if (!wanted?.length) continue;
      const lower = entry.name.toLowerCase();
      if (!wanted.some((ext) => lower.endsWith(ext))) continue;
      const info = await stat(full).catch(() => null);
      files.push({ name: entry.name, path: full, size: info?.size ?? 0 });
      continue;
    }

    if (!entry.isDirectory()) continue;
    // Dot-directories are tooling, not content, and they clutter the list.
    if (entry.name.startsWith('.')) continue;

    entries.push({
      name: entry.name,
      path: full,
      isProject: Boolean(await stat(join(full, 'scenario.yaml')).catch(() => null)),
      hasProjectFile: Boolean(await stat(join(full, 'project.yaml')).catch(() => null)),
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  const up = dirname(target);
  return {
    path: target,
    parent: up === target || parse(target).root === target ? undefined : up,
    entries,
    files,
    roots: await driveRoots(),
    synced: looksSynced(target),
  };
}

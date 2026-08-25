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
export async function browse(path?: string): Promise<Browse> {
  const target = resolve(path && path.trim() ? path : (config.workspace ?? homedir()));

  const entries: BrowseEntry[] = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // Dot-directories are tooling, not content, and they clutter the list.
    if (entry.name.startsWith('.')) continue;

    const full = join(target, entry.name);
    entries.push({
      name: entry.name,
      path: full,
      isProject: Boolean(await stat(join(full, 'scenario.yaml')).catch(() => null)),
      hasProjectFile: Boolean(await stat(join(full, 'project.yaml')).catch(() => null)),
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  const up = dirname(target);
  return {
    path: target,
    parent: up === target || parse(target).root === target ? undefined : up,
    entries,
    roots: await driveRoots(),
    synced: looksSynced(target),
  };
}

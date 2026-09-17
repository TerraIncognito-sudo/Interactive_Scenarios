/**
 * Opening a project's folder in the machine's own file manager.
 *
 * The board is a good place to see what a project *is* and a bad place to do
 * the handful of things that are still ordinary file work: dropping a rendered
 * still into a takes folder, copying a finished show onto a stick, looking at
 * why a clip is zero bytes because the sync client has not fetched it yet. All
 * of those end with somebody reading a path off the screen and typing it into
 * Explorer, which is a transcription step with nothing to gain from it.
 *
 * Two rules, and both are about the fact that this is the one place in the
 * program that runs another program.
 *
 * **No shell, ever.** `spawn` is given an argv array, and with `shell` left
 * off the path is one argument whatever is inside it. Through a shell, a
 * project folder somebody named `Q3 & review` would run `review` as a command —
 * and a folder name is not a thing this program controls, because it is
 * whatever is already on the author's disk.
 *
 * **The board sends a name, never a path.** `projectFolder` is the same
 * containment check every other project route goes through, so a name that
 * resolves anywhere but inside the workspace is refused before it reaches the
 * filesystem. That is the rule the destructive routes already keep, and this
 * one is not destructive but it is the one that hands a path to something
 * outside the program.
 *
 * The reply carries the path it opened, which is not decoration. On a machine
 * with no file manager — a headless Linux box, a locked-down desktop — the
 * button still answers the question the person actually had, which is *where
 * is it*.
 */

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { ProjectError } from './project.ts';
import { projectFolder } from './projects.ts';
import { workspace } from './workspace.ts';

/**
 * What this platform calls "show me this folder".
 *
 * Exported because it is the one decision in here a test can look at: the
 * spawn itself is deliberately not exercised by the suite, since a test that
 * proved it works would open a file manager window on whatever machine ran
 * `npm test`.
 */
export function openerFor(platform: NodeJS.Platform | string): string {
  if (platform === 'win32') return 'explorer.exe';
  if (platform === 'darwin') return 'open';
  return 'xdg-open';
}

/**
 * Which folder the button means.
 *
 * A project name gives that project's folder; nothing gives the workspace, so
 * the button still does something useful when no project is open — which is
 * the state somebody is in when they want to go and look at the folder in the
 * first place.
 */
export async function revealTarget(name?: string): Promise<string> {
  const dir = name === undefined || name === '' ? workspace() : projectFolder(name);

  if (dir === undefined) {
    throw new ProjectError('No workspace has been chosen yet — pick one with the Workspace button.');
  }

  const found = await stat(dir).catch(() => undefined);
  if (!found?.isDirectory()) {
    // Reachable in one ordinary way: the folder was moved or deleted in the
    // file manager and the board has not caught up. Naming the path is what
    // makes that obvious rather than mysterious.
    throw new ProjectError(`${dir} is not there any more.`);
  }
  return dir;
}

/**
 * Hands the folder to the file manager and stops caring.
 *
 * `detached` plus `unref` because the window is the person's, not this
 * process's: an Explorer window that closed when somebody pressed Ctrl-C in
 * the terminal running the board would be a surprising way to lose what you
 * were looking at, and a client that could not exit until it was closed would
 * be worse.
 *
 * The exit code is deliberately not waited on. `explorer.exe` exits 1 on
 * success, routinely and by design, so checking it would report a failure
 * every single time it worked. The one failure worth hearing about is the
 * opener not existing at all, which arrives as an `error` event, and even that
 * only goes to the log — the reply already carried the path, so the person is
 * not left with nothing.
 */
export function revealFolder(dir: string): void {
  const opener = openerFor(process.platform);
  try {
    const child = spawn(opener, [dir], { detached: true, stdio: 'ignore' });
    child.on('error', (error) => {
      console.error(`Could not run ${opener}: ${(error as Error).message}`);
    });
    child.unref();
  } catch (error) {
    console.error(`Could not run ${opener}: ${(error as Error).message}`);
  }
}

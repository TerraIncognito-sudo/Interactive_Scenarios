/**
 * The show this process is running, of which there is at most one.
 *
 * The public server holds a registry because it serves many rooms at once for
 * people it will never meet. This process serves one person, sitting at it,
 * with one projector plugged in. A second show would be a second stage window
 * nobody asked for and a second clock competing for the same screen, so
 * `startShow` refuses rather than replacing: ending a running show is a thing
 * somebody does on purpose, with the Stop button, knowing what is on the wall.
 *
 * ---
 *
 * This file is also where the rule that survived the merge is enforced.
 *
 * The editor and the game server used to be two programs that could not reach
 * each other, and CLAUDE.md said the boundary's real content was advice:
 *
 *   > do not author into a folder a show is being served from right now
 *
 * Advice was all it could be, because neither half knew what the other was
 * doing. The failure it warns about is exact: assets are served off disk as
 * they are asked for, so renaming one mid-show is a 404 on the next projector
 * to reconnect, and deleting a take that is also the published file is a
 * silent beat in front of a room. One program knows both facts, so `heldBy`
 * turns the advice into a refusal — which is the honest account of what
 * merging the two cost and what it bought.
 */

import { Room } from './room.ts';
import { loadScenarioFile, type LoadedScenario } from '../../../shared/scenario/load.ts';
import { ProjectError, type ProjectPaths } from '../project.ts';
import { projectPaths } from '../projects.ts';

export type ShowSession = {
  /** The project folder the show was started from. Also what the lock names. */
  project: string;
  room: Room;
  paths: ProjectPaths;
  loaded: LoadedScenario;
  startedAt: number;
};

export type ShowStatus = {
  running: boolean;
  project?: string;
  scenario?: { id: string; title: string; description?: string };
  /** Non-fatal problems the checker found, worth seeing before an audience does. */
  warnings?: { nodeId?: string; message: string }[];
  phase?: string;
  beat?: number;
  startedAt?: number;
  /** Set once the show is linked to a relay. Absent is the ordinary state. */
  room?: string;
  presence?: { displays: number; players: number };
  displayReady?: boolean;
};

let current: ShowSession | undefined;

export function currentShow(): ShowSession | undefined {
  return current;
}

/**
 * Which show, if any, is holding this project folder.
 *
 * Returns the project name rather than a boolean so the refusal can say what
 * is holding it — "team-union is on the projector" is actionable where
 * "locked" is a puzzle.
 */
function heldBy(name: string): string | undefined {
  return current?.project === name ? current.project : undefined;
}

/**
 * Refuses an edit that would change a file the running show is about to open.
 *
 * Only the destructive ones: writing a prompt into `project.yaml` or renaming
 * a node cannot reach the projector, because the scenario was read into memory
 * when the show started and nothing re-reads it. What can reach it is anything
 * that moves, overwrites or deletes bytes under `assets/` — which is exactly
 * the set this guards.
 */
export function assertNotShowing(name: string, action: string): void {
  if (heldBy(name) === undefined) return;
  throw new ProjectError(
    `"${name}" is on the projector right now, so ${action} would change a file the ` +
      `show is about to open — assets are read off disk as the display asks for them. ` +
      `Stop the show first.`,
  );
}

export async function startShow(name: string): Promise<ShowStatus> {
  if (current) {
    throw new ProjectError(
      current.project === name
        ? `"${name}" is already running. Stop it first to start it again.`
        : `"${current.project}" is running. Stop that show before starting another.`,
    );
  }

  const paths = await projectPaths(name);
  const loaded = await loadScenarioFile(paths.scenario, paths.dir);

  // One argument, and the shrinkage is the rebuild. A Room used to need a
  // code, two tokens, a store and a clock reading, because it was one of many
  // on a public server and had to survive that server restarting. This one is
  // the show this process is running, and it needs the show.
  const room = new Room({ loaded });

  // A stall is one room's rather than every room's here, but it is still a
  // show sitting still in front of people — so it reaches the terminal the
  // operator started this from, which is the only log there is.
  room.onError = (error, nodeId) => {
    console.error(`  The show stalled at "${nodeId}":`, error);
  };

  current = { project: name, room, paths, loaded, startedAt: Date.now() };
  return showStatus();
}

/**
 * Ends the show. Returns false when there was none, so a double-click on Stop
 * is not an error.
 */
export function stopShow(): boolean {
  if (!current) return false;
  // `close()` rather than `shutdown()`: the show is over, not interrupted.
  // The stage window is told so, and goes back to its lobby.
  current.room.close();
  current = undefined;
  return true;
}

export function showStatus(): ShowStatus {
  if (!current) return { running: false };
  const { room, project, loaded, startedAt } = current;
  return {
    running: true,
    project,
    scenario: {
      id: loaded.scenario.id,
      title: loaded.scenario.title,
      description: loaded.scenario.description,
    },
    warnings: loaded.warnings.map((w) => ({ nodeId: w.nodeId, message: w.message })),
    phase: room.phase,
    beat: room.state.beat,
    startedAt,
    ...(room.joinCode !== undefined ? { room: room.joinCode } : {}),
    presence: { displays: room.displayCount, players: room.playerCount },
    displayReady: room.displayReady,
  };
}

/**
 * Releases the show because the *process* is stopping.
 *
 * The distinction `close()` and `shutdown()` draw on the server survives here
 * for a smaller reason that is the same reason: this hands the sockets back
 * without telling anybody the show ended, because it did not — the operator
 * pressed Ctrl-C, and what they see next is their own terminal.
 */
export function shutdownShow(): void {
  current?.room.shutdown();
  current = undefined;
}

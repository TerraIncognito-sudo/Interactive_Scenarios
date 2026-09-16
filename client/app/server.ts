/**
 * The client: one program that authors a show and then presents it.
 *
 * These were two processes that could not reach each other, and the boundary
 * was load-bearing — an editor able to write into the folder a live show is
 * served from will eventually do it by accident, in front of a room. What it
 * cost was everything that needed both halves at once: a show could not be
 * rehearsed without standing up a server and creating a room, the projector's
 * asset server and the editor's media server were two implementations of one
 * fact, and nothing at the desk could tell you anything about a running show.
 *
 * So the boundary moves rather than disappearing. The rule that was doing the
 * real work is the one CLAUDE.md always stated —
 *
 *   do not author into a folder a show is being served from right now
 *
 * — and one program knowing both facts is what finally makes it enforceable
 * instead of advisory. `assertNotShowing` in `show/session.ts` is that
 * enforcement, and the destructive project routes below go through it.
 *
 * It binds to loopback only. It writes files and has no authentication, and
 * now it also runs a show, which is one more reason it has no business being
 * reachable from anywhere but the machine it runs on.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join, extname } from 'node:path';
import { parseScenarioSource, type AssetSection } from '../../shared/scenario/load.ts';
import { analyzeScenario, simulate } from './analysis.ts';
import { declaredAssets } from './sections.ts';
import { ProjectError } from './project.ts';
import { modelStatuses } from './models.ts';
import { downloadModel } from './download.ts';
import { sidecarStatuses, stopAllSidecars } from './sidecar.ts';
import {
  editAssetField,
  editSectionField,
  editVoiceField,
  generate,
  publish,
  initProject,
  listProjects,
  migrateShots,
  deleteTake,
  importTake,
  recordReference,
  sortAssets,
  wireSprites,
  removePortrait,
  openProject,
  resolveMedia,
  saveProjectSource,
  saveScenarioSource,
  moveScenarioNode,
  addScenarioNode,
  removeScenarioNode,
  renameScenarioNode,
  retypeScenarioNode,
  addScenarioScene,
  removeScenarioScene,
  renameScenarioScene,
  setScenarioLobby,
  setScenarioSceneField,
  sceneUsers,
  setScenarioNodeField,
  addScenarioListItem,
  moveScenarioListItem,
  removeScenarioListItem,
  saveStoryboardSource,
  selectTake,
  syncFromStoryboard,
  pruneOrphans,
  retime,
  discardStrays,
  adoptTakes,
  renameToFormat,
  wireVoice,
  migrateProjectRecipes,
} from './projects.ts';
import { SCENE_FIELDS, type SceneField } from './scenes.ts';
import { showAsset, showManifest } from './show/assets.ts';
import {
  assertNotShowing,
  currentShow,
  showStatus,
  shutdownShow,
  startShow,
  stopShow,
} from './show/session.ts';
import { dropLink, goLive, goOffline, linkView, relinkNow } from './show/link.ts';
import { attachShowSocket, type ShowSocket } from './show/ws.ts';
import {
  browse,
  loadConfig,
  looksSynced,
  modelsRoot,
  recentWorkspaces,
  setModelsRoot,
  setWorkspace,
  workspace,
} from './workspace.ts';

const PUBLIC_DIR = join(import.meta.dirname, '..', 'web', 'board');

/**
 * The projector, built.
 *
 * The board is ten thousand lines of vanilla ES modules served raw, so an edit
 * is one reload away. The stage cannot be: it imports the production engine
 * and runs the same `reduce` this process does, which is what makes it a
 * fallback when the socket drops rather than a renderer that freezes. That
 * needs TypeScript, so it needs a bundler, so it has a dist folder.
 */
const STAGE_DIR = join(import.meta.dirname, '..', 'web', 'stage', 'dist');

// Rare on purpose, and not the game server's 8880 — both can run at once.
const PORT = Number(process.env.EDITOR_PORT ?? 8890);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    // A scenario is prose and structure; anything this large is a mistake.
    if (size > 2_000_000) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Everything the editor knows about a chunk of YAML, valid or not. */
function inspect(source: string) {
  const parsed = parseScenarioSource(source);
  if (!parsed.ok) {
    return { ok: false as const, message: parsed.message, problems: parsed.problems };
  }
  return {
    ok: true as const,
    warnings: parsed.warnings,
    analysis: analyzeScenario(parsed.scenario),
    // The nodes themselves, not just the summary. The Nodes tab builds a form
    // per node and needs every field the schema allows; deriving that from the
    // analysis would mean a second, thinner model of what a node is, and the
    // two would disagree about the first field anybody added.
    scenario: parsed.scenario,
    // What to offer when somebody clicks into an asset box. Here rather than on
    // the project endpoint because it needs no disk and no project.yaml: a
    // folder with only a scenario in it is a perfectly good thing to edit, and
    // its picker should still know the name of every still it already uses.
    assets: declaredAssets(parsed.scenario),
  };
}

/**
 * Sends a file, honouring a byte range.
 *
 * Range matters here even though the clips are seconds long: an `<audio>`
 * element with a seek bar asks for one, and a browser handed 200 for a range
 * request will play the clip but refuse to scrub it — which is exactly the
 * control an author reaches for when they want to hear the end of a line again.
 */
async function sendFile(
  request: IncomingMessage,
  response: ServerResponse,
  file: string,
  type: string,
): Promise<void> {
  const size = (await stat(file)).size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');

  let start = 0;
  let end = size - 1;
  if (range) {
    const [, from, to] = range;
    if (from) start = Number(from);
    else if (to) start = Math.max(0, size - Number(to));
    if (from && to) end = Math.min(end, Number(to));
    if (start >= size) {
      response.writeHead(416, { 'content-range': `bytes */${size}` });
      return void response.end();
    }
  }

  response.writeHead(range ? 206 : 200, {
    'content-type': type,
    'content-length': end - start + 1,
    'accept-ranges': 'bytes',
    ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    // The whole point of a take is that another one is coming. A cached clip
    // would have the author listening to the reading they just replaced.
    'cache-control': 'no-store',
  });

  if (request.method === 'HEAD') return void response.end();

  try {
    await pipeline(createReadStream(file, { start, end }), response);
  } catch (error) {
    // A reader that stopped reading is not a failure, and treating it as one
    // killed the whole process: the rejection escaped to the last-resort
    // handler, which tried to write a 500 over a reply whose headers had gone
    // out minutes earlier, and threw `ERR_HTTP_HEADERS_SENT` from inside a
    // `.catch` — an unhandled rejection, which is a dead client in the middle
    // of a show. One aborted download did that, reliably.
    //
    // They are not rare. The projector prefetches a few hundred assets in the
    // seconds after a show starts, so a reloaded stage window cancels most of
    // them at once; and at a desk, every `<audio>` the board stops or scrubs
    // is another. Nothing can be said to a socket that has gone anyway — the
    // status line left with the first byte.
    if (!request.destroyed && !response.destroyed) throw error;
  }
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.includes('..')) {
    return sendJson(response, 404, { error: 'Not found' });
  }

  try {
    const body = await readFile(join(PUBLIC_DIR, name));
    response.writeHead(200, {
      'content-type': MIME[extname(name)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    sendJson(response, 404, { error: 'Not found' });
  }
}

/**
 * Serves the stage bundle.
 *
 * A second branch rather than a relaxation of `serveStatic`'s allow-list,
 * which is deliberate. That list is a set of flat filenames because the board
 * is a set of flat filenames; Vite emits `assets/main-B7pK2x9f.js`, so
 * widening the first check to admit a slash would quietly widen the board's
 * too. Two narrow rules that each describe one folder, not one loose rule
 * covering both.
 */
async function serveStage(pathname: string, response: ServerResponse): Promise<void> {
  const rest = pathname.slice('/stage/'.length);
  let file: string;

  if (rest === '' || rest === 'index.html') {
    file = join(STAGE_DIR, 'index.html');
  } else {
    const match = /^assets\/([A-Za-z0-9._-]+)$/.exec(rest);
    if (!match || match[1]!.includes('..')) {
      return sendJson(response, 404, { error: 'Not found' });
    }
    file = join(STAGE_DIR, 'assets', match[1]!);
  }

  try {
    const body = await readFile(file);
    response.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      // Hashed filenames could be cached forever, but the operator reloads this
      // window to recover from things and a stale projector is the one cache
      // nobody can debug from the back of a room.
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    if (rest === '' || rest === 'index.html') {
      // Said in the window that was opened to show a projector, because that
      // is where somebody is looking when it does not appear.
      response.writeHead(200, { 'content-type': MIME['.html']! });
      response.end(
        '<!doctype html><meta charset="utf-8"><title>Stage not built</title>' +
          '<body style="font:16px system-ui;background:#0b0d12;color:#e8ecf4;padding:3rem">' +
          '<h1>The stage has not been built</h1>' +
          '<p>Run <code>npm run build:stage</code> and reload this window.</p>',
      );
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
  }
}

/**
 * The show's sockets, so ending a show can drop them.
 *
 * Module-level rather than passed around: there is one process, one show and
 * one socket server, and threading a handle through forty route branches to
 * reach the one that stops a show would be ceremony about a singleton.
 */
let showSocket: ShowSocket | undefined;

/**
 * Builds the server without listening.
 *
 * Split out so the tests can put it on an ephemeral port. They drive the real
 * routes over a real socket, which is the discipline the server tests kept and
 * the reason those caught what they caught.
 */
export async function buildEditorServer() {
  await loadConfig();

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      // The last resort, and it must not be able to throw. It used to: a reply
      // already half-sent has no room for a 500, and `writeHead` says so by
      // throwing — from inside a `.catch`, where there is nothing left to
      // catch it, so the process exited. A route failing is a request failing;
      // it is never grounds for taking a running show down with it.
      //
      // Logged rather than only answered, because the reply goes to whichever
      // surface asked and the operator is looking at the other one. The method
      // and path are here for the same reason: the crash this replaces named
      // only this line, which is the one place in the file that knows nothing
      // about what was being served.
      console.error(`${request.method} ${request.url} failed`, error);
      try {
        if (response.headersSent || response.writableEnded) response.destroy();
        else sendJson(response, 500, { error: (error as Error).message });
      } catch {
        response.destroy();
      }
    });
  });

  showSocket = attachShowSocket(server);
  return server;
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname;

  // --- the show -----------------------------------------------------------
  //
  // First in the chain because the projector's prefetch comes through here a
  // few hundred times in the seconds after a show starts, and every one of
  // those would otherwise walk the whole router looking for itself.

  if (path.startsWith('/project-assets/')) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return sendJson(response, 405, { error: 'Not allowed' });
    }
    try {
      const asset = await showAsset(decodeURIComponent(path.slice('/project-assets/'.length)));
      // `return await`, not `return`. A returned promise leaves the `try`
      // without being awaited, so this `catch` never saw anything `sendFile`
      // did -- which is how a cancelled download reached the last-resort
      // handler instead of this one.
      return await sendFile(request, response, asset.path, asset.type);
    } catch (err) {
      // Nothing to say once the file has started going out. Reaching here with
      // headers sent means a real read error mid-stream, and the reply it
      // would have to be written over is already a partial asset.
      if (response.headersSent || response.writableEnded) return void response.destroy();
      // 404 rather than 400 even for a malformed name: this is the display's
      // hot path, and every failure here already reaches the operator as a
      // number on the readiness report. A distinction nobody reads is a
      // distinction that costs a branch.
      return sendJson(response, 404, { error: (err as Error).message });
    }
  }

  if (path === '/api/show' && request.method === 'GET') {
    return sendJson(response, 200, { ...showStatus(), link: linkView() });
  }

  if (path === '/api/show/scenario' && request.method === 'GET') {
    // Ungated, unlike the server's version of this, and the difference is the
    // whole rebuild in one line: that endpoint needed a token because it
    // carries every branch and ending and an audience member with the network
    // tab open could have read the story ahead. There is no audience on
    // loopback. The only reader is the window this process opened.
    try {
      return sendJson(response, 200, await showManifest());
    } catch (err) {
      return sendJson(response, 409, { error: (err as Error).message });
    }
  }

  if (path === '/api/show/start' && request.method === 'POST') {
    const body = (await readBody(request)) as { project?: unknown };
    if (typeof body.project !== 'string') {
      return sendJson(response, 400, { error: 'Expected { project }' });
    }
    try {
      return sendJson(response, 200, await startShow(body.project));
    } catch (err) {
      return sendJson(response, 400, { error: (err as Error).message });
    }
  }

  if (path === '/api/show/stop' && request.method === 'POST') {
    const was = currentShow()?.project;
    // The room goes before the show does. A relay left holding a code for a
    // show that has ended is a code that still answers, and the phones on it
    // wait for a question nothing is going to ask.
    await goOffline();
    const stopped = stopShow();
    // Every surface goes, so the stage window's own reconnect brings it back
    // against whatever runs next rather than sitting on the last frame of
    // something that has ended.
    if (stopped) showSocket?.dropAll();
    return sendJson(response, 200, { stopped, ...(was ? { project: was } : {}), ...showStatus() });
  }

  // --- the link ------------------------------------------------------------
  //
  // Three buttons on the board, and between them the entire audience-facing
  // half of this program. Everything else here runs on loopback for one person
  // at a desk; this is what puts a code on a wall.

  if (path === '/api/show/link' && request.method === 'POST') {
    const body = (await readBody(request)) as { relayUrl?: unknown; key?: unknown };
    try {
      return sendJson(
        response,
        200,
        await goLive({
          ...(typeof body.relayUrl === 'string' ? { relayUrl: body.relayUrl } : {}),
          ...(typeof body.key === 'string' ? { key: body.key } : {}),
        }),
      );
    } catch (err) {
      // 400 for "there is nothing to link" and its like. A relay that refused
      // the key is *not* an error here — it comes back 200 with a failed view
      // and a message, because the show is still running and the operator has
      // something to do about it.
      return sendJson(response, 400, { error: (err as Error).message });
    }
  }

  if (path === '/api/show/unlink' && request.method === 'POST') {
    return sendJson(response, 200, await goOffline());
  }

  if (path === '/api/show/link/reconnect' && request.method === 'POST') {
    // The cure for a socket that has gone quiet without closing. The room
    // stays open on the relay and the phones never notice.
    return sendJson(response, 200, relinkNow());
  }

  if (path === '/stage' && request.method === 'GET') {
    // The bundle's own asset URLs are relative, so a stage served without the
    // trailing slash asks for /assets/… at the root and gets four 404s and a
    // blank projector.
    response.writeHead(302, { location: '/stage/' });
    return void response.end();
  }

  if (path.startsWith('/stage/') && request.method === 'GET') {
    return serveStage(path, response);
  }

  // --- projects -----------------------------------------------------------
  //
  // A project is the workshop: a storyboard, a scenario, and the recipes and
  // takes for every asset the scenario asks for. It lives outside this repo,
  // and nothing it produces has to come back here.

  // The workspace is the folder the author keeps their scenarios in. The editor
  // has no opinion about where that is and asks on first run.
  if (path === '/api/workspace' && request.method === 'GET') {
    return sendJson(response, 200, {
      workspace: workspace(),
      recent: recentWorkspaces(),
      synced: workspace() ? looksSynced(workspace()!) : false,
      projects: await listProjects(),
    });
  }

  if (path === '/api/workspace' && request.method === 'POST') {
    const body = (await readBody(request)) as { path?: unknown };
    if (typeof body.path !== 'string') {
      return sendJson(response, 400, { error: 'Expected { path }' });
    }
    try {
      const chosen = await setWorkspace(body.path);
      return sendJson(response, 200, {
        workspace: chosen,
        recent: recentWorkspaces(),
        synced: looksSynced(chosen),
        projects: await listProjects(),
      });
    } catch (err) {
      return sendJson(response, 400, { error: (err as Error).message });
    }
  }

  // Serves the folder picker. `showDirectoryPicker()` in the browser hands the
  // page a handle and never a path, which is no use to a process that has to
  // open the files, so the listing comes from here instead.
  if (path === '/api/browse' && request.method === 'GET') {
    try {
      const files = url.searchParams.get('files');
      return sendJson(
        response,
        200,
        await browse(
          url.searchParams.get('path') ?? undefined,
          files ? files.split(',').filter(Boolean) : undefined,
        ),
      );
    } catch (err) {
      return sendJson(response, 400, { error: (err as Error).message });
    }
  }

  // Where model weights live, and which of them are actually on this disk.
  // Machine-level rather than per-project: `project.yaml` travels between
  // machines and a path to a folder of weights means nothing when it gets
  // there, while the model id it names still does.
  if (path === '/api/models' && request.method === 'GET') {
    return sendJson(response, 200, {
      root: modelsRoot(),
      models: await modelStatuses(modelsRoot()),
      sidecars: sidecarStatuses(),
    });
  }

  if (path === '/api/models' && request.method === 'POST') {
    const body = (await readBody(request)) as { path?: unknown };
    if (typeof body.path !== 'string') {
      return sendJson(response, 400, { error: 'Expected { path }' });
    }
    try {
      const root = await setModelsRoot(body.path);
      return sendJson(response, 200, { root, models: await modelStatuses(root) });
    } catch (err) {
      return sendJson(response, 400, { error: (err as Error).message });
    }
  }

  // Fetching the files for a model whose library will not fetch its own.
  // Slow — hundreds of megabytes — and answered when it is done rather than
  // streamed: the editor shows one spinner, and a progress bar for a download
  // that takes half a minute is not worth a second protocol.
  const downloadMatch = /^\/api\/models\/([a-z0-9-]+)\/download$/.exec(path);
  if (downloadMatch && request.method === 'POST') {
    try {
      const id = downloadMatch[1]!;
      let last = 0;
      const result = await downloadModel(id, modelsRoot(), ({ file, received, total }) => {
        // To the editor's terminal, so a long download is visibly alive.
        const percent = total ? Math.floor((received / total) * 100) : 0;
        if (percent >= last + 10) {
          last = percent;
          console.log(`  [${id}] ${file} ${percent}%`);
        }
      });
      return sendJson(response, 200, { ...result, models: await modelStatuses(modelsRoot()) });
    } catch (err) {
      return sendJson(response, 400, { error: (err as Error).message });
    }
  }

  // Stopping is worth a button. A loaded model holds the GPU, and the only
  // other way to get it back is to close the editor.
  if (path === '/api/models/stop' && request.method === 'POST') {
    stopAllSidecars();
    return sendJson(response, 200, { sidecars: sidecarStatuses() });
  }

  if (path === '/api/projects' && request.method === 'GET') {
    return sendJson(response, 200, { projects: await listProjects(), dir: workspace() });
  }

  // `[a-z-]` rather than `[a-z]`: a two-word action is a route that 404s while
  // looking perfectly correct at both ends, and the client's error for it —
  // "Not found" — points at the asset rather than at the URL.
  const projectMatch = /^\/api\/projects\/([^/]+)(?:\/([a-z][a-z-]*))?$/.exec(path);
  if (projectMatch) {
    const name = decodeURIComponent(projectMatch[1]!);
    const action = projectMatch[2];

    // One place rather than six call sites, because the cost of forgetting one
    // is a 404 on the projector halfway through an act. What is on the list is
    // everything that moves, overwrites or deletes bytes the display will ask
    // for by name while the show is running — the scenario itself is on it
    // because saving one re-derives recipes and can rename a published file.
    // Editing a prompt is not, and must not be: a show holds the scenario it
    // was started with in memory, so authoring the next draft while the
    // current one is on the wall is exactly the thing having one program makes
    // safe.
    const DESTRUCTIVE: Record<string, string> = {
      publish: 'publishing',
      folders: 'filing assets into folders',
      extensions: 'renaming a file to match its format',
      discard: 'discarding strays',
      'delete-take': 'deleting a take',
      scenario: 'saving the scenario',
    };
    if (action && action in DESTRUCTIVE && request.method !== 'GET') {
      try {
        assertNotShowing(name, DESTRUCTIVE[action]!);
      } catch (err) {
        return sendJson(response, 409, { error: (err as Error).message });
      }
    }

    try {
      if (!action && request.method === 'GET') {
        return sendJson(response, 200, await openProject(name));
      }

      if (action === 'project' && request.method === 'PUT') {
        const body = (await readBody(request)) as { source?: unknown };
        if (typeof body.source !== 'string') {
          return sendJson(response, 400, { error: 'Expected { source }' });
        }
        await saveProjectSource(name, body.source);
        return sendJson(response, 200, await openProject(name));
      }

      if (action === 'scenario' && request.method === 'PUT') {
        const body = (await readBody(request)) as { source?: unknown };
        if (typeof body.source !== 'string') {
          return sendJson(response, 400, { error: 'Expected { source }' });
        }
        // Saving the story re-derives the recipes on the same trip, and the
        // client says what moved: a line edited here silently re-records a
        // clip, and nobody should have to find that out from the board.
        const reconciled = await saveScenarioSource(name, body.source);
        return sendJson(response, 200, { ...(await openProject(name)), reconciled });
      }

      if (action === 'asset' && request.method === 'PATCH') {
        const body = (await readBody(request)) as {
          file?: unknown;
          field?: unknown;
          value?: unknown;
        };
        if (typeof body.file !== 'string' || typeof body.field !== 'string') {
          return sendJson(response, 400, { error: 'Expected { file, field, value }' });
        }
        await editAssetField(name, {
          file: body.file,
          field: body.field as 'prompt',
          value:
            typeof body.value === 'boolean' || typeof body.value === 'number'
              ? body.value
              : String(body.value ?? ''),
        });
        return sendJson(response, 200, await openProject(name));
      }

      if (action === 'storyboard' && request.method === 'PUT') {
        const body = (await readBody(request)) as { source?: unknown };
        if (typeof body.source !== 'string') {
          return sendJson(response, 400, { error: 'Expected { source }' });
        }
        await saveStoryboardSource(name, body.source);
        return sendJson(response, 200, await openProject(name));
      }

      // Playing a take, a published file, or a character's reference clip.
      // Everything else the board shows is text about a sound; this is the
      // sound, and without it choosing between two takes is guesswork.
      if (action === 'media' && (request.method === 'GET' || request.method === 'HEAD')) {
        const media = await resolveMedia(name, {
          section: url.searchParams.get('section') ?? undefined,
          file: url.searchParams.get('file') ?? undefined,
          take: url.searchParams.get('take') ?? undefined,
          reference: url.searchParams.get('reference') ?? undefined,
        });
        // `return await` for the same reason as `/project-assets/` above: a
        // returned promise escapes this `try` unawaited, and a difference in
        // spelling between the file's two stream routes is a difference
        // somebody will read as meaning something.
        return await sendFile(request, response, media.path, media.type);
      }

      if (action === 'folders' && request.method === 'POST') {
        const result = await sortAssets(name);
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      if (action === 'init' && request.method === 'POST') {
        return sendJson(response, 200, await initProject(name));
      }

      if (action === 'migrate-recipes' && request.method === 'POST') {
        // A dry run answers "what would this do" without touching the ledger or
        // the project file. The button asks that first and shows the answer,
        // because this is one press that rewrites both.
        const body = (await readBody(request)) as { dryRun?: unknown };
        const result = await migrateProjectRecipes(name, { dryRun: body.dryRun === true });
        return sendJson(response, 200, {
          ...result,
          project: body.dryRun === true ? undefined : await openProject(name),
        });
      }

      if (action === 'prune' && request.method === 'POST') {
        const result = await pruneOrphans(name);
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      if (action === 'extensions' && request.method === 'POST') {
        const body = (await readBody(request)) as { files?: unknown };
        const files = Array.isArray(body.files)
          ? body.files.filter((entry): entry is string => typeof entry === 'string')
          : undefined;
        const result = await renameToFormat(name, files);
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      if (action === 'adopt' && request.method === 'POST') {
        const body = (await readBody(request)) as { files?: unknown };
        // Names only, and the server decides which of them are actually
        // waiting to be adopted — the same rule discard and retime follow.
        const files = Array.isArray(body.files)
          ? body.files.filter((entry): entry is string => typeof entry === 'string')
          : undefined;
        const result = await adoptTakes(name, files);
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      if (action === 'discard' && request.method === 'POST') {
        const body = (await readBody(request)) as { files?: unknown };
        // Omitted means every stray the board found. Names only — the paths
        // are the server's to work out, and a name the board does not already
        // call a stray is refused rather than deleted.
        const files = Array.isArray(body.files)
          ? body.files.filter((entry): entry is string => typeof entry === 'string')
          : undefined;
        const result = await discardStrays(name, files);
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      if (action === 'shots' && request.method === 'POST') {
        const result = await migrateShots(name);
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      if (action === 'sprites' && request.method === 'POST') {
        const result = await wireSprites(name);
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      // The inverse of `sprites`, and a route of its own rather than a field
      // edit: a `sprite:` written inside a flow map is a different deletion
      // from one on its own line, and the author should not have to know which
      // theirs is.
      if (action === 'portrait-remove' && request.method === 'POST') {
        const body = (await readBody(request)) as { character?: unknown };
        if (typeof body.character !== 'string') {
          return sendJson(response, 400, { error: 'Expected { character }' });
        }
        const result = await removePortrait(name, body.character);
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      if (action === 'voice' && request.method === 'POST') {
        const result = await wireVoice(name);
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      // The Nodes tab. Each of these rewrites `scenario.yaml` and hands the
      // new source back, because the source tab holds its own copy: refresh it
      // late and the next Save quietly reverts everything the drag just did.
      if (action === 'node-move' && request.method === 'POST') {
        const body = (await readBody(request)) as { id?: unknown; toIndex?: unknown };
        if (typeof body.id !== 'string' || typeof body.toIndex !== 'number') {
          return sendJson(response, 400, { error: 'Expected { id, toIndex }' });
        }
        const result = await moveScenarioNode(name, body.id, body.toIndex);
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      if (action === 'node-add' && request.method === 'POST') {
        const body = (await readBody(request)) as {
          id?: unknown;
          nodeType?: unknown;
          after?: unknown;
          fields?: unknown;
        };
        if (typeof body.id !== 'string' || typeof body.nodeType !== 'string') {
          return sendJson(response, 400, { error: 'Expected { id, nodeType }' });
        }
        const fields =
          body.fields && typeof body.fields === 'object'
            ? (body.fields as Record<string, string | number>)
            : undefined;
        const result = await addScenarioNode(
          name,
          { id: body.id, type: body.nodeType, fields },
          typeof body.after === 'string' ? body.after : undefined,
        );
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      if (action === 'node-delete' && request.method === 'POST') {
        const body = (await readBody(request)) as { id?: unknown };
        if (typeof body.id !== 'string') {
          return sendJson(response, 400, { error: 'Expected { id }' });
        }
        const result = await removeScenarioNode(name, body.id);
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      if (action === 'node' && request.method === 'PATCH') {
        const body = (await readBody(request)) as {
          id?: unknown;
          path?: unknown;
          value?: unknown;
          after?: unknown;
        };
        if (typeof body.id !== 'string' || !Array.isArray(body.path) || body.path.length === 0) {
          return sendJson(response, 400, { error: 'Expected { id, path, value }' });
        }
        const path = body.path.filter(
          (step): step is string | number => typeof step === 'string' || typeof step === 'number',
        );
        if (path.length !== body.path.length) {
          return sendJson(response, 400, { error: 'A path step must be a name or an index' });
        }
        const value = body.value;
        if (
          value !== null &&
          typeof value !== 'string' &&
          typeof value !== 'number' &&
          typeof value !== 'boolean'
        ) {
          return sendJson(response, 400, { error: 'Expected a scalar value, or null to clear it' });
        }
        const result = await setScenarioNodeField(
          name,
          body.id,
          path,
          value,
          typeof body.after === 'string' ? body.after : undefined,
        );
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      // Changing a node's id, and every pointer that names it. Called
      // `node-id` because a guard in the tests scans this file for the verb
      // for moving a file on disk, which must never appear here — every write
      // the editor makes goes through projects.ts, inside the workspace. The
      // guard is deliberately blunt, and a route literal is not worth
      // blunting it for.
      if (action === 'node-id' && request.method === 'POST') {
        const body = (await readBody(request)) as { id?: unknown; to?: unknown };
        if (typeof body.id !== 'string' || typeof body.to !== 'string') {
          return sendJson(response, 400, { error: 'Expected { id, to }' });
        }
        const result = await renameScenarioNode(name, body.id, body.to);
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      // Changing what kind of beat a node is. Its own route rather than a
      // field edit on `type`, because the discriminator and the shape have to
      // move together — see `retypeNode`.
      if (action === 'node-type' && request.method === 'POST') {
        const body = (await readBody(request)) as { id?: unknown; to?: unknown };
        if (typeof body.id !== 'string' || typeof body.to !== 'string') {
          return sendJson(response, 400, { error: 'Expected { id, to }' });
        }
        const result = await retypeScenarioNode(name, body.id, body.to);
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      // ---------------------------------------------------------------------
      // Scenes
      // ---------------------------------------------------------------------

      if (action === 'scene-add' && request.method === 'POST') {
        const body = (await readBody(request)) as { id?: unknown };
        if (typeof body.id !== 'string') {
          return sendJson(response, 400, { error: 'Expected { id }' });
        }
        const result = await addScenarioScene(name, body.id);
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      // Its own route rather than a field edit, for the reason `node-id` is:
      // an id is the only value other lines depend on by name, so the key, every
      // node's `scene:` and the `lobby:` move together or not at all.
      if (action === 'scene-id' && request.method === 'POST') {
        const body = (await readBody(request)) as { id?: unknown; to?: unknown };
        if (typeof body.id !== 'string' || typeof body.to !== 'string') {
          return sendJson(response, 400, { error: 'Expected { id, to }' });
        }
        const result = await renameScenarioScene(name, body.id, body.to);
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      if (action === 'scene-delete' && request.method === 'POST') {
        const body = (await readBody(request)) as { id?: unknown };
        if (typeof body.id !== 'string') {
          return sendJson(response, 400, { error: 'Expected { id }' });
        }
        const result = await removeScenarioScene(name, body.id);
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      if (action === 'scene' && request.method === 'PATCH') {
        const body = (await readBody(request)) as {
          id?: unknown;
          field?: unknown;
          value?: unknown;
        };
        if (typeof body.id !== 'string' || typeof body.field !== 'string') {
          return sendJson(response, 400, { error: 'Expected { id, field, value }' });
        }
        if (!(SCENE_FIELDS as readonly string[]).includes(body.field)) {
          return sendJson(response, 400, { error: `"${body.field}" is not a scene field` });
        }
        // An empty box clears the field rather than writing an empty string: a
        // scene that paints nothing is a real choice and has to stay
        // distinguishable from one nobody has filled in yet.
        const value =
          body.value === null || body.value === '' ? null : String(body.value ?? '').trim();
        const result = await setScenarioSceneField(
          name,
          body.id,
          body.field as SceneField,
          value === '' ? null : value,
        );
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      if (action === 'lobby' && request.method === 'POST') {
        const body = (await readBody(request)) as { id?: unknown };
        const id = body.id === null || body.id === '' ? null : String(body.id ?? '');
        const result = await setScenarioLobby(name, id);
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      if (action === 'scene-users' && request.method === 'POST') {
        const body = (await readBody(request)) as { id?: unknown };
        if (typeof body.id !== 'string') {
          return sendJson(response, 400, { error: 'Expected { id }' });
        }
        return sendJson(response, 200, { nodes: await sceneUsers(name, body.id) });
      }

      if (action === 'node-list' && request.method === 'POST') {
        const body = (await readBody(request)) as {
          id?: unknown;
          path?: unknown;
          fields?: unknown;
          index?: unknown;
          from?: unknown;
          to?: unknown;
        };
        if (typeof body.id !== 'string' || !Array.isArray(body.path)) {
          return sendJson(response, 400, { error: 'Expected { id, path }' });
        }
        const path = body.path.filter(
          (step): step is string | number => typeof step === 'string' || typeof step === 'number',
        );
        // A pair of indices reorders, one index removes, fields add. Three
        // verbs on one route because they are the same edit to the same list
        // and always arrive from the same view.
        const result =
          typeof body.from === 'number' && typeof body.to === 'number'
            ? await moveScenarioListItem(name, body.id, path, body.from, body.to)
            : typeof body.index === 'number'
            ? await removeScenarioListItem(name, body.id, path, body.index)
            : await addScenarioListItem(
                name,
                body.id,
                path,
                (body.fields ?? {}) as Record<string, string | number>,
              );
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      if (action === 'retime' && request.method === 'POST') {
        const body = (await readBody(request)) as { files?: unknown };
        // Omitted means every mistimed clip. The numbers are never sent —
        // they are computed from the runtimes the board measured, so a client
        // cannot write a beat nothing on the board agrees with.
        const files = Array.isArray(body.files)
          ? body.files.filter((entry): entry is string => typeof entry === 'string')
          : undefined;
        const result = await retime(name, files);
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }
      if (action === 'sync' && request.method === 'POST') {
        const result = await syncFromStoryboard(name);
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      if (action === 'voice' && request.method === 'PATCH') {
        const body = (await readBody(request)) as Record<string, unknown>;
        if (typeof body.voice !== 'string' || typeof body.field !== 'string') {
          return sendJson(response, 400, { error: 'Expected { voice, field, value }' });
        }
        await editVoiceField(name, {
          voice: body.voice,
          field: body.field as 'reference',
          value: String(body.value ?? ''),
        });
        return sendJson(response, 200, await openProject(name));
      }

      if (action === 'section' && request.method === 'PATCH') {
        const body = (await readBody(request)) as Record<string, unknown>;
        if (typeof body.section !== 'string' || typeof body.field !== 'string') {
          return sendJson(response, 400, { error: 'Expected { section, field, value }' });
        }
        await editSectionField(name, {
          section: body.section,
          field: body.field as 'backend',
          value: String(body.value ?? ''),
        });
        return sendJson(response, 200, await openProject(name));
      }

      if (action === 'reference' && request.method === 'POST') {
        const body = (await readBody(request)) as Record<string, unknown>;
        if (typeof body.voice !== 'string' || typeof body.preset !== 'string') {
          return sendJson(response, 400, { error: 'Expected { voice, preset }' });
        }
        const clip = await recordReference(name, {
          voice: body.voice,
          preset: body.preset,
          model: typeof body.model === 'string' ? body.model : undefined,
        });
        return sendJson(response, 200, { ...clip, project: await openProject(name) });
      }

      if (action === 'generate' && request.method === 'POST') {
        const body = (await readBody(request)) as { section?: unknown; files?: unknown };
        if (typeof body.section !== 'string' || !Array.isArray(body.files)) {
          return sendJson(response, 400, { error: 'Expected { section, files }' });
        }
        const result = await generate(name, {
          section: body.section as 'voice',
          files: body.files.map(String),
        });
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      if (action === 'publish' && request.method === 'POST') {
        const body = (await readBody(request)) as { section?: unknown; files?: unknown };
        if (typeof body.section !== 'string' || !Array.isArray(body.files)) {
          return sendJson(response, 400, { error: 'Expected { section, files }' });
        }
        const result = await publish(name, {
          section: body.section as 'voice',
          files: body.files.map(String),
        });
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      // The bytes, raw, rather than JSON or a multipart envelope. A still is a
      // couple of megabytes and a clip is a hundred; base64 in a JSON body
      // would inflate that by a third and buffer all of it in memory to gain
      // nothing, when the metadata is three short strings that fit in a query.
      if (action === 'import' && request.method === 'POST') {
        const section = url.searchParams.get('section') ?? '';
        const file = url.searchParams.get('file') ?? '';
        const filename = url.searchParams.get('name') ?? '';
        if (!section || !file || !filename) {
          return sendJson(response, 400, { error: 'Expected ?section=&file=&name=' });
        }
        const result = await importTake(
          name,
          { section: section as AssetSection, file, filename },
          request,
        );
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      if (action === 'delete-take' && request.method === 'POST') {
        const body = (await readBody(request)) as {
          section?: unknown;
          asset?: unknown;
          take?: unknown;
        };
        if (
          typeof body.section !== 'string' ||
          typeof body.asset !== 'string' ||
          typeof body.take !== 'string'
        ) {
          return sendJson(response, 400, { error: 'Expected { section, asset, take }' });
        }
        await deleteTake(name, body.section as AssetSection, body.asset, body.take);
        return sendJson(response, 200, await openProject(name));
      }

      if (action === 'select' && request.method === 'POST') {
        const body = (await readBody(request)) as { asset?: unknown; take?: unknown };
        if (typeof body.asset !== 'string') {
          return sendJson(response, 400, { error: 'Expected { asset, take }' });
        }
        await selectTake(name, body.asset, typeof body.take === 'string' ? body.take : null);
        return sendJson(response, 200, await openProject(name));
      }
    } catch (err) {
      if (err instanceof ProjectError) {
        return sendJson(response, 400, { error: err.message, problems: err.problems });
      }
      throw err;
    }

    return sendJson(response, 405, { error: 'Method not allowed' });
  }

  if (path === '/api/analyze' && request.method === 'POST') {
    const body = (await readBody(request)) as { source?: unknown };
    if (typeof body.source !== 'string') {
      return sendJson(response, 400, { error: 'Expected { source }' });
    }
    return sendJson(response, 200, inspect(body.source));
  }

  if (path === '/api/simulate' && request.method === 'POST') {
    const body = (await readBody(request)) as {
      source?: unknown;
      choices?: Record<string, string>;
    };
    if (typeof body.source !== 'string') {
      return sendJson(response, 400, { error: 'Expected { source, choices }' });
    }
    const parsed = parseScenarioSource(body.source);
    if (!parsed.ok) {
      return sendJson(response, 400, { error: parsed.message, problems: parsed.problems });
    }
    return sendJson(response, 200, simulate(parsed.scenario, body.choices ?? {}));
  }

  if (request.method === 'GET') return serveStatic(path, response);
  sendJson(response, 404, { error: 'Not found' });
}

// Loopback only. This process writes files, runs a show and has no
// authentication; it has no business being reachable from anywhere but the
// machine it runs on.
async function main(): Promise<void> {
  const server = await buildEditorServer();

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  Interactive Scenario   http://localhost:${PORT}`);
    console.log(
      `  Workspace              ${workspace() ?? '(none chosen yet — pick one in the app)'}`,
    );
    console.log('');
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      // Before the server, because a model process outliving this one holds
      // the GPU with nothing left able to reach it — and the only cure anyone
      // finds for that is a reboot.
      stopAllSidecars();
      // Shutdown rather than close: the process is stopping, and telling the
      // stage window the show ended would be a claim about the show rather
      // than about the machine. What happens next is somebody's own terminal.
      // Drop rather than unlink, for the same reason: the room on the relay is
      // not over, and a client that closed it on the way out would have thrown
      // away the one thing that makes a Ctrl-C survivable mid-show.
      dropLink();
      shutdownShow();
      server.close(() => process.exit(0));
    });
  }
}

// Only when run directly, so the tests can build a server without one of these
// binding 8890 out from under the app the author already has open.
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  await main();
}

/**
 * The scenario editor's local server.
 *
 * Deliberately not part of the game server, and deliberately unable to reach
 * it. Authoring happens at a desk over weeks; the game server runs in front of
 * an audience. This process writes only inside the author's chosen workspace —
 * it cannot read or write `scenarios/`, and there is no route that would let
 * it. Deploying is a person copying a finished folder across, on purpose,
 * when they mean to.
 *
 * That is a hard boundary rather than a convention: an editor that can write
 * into the folder a live show is being served from will eventually do it by
 * accident, and the failure lands in front of a room.
 *
 * It binds to loopback only. It writes files and has no authentication.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { parseScenarioSource } from '../../src/scenario/load.ts';
import { analyzeScenario, simulate } from './analysis.ts';
import { ProjectError } from './project.ts';
import { modelStatuses } from './models.ts';
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
  openProject,
  saveProjectSource,
  saveScenarioSource,
  saveStoryboardSource,
  selectTake,
  syncFromStoryboard,
  pruneOrphans,
  wireVoice,
} from './projects.ts';
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

const PUBLIC_DIR = join(import.meta.dirname, 'public');

// Rare on purpose, and not the game server's 8880 — both can run at once.
const PORT = Number(process.env.EDITOR_PORT ?? 8890);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
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
  };
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

const server = createServer((request, response) => {
  void handle(request, response).catch((error: unknown) => {
    sendJson(response, 500, { error: (error as Error).message });
  });
});

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname;

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

  // Stopping is worth a button. A loaded model holds the GPU, and the only
  // other way to get it back is to close the editor.
  if (path === '/api/models/stop' && request.method === 'POST') {
    stopAllSidecars();
    return sendJson(response, 200, { sidecars: sidecarStatuses() });
  }

  if (path === '/api/projects' && request.method === 'GET') {
    return sendJson(response, 200, { projects: await listProjects(), dir: workspace() });
  }

  const projectMatch = /^\/api\/projects\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
  if (projectMatch) {
    const name = decodeURIComponent(projectMatch[1]!);
    const action = projectMatch[2];

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
        await saveScenarioSource(name, body.source);
        return sendJson(response, 200, await openProject(name));
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
          value: typeof body.value === 'boolean' ? body.value : String(body.value ?? ''),
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

      if (action === 'init' && request.method === 'POST') {
        return sendJson(response, 200, await initProject(name));
      }

      if (action === 'prune' && request.method === 'POST') {
        const result = await pruneOrphans(name);
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      if (action === 'shots' && request.method === 'POST') {
        const result = await migrateShots(name);
        return sendJson(response, 200, { ...result, project: await openProject(name) });
      }

      if (action === 'voice' && request.method === 'POST') {
        const result = await wireVoice(name);
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

// Loopback only. This process writes files and has no authentication; it has no
// business being reachable from anywhere but the machine it runs on.
await loadConfig();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Scenario editor   http://localhost:${PORT}`);
  console.log(`  Workspace         ${workspace() ?? '(none chosen yet — pick one in the editor)'}`);
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // Before the server, because a model process outliving the editor holds
    // the GPU with nothing left able to reach it — and the only cure anyone
    // finds for that is a reboot.
    stopAllSidecars();
    server.close(() => process.exit(0));
  });
}

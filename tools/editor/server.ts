/**
 * The scenario editor's local server.
 *
 * Deliberately not part of the game server. Authoring happens at a desk, days
 * before a show; the game server runs in front of an audience. Keeping them
 * separate means this tool can write files, reload freely and change shape
 * without any of that being reachable from the public internet.
 *
 * It binds to loopback only, and it is the one process in this project that
 * writes to `scenarios/`. Both of those are deliberate.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, rename, readdir, stat } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { parseScenarioSource } from '../../src/scenario/load.ts';
import { analyzeScenario, simulate } from './analysis.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PUBLIC_DIR = join(import.meta.dirname, 'public');
const SCENARIOS_DIR = resolve(process.env.SCENARIOS_DIR ?? join(ROOT, 'scenarios'));

// Rare on purpose, and not the game server's 8880 — both can run at once.
const PORT = Number(process.env.EDITOR_PORT ?? 8890);

/**
 * Folder names come from the client and are used to build a path, so they are
 * checked against a whitelist rather than sanitised. Nothing outside
 * `scenarios/<name>/scenario.yaml` is reachable.
 */
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

function scenarioFile(folder: string): string | undefined {
  if (!SAFE_NAME.test(folder)) return undefined;
  return join(SCENARIOS_DIR, folder, 'scenario.yaml');
}

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

async function listScenarios() {
  let entries: string[];
  try {
    entries = await readdir(SCENARIOS_DIR);
  } catch {
    return [];
  }

  const folders = [];
  for (const entry of entries.sort()) {
    if (!SAFE_NAME.test(entry)) continue;
    const info = await stat(join(SCENARIOS_DIR, entry)).catch(() => null);
    if (!info?.isDirectory()) continue;

    let source: string;
    try {
      source = await readFile(join(SCENARIOS_DIR, entry, 'scenario.yaml'), 'utf8');
    } catch {
      continue;
    }

    const result = inspect(source);
    folders.push({
      folder: entry,
      title: result.ok ? result.analysis.title : entry,
      ok: result.ok,
      // A broken scenario is listed, not hidden — being unable to open the one
      // file you need to fix would be a poor editor.
      message: result.ok ? undefined : result.message,
      nodes: result.ok ? result.analysis.counts.nodes : 0,
      polls: result.ok ? result.analysis.counts.polls : 0,
    });
  }
  return folders;
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

  if (path === '/api/scenarios' && request.method === 'GET') {
    return sendJson(response, 200, { scenarios: await listScenarios(), dir: SCENARIOS_DIR });
  }

  // /api/scenarios/<folder>/source
  const sourceMatch = /^\/api\/scenarios\/([^/]+)\/source$/.exec(path);
  if (sourceMatch) {
    const file = scenarioFile(decodeURIComponent(sourceMatch[1]!));
    if (!file) return sendJson(response, 400, { error: 'Bad scenario name' });

    if (request.method === 'GET') {
      try {
        const source = await readFile(file, 'utf8');
        return sendJson(response, 200, { source, ...inspect(source) });
      } catch {
        return sendJson(response, 404, { error: 'No scenario.yaml in that folder' });
      }
    }

    if (request.method === 'PUT') {
      const body = (await readBody(request)) as { source?: unknown };
      if (typeof body.source !== 'string') {
        return sendJson(response, 400, { error: 'Expected { source }' });
      }
      // Temp file plus rename, so a crash mid-write cannot leave a half-written
      // scenario behind — the game server may be reading this same folder.
      const temp = `${file}.tmp`;
      await writeFile(temp, body.source, 'utf8');
      await rename(temp, file);
      return sendJson(response, 200, { saved: true, ...inspect(body.source) });
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
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Scenario editor   http://localhost:${PORT}`);
  console.log(`  Reading           ${SCENARIOS_DIR}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

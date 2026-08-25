/**
 * Proving a voice backend works, before trusting it with a show.
 *
 * `npm run voice:check` — the placeholder, which needs nothing.
 * `npm run voice:check -- chatterbox` — the real thing, once it is installed.
 * `npm run voice:check -- chatterbox path/to/reference.wav` — with a voice.
 *
 * This exists because the failures worth catching all happen at load time and
 * all look the same from the editor: a button that spins and then says the
 * generator stopped. Run here, the same failures arrive as the Python sentence
 * that explains them — a CPU-only torch wheel, a card the wheels have no
 * kernels for, an MP3 encoder libsndfile is too old to have.
 *
 * It drives the real bridge rather than a copy of it, so a pass here means the
 * editor's path works, not merely that Python can be started.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelById, modelStatus } from '../editor/models.ts';
import { loadConfig, modelsRoot } from '../editor/workspace.ts';
import { voiceEnvDir } from './env.ts';
import {
  sidecarFor,
  stopAllSidecars,
  SidecarError,
  type SidecarInfo,
} from '../editor/sidecar.ts';

const LINE = 'Zero four hundred, Halifax. The pier is busy the way it always is.';

function say(label: string, value: string): void {
  console.log(`  ${label.padEnd(14)} ${value}`);
}

async function main(): Promise<number> {
  const [backend = 'placeholder', reference] = process.argv.slice(2);

  const spec = modelById(backend);
  if (!spec) {
    console.error(`\n  Unknown backend "${backend}". Known: placeholder, chatterbox.\n`);
    return 1;
  }

  await loadConfig();
  const root = modelsRoot();
  const status = await modelStatus(root, spec);

  console.log(`\n  Checking ${spec.title}\n`);
  say('environment', voiceEnvDir());
  say('models root', root ?? '(not set — choose one in the editor first)');
  say('weights', status.installed ? (status.path ?? 'bundled') : 'not downloaded yet');
  if (reference) say('reference', reference);

  // Said before the attempt rather than after it fails, because the download is
  // the slow part and finding out at the end of it is the worst moment.
  if (!status.installed && spec.repo) {
    say('note', `will be downloaded to ${root ?? '(nowhere — set a models root)'}`);
  }

  const scratch = await mkdtemp(join(tmpdir(), 'voice-check-'));
  const out = join(scratch, 'check.mp3');

  try {
    const started = Date.now();
    const sidecar = await sidecarFor({
      backend: spec.id,
      modelPath: status.local ? status.path : undefined,
      modelsRoot: root,
    });
    say('loaded in', `${((Date.now() - started) / 1000).toFixed(1)}s`);

    const info: Partial<SidecarInfo> = sidecar.info ?? {};
    say('device', String(info.gpu ?? info.device ?? 'unknown'));

    // The single most common silent failure: everything installs, imports and
    // runs, and does it on the processor at a minute a line.
    if (info.device === 'cpu' && spec.id !== 'placeholder') {
      say('warning', 'running on CPU — see the troubleshooting section of the walkthrough');
    }

    const result = await sidecar.request('selftest', {
      text: LINE,
      out,
      ...(reference ? { reference } : {}),
    });

    const bytes = (await readFile(out)).length;
    say('wrote', `${out} (${bytes} bytes)`);
    say('length', `${result.seconds}s in ${result.ms}ms`);
    console.log(`\n  OK — ${spec.title} works, and MP3 came out the other end.\n`);
    return 0;
  } catch (err) {
    console.error(`\n  FAILED: ${(err as Error).message}\n`);
    if (err instanceof SidecarError && err.detail) {
      console.error(err.detail.split('\n').slice(-25).join('\n'));
      console.error('');
    }
    return 1;
  } finally {
    stopAllSidecars();
    await rm(scratch, { recursive: true, force: true });
  }
}

process.exit(await main());

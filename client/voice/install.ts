/**
 * Installing a voice backend's dependencies.
 *
 * `npm run voice:install` — the base environment. Seconds, about 50 MB.
 * `npm run voice:install -- chatterbox` — adds PyTorch and the model code.
 *
 * A wrapper around `uv sync` rather than a line in the walkthrough telling
 * people to run `uv sync` themselves, for one reason: the environment has to be
 * built outside this repo. The repo is in OneDrive and the chatterbox extra is
 * three gigabytes of CUDA wheels. Someone following a documented `uv sync` would
 * get the default `.venv` beside the code, and find out months later.
 */

import { spawn } from 'node:child_process';
import { modelById } from '../app/models.ts';
import { voiceEnvDir } from './env.ts';

const SIDECAR_DIR = import.meta.dirname;

async function main(): Promise<number> {
  const backend = process.argv[2];
  const spec = backend ? modelById(backend) : undefined;

  if (backend && !spec) {
    console.error(`\n  Unknown backend "${backend}". Known: placeholder, chatterbox.\n`);
    return 1;
  }

  const env = voiceEnvDir();
  const args = ['sync', '--project', SIDECAR_DIR];
  if (spec?.extra) args.push('--extra', spec.extra);

  console.log(`\n  Installing ${spec?.title ?? 'the base sidecar'}`);
  console.log(`  into ${env}`);
  if (spec?.sizeGb) {
    console.log(`  about ${spec.sizeGb} GB of weights follow on first use\n`);
  } else {
    console.log('');
  }

  return new Promise<number>((resolve) => {
    const child = spawn('uv', args, {
      cwd: SIDECAR_DIR,
      env: { ...process.env, UV_PROJECT_ENVIRONMENT: env },
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });
    child.on('error', (error) => {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      console.error(
        missing
          ? '\n  uv is not on PATH. Install it with `winget install astral-sh.uv`, ' +
              'then open a new terminal.\n'
          : `\n  ${error.message}\n`,
      );
      resolve(1);
    });
    child.on('exit', (code) => {
      if (code === 0) console.log('\n  Done. Check it with `npm run voice:check`.\n');
      resolve(code ?? 1);
    });
  });
}

process.exit(await main());

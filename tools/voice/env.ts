/**
 * Where the sidecar's virtualenv lives — and why it is not next to its code.
 *
 * uv's default is `.venv` beside `pyproject.toml`, which would put it inside
 * this repo. This repo is inside OneDrive. The chatterbox extra is about three
 * gigabytes of CUDA PyTorch, and a sync client discovering that is a slow,
 * expensive, silent problem that ends with a full drive and a support call to
 * nobody.
 *
 * So the environment is relocated out of the tree entirely, by handing uv
 * `UV_PROJECT_ENVIRONMENT`. Every caller uses this one function, because two
 * answers would mean two multi-gigabyte environments and a very confusing
 * afternoon establishing which one is being used.
 *
 * Set `UV_PROJECT_ENVIRONMENT` yourself to override it.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export function voiceEnvDir(): string {
  const override = process.env.UV_PROJECT_ENVIRONMENT;
  if (override) return override;

  // The conventional home for a large, rebuildable, machine-local artefact.
  // Not the models root: that is chosen in the editor and can be changed, and
  // an environment that moved when you repointed the model folder would be a
  // surprise measured in gigabytes.
  const base =
    process.platform === 'win32'
      ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
      : (process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'));

  return join(base, 'interactive-scenario', 'voice-env');
}

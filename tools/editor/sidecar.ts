/**
 * The editor's handle on a generator process.
 *
 * A text-to-speech model takes tens of seconds to load and holds a GPU while
 * it is up, so it cannot be a process per clip — ninety lines would spend an
 * hour loading weights. It also cannot be started with the editor, because the
 * editor is opened every day to write dialogue and most of those days involve
 * no generation at all. So it starts on the first request and stays warm.
 *
 * Talking over the child's stdin and stdout rather than a socket is what makes
 * that safe. A pipe dies with its parent: a crashed or force-quit editor
 * cannot strand a process sitting on sixteen gigabytes of VRAM, which is
 * exactly the failure that teaches people to reboot before working. It also
 * avoids asking someone who wanted to hear a line read aloud to answer a
 * Windows firewall prompt.
 *
 * One request at a time. There is one GPU, and a queue that is visible in the
 * editor is worth more than concurrency that is not.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { hfHome } from './models.ts';
import { voiceEnvDir } from '../voice/env.ts';

/** Repo-relative, because the sidecar ships with the editor rather than the show. */
const SIDECAR_DIR = join(import.meta.dirname, '..', 'voice');

/**
 * Loading weights off a cold disk is slow, and the first run of all downloads
 * them. Long enough not to give up on a real install; short enough that a
 * genuinely wedged process does not hold the editor forever.
 */
const START_TIMEOUT_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 10 * 60_000;

export type SidecarOptions = {
  backend: string;
  /** Weights on disk, when they were fetched by hand rather than downloaded. */
  modelPath?: string;
  /** Where a backend that downloads its own weights should put them. */
  modelsRoot?: string;
};

export type SidecarInfo = {
  backend: string;
  device?: string;
  clones?: boolean;
  /** The model's own voices, as it reports them. */
  voices?: string[];
  gpu?: string | null;
  sampleRate?: number;
};

export type SpeakRequest = {
  text: string;
  out: string;
  reference?: string;
  /** One of the model's own voices, for a model that has a palette. */
  preset?: string;
  seed?: number;
  /** Length hint, used by the placeholder and ignored by a real model. */
  seconds?: number;
  params?: Record<string, string | number | boolean>;
};

export type SpeakResult = {
  file: string;
  seconds: number;
  ms: number;
  /** What the scenario's `hold:` should be for this clip: its length, rounded up. */
  hold: number;
};

/**
 * A tqdm progress bar, redrawing itself.
 *
 * On a terminal these overwrite one line with a carriage return. Through a
 * pipe every redraw is a separate line, so one clip arrives as two hundred of
 * them — which buries the warnings that matter and makes the kept stderr ring
 * useless exactly when a traceback needs it.
 *
 * The last one is kept, because "Sampling: 100%" is worth seeing and the
 * ninety-nine before it are not.
 */
const PROGRESS = /\d+%\|.*\|\s*\d+\/\d+/;

export class SidecarError extends Error {
  /** The child's stderr, which is where a Python traceback actually lands. */
  readonly detail: string;

  constructor(message: string, detail = '') {
    super(message);
    this.name = 'SidecarError';
    this.detail = detail;
  }
}

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

class Sidecar {
  readonly key: string;
  readonly options: SidecarOptions;
  info: SidecarInfo | undefined;

  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<SidecarInfo> | undefined;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stdoutBuffer = '';
  /**
   * A ring of the child's recent stderr. When a model fails to load, the
   * useful part is the traceback, and the process is gone by the time anyone
   * thinks to look for it.
   */
  private stderr: string[] = [];
  /** Serialises requests: one GPU, one line at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(key: string, options: SidecarOptions) {
    this.key = key;
    this.options = options;
  }

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null;
  }

  recentErrors(): string {
    return this.stderr.join('\n');
  }

  async start(): Promise<SidecarInfo> {
    if (this.info && this.running) return this.info;
    this.starting ??= this.spawn().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private spawn(): Promise<SidecarInfo> {
    const args = [
      'run',
      '--project',
      SIDECAR_DIR,
      ...(this.options.backend === 'placeholder' ? [] : ['--extra', this.options.backend]),
      'python',
      '-m',
      'voice',
      '--backend',
      this.options.backend,
    ];
    if (this.options.modelPath) args.push('--model-path', this.options.modelPath);

    const child = spawn('uv', args, {
      cwd: SIDECAR_DIR,
      env: {
        ...process.env,
        // Weights land under the models root rather than several gigabytes
        // into the user profile, which is the one place they said not to put
        // them — and they would find out when the disk filled.
        ...(this.options.modelsRoot ? { HF_HOME: hfHome(this.options.modelsRoot) } : {}),
        // Out of the repo, which is inside OneDrive. uv's default would put
        // three gigabytes of CUDA wheels next to the code and sync every byte.
        UV_PROJECT_ENVIRONMENT: voiceEnvDir(),
        // Said once in the walkthrough; repeating it on every model load
        // trains people to ignore the warnings around it.
        HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
      },
      // On Windows `uv` is uv.exe on PATH; shell:false keeps arguments with
      // spaces in them — every path in this project has spaces — intact.
      shell: false,
      windowsHide: true,
    });

    this.child = child;
    this.stderr = [];

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Carriage returns as well as newlines: a redrawing progress bar sends
      // its frames separated by \r, and splitting only on \n would deliver a
      // hundred of them glued into a single unreadable line.
      for (const line of chunk.split(/\r?\n|\r/)) {
        if (!line.trim()) continue;

        if (PROGRESS.test(line)) {
          // Replace the previous frame rather than appending another.
          if (this.stderr.length > 0 && PROGRESS.test(this.stderr[this.stderr.length - 1]!)) {
            this.stderr[this.stderr.length - 1] = line;
          } else {
            this.stderr.push(line);
          }
          continue;
        }

        this.stderr.push(line);
        if (this.stderr.length > 200) this.stderr.shift();
        // Echoed as well as kept. A model that will not load is debugged from
        // the terminal the editor was started in, and a traceback that exists
        // only inside a ring buffer might as well not exist.
        console.error(`  [${this.options.backend}] ${line}`);
      }
    });

    return new Promise<SidecarInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stop();
        reject(new SidecarError('The generator did not start in time', this.recentErrors()));
      }, START_TIMEOUT_MS);

      const settle = (error?: Error, info?: SidecarInfo) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(info!);
      };

      child.stdout.on('data', (chunk: string) => {
        this.stdoutBuffer += chunk;
        let newline = this.stdoutBuffer.indexOf('\n');
        while (newline >= 0) {
          const line = this.stdoutBuffer.slice(0, newline).trim();
          this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
          if (line) this.receive(line, settle);
          newline = this.stdoutBuffer.indexOf('\n');
        }
      });

      child.on('error', (error) => {
        // The overwhelmingly likely cause, and worth saying plainly rather
        // than as ENOENT.
        const hint =
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'uv is not on PATH. Install it — see docs/voice-generation.md.'
            : error.message;
        settle(new SidecarError(hint, this.recentErrors()));
        this.failAll(new SidecarError(hint, this.recentErrors()));
      });

      child.on('exit', (code) => {
        this.child = undefined;
        this.info = undefined;
        const error = new SidecarError(
          `The generator stopped${code === null ? '' : ` (exit ${code})`}`,
          this.recentErrors(),
        );
        settle(error);
        this.failAll(error);
      });
    });
  }

  private receive(line: string, settle: (error?: Error, info?: SidecarInfo) => void): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Not protocol. The sidecar sends diagnostics on stderr, so anything
      // unparseable here is a library that printed to stdout despite the
      // precautions in protocol.py — keep it, do not let it break the stream.
      this.stderr.push(line);
      return;
    }

    if (message.event === 'ready') {
      this.info = message as unknown as SidecarInfo;
      settle(undefined, this.info);
      return;
    }
    if (message.event === 'error') {
      settle(new SidecarError(String(message.error ?? 'unknown error'), this.recentErrors()));
      return;
    }

    const id = typeof message.id === 'number' ? message.id : undefined;
    if (id === undefined) return;
    const waiting = this.pending.get(id);
    if (!waiting) return;
    this.pending.delete(id);
    clearTimeout(waiting.timer);

    if (message.ok === true) waiting.resolve(message);
    else {
      waiting.reject(
        new SidecarError(String(message.error ?? 'generation failed'), this.recentErrors()),
      );
    }
  }

  private failAll(error: Error): void {
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
  }

  /** Queued, so two clicks on two rows do not fight over one GPU. */
  request(op: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const run = async () => {
      await this.start();
      const child = this.child;
      if (!child) throw new SidecarError('The generator is not running', this.recentErrors());

      const id = this.nextId++;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new SidecarError('The generator took too long', this.recentErrors()));
        }, REQUEST_TIMEOUT_MS);
        this.pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`);
      });
    };

    // The queue holds the *order*; a failed request must not poison the ones
    // behind it, so the chain swallows rejections and each caller gets its own.
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  stop(): void {
    this.failAll(new SidecarError('The generator was stopped'));
    this.child?.kill();
    this.child = undefined;
    this.info = undefined;
  }
}

/**
 * One process per configuration.
 *
 * Keyed by backend and weights, so switching a section from the placeholder to
 * a real model starts the real one rather than quietly keeping the tone
 * generator alive under a new name.
 */
const running = new Map<string, Sidecar>();

function keyOf(options: SidecarOptions): string {
  return `${options.backend}|${options.modelPath ?? ''}|${options.modelsRoot ?? ''}`;
}

export async function sidecarFor(options: SidecarOptions): Promise<Sidecar> {
  const key = keyOf(options);
  let sidecar = running.get(key);
  if (!sidecar) {
    sidecar = new Sidecar(key, options);
    running.set(key, sidecar);
  }
  await sidecar.start();
  return sidecar;
}

export async function speak(
  options: SidecarOptions,
  request: SpeakRequest,
): Promise<SpeakResult> {
  const sidecar = await sidecarFor(options);
  const result = await sidecar.request('speak', request as unknown as Record<string, unknown>);
  return {
    file: String(result.file),
    seconds: Number(result.seconds ?? 0),
    ms: Number(result.ms ?? 0),
    hold: Number(result.hold ?? 0),
  };
}

export type SidecarStatus = {
  key: string;
  backend: string;
  running: boolean;
  info?: SidecarInfo;
};

export function sidecarStatuses(): SidecarStatus[] {
  return [...running.values()].map((sidecar) => ({
    key: sidecar.key,
    backend: sidecar.options.backend,
    running: sidecar.running,
    info: sidecar.info,
  }));
}

/**
 * Shuts every generator down.
 *
 * Wired to the editor's own signal handlers. A model process outliving the
 * editor holds the GPU with nothing able to reach it, and the only cure a
 * person finds is a reboot.
 */
export function stopAllSidecars(): void {
  for (const sidecar of running.values()) sidecar.stop();
  running.clear();
}

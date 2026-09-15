/**
 * Which generators exist, and whether this machine has them.
 *
 * Model weights are the one part of the pipeline that is neither content nor
 * code. They are tens of gigabytes, they are machine-specific, and they must
 * never land in the project folder — which is inside a synced drive — or in the
 * repo. So they live under one root the author chooses once, the same way the
 * workspace is chosen once, and everything else refers to a model by id.
 *
 * That indirection is the point. `project.yaml` travels: it is opened on
 * another machine, or a year later, and a model named `chatterbox` still means
 * something there. An absolute path to a folder of weights would not.
 *
 * This registry is deliberately a fixed list rather than a scan of the folder.
 * A generator is not just weights — it is weights plus the adapter that knows
 * how to call them — and the adapter is code in `client/voice/`. Offering the
 * author a model the sidecar has never heard of would be offering a button
 * that cannot work.
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssetSection } from '../../shared/scenario/load.ts';

export type ModelSpec = {
  /** What `sections.<section>.file` holds, and what the sidecar is asked for. */
  id: string;
  section: AssetSection;
  title: string;
  /** One line, for the picker. */
  summary: string;
  /**
   * The uv extra that installs this backend's dependencies. Absent means the
   * base environment already has everything — which is what makes the
   * placeholder usable before any download has happened.
   */
  extra?: string;
  /** Hugging Face repo, for the download step of the walkthrough. */
  repo?: string;
  /** Folder under the models root, if the weights are fetched by hand. */
  folder?: string;
  /** Roughly, so nobody starts a download they have no room for. */
  sizeGb?: number;
  /** True when the model needs a reference clip per character to clone from. */
  clones?: boolean;
  /**
   * True when landing on the CPU is a misconfiguration rather than the plan.
   *
   * Kokoro on a processor is faster than real time and entirely normal;
   * chatterbox on a processor is a minute a line and almost always a CPU-only
   * torch wheel. Warning about both would train people to ignore the warning.
   */
  prefersGpu?: boolean;
  /**
   * The voices this model already has, for one that does not clone.
   *
   * Listed here as well as reported by the sidecar, because the picker has to
   * be usable before the model is downloaded — choosing a voice is how you
   * decide whether to download it at all. The sidecar validates against its
   * own list and says so if the two ever drift.
   */
  voices?: { id: string; label: string }[];
  /**
   * Files to fetch, for a model whose library will not fetch its own.
   *
   * Named explicitly rather than pointed at a repo, because these land in a
   * folder the author chose and has to be able to recognise later. A cache
   * full of hashes is fine for a library and useless to a person.
   */
  files?: { name: string; url: string; mb: number }[];
  license?: string;
};

/**
 * Voice first, and only voice, because a pathway that stops halfway is worse
 * than one that has not started. Images and video get their own entries when
 * their adapters exist.
 */
export const MODELS: ModelSpec[] = [
  {
    id: 'placeholder',
    section: 'voice',
    title: 'Placeholder tone',
    summary:
      'No model at all: a quiet tone the length the line would take to say. ' +
      'Rehearses the timing of a show before a single voice exists.',
    clones: false,
  },
  {
    id: 'kokoro',
    section: 'voice',
    title: 'Kokoro',
    summary:
      'About thirty ready-made English voices. Needs no recordings, runs ' +
      'without a GPU, and can make the reference clips a cloning model wants.',
    extra: 'kokoro',
    folder: 'voice/kokoro',
    sizeGb: 0.34,
    clones: false,
    license: 'Apache-2.0',
    files: [
      {
        name: 'kokoro-v1.0.onnx',
        url: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx',
        mb: 310,
      },
      {
        name: 'voices-v1.0.bin',
        url: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin',
        mb: 27,
      },
    ],
    // American and British only: this is the palette an English-language show
    // casts from, and offering fifty entries in nine languages to pick a
    // narrator out of is not help. The model knows the others; the sidecar
    // will accept one typed into project.yaml by hand.
    voices: [
      { id: 'af_heart', label: 'Heart — American, female, warm' },
      { id: 'af_bella', label: 'Bella — American, female, bright' },
      { id: 'af_nicole', label: 'Nicole — American, female, soft' },
      { id: 'af_aoede', label: 'Aoede — American, female, even' },
      { id: 'af_kore', label: 'Kore — American, female, firm' },
      { id: 'af_sarah', label: 'Sarah — American, female, light' },
      { id: 'af_nova', label: 'Nova — American, female, clear' },
      { id: 'af_sky', label: 'Sky — American, female, young' },
      { id: 'af_alloy', label: 'Alloy — American, female, flat' },
      { id: 'af_jessica', label: 'Jessica — American, female, dry' },
      { id: 'af_river', label: 'River — American, female, quiet' },
      { id: 'am_michael', label: 'Michael — American, male, steady' },
      { id: 'am_fenrir', label: 'Fenrir — American, male, deep' },
      { id: 'am_puck', label: 'Puck — American, male, light' },
      { id: 'am_adam', label: 'Adam — American, male, plain' },
      { id: 'am_echo', label: 'Echo — American, male, level' },
      { id: 'am_eric', label: 'Eric — American, male, clipped' },
      { id: 'am_liam', label: 'Liam — American, male, young' },
      { id: 'am_onyx', label: 'Onyx — American, male, low' },
      { id: 'am_santa', label: 'Santa — American, male, old' },
      { id: 'bf_emma', label: 'Emma — British, female, measured' },
      { id: 'bf_alice', label: 'Alice — British, female, crisp' },
      { id: 'bf_isabella', label: 'Isabella — British, female, formal' },
      { id: 'bf_lily', label: 'Lily — British, female, young' },
      { id: 'bm_george', label: 'George — British, male, older' },
      { id: 'bm_daniel', label: 'Daniel — British, male, even' },
      { id: 'bm_fable', label: 'Fable — British, male, storytelling' },
      { id: 'bm_lewis', label: 'Lewis — British, male, gruff' },
    ],
  },
  {
    id: 'chatterbox',
    section: 'voice',
    title: 'Chatterbox TTS',
    summary:
      'Zero-shot cloning from a few seconds of reference audio. One clip per ' +
      'character gives the whole cast distinct voices.',
    extra: 'chatterbox',
    prefersGpu: true,
    repo: 'ResembleAI/chatterbox',
    folder: 'voice/chatterbox',
    sizeGb: 2,
    clones: true,
    license: 'MIT',
  },
];

export function modelsFor(section: AssetSection): ModelSpec[] {
  return MODELS.filter((model) => model.section === section);
}

export function modelById(id: string): ModelSpec | undefined {
  return MODELS.find((model) => model.id === id);
}

export type ModelStatus = ModelSpec & {
  /** Weights found under the root, so the sidecar can load without a download. */
  installed: boolean;
  /** Where they are, or where they would go. */
  path?: string;
  /**
   * True only when `path` is a plain snapshot folder a loader can be pointed
   * at directly.
   *
   * The Hugging Face cache also counts as installed, but its layout is
   * `models--org--repo/snapshots/<sha>/` and handing that to a `from_local`
   * would fail. Found there, the right move is to let the library resolve it
   * from the cache itself — which it will, because the editor sets HF_HOME.
   */
  local?: boolean;
};

/**
 * Where a backend that downloads its own weights should cache them.
 *
 * Handed to the sidecar as `HF_HOME`. Without it a `from_pretrained` call puts
 * several gigabytes in the user profile, which is the one place they said they
 * did not want it — and they would find out when the disk filled, not now.
 */
export function hfHome(root: string): string {
  return join(root, 'huggingface');
}

/** True when the path is a directory with anything at all in it. */
async function occupied(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) return false;
  // Existence is not enough: a cancelled download leaves the folder behind,
  // and reporting that as installed sends someone to debug a model that is not
  // there.
  return (await readdir(path).catch(() => [])).length > 0;
}

/**
 * Whether a model's weights are already on disk.
 *
 * Two places count, because there are two honest ways to get them there. A
 * snapshot fetched by hand lands in `<root>/<folder>`; a backend left to
 * download its own lands in the Hugging Face cache, which the editor points at
 * the same root. Checking only the first would mark a working install as
 * missing for as long as it kept working.
 *
 * Neither check looks for particular filenames. That would be this file
 * claiming to know a repo's layout, which changes without warning.
 *
 * A model with no `folder` — the placeholder — is always installed, because
 * there is nothing to install.
 */
export async function modelStatus(root: string | undefined, spec: ModelSpec): Promise<ModelStatus> {
  if (!spec.folder) return { ...spec, installed: true };
  if (!root) return { ...spec, installed: false };

  const path = join(root, spec.folder);
  if (await occupied(path)) return { ...spec, installed: true, path, local: true };

  if (spec.repo) {
    const cached = join(hfHome(root), 'hub', `models--${spec.repo.replaceAll('/', '--')}`);
    if (await occupied(cached)) {
      return { ...spec, installed: true, path: cached, local: false };
    }
  }

  return { ...spec, installed: false, path };
}

export async function modelStatuses(
  root: string | undefined,
  section?: AssetSection,
): Promise<ModelStatus[]> {
  const specs = section ? modelsFor(section) : MODELS;
  return Promise.all(specs.map((spec) => modelStatus(root, spec)));
}


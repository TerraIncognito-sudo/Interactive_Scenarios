# Setting up voice generation

How to go from a scenario full of `voice:` declarations to a folder of clips the show
actually plays. Read [asset-pipeline.md](asset-pipeline.md) first if you have not — this
picks up where the asset board leaves off.

The short version: the editor keeps a **models root** on this machine, starts a small
Python **sidecar** when you press Generate, and writes each attempt into the project's
takes folder as a numbered **take**. You listen, pick one, and **publish** it to the name
the scenario declares. Nothing is overwritten along the way.

---

## Before you start

**[uv](https://docs.astral.sh/uv/)** must be on PATH. It manages the sidecar's Python
environment, including fetching a Python version of its own — you do not need to install
one, and the one you already have is not necessarily the one used.

**No compiler is needed**, and the pinned Python version is what keeps it that way. See
[Why Python 3.13](#why-python-313) if you ever want to move it.

```bash
uv --version
```

If that fails, install it (`winget install astral-sh.uv`) and open a new terminal.

**Disk.** The base sidecar is about 50 MB. Chatterbox adds roughly 3 GB of CUDA PyTorch
plus 2 GB of weights. Two places need room, and neither is inside OneDrive:

- **Weights** go in the models root you choose below. The editor refuses a synced path.
- **The Python environment** goes in `%LOCALAPPDATA%\interactive-scenario\voice-env`,
  deliberately outside this repo — the repo is in OneDrive, and uv's default would put
  three gigabytes of CUDA wheels next to the code and sync every byte of it. Set
  `UV_PROJECT_ENVIRONMENT` if you want it somewhere else.

**GPU.** Optional but the difference between a second a line and most of a minute. An
NVIDIA card with 6 GB or more is comfortable.

---

## 1. Tell the editor where models live

Start the editor and open any project. At the top of the asset board there is a **Models**
strip:

```
Models   not set — generation is off until it is   [ Change… ]
```

Press **Change…** and pick your models folder — `C:\ML Models`. The editor creates it if
it is not there, remembers it in its own config, and uses it for every project.

This lives in the editor's config rather than in `project.yaml` on purpose. A project file
gets copied to other machines and opened a year later; a path to a folder of weights means
nothing there, while the model *name* it records still does.

What ends up under it:

```
C:\ML Models\
  huggingface\                  the download cache — the editor points HF_HOME here
    hub\models--ResembleAI--chatterbox\
  voice\
    chatterbox\                 optional: a snapshot you fetched by hand
```

---

## 2. Prove the wiring before downloading anything

There is a backend called **Placeholder tone** that needs no model at all. It writes a
quiet pulsing tone exactly as long as the line would take to say.

```bash
npm run voice:install
```

```bash
npm run voice:check
```

You should see `OK — Placeholder tone works, and MP3 came out the other end.`

Those two commands exercise the whole path: uv resolves the environment, the sidecar
starts, the bridge talks to it, audio comes back, and it is encoded as MP3. If anything is
wrong with the plumbing, it is wrong here — where the error is one sentence, rather than
after a 5 GB download.

Then do the same from the editor. Open a project, expand **Voice**, and set the section's
model dropdown to **Placeholder tone**. Every row grows a **Generate** button. Press one.

The placeholder is worth more than a smoke test. Because the show's timing comes from
`hold:` and never from the audio, a full act of placeholder clips lets you rehearse a
forty-minute show, on a projector, at its real running time, before a word has been
recorded.

---

## 3. Install Chatterbox

[Chatterbox](https://github.com/resemble-ai/chatterbox) clones a voice from a few seconds
of reference audio, which is what a scenario with a cast needs — a model with a fixed
palette of voices gives you a palette, not a cast.

```bash
npm run voice:install -- chatterbox
```

Several minutes and about 3 GB, all of it prebuilt wheels. It pulls PyTorch from the
CUDA 12.8 index rather than PyPI, which matters more than it sounds like: the default
Windows wheel is CPU-only, and on a 50-series card the older CUDA builds have no kernels at
all. `tools/voice/uv.lock` pins the combination that works.

Use the npm script rather than `uv sync` directly — it is what points uv at the
environment outside the repo.

---

## 4. Check it

```bash
npm run voice:check -- chatterbox
```

The first run downloads about 2 GB of weights into the models root. Look at the `device`
line:

```
  models root    C:\ML Models
  weights        C:\ML Models\huggingface\hub\models--ResembleAI--chatterbox
  loaded in      15.0s
  device         NVIDIA GeForce RTX 5080
```

Loading takes about a minute the first time and around fifteen seconds after that. The
model then stays resident between lines, so generation runs at roughly the length of the
clip — a few seconds a line, five minutes for an act.

If it says `cpu`, stop and fix that now — see [Troubleshooting](#troubleshooting). It will
work on CPU, at roughly a minute a line, and ninety lines is a wasted evening.

To fetch the weights yourself instead of letting it download, put a snapshot in
`C:\ML Models\voice\chatterbox` and the editor will load it from there without touching
the network.

---

## 5. Give each character a voice

Switch the Voice section's model to **Chatterbox TTS**. A **cast panel** appears above the
rows: every character in the scenario who speaks, with how many lines they have.

Each one needs a reference clip. Press **Choose clip…** and pick a file.

**What makes a good reference:**

- **7–20 seconds.** Shorter gives the model too little; much longer does not help.
- **One speaker, clean, no music or room echo.** The model copies the recording's
  character, including its faults — reference a clip with hiss and every line hisses.
- **Similar delivery to what you want.** A reference read flat produces a flat read of
  everything. For the narrator of Arctic Sentinel, something unhurried and matter-of-fact.
- **WAV or MP3**, mono or stereo, any common rate.

Put the clips inside the project — `arctic-sentinel/voices/narr.wav` — and the editor
stores the path relative to the project so the folder stays copyable. A clip from
elsewhere on disk is recorded absolutely and will not travel.

The **Direction** field on each character is free text for models that take one. Chatterbox
does not, so it is a note to yourself for now; it is part of the recipe, so editing it does
mark that character's clips stale.

> **A character with no clip is not an error, and that is the danger.** Chatterbox will
> read the line in its own default voice, do it for every character, and hand you back a
> cast who all sound like the same person. The panel outlines them in orange, and generate
> refuses rather than guessing.

---

## 6. Generate, listen, publish

Each row has:

- **Generate** / **Another take** — makes one clip. Pressing it again adds a take; it never
  replaces one and never steals a selection you have already made.
- the **takes strip** — click a take to select it.
- **Publish** — copies the selected take to the filename the scenario declares.

Generating and publishing are separate on purpose. Generate a whole act, listen to it, pick
the readings you want, then publish. Only publishing puts a file where the show will look.

The status line after each generate reports the clip's length, and says so when it
disagrees with the line's `hold:`:

```
9f2c1a04b8-01.mp3 · 8s · this line holds for 5s but the clip runs 8s — set hold: 8
```

**Fix these.** Nothing on the server opens the audio file — the beat ends when `hold` says
it does, so a clip longer than its hold is the narrator cut off mid-sentence in front of a
room. `npm run validate` will not catch it; only this will.

Run `npm run validate --strict` before a show, when a declared-but-missing file becomes an
error rather than a warning.

---

## What is stored where

| | |
|---|---|
| `C:\ML Models\` | weights. Never in the project, never in the repo. |
| `%LOCALAPPDATA%\interactive-scenario\voice-env` | the sidecar's Python environment. Rebuildable; delete it freely. |
| `<project>/voices/*.wav` | reference clips. Part of the show; travels with it. |
| `<generated>/voice/<asset>/` | every take, named for the recipe hash that made it. |
| `.ledger.json` | which takes exist and which is selected. The machine's file. |
| `project.yaml` | the `voices:` map and the section's model. Yours. |
| `<publish>/` | the published clips, under the names the scenario declares. |

A take's filename is the hash of the recipe that produced it. That is how the board knows a
clip is **stale**: edit a line's text, or a character's reference clip, and every clip made
from the old recipe says so instead of quietly staying wrong.

Changing one character's reference marks every line they speak stale — deliberately. It is
the same recipe for all of them, so it is the same decision.

---

## Troubleshooting

**`uv is not on PATH`** — install uv and restart the editor, not just the terminal.

**`device cpu` on a machine with an NVIDIA card** — the CPU build of PyTorch got installed.
Delete the environment and install again:

```bash
rm -r "$LOCALAPPDATA\interactive-scenario\voice-env"
```

```bash
npm run voice:install -- chatterbox
```

**`no kernel image is available for execution on the device`** — PyTorch is too old for the
card. A 50-series (Blackwell, sm_120) needs CUDA 12.8 wheels, which is what `uv.lock` pins;
this means something overrode it. Check `nvidia-smi` reports a driver of 570 or newer.

**`could not write MP3 … libsndfile`** — the bundled libsndfile predates MP3 writing.

```bash
npm run voice:install
```

If that does not lift it, `soundfile` is pinned too low in `tools/voice/uv.lock`; raise the
floor in `pyproject.toml` and re-lock.

**`Microsoft Visual C++ 14.0 or greater is required`** — something in the tree has no
prebuilt wheel for the Python being used, so uv fell back to compiling it. Do not install
the build tools; the fix is the Python version. `spacy-pkuseg`, which chatterbox pulls in
for Chinese word segmentation, publishes wheels only up to cp313, which is why
`tools/voice/pyproject.toml` pins `>=3.13,<3.14`. If you see this, that pin has been
widened or uv is being run against a different interpreter.

**The generator stopped (exit 1)** — the Python traceback is printed in the terminal the
editor is running in, and the last lines of it are almost always the whole answer.

**Generation is slow after the first line** — it should not be; the model stays loaded
between requests. If every line takes as long as the first, the sidecar is being restarted,
which means it is crashing. Check the editor's terminal.

**Getting the GPU back** — press **Unload model** on the Models strip. Closing the editor
also does it: the sidecar talks over a pipe, so it cannot outlive its parent.

---

## Why Python 3.13

The version is pinned in `tools/voice/pyproject.toml`, and it is wedged between two
failures that both look like something else.

`chatterbox-tts` pins `torch==2.6.0` on Python below 3.14, and `torch>=2.9` on 3.14.
**Torch 2.6 ships no sm_120 kernels**, so on a 50-series card it installs perfectly and
then fails at the first generate with *no kernel image is available for execution on this
device*. That argues for 3.14.

But **`spacy-pkuseg` has no cp314 wheel**. On 3.14 uv falls back to building it from
source, which needs the MSVC build tools — a multi-gigabyte GUI install, to support a
language this show does not speak.

So the sidecar takes 3.13, where every C extension in the tree has a wheel, and lifts the
torch pin with an override:

```toml
[tool.uv]
override-dependencies = ["torch>=2.9", "torchaudio>=2.9"]
```

That override is safe rather than hopeful: chatterbox asks for `torch>=2.9` itself on 3.14,
so it demonstrably runs on modern torch. The `==2.6.0` is a tested baseline, not an
incompatibility. If a future release genuinely breaks, the symptom will be an import error
rather than silence.

---

## Adding another voice model

Three places, and the tests will tell you if you miss one:

1. `tools/voice/voice/backends/<name>.py` — a class with `info()` and `speak()`.
2. A line in `tools/voice/voice/backends/__init__.py`.
3. An entry in `MODELS` in `tools/editor/models.ts`, with its uv extra and HF repo.

The registry is a fixed list rather than a scan of the models folder, because a generator is
weights *plus* the adapter that knows how to call them. Offering a model with no adapter
would be offering a button that cannot work.

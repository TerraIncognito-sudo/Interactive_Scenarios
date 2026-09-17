# Setting up voice generation

How to go from a scenario full of `voice:` declarations to a folder of clips the show
actually plays. Read [asset-pipeline.md](asset-pipeline.md) first if you have not — this
picks up where the asset board leaves off.

"The editor" throughout means the client — `npm run client`, the board window on
`localhost:8890`. Voice is the one section of the pipeline with a generator behind it;
everything else is made elsewhere and brought in.

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

## 3. Choose a model

Two, and the right first move is usually the smaller one.

| | Kokoro | Chatterbox |
|---|---|---|
| Size | 340 MB | ~5 GB |
| GPU | not needed | wants one |
| Speed | faster than real time on CPU | roughly real time on a GPU |
| Voices | ~28 ready-made English | clones any voice from a clip |
| Needs from you | pick a voice per character | a reference recording per character |

**Start with Kokoro.** It has a cast in it already, it installs in a minute, and it will
tell you whether the pipeline suits the show before you spend an evening on the big one.

```bash
npm run voice:install -- kokoro
```

```bash
npm run voice:fetch -- kokoro
```

```bash
npm run voice:check -- kokoro
```

Its files do not come down automatically, which is what `voice:fetch` is for — it puts
them in `C:\ML Models\voice\kokoro\` under names you will recognise a year from now. The
editor has a **Download** button beside the model that does the same thing.

### Then Chatterbox, if you want more

[Chatterbox](https://github.com/resemble-ai/chatterbox) clones a voice from a few seconds
of reference audio. It is more expressive than a fixed palette and it is how you get a
voice that is not on anybody's list — but it needs that recording, and §5 below is about
where to get one when you have none.

```bash
npm run voice:install -- chatterbox
```

Several minutes and about 3 GB, all of it prebuilt wheels. It pulls PyTorch from the
CUDA 12.8 index rather than PyPI, which matters more than it sounds like: the default
Windows wheel is CPU-only, and on a 50-series card the older CUDA builds have no kernels at
all. `client/voice/uv.lock` pins the combination that works.

Use the npm script rather than `uv sync` directly — it is what points uv at the
environment outside the repo.

---

## 4. Check Chatterbox

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

Pick a model in the Voice section's dropdown. A **cast panel** appears above the rows:
every character in the scenario who speaks, with how many lines they have.

One entry may not be a character: **Narration — no nameplate**, id `vo`. Some lines have no
`who:` — a fiction notice, a title card, anything the display shows without attributing it to
anybody. They still have to be spoken, and giving them a character to get a voice would put
that character's name on screen under a legal disclaimer. So they are cast here like anyone
else, and whether that is the same voice as the narrator or a different one is your call.

### With Kokoro — pick from the list

Each character gets a dropdown of about thirty voices. Choose one and that character is
cast. There is nothing to record and nothing to download per voice; they all live in the
one 27 MB voices file.

That is the whole step. Skip to §6.

### With Chatterbox — and no recordings

Chatterbox's first question is "which recording?", and most authors cannot answer it: you
have a scenario, not a sound booth. So the cast panel answers it for you.

With Kokoro downloaded, each character's dropdown reads **record a clip from…** and lists
the same thirty voices. Choose one and the editor:

1. collects that character's own lines from the scenario, in order, until it has enough
   words for a good reference,
2. has Kokoro read them,
3. saves the result as `voices/<character>.wav` inside the project,
4. points the character's `reference:` at it, and records which voice made it.

A couple of seconds per character. Six characters, six distinctly different voices, no
microphone.

It uses their **own lines** on purpose. A reference is copied in register as much as in
timbre — a voice sampled reading *the quick brown fox* carries none of the flatness a duty
officer reads with, and the clone comes back sounding like an audiobook rather than a
watch-keeper.

The `preset:` recorded beside the reference is what lets the clip be made again. A wav in
a folder with no note of where it came from is a dead end the first time you want to adjust
it.

### Or use your own recording

**Use a recording…** takes any file you point it at, which is what you want as soon as a
character deserves a real performance.

**What makes a good reference:**

- **7–20 seconds.** Shorter gives the model too little; much longer does not help.
- **One speaker, clean, no music or room echo.** The model copies the recording's
  character, including its faults — reference a clip with hiss and every line hisses.
- **Similar delivery to what you want.** A reference read flat produces a flat read of
  everything. For the narrator of Arctic Sentinel, something unhurried and matter-of-fact.
- **WAV or MP3**, mono or stereo, any common rate.

Put the clips inside the project — `arctic-sentinel/voices/narr.wav` — and the editor
stores the path relative to the project so the folder stays copyable. A clip from
elsewhere on disk is recorded absolutely and will not travel. Clips the editor records for
you are already in the right place.

The **Direction** field on each character is free text for models that take one. Chatterbox
does not, so it is a note to yourself for now; it is part of the recipe, so editing it does
mark that character's clips stale.

> **A character with no voice is not an error, and that is the danger.** Either model
> falls back to one default voice and applies it to the whole cast, silently, and you find
> out after ninety generations. The panel outlines those characters in orange, and generate
> refuses rather than guessing.

---

## 6. Generate, listen, publish

Each row has:

- **Generate** / **Another take** — makes one clip. Pressing it again adds a take; it never
  replaces one and never steals a selection you have already made.
- the **takes strip** — a **▶** beside each take, and the take itself to select it.
- **Publish** — copies the selected take to the filename the scenario declares.

The section header has **Generate N missing**, for when the auditioning is done and a whole
act needs making. It skips anything that already has a take, reports each clip as it lands,
and has a **Stop** beside it — it is minutes of GPU time, and a run you cannot get out of is a
run nobody starts. A line that fails does not stop the rest; the failures are listed at the
end.

### Listening

Press **▶** on any take. One clip plays at a time, so clicking down a column of takes is how
you compare them rather than how you hear six readings at once. A published row plays the
**published file** rather than the selected take — usually the same clip, and the times it is
not are exactly when it matters, because a selection changed after the last publish is the old
reading in front of the room.

Each character's reference clip has one too. It is worth a listen before generating ninety
lines: it decides what every one of them sounds like.

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
| `<project>/voices/*.wav` | reference clips, recorded or your own. Part of the show; travels with it. |
| `<project>/generated/voice/<clip>/` | every take of that clip. Inside the project, so it copies as a unit. |
| `<project>/assets/voice/<clip>` | what Publish writes: the file the show opens. |
| `C:\ML Models\voice\kokoro\` | Kokoro's two files, fetched by `voice:fetch`. |
| `.ledger.json` | which takes exist and which is selected. The machine's file. |
| `project.yaml` | the `voices:` map and the section's model. Yours. |

Takes are named for the hash of the recipe that made them, and the folder does not repeat the
section it already sits in — `voice/tran-d5-01.mp3` in the scenario is
`generated/voice/tran-d5-01.mp3/` on disk, the same place it was before the assets were filed.

A take's filename is the hash of the recipe that produced it. That is how the board knows a
clip is **stale**: edit a line's text, or a character's reference clip, and every clip made
from the old recipe says so instead of quietly staying wrong.

Changing one character's reference marks every line they speak stale — deliberately. It is
the same recipe for all of them, so it is the same decision.

---

## Reading the editor's terminal

A model load looks like this, and all three lines are good news:

```
  [chatterbox] loading weights from Hugging Face (cache: C:\ML Models\huggingface)
  [chatterbox] loaded PerthNet (Implicit) at step 250,000
  [chatterbox] ready in 16.9s on cuda
```

**`ready in …` is the line that matters.** It only prints when the model has loaded and can
be spoken to, so if you see it, nothing is wrong. Generation after that is silent — the board
reports each clip, and a terminal narrating ninety of them would bury the one that failed.

Anything a model's dependencies print on the way — deprecation notices about
`pkg_resources`, `LoRACompatibleLinear`, `sdp_kernel`, or a note that downloads are
anonymous — is suppressed. None of it is actionable by anyone here, all of it appears on
every single load, and a screen that ends on a warning reads as a failure whether or not one
happened. It is all still kept, and a failure arrives with it attached.

A **real** failure is unmistakable: no `ready` line, a red status in the editor, and the
Python traceback underneath it.

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

If that does not lift it, `soundfile` is pinned too low in `client/voice/uv.lock`; raise the
floor in `pyproject.toml` and re-lock.

**`Microsoft Visual C++ 14.0 or greater is required`** — something in the tree has no
prebuilt wheel for the Python being used, so uv fell back to compiling it. Do not install
the build tools; the fix is the Python version. `spacy-pkuseg`, which chatterbox pulls in
for Chinese word segmentation, publishes wheels only up to cp313, which is why
`client/voice/pyproject.toml` pins `>=3.13,<3.14`. If you see this, that pin has been
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

The version is pinned in `client/voice/pyproject.toml`, and it is wedged between two
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

1. `client/voice/voice/backends/<name>.py` — a class with `info()` and `speak()`.
2. A line in `client/voice/voice/backends/__init__.py`.
3. An entry in `MODELS` in `client/app/models.ts`, with its uv extra, and either an HF
   repo (fetches itself) or a `files:` list (the editor fetches it).

A model that does not clone lists its `voices:` there too. That list is what the cast panel
offers before the model is downloaded — choosing a voice is part of deciding whether to
download it at all — and the backend validates against its own list at load time.

The registry is a fixed list rather than a scan of the models folder, because a generator is
weights *plus* the adapter that knows how to call them. Offering a model with no adapter
would be offering a button that cannot work.

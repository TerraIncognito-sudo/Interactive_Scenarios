# The asset pipeline — plan → implement → build, in one place

A design for turning `tools/editor/` into the whole workshop: storyboard at the top, scenario
in the middle, generated images / video / voice / SFX / ambience / music at the bottom, and a
drag-and-drop canvas for arranging a shot before any of its art exists.

**Phase 1 is built** — the project file, the ledger, the storyboard importer and the six
section views: the status board, useful before a single model is installed.

**Voice generation is built** — a cast with a reference clip each, a model per section, and
generate / audition / publish per row. See [voice-generation.md](voice-generation.md) for
how to set the models up. Images, video and the rest of §13 are still design.

---

## 1. Three files, three owners

**A project is a folder containing `scenario.yaml`.** Nothing more is required — that is the
same shape the game server already reads, which is what makes shipping a finished scenario a
matter of copying the folder across. The storyboard, `project.yaml` and the takes ride along
and are inert to the loader.

The editor holds no opinion about where those folders live. On first run it asks for a
**workspace** — the folder that contains them — and remembers the answer in
`~/.interactive-scenario/editor.json`. The picker is served by the editor process, because the
browser's `showDirectoryPicker()` hands the page a handle and deliberately never reveals a
path, and a path is exactly what the server needs.

Model weights, generated candidates and the repo are all separate things in separate places,
and none of them has to live next to the others.

| File | Owner | Contents |
|---|---|---|
| `storyboard.md` | **human**, prose | acts, shots, prompts, VO script, direction |
| `scenario.yaml` | **human + editor**, structured | the show the game server runs. Unchanged in kind. |
| `project.yaml` | **human**, structured | model selection per section, per-asset prompts and params, frame layouts |
| `.ledger.json` | **machine only** | every generated candidate, its seed and hash, which one is selected |

The split between `project.yaml` and `.ledger.json` is the important one. The project file is
full of hand-tuned prompts you will edit for weeks; the ledger is appended to on every single
generation. Round-tripping YAML through a program destroys comments and reflows formatting, so
**the machine never writes the file the human owns.** Prompts stay pristine; the churn goes in
JSON nobody reads by hand.

### Project layout

```
D:\scenario-projects\arctic-sentinel\        <- anywhere; not in the repo
  project.yaml
  scenario.yaml
  storyboard.md                              <- or a path to one elsewhere
  .ledger.json
  voices\                                    <- reference clips, part of the show
    narr.wav  tran.wav
  generated\                                 <- every take ever made
    images\station.jpg\   9f1befa9-01.png  9f1befa9-02.png
    video\station.mp4\    ca1d3711-01.mp4
    voice\tran-d5-01.mp3\ 4b2c8e10-01.mp3
  assets\                                    <- what publish writes; what the show opens
    images\station.jpg
    video\station.mp4
    voice\tran-d5-01.mp3
```

Everything a project is made of is in one folder that copies as a unit — which is what makes
deploying "move this folder" and what makes a project openable a year later. If the folder is
inside a synced drive the editor says so in a comment at the top of `project.yaml`; where the
takes go stays the author's call, because a project split across two drives is one nobody can
hand to anybody else.

```yaml
# project.yaml — the head of it
project: arctic-sentinel
storyboard: storyboard.md                                   # relative to this file
scenario:   C:\...\Interactive Scenario\scenarios\arctic-sentinel\scenario.yaml
publish:    C:\...\Interactive Scenario\scenarios\arctic-sentinel\assets
```

Paths resolve relative to `project.yaml` and may be absolute. That is what lets one project
drive a scenario living in the repo while its 40 GB of candidates sit on another drive.

---

## 2. The mechanism that makes candidate history work

An asset takes several tries. You want all of them kept, comparable, and disposable. But
`scenario.yaml` says `background: station.jpg`, and the game server will open exactly that one
file — it cannot know about `0003-s60011.png`.

So the pipeline has two stages, and this distinction is the spine of the whole design:

```
generate  ->  generated\images\station\0003-s60011.png     many candidates, kept
select    ->  ledger records station.jpg -> 0003           a pointer, reversible
publish   ->  assets\images\station.jpg                     exactly one file, canonical name
```

**Publish is a copy, and it is the only thing that touches the repo.** Everything upstream is
scratch. Consequences worth having on purpose:

- Selecting a different take is instant and free — re-publish, done. No regeneration.
- The repo only ever contains the takes you chose, at the names the scenario expects.
- Deleting a candidate is safe unless it is the selected one, which the editor refuses without
  a confirmation.
- A show can be rebuilt from the ledger months later without opening a model.

`assetsOf()` in [src/scenario/load.ts](../src/scenario/load.ts) still defines *what* is needed:
it walks a parsed scenario and returns every filename referenced. That remains the manifest.
The project file supplies the recipe for each name; the ledger supplies the takes.

---

## 3. Six sections, not five

You listed images, video, voice, SFX and music. There is a sixth, and it falls out of the
schema: **ambience**. `scenes.*.ambience` is its own field, and its production profile is
nothing like a one-shot SFX — 90 seconds, looping, textural, generated with different
parameters even when the same model serves both.

The routing rule should be **which schema field referenced the file**, never the file
extension:

| Section | Schema field | Arctic Sentinel count |
|---|---|---|
| images | `characters.*.sprite`, `scenes.*.background`, layout layers | 5 refs + 26 stills |
| video | `scenes.*.video` | 26 |
| voice | `lines[].voice` | 41 |
| sfx | `lines[].sfx` | as scripted |
| ambience | `scenes.*.ambience` | 5 |
| music | `scenes.*.music` | 1 |

Deterministic, no guessing, and an asset can never land in two sections. A `.mp3` in `voice:`
and a `.mp3` in `music:` are different work with different models, and the field already says
which is which.

---

### What the storyboard defines once

A storyboard states its style, its negative and its design bibles in a section of its own, and
every shot refers to them by name:

```
STYLE. SHIP. Pre-dawn at a working naval jetty in Halifax Harbour, low tide…
NEGATIVE.
```

That is the right way to *write* it and exactly the wrong thing to hand a generator, which reads
`STYLE.` as a word. Import reads the definitions — any fenced block outside a shot that opens
`NAME:` — and routes them:

| In the storyboard | Lands in | Why there |
|---|---|---|
| `STYLE:` | `sections.images.style` | the field already means this, and is already in every recipe |
| `NEGATIVE:` | `sections.images.negative` | same |
| anything else | `tokens:` | a bible referred to by some shots, not all |

Rows keep the prompt exactly as written. Expansion happens when the prompt is composed, so one
edit to the ship's bible changes every hull shot — and because only the definitions a prompt
*uses* are folded into its recipe, that edit makes exactly those shots stale and nothing else.

Each row on the board carries a **what the model gets** preview with the composed positive and
negative, and a copy button for each. Until an image generator is wired up, that copy button is
how art gets made.

---

## 4. Model selection per section

Each section opens with its model block. Point it at a folder; the editor scans that folder and
offers what is actually in it, so swapping models is a dropdown rather than an edit.

```yaml
sections:
  images:
    backend: comfyui
    root: D:\ai\models\checkpoints          # scanned for *.safetensors, *.gguf
    file: flux1-dev-fp8.safetensors
    workflow: workflows\flux-ref.json       # ComfyUI graph with substitution points
    defaults: { width: 1920, height: 1080, steps: 28, cfg: 3.5 }
    negative: |
      text, letters, watermarks, logos, flags, national insignia …
    style: |
      cinematic 2.5D animated illustration, painterly semi-realism …

  voice:
    backend: sidecar
    root: D:\ai\models\tts
    file: chatterbox
    defaults: { exaggeration: 0.3 }
    post: { radio: highpass=f=300,lowpass=f=3400,acompressor=ratio=4 }
```

**The trap that will cost you an afternoon:** ComfyUI only resolves checkpoints under its own
`models/` directory. Pointing it at `D:\ai\models` does not work by configuring the editor — it
works by ComfyUI's `extra_model_paths.yaml`. The editor should **write and maintain that file**
from the project's `root:` values on startup, then restart-check ComfyUI. Otherwise every model
folder change is a manual YAML edit in a second program, and the dropdown will list models
ComfyUI cannot load.

`style:` and `negative:` living at section level rather than per asset is what keeps 26 stills
looking like one film. One edit changes the look of everything; per-asset fields override.

---

## 5. The per-asset record

Every row in a section is one filename from `assetsOf()`, with:

| Box | Purpose |
|---|---|
| **prompt** | prefilled from the storyboard, then tweaked. The main working surface. |
| **negative** | inherits the section's; override per asset |
| **refs** | reference images + strength — how faces stay the same face |
| **params** | seed, steps, size; for audio: duration, loop, post chain |
| **source** | link back to storyboard shot and scenario node — click through both ways |
| **notes** | free text; what you are still unhappy with |
| **status** | missing / stale / ready / frozen |
| **takes** | the filmstrip — every candidate, newest first |

```yaml
assets:
  station.jpg:
    section: images
    prompt: |
      $ship High wide aerial: the ship holding a slow racetrack patrol in a channel
      between two snow-dark islands, ice-strewn water, flat grey light, no horizon.
    refs: [{ file: beau-sheet.png, strength: 0.35 }]
    params: { seed: 41207 }
    source: { shot: C.1, node: c1_on_station }

  tran-d5-01.mp3:
    section: voice
    text: We've lost the link.
    voice: tran
    params: { post: radio }
    source: { shot: D.5, node: d5_link_dies, line: 0 }
```

**Status semantics.** `stale` is the one that earns its keep: the file exists, but the hash of
`{prompt, refs, params, model}` no longer matches the hash recorded when it was made. That means
you edited the prompt after the art was generated — the state you cannot see today, and the one
that produces the single frame that does not match the film. `frozen: true` protects character
sheets and ship plates from ever re-rolling, since everything downstream was matched to them.

### Takes

The ledger keeps, per candidate: file, seed, model, param diff from the row, timestamp, and
elapsed generation time. Enough to answer "what was different about the one I liked" and to
re-roll near it rather than starting over.

```json
{ "images/station.jpg": {
    "selected": "0003-s60011.png",
    "takes": [
      { "id": "0003-s60011.png", "seed": 60011, "steps": 28, "at": "2026-08-25T14:02:11Z", "ms": 41200 },
      { "id": "0002-s41208.png", "seed": 41208, "steps": 28, "at": "2026-08-25T13:58:02Z", "ms": 40850 }
    ] } }
```

---

## 6. Prefill from the storyboard

The storyboard already has the structure an importer needs. Each shot is
`### Shot A.1 — Cold open, the jetty`, followed by `**Hold:** 8 s · **Scene:** halifax`, an
`**IMAGE**` fenced block, a `**MOTION**` line, and `**VO — narr**` blockquotes. That is enough
to emit, on project creation:

- one scenario node per shot, with `scene:`, `hold:` and the dialogue lines
- one **images** row per IMAGE block, prompt prefilled from the fence
- one **video** row per MOTION line, `from:` its own still
- one **voice** row per VO blockquote, `text:` prefilled from the quote

The cost is that the storyboard becomes semi-structured: the shot heading and the labelled
blocks are a contract the importer depends on. That is a fair trade — it is still markdown you
can read in any editor, and the alternative is retyping 26 prompts and 41 lines by hand.

The storyboard **lives in the project**, beside the scenario it describes, and is edited on the
editor's Storyboard tab. It is the document the work starts from, so keeping it in another
window would mean the fullest description of a project was the one thing the project did not
contain.

Seeding is **strictly additive**. "Seed missing assets" adds rows for filenames the project does
not have yet and touches nothing else — once a prompt has been tuned, the document that
suggested it has no authority over it.

It is also **keyed by the scenario, never by the storyboard**. The player opens exactly the
filenames in `scenario.yaml`, so those are the only keys seeding may use: rows come from
`assetReferencesOf(scenario)`, and a storyboard prompt with nowhere to attach is reported
rather than written under a name of the editor's devising. The scenario says what a file is
called; the storyboard says what it should look like.

The mapping runs storyboard shot → scenario node → scene → filename. Node ids carry their shot
(`a1_jetty` is Shot A.1), and a scene takes its still from the first node that plays there — its
establishing shot, or, where that node was never storyboarded, the first node in the scene that
was. Widening it that far is not a guess: a scene has exactly one background, so any shot playing
in it is describing that background. Where the chain breaks entirely, the prompt is reported
unmatched instead of guessed at. Tests guard both halves.

A shot whose node is *not* named for it says so, with **`**Node:** `p1_defend`** in the shot
header. Stated beats inferred. This is not a fallback for sloppy naming — it exists because some
nodes genuinely cannot carry their shot in their id: `p1_defend` is named for the poll result it
belongs to, and `e_tree` for what it is, so no prefix of either will ever reach Shots E.1a or
E.2. A `**Node:**` naming something the scenario does not have is reported as unmatched, because
a typo there maps to nothing silently and takes the shot's whole delivery with it.

Voice is keyed the same way and goes one step further: a voice row's **`text` is the scenario's
line, not the storyboard's blockquote**. A storyboard quotes a whole delivery in one block —
three sentences a narrator says in one breath — where the scenario splits the same words across
the lines the display actually shows. The two do not index against each other, so matching them
by position would put one line's words into another line's clip. What the model speaks has to be
what the audience is reading. The storyboard contributes only the *Delivery:* note, matched by
speaker rather than by position, because one note covers every line split out of its block.

That also means a spoken line the storyboard never described still gets a row: it has text, a
speaker, and an empty prompt waiting for a delivery note.

A beat does not have to be a numbered shot to be imported. `### ENDING A`, `### DEBRIEF END
NODE`, `### EPILOGUE` and friends parse as shots too — the labels are a fixed list, deliberately,
because a document written for people is full of `###` headings that are furniture (`### 3.1 The
style token`, `### Media fields`) and a parser that swallowed those would fill the board with
prose. Beats carry no shot number, so they must state their node with `**Node:**`.

Re-import is **additive at the level of values, not of rows**. A field that holds something is
never touched; a field that is *absent* is a hole, and holes get filled. The distinction matters
because otherwise a fix to the shot→node mapping lands in the storyboard and never reaches the
board — the rows already exist, so a strictly row-additive sync has nothing to add and quietly
does nothing. `syncFromStoryboard` reports `added` and `filled` separately for that reason.

The reverse case — a storyboard and no scenario — is `scaffold.ts`, which *is* free to invent
filenames, because it writes the scenario that references them. Both routes end with the two
files agreeing; neither guesses.

---

## 7. Adding assets, and the rule that prevents orphans

**The project file must never contain an asset the scenario does not reference.** Generated art
that nothing plays is wasted GPU hours and wasted disk, and it hides real gaps behind a long
list. So adding an asset always means adding the field to `scenario.yaml` first — which the
editor does for you from three places:

- the **scenario tab**, editing YAML directly
- **Declare voice clips**, which gives every spoken line a `voice:` file and the `hold:` a
  voiced line requires — a scenario with ninety lines is not one anybody types out by hand
- **Give each shot its own picture**, which hangs a `background:` and `video:` on the node
  that plays each storyboard shot (see below)
- the **canvas**, by dropping a new layer box into a frame (see below)
- a section's **add row**, which writes the field and then opens the new row

Assets present in the project but absent from `assetsOf()` are shown as **unreferenced**, with a
one-click cleanup — **Remove orphaned recipes**, which appears only when something is orphaned.
Assets in `assetsOf()` but absent from the project appear as **missing** with an empty prompt.
Neither state can hide.

Pruning is a separate, explicit action rather than something sync does on its own: a row can
hold an afternoon of tuning, and losing it to a rename nobody meant to make is not a trade the
machine gets to choose.

### Editing the author's file

Both of these write to files a person wrote and will read again — `scenario.yaml` full of
comments recording why a beat is the length it is, and hand-wrapped folded scalars. Parsing to
an object and re-serialising reflows every one of those and buries the change under rewrapped
prose, so edits are computed from the parsed document's source offsets and applied to the text.
Insertions only; nothing else on the page moves. A block map takes a new line, a flow map
(`{ who: narr, text: … }`) takes a comma before its brace, and both spellings appear in real
scenarios so both are handled rather than normalised into one.

### Give each shot its own picture

A storyboard has far more shots than places. `transit` is three shots of the same ocean;
`control_cell` is seven beats in one room. A scene carries one `background:`, so historically
only the first shot in each place had anywhere to put its still and the rest were reported as
**unplaceable** — real work, written, with no filename to hang off.

Authors worked around it the only way the schema allowed: by giving a second camera setup its
own scene. `halifax_flank`, `control_cell_checks`. That costs more than duplication, because
`music:` and `ambience:` hang off the scene and are re-triggered when the scene id changes — a
"scene" that is really a second angle restarts the room's sound halfway through a beat.

Now that a node can carry its own still and clip, this button does both halves at once:

- every storyboarded shot that is not its scene's **establishing shot** — the first beat played
  there, which is what the scene's still has always depicted — gets a `background:` and
  `video:` of its own
- a **stand-in scene**, one whose every node the storyboard places somewhere else, is folded
  back into that place and its filenames move onto the node unchanged

Then it re-seeds, so the prompts that had nowhere to go land on the names it just declared.
Declaring the filenames and leaving the prompts unattached would be the half nobody remembers.

Folding is deliberately conservative. A scene is folded only when the storyboard is unanimous
about where its nodes belong, the destination exists, and the two agree on `music:` and
`ambience:` — folding a scene whose sound differs would change what the audience hears, which
is not a migration but a rewrite. What it refuses is reported with the reason.

Filenames it invents follow the importer's own convention, `{scene}-{shot}.jpg`, and a node
that already states its own media is never rewritten. It is safe on a half-migrated project,
which is the normal case.

One thing it reports rather than fixes: **comments left describing scenes that are now gone.**
The prose in a scenario is the author's — several comments in a real one record why a beat is
the length it is — and a machine that edits prose to keep it true will eventually edit prose
that was already true. It names the lines and stops there.

### Give speakers a portrait

The display has drawn portraits since the beginning: bottom right, over the dialogue box,
sliding in when someone speaks — the shape every 2D RPG and visual novel has used for thirty
years. What it never had was a picture. `sprite:` is optional on a character, no scenario ever
declared one, and a portrait nothing declares is one nobody notices is missing.

A storyboard that plans for this writes a **character sheet** per character — one neutral
three-quarter portrait, generated first and reused as the reference for every later shot so
faces do not drift between scenes. **Give speakers a portrait** turns those paragraphs into
files the show will open: a `sprite:` on each character, then a re-seed so the sheet's prompt
lands on the name it just declared.

Only the characters the storyboard drew. Arctic Sentinel has six speaking parts and three
sheets — the narrator has no face, the ship is a ship, and the Russian officer is "heard only
over radio; never seen as a face". Giving every speaker a portrait would invent three the
author deliberately withheld.

Matching `Beaudoin` to `beau` is the one guess in it, and it is narrow: the id outright, or a
whole word of the character's name. Two characters that both match is reported, not resolved —
a face on the wrong person lasts the whole show.

### File assets by media type

A finished show is a few hundred files. Flat, `assets/` is a folder where finding the bed for
act two means reading ninety voice clips first, and where the only thing saying what
`a4-flank.mp4` *is* is its extension. **File assets by media type** renames every reference to
`<section>/<name>` — the same six sections the board already groups the work into, because the
section an asset belongs to is a fact the scenario already carries.

The folder goes into **the name `scenario.yaml` declares**, not into a layout rule the display
works out for itself. A convention would have to live in the display, the validator and the
editor at once; a name is one fact, stated once, and reading the scenario tells you where a
file is. Flat names stay legal — every scenario written before this is one, and the button
leaves alone anything the author already filed somewhere of their own choosing.

Four things move together, which is the whole reason it is a button rather than a rename:

- every reference in `scenario.yaml`, by source offset, so comments and folded scalars survive
- the `assets:` keys in `project.yaml`, by key edit, so a row keeps its prompt and its comment
- the ledger, so the take that was already chosen is still chosen
- anything already published, moved into the folder the scenario now names

Takes need no move at all: `takesDir` drops the section from a name that already carries it, so
`generated/voice/tran-d5-01.mp3/` is where they were and where they stay. A project's whole
history of attempts survives being filed.

What it will not do is guess. A name two schema fields both claim — `bed.mp3` used as both
`music:` and `ambience:` — is reported rather than filed, because either answer is wrong for
one of the two uses.

They are also idempotent. Pressing **Declare voice clips** twice does nothing the second time,
and numbering continues from what the scenario already uses rather than restarting at `01` —
a half-wired scenario is the normal case, and a collision would name a clip that already exists
on disk. That difference is what makes it a button rather than a script.

---

## 8. The frame layout canvas

This is new engine capability, not just an editor view. Today the display has no spatial layout
at all: `.stage` is a fixed 1920×1080 surface scaled by transform, `.portrait` is pinned at
`right: 120px; bottom: 340px; width: 460px`, and the dialogue box is fixed. Arranging a frame
means giving the scenario a way to say otherwise.

Two facts from the existing code make this much cheaper than it sounds:

1. **The stage is already a fixed design surface.** So layout coordinates are plain pixels on
   1920×1080 — no percentages, no ambiguity, and the editor canvas is literally the same
   coordinate space at a smaller scale.
2. **The portrait is already absolutely positioned.** Honouring a layout is setting inline
   styles on elements that are already placed that way.

### Schema

All optional, so every existing scenario renders exactly as it does now.

```yaml
scenes:
  control_cell:
    background: cell.jpg
    layout:
      portrait: { x: 1340, y: 400, w: 460 }        # h optional; aspect preserved
      dialogue: { x: 96, y: 760, w: 1728, h: 240 }
      layers:
        - asset: hud-overlay.png                   # flows into assetsOf() -> images section
          rect: { x: 0, y: 0, w: 1920, h: 1080 }
          opacity: 0.4
          z: 2
```

Layout rides on the **scene**, because a frame is a place. A node-level `layout:` override
handles the shot that wants the portrait on the other side. Reserved layer ids `portrait` and
`dialogue` map to the existing elements; everything else is a new image layer.

### Where the change lands

- `src/scenario/schema.ts` — `LayoutSchema`, optional on `SceneSchema` and the dialogue node.
- `src/scenario/load.ts` — `assetsOf()` picks up `layout.layers[].asset`.
- `src/scenario/check.ts` — reject rects outside 1920×1080 or with non-positive size; warn on
  layers fully hidden behind an opaque one, and on a `dialogue` rect too small for its text.
- `src/shared/protocol.ts` — `snapshot.scene` already carries resolved scene media; `layout`
  joins it there.
- `src/client/display/main.ts` — apply rects as inline styles when present, fall back to CSS.

**The engine does not change, and must not.** Layout is presentation resolved from scenario
definitions, never state. `reduce` stays `state + event -> state`, and the display keeps running
the same engine client-side.

### The canvas itself

A 16:9 board at the same coordinates, with **tagged boxes instead of art** — a grey rect reading
`bg: station.jpg`, another reading `portrait: beau.png`. Drag to move, handles to resize, snap to
a grid and to the title-safe margin. Real thumbnails appear once a take is selected, so the same
view carries you from "nothing exists" to final review without changing tools.

The payoff is the thing you asked for: **the canvas creates work**. Dropping a new layer box
writes the layer into `scenario.yaml`, which makes `assetsOf()` return a new filename, which puts
an empty row in the images section waiting for a prompt. Arranging the shot is how you discover
what art the shot needs.

---

## 9. Process topology

Node cannot run diffusion models and should not try. The editor is an **orchestrator** over local
HTTP services it detects and health-checks.

| Port | Process | Role |
|---|---|---|
| 8880 | game server | the show. Unchanged. |
| 8890 | **editor** | storyboard, scenario, sections, canvas, build queue |
| 8188 | **ComfyUI** | images + video |
| 8191 | **audio sidecar** (FastAPI) | TTS, music, SFX, ambience |
| 11434 | **Ollama** | text: beats to prompts, phrasing variants |

ComfyUI earns its place by already solving model load/unload, VRAM management, quantised
checkpoints, reference conditioning and queueing, behind a plain HTTP API — `POST /prompt`,
`GET /history/{id}`, a WebSocket for progress, `POST /free` to evict. The editor substitutes
prompt, seed and reference paths into a stored workflow template per section.

Audio gets a hand-rolled sidecar instead, because the ComfyUI audio node ecosystem is its
flakiest corner and audio models are small enough that VRAM juggling buys nothing. ~200 lines of
FastAPI with pinned dependencies, exposing `POST /tts`, `/music`, `/sfx`.

Ollama is already installed here with `qwen3.5:9b`, and is the right size for prompt expansion in
the frozen house style and `hold:` estimates. Story judgement stays with you and Claude Code.

---

## 10. The build is family-ordered

16 GB of VRAM holds one big model at a time, so the queue runs in tiers and swaps models twice,
not fifty times:

```
tier 0   images     5 reference sheets + ship plates    <- freeze before continuing
tier 1   images     26 stills (refs from tier 0)
         -- unload --
tier 2   video      26 clips (each img2vid from its own still)
         -- unload --
tier 3   voice      41 clips        <- small models, batch freely
tier 4   sfx / ambience / music
         -- ffmpeg post pass --
tier 5   writeback  hold: values, poster frames, loop crossfades, loudness
```

Within a tier, one job at a time — parallelism on one GPU buys nothing and risks an OOM halfway
through a 26-job run. It also matches how the work needs reviewing: 26 stills judged together is
the only way to tell whether they are one film.

### Loops the pipeline closes that a human currently has to remember

- **`hold:` must equal the voice clip's length.** Nothing on the server opens the audio file, so
  a wrong `hold` talks over the next line in front of an audience. After TTS, `ffprobe` the clip,
  round up, write `hold:` back at `{node, line}`. The checker's warning becomes unreachable.
- **A scene with `video:` needs a `background:` poster.** Free — clips are img2vid *from* the
  still, so the dependency edge is the guarantee.
- **`pf` and `rus` need an identical radio chain.** Declared once as `post: radio`, applied as an
  ffmpeg filter chain, cannot drift between clips.
- **Loudness.** One `loudnorm` pass across all VO. A room notices level mismatch faster than art.

---

## 11. Models for this machine

Measured: **RTX 5080, 16 GB VRAM · Ryzen 9 7950X · 64 GB RAM · 182 GB free on C:**. The 64 GB of
system RAM matters as much as the VRAM — video models offload hard, and 16 GB paired with 16 GB
would thrash.

| Section | Recommendation | Why |
|---|---|---|
| images | **FLUX.1 dev (FP8)**, alt **Qwen-Image (FP8)** | FP8 is the sweet spot at exactly 16 GB. FLUX leads prompt adherence; Qwen leads *in-image text*, which this scenario's negative token forbids outright. |
| video | **LTX-2** (16 GB stated floor), alt **Wan 2.2** 14B GGUF / 5B TI2V | 4–7 s of subtle motion is the easiest thing these do. LTX is much faster; Wan has better temporal coherence. |
| video (parallax) | **ffmpeg `zoompan`** — no model | The default motion is a 3–5 % push over a still. A model will hallucinate detail and break the art. Deterministic, free, and better. Reserve img2vid for element loops. |
| voice (`narr`) | **Kokoro** (82 M) | Fast, CPU-capable, 54 built-in voices. Cannot clone — the narrator is nobody. |
| voice (cast) | **Chatterbox** | Clones from ~10 s of reference, with emotion control. |
| music | **ACE-Step 1.5** | One sustained pad. Seconds per generation on this card. |
| sfx / ambience | **Stable Audio Open 1.5** | Built for texture and foley rather than songs. |

~90–120 GB of weights, all under the section `root:` folders, none of it in the repo.

---

## 12. Setting this machine up — four traps

1. **Python 3.12 via `uv`.** This box has 3.14.3 and 3.13; `torch` ships no 3.14 wheels and 3.13
   support is patchy. `uv python install 3.12` and pin every sidecar. `uv` is already installed.
2. **CUDA 12.8+ torch.** The RTX 5080 is Blackwell, **sm_120**. cu121 wheels contain no sm_120
   kernels and fail with *"no kernel image is available for execution on the device"* — which
   reads like a broken install and is not one.
3. **`ffmpeg` is missing.** Load-bearing here: duration probing, poster frames, loop crossfades,
   radio chain, loudness. `winget install Gyan.FFmpeg`, and check `ffprobe` is on `PATH` too.
4. **Nothing large goes in OneDrive.** The repo is under `OneDrive\Programming projects\`. Model
   roots and the project folder with its candidate history both belong on a normal path
   (`D:\ai\models`, `D:\scenario-projects\`). Only the published assets — one file per name —
   land in the synced repo.

---

## 13. Build order

- **Phase 1 — project + sections, no generation.** Project file, ledger, storyboard import, the
  six section views showing missing / stale / ready against `assetsOf()`. Turns a checklist in a
  document into a live status board, and is useful before a single model is installed.
- **Phase 2 — images.** ComfyUI, `extra_model_paths.yaml` management, one workflow template,
  tiers 0–1, takes and select/publish. Most of the risk and most of the value.
- **Phase 3 — voice.** *Built.* A uv-managed Python sidecar over stdio, a placeholder backend
  and Chatterbox, a cast panel, per-row generate and publish. The `hold:` mismatch is reported
  after each generate rather than written back: the number belongs to the scenario, and a
  machine editing timing while an author is editing dialogue is a fight nobody wins.
- **Phase 4 — the canvas.** Schema, checker, protocol and display changes, then the board.
- **Phase 5 — video, then music/sfx/ambience and the loudness pass.**

Voice before video is deliberate: voice is what the show cannot run without, it is cheap, and it
unblocks the `hold:` values the timing depends on. A scene with a still and no `video:` is a
complete, shippable scene.

---

## 14. Decisions and open questions

**Settled: published assets do not go into git.** A project is built somewhere else and
published somewhere else, and the editor is standalone of the projects it develops. So a
project is entirely self-contained — `scenario.yaml` and `storyboard.md` live *in the project
folder*, takes accumulate under `generated/`, and `publish:` points at the project's own
`dist/assets`. Nothing points into this repo and nothing comes back to it. The repo's
`scenarios/` folder is just one possible publish target, for the bundled demo scenarios.

Takes live under `generated/` **inside the project**, for the same reason: a project split
across two drives is one nobody can hand to anybody else, and one nobody can open a year later.
Where a workspace sits in a cloud-synced folder the editor says so in a comment at the top of
`project.yaml` — voice takes are kilobytes, stills and video are not — but it says it rather
than acting on it. Where the takes go is the author's call, and `generated:` accepts an
absolute path for exactly that reason.

**Settled: a shot carries its own still.** `background:` and `video:` are optional on any
node, overriding the scene's for as long as that node plays. A scene is a *place* — its music
and ambience persist across every node played there — and a place gets many camera setups; a
storyboard has far more shots than locations. Without this, a second shot in one room needed a
second scene, which made "scene" stop meaning "place" and re-triggered the scene's audio on
every beat.

The override belongs to the node that declared it and ends when that node does. A later node
with no override falls back to the scene's still, which is what keeps the scene the default
rather than merely the first shot. Inheriting it forward would make the picture depend on which
way the audience voted.

The fields are independent, so a node may take the clip and leave the still — motion over the
scene's picture is a real thing to want. It is also how one shot's still ends up under another
shot's clip, which only becomes visible on a projector, so the checker warns when a node
overrides one and inherits the other.

For the importer this is the whole ballgame: a node-level still maps straight to the shot that
node came from, instead of every shot in a place competing for one scene-level slot.

**Also open:**

1. **Does the editor supervise ComfyUI, or do you?** Recommendation: it detects and health-checks,
   and prints the command to start anything that is down. It stays a tool, not a process manager.
2. **Does a node-level `layout:` override earn its complexity**, or is scene-level enough for the
   first cut? Scene-level alone is simpler and probably covers Arctic Sentinel.
3. **`music:` and `ambience:` are declared and sent to the display, but nothing plays them yet.**
   Their rows appear on the board, but the files they name will not be heard until that lands.

**Settled: a scenario declares its media before the media exists.** That is the only way the
board can show work still to do, and `npm run validate` now treats missing art as a warning
rather than a failure — `--strict` restores the old behaviour and is what a pre-show check
should run. The display was already safe: a 404 resolves the preload immediately instead of
stalling it, and the stage gradient now shows through a declared-but-missing background.

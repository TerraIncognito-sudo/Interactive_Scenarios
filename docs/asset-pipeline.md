# The asset pipeline

How a scenario full of declared filenames becomes a folder of finished media the projector
opens. This is the middle layer: [README.md](../README.md) says what the program is and
[voice-generation.md](voice-generation.md) covers setting up the one section that has a
generator. Everything here is about the board — the tabs in the client window where the work
is tracked, brought in, checked and shipped.

The order of work, in one line: **declare → make → select → publish**. Declaring comes first
on purpose. A filename in `scenario.yaml` is what puts a row on the board, so a scenario can
name every picture it needs before a single one exists — and that list *is* the work.

---

## 1. Three files, three owners

**A project is a folder containing `scenario.yaml`.** Nothing more is required — that is the
same shape the show reads, which is what makes shipping a finished scenario a matter of
copying the folder across. The storyboard, `project.yaml` and the takes ride along and are
inert to the loader.

The client holds no opinion about where those folders live. On first run it asks for a
**workspace** — the folder that contains them — and remembers the answer in
`~/.interactive-scenario/editor.json`. The picker is served by the local process, because
the browser's `showDirectoryPicker()` hands the page a handle and deliberately never reveals
a path, and a path is exactly what the server needs.

| File | Owner | Contents |
|---|---|---|
| `storyboard.md` | **human**, prose | acts, shots, image briefs, VO script, direction |
| `scenario.yaml` | **human + client**, structured | the show. Every asset filename lives here |
| `project.yaml` | **human**, structured | which model makes a section, per-asset briefs and params, the voices |
| `.ledger.json` | **machine only** | every take, its hash, which one is selected, which one shipped |

The split between `project.yaml` and `.ledger.json` is the important one. The project file is
full of hand-tuned text you will edit for weeks; the ledger is appended to on every single
generation. Round-tripping YAML through a program destroys comments and reflows formatting, so
**the machine never rewrites the file the human owns** — field edits go through YAML's
document API and by source offset, and a test guards it. Prose stays pristine; the churn goes
in JSON nobody reads by hand.

### Project layout

```
<workspace>\arctic-sentinel\
  project.yaml
  scenario.yaml
  storyboard.md                              <- or a path to one elsewhere
  .ledger.json
  voices\                                    <- reference clips for a cloning model
    narr.wav  tran.wav
  generated\                                 <- every take ever made
    images\station.jpg\   9f1befa9-01.png  9f1befa9-02.png
    voice\tran-d5-01.mp3\ 4b2c8e10-01.mp3
  assets\                                    <- what publish writes; what the show opens
    images\station.jpg
    voice\tran-d5-01.mp3
  records\                                   <- what an audience decided, once it has
    2026-09-16-1942.md
```

Everything a project is made of is in one folder that copies as a unit — which is what makes
deploying "move this folder" and what makes a project openable a year later. Paths in
`project.yaml` resolve relative to it and may be absolute, so one project can drive a scenario
living in the repo while 40 GB of takes sit on another drive. If the folder is inside a synced
drive the client says so in a comment at the top of the file; where the takes go stays the
author's call, because a project split across two drives is one nobody can hand to anybody
else.

`.gitignore` keeps the author's half — `project.yaml`, `.ledger.json`, `generated/`,
`voices/`, the storyboard and `records/` — out of version control for folders under
`scenarios/`. So the folder is the show to git and the whole project to the client, and you
can author in place.

---

## 2. Generate, select, publish

An asset takes several tries. You want all of them kept, comparable, and disposable. But
`scenario.yaml` says `background: images/station.jpg` and the show will open exactly that one
file — it cannot know about `9f1befa9-03.png`.

So the pipeline has three stages, and the distinction is the spine of the whole thing:

```
make      ->  generated\images\station.jpg\9f1befa9-03.png    many takes, kept
select    ->  the ledger records station.jpg -> take 03        a pointer, reversible
publish   ->  assets\images\station.jpg                        exactly one file, the declared name
```

**Publish is a copy, and it is the only thing that touches what the show opens.** Everything
upstream is scratch. Consequences worth having on purpose:

- Choosing a different take is instant and free — re-publish, done. No regeneration.
- What ships is only the takes you chose, at the names the scenario expects.
- Deleting a take never touches the published file. Publishing is the deliberate act that put
  a reading in front of an audience, and a delete that quietly un-shipped a line would not be
  noticed until the room went silent.
- **Generating never publishes and never steals a selection.** Re-rolling has to be free or
  nobody does it, and then the first acceptable reading of every line is the one that ships.

`assetsOf()` in `shared/scenario/load.ts` defines *what* is needed: it walks a parsed scenario
and returns every filename referenced. That is the manifest. `project.yaml` supplies the recipe
for each name; the ledger supplies the takes.

---

## 3. Six sections, decided by the schema field

| Section | Schema field |
|---|---|
| images | `characters.*.sprite`, `scenes.*.background`, node `background:` |
| video | `scenes.*.video`, node `video:` |
| voice | `lines[].voice` |
| sfx | `lines[].sfx`, `pause` node `sfx:` |
| ambience | `scenes.*.ambience` |
| music | `scenes.*.music` |

The routing rule is **which schema field referenced the file**, never the file extension. A
`.mp3` in `voice:` and a `.mp3` in `music:` are different work made by different models, and
the field already says which is which. `assetReferencesOf` is the single walk both `assetsOf`
and the board are built from; two walks would eventually disagree, and the board's would be
the one that disagreed silently.

Ambience is its own section rather than a flavour of sfx because its production profile is
nothing like a one-shot: ninety seconds, looping, textural, made with different parameters
even when the same model serves both.

**Assets are filed by media type, in the name the scenario declares** — `voice/tran-d5-01.mp3`,
not `tran-d5-01.mp3` under a rule the display works out for itself. Flat names stay legal
because every scenario written before the convention is one, and the **File into folders**
button migrates a project. It costs a project no takes: a takes folder whose name already
carries its section is recognised as the same folder.

---

## 4. The row

Every row is one filename from the manifest. It carries:

| Field | Purpose |
|---|---|
| `prompt` | the brief — what this file is supposed to be. The main working surface |
| `size` | `1920x1080`. Declared, then checked against the real file |
| `params` | free-form; seeds, steps, post chains |
| `text` | voice only: the line this clip says. **Owned by the scenario** |
| `voice` | voice only: which configured voice reads it. Owned by the scenario |
| `gap` | voice only: seconds of room after the clip before the beat ends |
| `notes` | free text; what you are still unhappy with |
| `freeze` | character sheets and ship plates, protected from re-rolling |
| `source` | back to the storyboard shot and the scenario node |

```yaml
assets:
  images/station.jpg:
    prompt: |
      High wide aerial: the ship holding a slow racetrack patrol in a channel
      between two snow-dark islands, ice-strewn water, flat grey light, no horizon.
    size: 1920x1080
    source: { shot: C.1, node: c1_on_station }

  voice/tran-d5-01.mp3:
    text: We've lost the link.
    voice: tran
    gap: 0.6
    source: { shot: D.5, node: d5_link_dies, line: 0 }
```

There is deliberately **no `section:` key**. The section is derived from the field that
referenced the file, so storing it would be a second answer to a question the scenario already
settles.

### A row has two owners

Most of a row is yours — the prompt, the size, weeks of tuning. Four fields are not opinions at
all but copies of something the scenario already says: `text`, `voice`, and
`source.node`/`source.line`. Those are **re-derived on every scenario save**.

`text` is the one that bites. Seeding used to be strictly additive, which is correct for a
prompt and silently wrong for this: edit a line of dialogue and the row kept the words it was
seeded with, the hash never moved, the board went on saying `ready`, and the clip in the show
read a sentence that had been deleted. Nothing reported it, and the only way to find it was to
listen to all ninety. Because `text` is in the hash, correcting one now marks exactly the
affected clips stale — the re-record list writes itself.

A prompt is **not** on that list and must never be. Two people can disagree about how a shot
should look, and only one of them has seen the film.

### Status

`missing` · `unselected` · `unmanaged` · `stale` · `ready`

`stale` is the one that earns its keep: the file exists, but the hash of the recipe no longer
matches the hash recorded when the take was made. That means the brief changed after the art
was made — the single frame that does not match the film. `freeze: true` protects a character
sheet from ever going stale when a shared brief is edited.

`unmanaged` means a file is in place and nothing on record says which recipe it answers. That
used to be a dead end for any section with no generator — which is every section but voice.
Both ends are closed now: an import records what it brought in, and **Adopt** records a file
already sitting there. What gets written is the *current* recipe hash, which is not a claim
that a model made it but the author saying *this file is my answer to this row*. That is what
makes the whole board work on hand-made art: edit the brief afterwards and it goes stale,
which is exactly the reminder you want.

### The ledger

```json
{ "images/station.jpg": {
    "selected": "9f1befa9-03.png",
    "published": "9f1befa9-03.png",
    "takes": [
      { "id": "9f1befa9-03.png", "hash": "9f1befa9…", "from": "station-v3.png", "at": "2026-08-25T14:02:11Z" },
      { "id": "9f1befa9-02.png", "hash": "9f1befa9…", "at": "2026-08-25T13:58:02Z", "ms": 40850 }
    ] } }
```

`published` exists because `ready` says the selected take matches the recipe and says nothing
about whether anyone ever copied it to the name the show opens. Without it a project could be
entirely green while the room heard the previous reading of every re-recorded line, and nothing
on the board could see it. `from` is present exactly when nothing generated the take — a dialog
filename, or the published file it was adopted out of — which is the honest way to record art
made in another program: no seed will reproduce it, and saying so is better than implying one
would.

---

## 5. Prefill from the storyboard

A storyboard already has the structure an importer needs. Each shot is
`### Shot A.1 — Cold open, the jetty`, followed by `**Hold:** 8 s · **Scene:** halifax`, an
`**IMAGE**` fenced block, a `**MOTION**` line, and `**VO — narr**` blockquotes with
`*Delivery:*` notes. `docs/prompts/storyboard-brief.md` is the document that teaches a language
model to write one in exactly that shape, and `tests/guide.test.ts` holds it against the
parser.

From that, creating a project emits one scenario node per shot with its `scene:`, its `hold:`
and its dialogue lines, plus one row per asset with the brief already in it. Retyping
twenty-six image briefs is the kind of work that stops a pipeline being used.

Two rules keep it honest.

**Names are never invented.** Seeding keys every row to `assetReferencesOf(scenario)` and
reports anything it cannot place. A brief written against a name of the board's own choosing
would belong to a file nothing ever loads. The one place names *are* invented is the scaffold,
which is writing the scenario that will reference them — so the two files still agree.

**A voice row's `text` is the scenario's line, never the storyboard's blockquote.** A
storyboard quotes a whole delivery at once where the scenario splits it into the lines the
display shows, so reading the storyboard by position puts one line's words in another line's
clip. The storyboard contributes the `*Delivery:*` note and nothing else, matched by speaker,
since one note covers every line split out of its block.

Re-seeding is safe and additive: it fills in what a row does not have yet and touches nothing
else.

---

## 6. The buttons, and why they are buttons

**Anything the pipeline needs done to a project, the client does.** If a scenario has to be
hand-edited or a script run once to get an asset onto the board, the ecosystem has a hole in it
and the two halves will drift. All of these are idempotent, all report what they changed, and
all edit by source offset so comments and hand-wrapped scalars survive.

| Button | What it does |
|---|---|
| **New…** | Makes a folder and a starter scenario that already runs, from nothing but a name |
| **Create the project** | The same route with a pasted `scenario.yaml` in hand, which is how the walkthrough ends |
| **Open folder** | Hands the project's folder to the file manager, because dropping a still into a takes folder is still file work |
| **Declare voice clips** | Puts a `voice:` on every spoken line, then re-seeds so each has a row |
| **Give each shot its own picture** | Moves a storyboard shot's still onto its node as `background:`, and folds away stand-in scenes that existed only to carry one |
| **Give speakers a portrait** | Declares a `sprite:` for each character the storyboard drew a *character sheet* for, and only those |
| **File into folders** | Migrates flat asset names to `voice/…`, `images/…`, carrying the takes and the published files with them |
| **Fix extensions** | Renames a file whose bytes disagree with its name. A rename, never a conversion |
| **Write the timings** | Reads each clip's real runtime, adds its `gap`, and writes `hold:` into the scenario |
| **Adopt** | Records a take that was already sitting there |
| **Import** | Brings a file in from the system file dialog and records it |
| **Prune orphans** | Removes rows the scenario stopped referencing, with the list in front of you |
| **Discard strays** | Deletes files on disk that no row and no scenario mentions any more |

Two of those need their reasoning stated, because both look like omissions.

**Reconciliation adds and corrects; it never removes.** A row the scenario stopped referencing
is *reported* and left exactly where it is, because a row can hold an afternoon of tuning and a
rename nobody meant to make is not a trade the machine gets to choose. Removal is a button,
with the list visible.

**An action must not edit your prose.** A migration that removes a scene leaves any comment
describing it factually wrong, and the temptation is to fix the sentence — but a machine that
rewrites prose to keep it true will eventually rewrite prose that was already true. It reports
the line numbers and stops.

---

## 7. Checks the board runs for you

None of these owns a codec. All three read file headers only, which is the discipline that
keeps the board able to *read* a file the show will play without pretending to make one.

**Format.** A `.wav` served as `audio/mpeg` is a silent beat in front of a room with nothing in
any log, because the content type comes out of the extension. So the bytes are sniffed and a
mismatch is offered as a rename. Never a conversion: re-encoding a PNG as a JPEG to satisfy a
name somebody typed months ago throws away the transparency a portrait needs. A format with
several true names (`.jpg`/`.jpeg`, the MP4/M4A/MOV family) is never nagged about, because being
technically right there is how a list becomes one people skip.

**Size.** Every web image tool opens on a square, so a still arrives 1024×1024, lands in a 16:9
show, and is letterboxed or cropped through the subject with nothing saying so. The row declares
what the picture is supposed to be — defaults taken from the stage's own geometry, a 1920×1080
surface and a portrait 460 wide — and the file is measured against it. Stills only: a clip's
dimensions live several nested atoms deep, and reporting a correct clip as the wrong shape sends
somebody off to re-render something that was already right.

**Duration.** Nothing on the clock's side ever opens an audio file — a beat ends when `hold`
says it does — so a `hold` a second short cuts a reading off mid-word, and the only way to find
out used to be sitting through every clip with a stopwatch. The board measures the clip and
compares it to the beat, with a second of headroom because equal is not safe. *Could not tell*
never warns: sending somebody to re-cut a line that was already right is worse than not telling
them.

A **portrait** gets two extra rules, both from one failure. The display draws it over the scene
with a `drop-shadow`, which follows the alpha — so a JPEG arrives as a bust card with a shadow
around all four sides, a failure that reads as a deliberate frame and would therefore survive
all the way to a projector. It must be a transparent PNG, and its brief must not ask for a
background.

---

## 8. The command centre

The board is organised the way the work is *made* — by section, by character, by row — which
is right while you are making it and useless when you are trying to find out whether you are
finished. The command centre is the other view of the same thing, and it is deliberately *only*
a view: every item is derived from what the board already built, and nothing in it reads the
disk, the ledger or the scenario on its own. A second walk would eventually disagree about what
is finished, and the disagreement would be invisible — both would look like a full list.

Its groups run in the order the work has to happen: **missing → unselected → reselect → stale →
republish → publish**, then the ones that are not pipeline stages at all — unmanaged, cast,
timing, misnamed, quality, orphans, strays. Every asset lands in at most one of the six pipeline
groups, because a file that was never made is not *also* waiting to be published and counting it
twice makes the total useless. Quality is the exception and is additive: a clip can be finished,
shipped, and still the wrong shape.

**When every group is empty, the show is ready.** That is the whole contract, and it means
anything that can leave a project unfinished has to appear there or the emptiness is a lie.

---

## 9. What this pipeline deliberately does not do

**It does not generate images or video.** It never did — only prompt scaffolding for it existed,
and that scaffolding is deleted. Stills, clips, effects and beds are made in whatever program
you like and brought in; the board's job is to know what is needed, record what arrived, check
it, and ship it. A row's `prompt` is a note to whoever makes the picture, still in the recipe
hash, because for hand-made art the note going stale is exactly the reminder you want.

**It does not expand a shorthand.** A storyboard that writes `STYLE. SHIP. Pre-dawn at a
jetty…` used to have `STYLE` and `SHIP` substituted at compose time. Nothing expands them now,
so a brief must stand on its own — and the briefs in `docs/prompts/` say so, with a test to keep
them saying it.

**It does not own an encoder.** Format, size and duration all read headers. Correcting a name is
a rename.

**It does not reach a running show.** While a project is on the projector, the routes that move,
overwrite or delete bytes the display will ask for by name are refused, and the refusal names
the show holding the folder. Editing a brief is *not* on that list and must not be: a show holds
the scenario it was started with in memory, so authoring the next draft while the current one is
on the wall is exactly the thing having one program makes safe.

# CLAUDE.md

Guidance for Claude Code working in this repo. Read [README.md](README.md) for what the
project is and [DEPLOY.md](DEPLOY.md) for how it ships. This file covers what those two
don't: the constraints that will bite you, and the invariants that must not be broken.

## Commands

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run validate
```

Structural problems are errors; art that has not been made yet is a warning, so a scenario
can declare its media before the media exists — which is what puts it on the editor's asset
board. Add `--strict` for a pre-show check, where a missing file *is* an error.

```bash
npm run build
```

```bash
npm run voice:check
```

Proves the voice sidecar end to end — uv, Python, the bridge, and MP3 encoding — without a
model. Add `-- chatterbox` once one is installed. See
[docs/voice-generation.md](docs/voice-generation.md).

`npm start` runs the server, `npm run local` runs it in laptop-fallback mode, `npm run dev`
watches, `npm run editor` starts the scenario editor on 8890. **Never leave a dev server
running** — one was left on port 8880 once and served a stale page to the user's browser
while they debugged a "crash" on the real server. Kill what you start.

```bash
npm run project:new -- <storyboard.md> <target-folder> "Some Title"
```

Scaffolds a project folder from a storyboard, for when a storyboard exists and there is no
scenario yet. Once a folder has a `scenario.yaml` the editor takes over: it asks for a
**workspace** folder on first run and lists every folder inside it that has one. See
[docs/asset-pipeline.md](docs/asset-pipeline.md).

## The build constraint that shapes everything

Server code is TypeScript that **Node 24 runs directly** by stripping types. There is no
server build step, and keeping it that way is deliberate. Three consequences:

- **Relative imports carry an explicit `.ts` extension.** `import { Room } from './room.ts'`.
- **No non-erasable syntax.** No `enum`, no `namespace`, and no parameter properties —
  `constructor(private readonly store: Store)` throws `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`
  at runtime. Declare the field, assign it in the body. `erasableSyntaxOnly` catches this
  in typecheck; trust it, it is not being fussy.
- **`typescript` is 7.x**, the native compiler. It does not auto-include `@types`, hence the
  explicit `"types": ["node"]` in tsconfig.

Only the client is bundled (Vite, four entry points, no root `index.html` — the server
routes `/` to the player app so the landing page is the audience join screen).

`node --test tests/` does not work. The script uses a quoted glob: `node --test "tests/**/*.test.ts"`.

## Invariants

These are load-bearing. Each one exists because breaking it produced a real failure.

**The engine is pure.** `src/engine/engine.ts` is `state + event -> state` with no I/O. That
is what makes every branch path testable without a browser, and what lets the display run
the same engine client-side. Do not reach for a timer, a socket, or the database in there.

**Players never receive a snapshot.** `Room.subscribe()` sends players only `playerState`.
A snapshot contains upcoming dialogue, the scene, and any pending poll result — sending it
leaks the story to forty phones. A test guards this.

**`close()` ends a show; `shutdown()` stops the process.** They are not synonyms. Marking
rooms closed on shutdown means a container restart or a SIGTERM silently destroys every
live session.

**Every poll needs a `default:`.** Enforced by the validator. A poll that receives zero
votes must never deadlock in front of an audience.

**Scenario files are content and content must never execute code.** The expression language
in `src/engine/expr.ts` is a hand-written recursive-descent parser with no `eval`, no
property access, and no function calls. Keep it that way.

**Scenario schemas use `z.strictObject`.** A typo like `nxt:` should be a loud load-time
error, not a silently ignored key.

**Generated links follow the request.** `baseUrlFor()` honours `X-Forwarded-Host`/`Proto`,
so a LAN request gets LAN links and a Cloudflare-proxied one gets public links with no
config. `PUBLIC_URL` is an override for the rare mismatch, and an empty value means unset —
it must never fall back to `localhost`, which is how links once pointed at the operator's
own machine while looking perfectly valid.

**Room timer callbacks are wrapped in `Room.guard()`.** An exception inside `setTimeout` is
uncaught, and an uncaught exception exits Node — one malformed node would kill every other
room on the server. Anything scheduled goes through the guard.

**Room codes exclude `O/0`, `I/1`, `S/5`, `Z`.** They are read off a projector from the back
of a room.

**A scene is a place; a node is a shot.** `music:` and `ambience:` hang off the scene and
persist across every node played there. `background:` and `video:` may be overridden per node,
for that node only — `sceneMediaOf` in the engine is the one resolver, used by the server
snapshot and the display alike. An override that leaked forward would make the picture depend
on the path the audience voted down, and one scene per shot would re-trigger the scene's audio
on every beat.

**An asset's production section comes from the schema field that referenced it**, never from
its extension. A `.mp3` in `voice:` and a `.mp3` in `music:` are different work made by
different models. `assetReferencesOf` is the single walk both `assetsOf` and the editor's
board are built from — two walks would eventually disagree, and the editor's would be the one
that disagreed silently.

**Assets are filed by media type, in the name the scenario declares.** `voice/tran-d5-01.mp3`,
not `tran-d5-01.mp3` under a rule the display works out for itself. A layout convention would
have to live in the display, the validator and the editor at once, and the first time the three
disagreed the audience would see it — where a name is just a name, `publish` writing to
`assets/voice/` and the projector fetching `assets/voice/` are the same fact stated once.
Flat names stay legal, because every scenario written before this is one. `folders.ts` is the
migration and `filed()` in `storyboard.ts` is what makes new projects born that way; `takesDir`
drops the section from a name that already carries it, so filing a project costs it no takes.

**A part is the unit of work, and the Characters tab is where it lives.** A voice is set once,
belongs to one person, and changing it makes every line they speak stale at once; a portrait is
that same person's face. Those two halves are made weeks apart by different models and used to
sit under two different sections, joined only by an id the author carried in their head — so
`renderCast` puts them on one sheet, with a thumbnail (a face is the one thing on the board that
cannot be checked by reading) and a sub-tab for each half. It is the **first** tab: a show is
people, and the rest is machinery.

**Portraits and stills split in presentation, never in production.** `isPortraitAsset` reads the
scenario's own `origins`, so a portrait leaves the Images list and appears on its character's
sheet — but its *section* stays `images`, because it is made by the same model with the same
style, and a face that does not match the film reads as clip art the moment it slides in. Every
row has exactly one home (`rowsFor`); listing one in two places is two views that disagree about
what is selected the moment either is a click behind, and the section it left says where it went.

**The three actor-level actions are the re-voicing job in order**: **Regenerate** (stale ones when
there are any, all of them otherwise — the label says which), **Use newest**, **Publish**. *Use
newest* is separate from generating on purpose — generating never steals a selection, so moving
one is its own act with its own count. **Publish covers every clip with a selection**, not the
ones that "look like they need it": `ready` means the selected take matches the recipe and says
nothing about whether it was ever copied to the published name, which nothing on the board knows.

**Importing sends bytes, never a path.** The browser's file dialog is the system one and hands
the page a `File` with no path in it, so `importTake` takes a stream and the metadata rides in the
query — raw `application/octet-stream`, because base64 in JSON inflates a hundred-megabyte clip by
a third and buffers all of it to gain nothing. That is also the safer half: no route here opens a
location somebody typed. It writes through a temporary file and renames, since a truncated file in
a takes folder looks exactly like a take. The one `<input type="file">` is created once and kept
out of the render tree — `render()` replaces the tree on every state change, and an input inside it
is destroyed the moment the picker opens, taking its change event with it, silently.

**A name is a promise about content, and the name follows the bytes.** The display asks for
the name `scenario.yaml` declares and the server picks a content type out of its extension, so
PNG bytes called `.jpg` go out labelled `image/jpeg`. Browsers sniff images and forgive it; a
`.wav` served as `audio/mpeg` is a silent beat in front of a room with nothing in any log.
`format.ts` reads the header only — no dependency, the same discipline `size.ts` and
`duration.ts` keep — and video *is* handled there, unlike in `size.ts`, because a container is
the first four bytes while dimensions are several atoms deep. Correcting one is a **rename**
and never a conversion: owning an encoder is the thing all three of those modules exist by
refusing to do, and re-encoding a PNG as a JPEG to satisfy a name somebody typed months ago
throws away the transparency a portrait needs. Two rules keep the group worth reading —
`undefined` from the sniffer must never produce a complaint, and a format with several true
names (`.jpg`/`.jpeg`, the whole MP4/M4A/MOV family) is never nagged about, because being
technically right there is how a list becomes one people skip. The rename goes through
`renameReferences` and `carryRename`, the same two pieces filing by media type uses: a
half-renamed asset is worse than a misnamed one, since the board reports it ready and one shot
of the show is a gradient.

**A take that came in from outside is recorded, not merely written.** `unmanaged` means a
file is in place and nothing on record says which recipe it answers — and for a section with
no generator that was every asset in it, permanently. `importTake` wrote the bytes and no
ledger line, so the row stayed `unmanaged` with the file in its own takes folder, selected,
while the command centre advised importing it: the thing that had just been done. There was no
route out of the state at all. Both ends are now closed — an import records what it brought in,
and `adoptTakes` records a file already sitting there. What gets written is the *current recipe
hash*, which is not a claim that a model made it (`from` says where it came from, and there is
no seed) but the author saying this file is their answer to this row. That is what makes the
rest of the board work on hand-made art: edit the prompt afterwards and it goes stale, which is
exactly the reminder somebody wants when the shot they drew no longer matches what the row asks
for. Adopting takes the *selected* take only — a folder with nothing picked reads as
`unselected`, a different question — and the one case that copies bytes, out of the publish
folder into an empty takes folder, is also the only one allowed to claim `published`, because
the copy is what just made them the same file.

**A dropped asset leaves disk behind, and only the folder still says what it was.**
The board is built from the scenario, which is what stops it drifting — cut a line and its row
goes with it. What goes nowhere is the clip in `assets/` and the six takes in `generated/`:
off the board, so nothing ever mentions them again. `findStrays` in `sections.ts` is the one
walk that finds them, and `discardStrays` deletes the published file, every take and the ledger
entry — never the recipe row, which is an afternoon of tuning and `pruneOrphans`' decision to
make in front of its own list. A takes folder is found by its own path, since `generated/<section>/`
carries the section; a published file is found only under a `<section>/` prefix, because once the
scenario stops naming a file the folder it was filed into is the last record of what kind of thing
it is — and the publish root also holds READMEs and notes the pipeline did not put there. The
client sends names, never paths, and a name the board does not already call a stray is refused:
that, not the containment check, is what makes the route safe.

**A destructive route validates the name itself.** `deleteTake` takes a string that reaches
`join()` on the way to an `rm`. `safeTake` rejects `.` and `..` — the dot is in the character
class because a take has an extension, which is the same trap `safeAsset` had — and the result is
checked for containment as well. Deleting never touches the published file: publishing is the
deliberate act that puts a reading in front of an audience, and a delete that quietly un-shipped a
line would not be noticed until the room went silent. Deleting the *selected* take clears the
selection rather than moving it, because guessing a replacement ships a reading nobody chose.

**A project route's action may contain a hyphen.** The router's `([a-z][a-z-]*)` was `([a-z]+)`,
and `delete-take` 404d while looking correct at both ends — the client reported "Not found"
against the asset rather than the URL.

**The editor plays what it made — and shows it.** A board that can only describe a clip is a
board whose selection step is guesswork, and a pipeline nobody can hear ships the first reading
of every line. Choosing between six jetties by filename is worse than guesswork. `resolveMedia`
in `tools/editor/projects.ts` resolves a take, a published file or a reference clip from
structured parts and checks the result is under the project — the editor browses the whole disk
on purpose, but that is a picker a person drives, and a URL that dereferences `../..` is a
different thing. One `Audio` element and one `<dialog>` serve the whole board: forty of either is
six readings of one line at once, or six windows of the same jetty to close.

**What a take is auditioned *with* follows its section, never its presence.** `auditionButton`
picks by `AUDIBLE`/`VISIBLE`; every take carried a play button for months because every take was
a sound, and the first image on the board fed a JPEG to an `<audio>` element — whose decode error
reads "could not play that file — is it still on disk?", sending the author to look for a file
that is right there. Cleanup on the viewer hangs off an explicit `closeViewer`, not the `close`
event: `showModal()`/`close()` toggle the attribute everywhere, but the event does not arrive in
every browser, and a clip playing behind a dialog that has visibly gone is the failure that
found it.

**The editor and the player must agree on filenames.** The player opens exactly the names in
`scenario.yaml`, so the editor may never invent one. Seeding prompts from a storyboard keys
every row to `assetReferencesOf(scenario)` and reports anything it cannot place; a prompt
written against a name of the editor's own choosing would belong to a file nothing ever loads.
The one place names *are* invented is `scaffold.ts`, which is writing the scenario that will
reference them — so the two files still agree. Tests guard both routes.

The same rule governs what a voice clip *says*: `text` on a voice row is the scenario's line,
never the storyboard's blockquote. A storyboard quotes a whole delivery at once where the
scenario splits it into the lines the display shows, so reading the storyboard by position puts
one line's words in another line's clip. The storyboard contributes the *Delivery:* note and
nothing else — matched by speaker, since one note covers every line split out of its block.

**The game server never learns about Python.** The sidecar in `tools/voice/` belongs to the
editor, which runs at a desk for weeks; the show runs from a container holding no models at
all. Generation deps must never reach `package.json`'s runtime path or the Dockerfile — a
projector that needed three gigabytes of CUDA wheels to read a YAML file is a projector that
does not start.

**A model process talks over a pipe, never a socket.** A pipe dies with its parent, so a
force-quit editor cannot strand a process holding sixteen gigabytes of VRAM — the failure
whose only apparent cure is a reboot. It also avoids a Windows firewall prompt for someone
who wanted to hear a line read aloud.

**Where models live is the machine's business, not the project's.** `project.yaml` travels
to other machines and is opened a year later, so it names a model (`chatterbox`) while the
editor's own config holds the path. The same reasoning as the workspace, for the same reason.

**`assetBase` goes down to `assets/`.** The display joins it to a name straight out of
`scenario.yaml`, so a base one level short makes every asset a 404. It was one level short for
months and nothing noticed, because no scenario had a single asset made — the first would have
been a missing picture in front of a room. A test now fetches `assetBase + file` for real, which
is the only form of this assertion that could have caught it.

**Who gets a portrait is the storyboard's decision.** `sprites.ts` declares a `sprite:` for each
character the document drew a *character sheet* for, and only those. Arctic Sentinel has six
speaking parts and three sheets: the narrator has no face, the ship is a ship, and the Russian
officer is "heard only over radio; never seen as a face". Wiring every speaker would invent three
faces the author deliberately withheld, and one of them would be a person for a warship. Matching
a sheet labelled `Beaudoin` to `beau` is the one guess, so it is narrow — the id outright, or a
whole word of the name — and ambiguity is refused rather than resolved.

**A portrait is a cutout, so it is a transparent PNG.** The display draws it over the scene with
a `drop-shadow`, which follows the alpha; a JPEG has no outline, only four corners, so it arrives
as a bust card with a shadow around all four sides — a failure that reads as a deliberate frame,
which is why it would survive to a projector. `isPortrait` in `size.ts` is the one predicate, and
both consequences hang off it: the size (`PORTRAIT` rather than `STAGE`) and the cutout. The
composer asks for a picture that *mattes* cleanly rather than for transparency itself, because
most image models cannot emit alpha and asking for it produces a painted checkerboard. `portrait`
is on the Recipe, so it is in the hash — and it comes from the scenario, which means every caller
of `resolveRecipe` must derive it the same way (`portraitFilesOf`) or the board and the generator
will disagree about what is finished. Re-pointing an existing `.jpg` is a rename, so
`carryRename` takes the recipe row, the ledger entry, the takes folder and the published file
with it; a portrait aimed at some other name is the author's and is left alone.

**Every picture declares a size, and the file is measured against it.** Art is made in another
program and dropped into the takes folder, and every web UI opens on a square — so a still
arrives 1024x1024, lands in a 16:9 show, and is letterboxed or cropped through the subject with
nothing anywhere saying so. `size.ts` takes its defaults from the display's own geometry (a
1920x1080 stage; a portrait 460 wide with 740 above the dialogue box) rather than from taste, and
writes them onto the row so the choice is in the file the author reads. It reads a real file's
dimensions from the header only — stills, never video, because a clip's dimensions live several
nested atoms deep and reporting a correct clip as wrong shape sends someone off to re-render
something that was already right.

**A prompt is not what the model gets.** A storyboard writes `STYLE. SHIP. Pre-dawn at a
jetty…` and defines STYLE and SHIP once, hundreds of characters each, because the style belongs
to the production rather than to any one shot. Handed to a model unchanged that is five dead
characters and a picture with none of the palette. `prompt.ts` puts them back: `STYLE` and
`NEGATIVE` resolve from the section's own `style`/`negative`, everything else from
`project.tokens`. Expansion happens at compose time, never at import — pasting a bible into
twenty hull shots means re-tuning it twenty times — and only the definitions a prompt *uses* go
into its recipe, so editing one ages exactly the shots that mention it.

An undefined name is reported only where the prompt is plainly invoking it: the leading run, or
a trailing marker on its own line. Every storyboard is full of `RIB.` and `AIS.`, which are
indistinguishable from a reference by shape, and a warning that fires on those is one people
learn to skip.

**The board shows the composed prompt.** Every complaint about the art this pipeline makes has
started with not being able to see what the model was given. A prompt you cannot read is one you
cannot fix.

**A line with no `who:` is still somebody's to read.** Narration with no nameplate — a fiction
notice, a title card — is cast under `NARRATION_VOICE` (`vo` in `project.ts`), an id that is
deliberately not a character, because attributing the line to one to give it a voice would put
that name on screen under a legal disclaimer. `wire.ts` already named those clips `vo-…`; seeding
sets the row's `voice:` to match, `referenceTextFor` reads its lines as the ones with no `who`,
and the cast panel labels it. Miss any of those and the fiction notice is the one silent beat in
a finished show — which is exactly how it was found.

**A character's voice is part of every line they speak.** `resolveRecipe` folds the cast's
reference clip and direction into the recipe, so re-recording a reference marks all ninety
of that character's clips stale. Left out, the hash would say finished about clips made from
a voice that no longer exists.

**A cloning model needs a recording that does not exist yet.** That circle is broken by
keeping a palette model — Kokoro — beside it: it has thirty voices of its own, so it can
read a character's lines and the result becomes the reference clip Chatterbox wanted.
`makeReferenceClip` in `tools/editor/generate.ts` uses the character's *own* lines,
because a reference is copied in register as much as in timbre — a voice sampled reading
"the quick brown fox" comes back as an audiobook rather than a watch-keeper. The preset
that made it is written beside it, so the clip can be made again.

**Generating never publishes, and never steals a selection.** A take is added; the published
file changes only when someone presses Publish. Re-rolling has to be free or nobody does it,
and then the first acceptable reading of every line is the one that ships.

**Anything the pipeline needs done to a project, the editor does.** If a scenario has to be
hand-edited or a script run once to get an asset onto the board, the ecosystem has a hole in it
and the two halves will drift. Declaring `voice:` on every line is `wireVoice` in
`tools/editor/wire.ts`; giving each storyboard shot its own `background:`/`video:` — and
folding away the stand-in scenes that existed only to carry one — is `migrateShotsInto` in
`tools/editor/shots.ts`; removing a recipe the scenario stopped referencing is `pruneOrphans`.
All are buttons, all are idempotent, and all edit by source offset rather than by
re-serialising, so the author's comments and hand-wrapped folded scalars survive.
`tools/editor/yaml-edit.ts` is the one home for that technique; a second copy of it would
eventually disagree with the first about where a key goes.

**A recipe row has two owners, and the scenario takes its half back on every save.**
Most of a row is the author's — the prompt, the negative, the size, weeks of tuning. Four
fields are not opinions at all but copies of something the scenario already says: `text`,
`voice`, and `source.node`/`source.line`. `text` is the one that bites. It is what a voice
clip *says*, seeding was strictly additive, and that is correct for a prompt and silently
wrong for this — edit a line of dialogue and the row kept the words it was seeded with, the
recipe hash never moved, the board went on saying `ready`, and the clip in the show read a
sentence that had been deleted. Nothing anywhere reported it; the only way to find it was to
listen to all ninety. So `planReconcile` in `reconcile.ts` re-derives `DERIVED_PATHS` on every
scenario write, and because `text` is in the hash, correcting one marks exactly the affected
clips stale — the re-record list writes itself. The bar for adding a name to `DERIVED_PATHS`
is that the scenario is *definitionally* right about it. A prompt is not on that list and must
never be: two people can disagree about how a shot should look, and only one of them has seen
the film.

**Reconciliation adds and corrects; it never removes.** A row the scenario stopped referencing
is reported in `plan.orphans` and left exactly where it is, because a row can hold an afternoon
of tuning and a rename nobody meant to make is not a trade the machine gets to choose. Removal
is `pruneOrphans`, which is a button, with the list in front of the person pressing it. The
same walk (`seedRowsFor`) serves seeding and reconciliation, so the two can never disagree about
which line a clip belongs to — and reconciliation does not need the storyboard, because
everything it derives comes from the scenario alone. A project with no storyboard still stays in
sync.

**Saving the scenario is what triggers it, and so is every action that rewrites one.**
`saveScenarioSource` returns the plan; `wireVoice`, `migrateShots` and `wireSprites` call it too.
`wireVoice` had no follow-up at all, so declaring a `voice:` gave the line a file the player
would open and no row anywhere saying how to make it. The client says what moved, because a save
that quietly re-records a clip is its own kind of surprise.

**The command centre is a projection of the board, never a second opinion about it.**
`outstandingOf` reads the `Overview` the other tabs already render and touches no disk, ledger
or scenario of its own. A second walk would eventually disagree about what is finished, and the
disagreement would be invisible — both would look like a full list. Its one promise is that an
empty tab means the show is ready, so anything that can leave a project unfinished has to reach
it or the emptiness is a lie. Every asset lands in at most one of the six pipeline groups, which
are stages rather than independent complaints: a file that was never made is not also waiting to
be published, and counting it twice makes the total useless as a measure of what is left.
Quality is the exception and is additive — a clip can be finished, shipped, and still the wrong
shape.

**Publishing writes down which take it shipped.** `ready` means the selected take matches the
recipe and says nothing about whether anyone ever copied it to the name the player opens, so a
project could be entirely green while the room heard the previous reading of every re-recorded
line. Nothing on the board could see it, because nothing recorded it. `LedgerEntrySchema.published`
closes that, and `republish` is only ever claimed against a recorded take — a file with no record
of how it got there was put there by hand, and telling somebody to overwrite it would be guessing
at work they did deliberately.

**A regenerated take asks to be chosen, not generated again.** Generating never steals a
selection, which is what keeps re-rolling free — but it left the asset reporting `stale` with
the answer already sitting in its own takes folder, under a heading whose button made a *third*
take of a line that already had the right one. `matchingTake` on the view is a take whose hash
equals the current recipe and is not the one selected, and `reselect` sits ahead of `stale` in
the command centre because the two ask for opposite things. `use-newest` picks the take that
matches the recipe rather than the last one in the list: newest is only a guess at that, and it
is the wrong guess the moment anything else was rolled afterwards.

**The board knows where each row actually renders.** `rowsFor` gives voice clips to the
Characters tab and portraits to a character's other sub-tab, so a link that sends somebody to
Assets for either lands them on a tab that does not contain the row — which is worse than no
link, because it reads as the row having been deleted. `homeOf` in the client is the one place
that answers this, and it uses the same `asset.row.voice ?? UNCAST` fallback `byActor` groups
by, so the sheet it opens is the sheet the row is really in.

**A clip's runtime is checked against the beat it has to fit in.** Nothing on the server ever
opens an audio file — a beat ends when `hold` says it does — so a `hold` a second short cuts
the reading off mid-word in front of a room, and the only way to find out was to sit through
every clip with a stopwatch. Every `hold` starts as a reading-speed estimate and a generated
clip is routinely a second or two away from it. `duration.ts` reads the length from the header
only, with no dependency, for the same reason `size.ts` does: the editor's job is to read a
file the show will play, not to own a codec. A second of headroom rather than none, because
equal is not safe — the last word needs somewhere to land. Undefined means *could not tell* and
must never warn: sending somebody to re-cut a line that was already right is worse than not
telling them. Two ways to get it wrong are both pinned by tests — MPEG 2 halves the Layer III
frame, and a wav's byte rate is four bytes past its sample rate; either mistake reports every
clip at exactly twice its length, which turns a real overrun into silence.

**`republish` falls back to comparing the files.** The ledger is exact where it has a record,
but it cannot see back past the day it started keeping one — and choosing a newer reading of an
already-shipped line then moved it to `ready` and asked for nothing while the room went on
hearing the old one. Where no take is recorded, a published file of a different size than the
selected take is certainly not that take. Matching sizes are taken as the same file rather than
hashed: two readings of one line landing on the same byte count is a coincidence, and re-reading
ninety published files on every board build to rule it out is a cost paid every time.


**A gate is a beat with no duration, and that absence is the whole design.**
`schedule()` sets a timer from a beat's `durationMs`, so a beat that reports none is a beat
no clock can end — it leaves on an `advance` that only the moderator's console sends. That
is what makes a presentation possible: the room asks a question, somebody arrives late, and
the title card stays up until a person says otherwise. Deliberately its own node type rather
than a `pause` with the number left out, because an omitted number reads as a mistake and
the failure it causes is a show sitting still in front of an audience while nobody knows a
button is waiting. Two traps are pinned by tests. `beatDeadline` is `Infinity` on every path
that schedules nothing — left stale, `pause` would compute a remainder from the *previous*
beat and `resume` would release the gate on its own, which is the one thing a gate exists to
prevent. And `continue` is a separate command from `skip` even though both reduce to
`advance`: `skip` cuts a beat short, this is the beat arriving on time, and a moderator who
has to press "Skip" to begin their own presentation has been handed the wrong button.

**A node is a block of source, and a block moves whole.** `nodeBlocks` in
`tools/editor/nodes.ts` carves the `nodes:` sequence into contiguous, non-overlapping spans —
one per node, each running from its own leading comments to just before the next node's.
Reordering is a permutation of those spans concatenated back together, so every byte inside a
block survives: the comment above a beat, the hand-wrapped folded scalar, the blank line
somebody left for breathing room. Nothing ever looks inside. A sequence entry's `range`
cannot be used for this and neither can `doc.toString()` — the first runs past the entry into
whatever follows (which deleted the dash off the next line and turned a list into a mapping),
and the second reflows the entire file on the first click.

**The spine is spliced, never recomputed.** Dragging a node rewrites at most three `next`
pointers, and only where a pointer still names the node that followed it in the order it is
being moved out of. A poll option, a branch condition, and a `next` that already skips ahead
are all somebody deliberately jumping; recomputing every exit from list position would flatten
a branching story the first time anyone dragged anything. What is left alone is *reported*
rather than silently kept, because a drag that reroutes nothing and says nothing is
indistinguishable from one that did not work. Renaming an id is never a field edit for the
same reason: an id is the only value other lines depend on by name, so `renameNode` moves the
id, every pointer at it and `start:` together or not at all.

**A structural edit is refused unless the result still loads.** `editNodesIn` parses what it
is about to write and throws with the problems instead of saving. These edits come from
dragging and from text boxes, so the cost of one being wrong is a file the show cannot open,
found by whoever next presses play. For the same reason a new node is born valid: the
template in `addNode` supplies the structure each type's schema insists on — a dialogue's
line, a poll's two options and default, a branch's condition and else — rather than trusting
the caller, and a node added at the very bottom points at the show's ending rather than at
itself, because self-reference also loads and is a beat that repeats forever in front of a
room.

**A node's type and its shape move together.** `type:` is the schema's discriminator, so
writing it alone leaves a node carrying keys its new type rejects and a file that will not
load — which is why retyping is `retypeNode` and not a field edit on a `type` box. Realising
a beat should have been a gate rather than a one-line dialogue is ordinary authoring, and it
used to mean rewriting the block by hand. Two rules make it survivable. Whatever the new type
cannot hold is dropped and **reported**: an edit that quietly deletes a paragraph and says
"saved" is the one people stop trusting an editor over, so the cost arrives in the status line
and the client asks first when the cost is the node's content. And whatever the new type
insists on is supplied, so the node is valid the moment it lands — a dropdown that answers
four of its six choices with an error message is a dropdown nobody uses. What is never
invented is a destination: a node that gains a `next` inherits its own old pointer first, then
the beat below it, and a last ending with none of either is a refusal rather than a guess,
because a self-reference also loads and is a beat that repeats forever in front of a room.
`OWN_FIELDS` is the one list of what each type may hold, and a test compares it against the
Zod schemas — a field added to one and not the other is caught there rather than by an author.
The single case where words survive is a *single* line, both directions: five lines have no
one sentence to become, and picking the first would discard four while looking like it worked.

**A dropped field is a block, and indentation is what says how big.** Removal used to end at
the newline after the pair's own range, which is right for a scalar and wrong for everything
else: a block sequence's range runs past its last entry into whatever follows, so dropping a
dialogue's `lines:` took the top of `next:` with it and left the story pointing nowhere. The
same over-extension `itemSpans` exists to work around. Indentation is what actually delimits
a block value in YAML, so the span is walked down from the key's own line — with a blank line
belonging to nobody, so it neither ends the value nor is swallowed by it, and a dash written
in the key's own column counted as part of the key, because that spelling is legal and reads
that way. `spanOfEntry` in `yaml-edit.ts` is the one home for it, and it takes the parent map
because the *other* spelling has its own trap: removing a key from a flow map has to eat a
comma too, or `{ name: Rook, sprite: … }` becomes `{ name: Rook, }`. Both failures are one
function's to get right, or the copy that did not know about flow maps would be the one
somebody's character was written in.

**A portrait is removed by un-declaring it, and the bytes are a separate decision.**
A face is in the show exactly as long as a `sprite:` names it, so `removeSpriteFrom` drops the
key and stops — the published PNG and its takes stay exactly where they are. That is not
laziness: they become strays, which `findStrays` already prices and `discardStrays` already
deletes in front of a list, and the recipe row holding the prompt becomes an orphan for
`pruneOrphans`. A remove button that also threw away an afternoon of rendering is one nobody
dares press, and the author who wanted the face out of one scene would have lost the picture.
What it reports is where the file *went*, not merely that it left — a board that stops
mentioning a file is otherwise indistinguishable from one that deleted it. Two characters can
share a portrait, so `sharedWith` is computed rather than assumed: calling a file spare while
the projector still opens it is the one wrong answer here. And re-declaring is
`wireSprites`, unchanged — removal keeps no memory of itself, because a hidden list of
"portraits the author said no to" is state nobody can see and nobody can clear.

**A list entry moves whole, like a node one level up.** `moveListItem` is `reorderBlocks`
against `itemSpans`, for the same reason: a line's `hold`, `voice` and `sfx` have to travel
with its words. Reordering by retyping two boxes moves the text and leaves the timing and the
clip behind on the wrong line — a re-record and a beat that cuts off mid-word, from an edit
that looked like nothing. The spine is not involved at all, which is what makes this cheap:
lines play in the order they are written, so nothing outside the node can notice. Poll options
and branch conditions get it too, and there it is not cosmetic — options are the order phones
show them in, and `when` is evaluation precedence, so dragging one above another is a real
edit to how the story routes.

**An asset box offers what the scenario already names.** Reuse is the common case, because a
scene is a place and a place gets several shots — so the second shot wants the first one's
still, character for character. Typed again it becomes `images/jetty-wide.png` on the board
and `images/jetty_wide.png` in the file the projector opens, which is the rule about the
editor and the player agreeing on filenames, failing quietly. `declaredAssets` is the same
`assetReferencesOf` walk the board is built from and not a second one; what is on disk and
unclaimed comes from the `strays` the overview already found, appended after, since a picture
somebody rendered and never wired up is not rubbish until they say so and the board otherwise
only offers to delete it. Offered as a **datalist**, never a `<select>`: an asset is routinely
declared before it is made — that is what puts it on the board to be made — so a control that
refused a new name would break the pipeline's own order of work.

**A beat is the clip plus a gap, and the editor writes it.** Nothing on the server opens an
audio file, so the two numbers only agree if somebody puts them in agreement — which meant
reading a runtime off the board, doing the addition and typing it into `scenario.yaml`, eighty
times, without transposing any of them. `retimeInto` in `timing.ts` writes `hold:` by source
offset like every other scenario action, so a comment beside a beat stays exactly where it is;
which of those comments the change has made *wrong* is reported by line number and never
reworded. One decimal throughout: clip runtimes are real numbers and rounding a beat down to
the whole second below it is how a line gets cut off by a rounding decision nobody made.
`holdMatches` compares at that same precision, or a hold of 5.8 against a target of
5.800000000000001 is a mismatch no edit can ever fix and the board asks for it forever.

**The gap is per clip, and it is timing rather than audio.** A second is the default because
the last word of a line needs somewhere to land, but a beat before a poll wants to breathe and
a three-word interruption wants to land on top of what follows — so `gap` is a field on the
asset row. It is deliberately **not** in `resolveRecipe`, and a test says so: it changes how
long a beat lasts and nothing whatever about the audio, so folding it into the hash would mark
ninety finished clips stale for a timing edit and make re-timing a show cost a re-record of it.
An empty box clears the field rather than writing zero, because a gap of nothing is a real
choice and has to stay distinguishable from never having made one.

**The client sends which clips to retime, never what to.** The target is computed server-side
from the runtime the board measured and the gap the row declares. A client that could send the
number itself is a client that can write a beat nothing on the board agrees with — and the
arithmetic would then exist in two places, which is one more than it can be right in.


**Everything the scenario can declare has to reach the room.** `music`, `ambience` and `sfx`
were in the schema from the beginning: the checker validated them, the board tracked them, the
projector prefetched them — and nothing ever opened one. A scenario could declare a harbour bed,
the board could report it finished and green, and the audience heard silence with nothing
anywhere saying why. Voice was the only audio that ever played. A field is cheap to add to a
schema and the half that consumes it lives in another program, so `tests/playback.test.ts` reads
the display as text and insists every `ASSET_SECTIONS` entry is named there — crude on purpose,
since a check that needs a browser is a check nobody runs. The split in playback follows the one
the scenario already makes: a **bed** hangs off the scene and is keyed on its own file, so a
second camera setup in one room does not restart the sea; a **one-shot** hangs off the line that
fires it and is deliberately *not* cut by the next beat, because two voices at once is worse than
a clipped one but an effect ringing on under the following line is ordinary sound design. A scene
change does stop it — a crack should not follow the picture into another room. Levels are named
constants and every bed is mixed under the voice, which is the thing an audience has to follow.

`sfx:` is on a **line**, and also on a **pause node** — the one node type that has no line to
hang it on. That is not a convenience: a pause is a beat whose entire content can be a sound,
and those are the beats where one matters most. Arctic Sentinel's F.3 is four wordless seconds
of a gun firing, written in the storyboard as `SFX` with `VO — none`, and until the schema
carried it the only way to give that beat any audio was to make it dialogue — which draws the
box the pause exists to leave off. So `AssetOrigin` has an sfx shape with no `line`, and
anything matching on it (`pathFor` most of all, since it decides which key a rename rewrites)
tests the *shape* rather than the kind alone.

**A wait that says nothing is indistinguishable from a hang.** A projector pulls a few
hundred megabytes down before it reports ready, and for the minute or two that takes the host
console said `loading…` — no number, nothing moving, for the same minute whether the download
had ten seconds or four minutes left. Worse, it lied: every asset was started at once and
raced against its own `PRELOAD_TIMEOUT_MS`, but a browser opens about six connections to a
host, so the rest waited in a queue with their clocks already running. At twenty seconds the
whole queue timed out together, the count jumped from about halfway straight to the end, and
the display announced ready while it was still downloading. `pooled` in
`src/client/shared/pool.ts` is the fix and the reason it is a fix: work starts when its turn
comes, so a per-item deadline bounds a download rather than a wait for a turn. The rest is
saying what is true — `displayProgress` carries the count and the bytes (`sizes` on the
scenario endpoint is where the bytes come from, absent for art that does not exist yet), and
`displayReady` carries what never arrived, because a missing decoration must never stop a show
but `ready` over eleven assets that 404'd is the same lie in a different place. One counter,
on the display, sent to the console: two counts over one download would eventually disagree and
the one on the far end of a socket is the one nobody could check.

**Anything the audience is looking at is a beat the server clocks.** The result of a poll used
to be a `setTimeout` inside the display and nothing else knew about it, so the server started
the next line's `hold` the instant the poll closed — while the projector was still showing the
bar chart. Every first line after a vote lost 2.6 seconds: truncated where its hold was longer,
never drawn at all where it was shorter, which after retiming is most of them. It looked like a
polling bug because rewinding and picking manually made it go away — the display had already
revealed that poll once and skipped the animation the second time. `REVEAL_MS` is now a real
beat with a `revealing` phase, and the display renders what it is told. A client-side animation
that holds the screen is a second clock, and the two will disagree in front of a room.

**A phase is restored, never assumed.** `pollClosed` enters the node the vote chose and then
sits on the reveal, so the node is already correct while the bar chart is up. `restingPhase` is
the one place that says what a node settles into afterwards — and `Room.apply` opens a poll on
*entering the polling phase* rather than on the node id changing, because by the time the reveal
ends the node has not changed for some time. Keyed the old way, a vote leading into a second
poll left that poll's deadline at the zero it is stamped with on entry, and it never closed.
What an action must *not* do is edit the author's prose. A migration that removes a scene
leaves any comment describing it factually wrong, and the temptation is to fix the sentence —
but a machine that rewrites prose to keep it true will eventually rewrite prose that was
already true. `migrateShotsInto` reports the line numbers and stops.

An action that rewrites `scenario.yaml` must also push the new source back into the editor
pane and wait for the re-analysis before reporting. The pane holds its own copy: refresh it
late and the analysis overwrites the action's status line; do not refresh it at all and the
next Save quietly reverts everything the action just did.

**The machine never rewrites `project.yaml` wholesale.** It is the author's file, full of
hand-tuned prompts and comments recording why. Field edits go through YAML's document API
(`tools/editor/projects.ts`); parsing to an object and re-serialising strips every comment in
the file the first time anyone touches a text box. A test guards this.

## Layout

| Path | What lives there |
|---|---|
| `src/engine/` | Pure state machine, vote resolution, expression parser |
| `src/scenario/` | Zod schema, YAML loader, graph checker, `validate` CLI |
| `src/server/` | Fastify, rooms, WebSocket, SQLite, admin auth |
| `src/client/` | `display/` projector, `host/` console, `player/` phone, `admin/` console |
| `tools/editor/` | The scenario editor — a separate local process, not part of the server |
| `tools/editor/models.ts` | Which generators exist and whether this machine has their weights |
| `tools/editor/sidecar.ts` | Owning a generator process; stdio JSON, one request at a time |
| `tools/voice/` | The text-to-speech sidecar. Python, uv-managed, editor-only |
| `tools/editor/workspace.ts` | Which folder holds the projects, and the server-side folder picker |
| `tools/editor/project.ts` | Asset projects: `project.yaml` (author-owned) + `.ledger.json` (machine-owned) |
| `tools/editor/sections.ts` | The status board — scenario, recipes, ledger and disk reconciled |
| `tools/editor/nodes.ts` | Nodes as structure: reorder, add, remove, rename, retype, edit any field |
| `tools/editor/reconcile.ts` | What the scenario owns on a recipe row, re-derived on every save |
| `tools/editor/outstanding.ts` | The command centre — the board projected into one list of what is left |
| `tools/editor/duration.ts` | How long a clip runs, from its header — the other half of the `hold` check |
| `tools/editor/timing.ts` | Clip + gap = beat, and writing it into `scenario.yaml` |
| `src/shared/protocol.ts` | Message unions, Zod-validated in both directions |
| `scenarios/` | Content. Adding a scenario is adding a folder — no code changes |

`src/scenario/check.ts` holds the graph integrity Zod cannot express: dangling `next`,
unreachable nodes, unknown characters and scenes, poll defaults that are not options,
unknown `$placeholder`s. Run `npm run validate` after touching a scenario.

The editor is a separate process by design — authoring happens at a desk over weeks, the
game server runs in front of an audience. **The editor has no path of its own into
`scenarios/`**: it serves no route into that folder, holds no constant naming it, and writes
only inside the workspace the author picked. A test asserts that capability stays absent, and
it must stay absent — an editor that could reach the live folder without being asked would
eventually do it by accident.

What the author points that workspace *at* is theirs to decide, and it is now `scenarios/`
itself: a folder picker made the second copy pure overhead, and keeping two meant every change
was made twice or copied across and diverged. `.gitignore` already keeps the editor's half —
`project.yaml`, `.ledger.json`, `generated/`, `voices/` and the storyboard — out of the repo,
so the folder is the show to git and the whole project to the editor. The rule that survives
the move is the one that was doing the work: **do not author into a folder a show is being
served from right now.** The server reads its library at boot and `/api/reload` is deliberate,
so a scenario edit cannot reach a running room — but assets are served off disk as they are
asked for, and renaming one mid-show is a 404 on the next projector to reconnect. Its
simulator
calls the production `reduce`, so **never give it its own copy of the engine**: a
simulation that could drift from the real thing is worse than none. `parseScenarioSource`
in `src/scenario/load.ts` is the shared validation path — the editor and the server must
never disagree about what a valid scenario is.

## Conventions

Comments explain **why**, not what — several in this codebase record the failure that
motivated the code, and that is the house style. Match it rather than stripping it.

Tests are `node:test` + `node:assert/strict`, colocated in `tests/`, named for the behaviour
rather than the function. The server tests drive real sockets against a real server on an
ephemeral port; prefer extending those over mocking.

## Deployment notes

The Docker host is `192.168.1.149`, reachable over SSH, running Docker Desktop on Windows.
**Rebuilding remotely does not work**: Docker Desktop's `credsStore: desktop` requires an
interactive Windows logon session, so `docker compose up -d --build` over SSH fails with
"A specified logon session does not exist" — even for an anonymous pull of a public base
image. `DOCKER_CONFIG` and `--config` do not get around it. The rebuild has to be run by
the user in their own terminal on that machine.

`.env` is gitignored and the user maintains it on the server; `docker-compose.yml` reads it
via `${VAR:-}` defaults. Do not edit the server's compose file to hardcode values.

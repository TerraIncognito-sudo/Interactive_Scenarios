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
| `src/shared/protocol.ts` | Message unions, Zod-validated in both directions |
| `scenarios/` | Content. Adding a scenario is adding a folder — no code changes |

`src/scenario/check.ts` holds the graph integrity Zod cannot express: dangling `next`,
unreachable nodes, unknown characters and scenes, poll defaults that are not options,
unknown `$placeholder`s. Run `npm run validate` after touching a scenario.

The editor is a separate process by design — authoring happens at a desk over weeks, the
game server runs in front of an audience. **The editor cannot reach `scenarios/` at all**:
it serves no route into that folder and writes only inside the author's chosen workspace.
Deploying is a person copying a finished project folder across when the show is ready, and
a test asserts the capability stays absent. An editor able to write into the folder a live
show is served from will eventually do it by accident. Its simulator
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

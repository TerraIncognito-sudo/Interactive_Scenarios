# CLAUDE.md

Guidance for Claude Code working in this repo. Read [README.md](README.md) for what the
project is and [DEPLOY.md](DEPLOY.md) for how it ships. This file covers what those two
don't: the constraints that will bite you, and the invariants that must not be broken.

## The shape of it

Two programs, and almost everything here follows from the split.

**The client** is the program. A local Node process on loopback plus two browser windows:
the **board**, where a show is written, its assets are made and its beats are driven, and
the **stage**, which is the projector. It holds the scenario, the engine, the clock and the
asset pipeline. It runs a whole show, start to finish, with no network at all.

**The relay** is a container that carries votes. It holds a room code, at most one open
poll and the ballots. It has no scenario, no engine and no YAML parser, and it decides
nothing — a winner depends on `default:`, the tie-break mode and `resolvePoll`, all of
which are the client's. The client connects **outbound** to it, because the machine running
the show is behind a domestic router and the relay is the thing with a hostname. Phones
reach the relay; the relay never reaches back.

Going live is an *addition* to a show already on the projector, not a different program.

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
can declare its media before the media exists — which is what puts it on the board's asset
tab. Add `--strict` for a pre-show check, where a missing file *is* an error.

```bash
npm run build
```

Two Vite builds, and which folder each owns matters. The root `vite.config.ts` is the
**relay's** — three entries out of `server/web/` into `dist/client/`, no projector.
`client/vite.config.ts` is the **stage's**, one entry, output beside its own source in
`client/web/stage/dist/`. `npm run build:stage` runs the second alone. The board is never
built: it is vanilla ES modules served raw.

```bash
npm run voice:check
```

Proves the voice sidecar end to end — uv, Python, the bridge, and MP3 encoding — without a
model. Add `-- chatterbox` once one is installed. See
[docs/voice-generation.md](docs/voice-generation.md).

`npm run client` starts the client on **8890**, loopback only. `npm start` runs the relay on
**8880** and `npm run dev` watches it. **Never leave a dev server running** — one was left on
8880 once and served a stale page to the user's browser while they debugged a "crash" on the
real server. Kill what you start, on both ports.

```bash
npm run project:new -- <storyboard.md> <target-folder> "Some Title"
```

Scaffolds a project folder from a storyboard, from a terminal. The **Start here** tab does
the same job with a walkthrough in front of it and is the route to prefer; this survives for
the case where a storyboard already exists and nobody wants the browser.

`node --test tests/` does not work. The script uses a quoted glob: `node --test "tests/**/*.test.ts"`.

## The build constraint that shapes everything

Server code is TypeScript that **Node 24 runs directly** by stripping types. There is no
build step for anything that runs in Node — not the client's process, not the relay — and
keeping it that way is deliberate. Four consequences:

- **Relative imports carry an explicit `.ts` extension.** `import { Room } from './room.ts'`.
- **No non-erasable syntax.** No `enum`, no `namespace`, and no parameter properties —
  `constructor(private readonly store: Store)` throws `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`
  at runtime. Declare the field, assign it in the body. `erasableSyntaxOnly` catches this
  in typecheck; trust it, it is not being fussy.
- **Cross-workspace imports are relative, never by package name.** Node refuses to strip
  types for any file whose resolved path contains a `node_modules` segment
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and whether a workspace symlink escapes
  that is a resolution detail one flag away from a show that will not start. The workspaces
  in `package.json` are for installation and scripts only. `client/app/show/room.ts` reaches
  the engine as `'../../../shared/show/protocol.ts'`, and that is the house style.
- **`typescript` is 7.x**, the native compiler. It does not auto-include `@types`, hence the
  explicit `"types": ["node"]` in tsconfig.

Only the two browser bundles are built, and the board deliberately is not — an edit to
`client/web/board/*.js` is one reload away, which is what makes a tool somebody uses all day
bearable to work on.

## Invariants

These are load-bearing. Each one exists because breaking it produced a real failure.

### The split

**The relay decides nothing.** It reports a code, a count of phones and a count of votes.
Which node those votes belong to, whether the poll is still open, who won and where the story
goes next are all decided in `Room`, out of a scenario the relay has never seen. If that stops
being true, the relay becomes a box on the internet that can drive somebody's presentation.

**Nothing privileged travels toward the client.** No message the relay can send is a command,
and nothing from a phone is anything but a vote. `ShowCommandSchema` and `DISPLAY_COMMANDS`
must never appear in `shared/relay/protocol.ts`, and a test reads the file to say so. This is
what makes the rest of the security story cheap: a key stolen off the relay buys the ability
to open a room and publish a poll to some phones, and nothing else, because there is no
direction for anything else to travel in.

**The relay cannot understand a show, and that inability is the security property.**
`server/**` imports nothing from `shared/scenario/` or `shared/engine/`, declares no `yaml`
dependency, and the image copies one folder of `shared/` rather than the whole of it. It is
not kept by care — `tests/relay.test.ts` walks the import graph from `server/index.ts` and
asserts the whole of what it borrows is one protocol file, and reads the Dockerfile,
`.dockerignore` and `docker-compose.yml` to assert no scenario reaches the container by any
of the three routes. This is "the game server never learns about Python", generalised and
given teeth.

**`shared/` imports nothing outward.** It depends on `zod` and `yaml` and on nothing in
`client/` or `server/`. Both halves import it; a reverse edge would make one half's change a
surprise in the other's.

**The client is the clock, and the stage schedules only when the socket is gone.**
`Room` lives in the client's Node process. Chrome clamps timers in background and occluded
tabs to ≥1s and can suspend them outright, and the stage window is routinely on a second
display while the operator works in the board in front — a beat clocked at 4.2s would become
whatever the compositor felt like. The stage's local `reduce` is a dropout fallback, not the
clock. That is also why it imports the production engine and must never get a copy of one.

**A simulated vote is refused while linked.** `castVotes` returns early when a relay is
attached, the Show tab disables the buttons and says which room is live, and a test asserts
the refusal. Otherwise the rehearsal control stuffs a live ballot, and it will happen exactly
once: in front of a room, five minutes after somebody goes live having simulated all
afternoon.

**The show's folder is locked against destructive edits while it runs.** This replaces the
old boundary. The editor and the game server used to be two programs that could not reach
each other, and this file could only *advise* not authoring into a folder a show was being
served from. One program knows both facts, so `heldBy` in `client/app/show/session.ts` turns
the advice into a refusal, and `DESTRUCTIVE` in `client/app/server.ts` is the one list of
routes it covers: publish, folders, extensions, discard, delete-take, and saving the scenario.
The failure is exact — assets are served off disk as they are asked for, so renaming one
mid-show is a 404 on the next projector to reconnect. What is deliberately *not* on the list
is editing a prompt: a show holds the scenario it was started with in memory, so authoring
the next draft while the current one is on the wall is precisely the thing merging the two
programs made safe. The refusal names the show holding the folder, because "team-union is on
the projector" is actionable where "locked" is a puzzle.

### Keys, rooms and going live

**A key is data, not configuration.** There is no `RELAY_KEY` environment variable and
nothing should helpfully add one. A secret in `docker-compose.yml` is one phrase shared by
everyone who has ever been told it: it cannot be withdrawn from one person, there is no way
to see who is using it, and changing it locks out every client at once. Keys live in the
relay's SQLite with a required `label` and a `last_used_at`, and are issued and revoked one
at a time at `/keys`. They are stored in the clear on purpose, because the console has to
list them and a key you can only see once is a key that gets written on a sticky note.

**Revoking refuses the next room and never the running one.** Setting `revoked_at` is all it
does; a room already open keeps running and its phones never notice. This is why `resumeRoom`
authenticates with the **room token** rather than the key — a client that drops mid-show must
be able to come back even if somebody revoked its key while it was gone, because the
alternative is forty phones holding a dead code and no way to finish. The deliberate way to
stop a running show is **End** on `/status`, which is a decision somebody makes while looking
at the room. A revoked key stays listed and greyed: one that vanishes is one somebody
re-issues by accident.

**A relay with no keys opens no rooms.** A fresh container issues none and refuses everything
until somebody signs into the console and generates one. `keyed` on `/api/health` is the field
that explains a relay which is up and refusing everything. Same rule as empty `PUBLIC_URL`
never quietly meaning the permissive thing: an absent value must never mean the permissive
thing.

**Minted room codes exclude `O/0`, `I/1`, `S/5`, `Z`; chosen names deliberately do not.**
Six random characters get read off a projector from the back of a room and nobody proofreads
them, so the alphabet drops every pair that looks alike. Applied to a word somebody *chose*
that rule would outlaw SEPTEMBER, so `RoomNameSchema` is wider — capitals, digits and hyphens,
3 to 24. The relationship that matters is that every minted code is also a legal name, which
is what lets one wire field carry both, and a test asserts it rather than assuming it.

**A named room is re-entered by the key that opened it.** `resumeRoom` proves a token, and a
crashed client's token died with its process — so the one real answer to "resume after a
crash" is to ask for the name again with the same key and be handed the room back as
`roomResumed`, open question and ballots intact. A *different* key is refused: a name is
written on a wall, and without that check the second operator to like ARCTIC gets the first
one's audience.

**`openRoom.name` is optional on a non-strict schema, and that is the upgrade path.** The
relay's wire schemas are `z.object`, which strips unknown keys, so an older relay silently
mints a code instead. The client compares what came back against what it asked for and says
*"this relay is too old to name a room — it opened KPQ4T7 instead"*, which is why
`RELAY_PROTOCOL` was not bumped. A version bump would have locked out every relay in the
field to add an optional field.

**`close()` ends a show; `shutdown()` stops the process.** They are not synonyms. Marking
rooms closed on shutdown means a container restart or a SIGTERM silently destroys every live
session. The client's SIGINT handler has the same shape for the same reason: it *drops* the
link rather than unlinking, because the room on the relay is not over and a client that closed
it on the way out would have thrown away the one thing that makes a Ctrl-C survivable mid-show.

**Generated links follow the request.** `baseUrlFor()` honours `X-Forwarded-Host`/`Proto`, so
a LAN request gets LAN join links and a Cloudflare-proxied one gets public links with no
config. That is also what makes the offline fallback free: bring the relay up on the
presenting laptop, point the client at its LAN address, and phones on the venue wifi get
links that work. `PUBLIC_URL` is an override for the rare mismatch, and an empty value means
unset — it must never fall back to `localhost`, which is how links once pointed at the
operator's own machine while looking perfectly valid.

**The status page must not carry the room token.** The list it replaces did, and said why: a
host link lost to a closed tab stranded a live show and the tokens existed nowhere else.
There is no host link any more — the client holds its own token and resumes with it — so the
field goes, and with it that endpoint's ability to hand a reader full control of every running
show. The absence is deliberate; do not add it back for convenience.

### The show

**The engine is pure.** `shared/engine/engine.ts` is `state + event -> state` with no I/O.
That is what makes every branch path testable without a browser, and what lets the stage run
the same engine client-side. Do not reach for a timer, a socket, or the database in there.

**Players never receive a snapshot.** A snapshot contains upcoming dialogue, the scene, and
any pending poll result. On the relay this is structural rather than guarded — a phone is
answered with `PlayerState` and the relay has no snapshot to leak — but the rule is why the
protocol is shaped that way, and a test asserts a client cannot vote and a phone cannot
publish a poll.

**Every poll needs a `default:`.** Enforced by the validator. A poll that receives zero votes
must never deadlock in front of an audience.

**Scenario files are content and content must never execute code.** The expression language
in `shared/engine/expr.ts` is a hand-written recursive-descent parser with no `eval`, no
property access, and no function calls. Keep it that way.

**Scenario schemas use `z.strictObject`.** A typo like `nxt:` should be a loud load-time
error, not a silently ignored key. The relay's wire schemas are the deliberate exception,
and the room name is what that exception bought.

**Room timer callbacks are wrapped in `Room.guard()`.** An exception thrown inside
`setTimeout` is uncaught, and an uncaught exception exits Node. There is one room per process
now, so what it kills is this show rather than everyone's — which is still a show sitting
still in front of people. It stalls instead, tells the board where, and Skip or a Force
rescues it.

**A scene is a place; a node is a shot.** `music:` and `ambience:` hang off the scene and
persist across every node played there. `background:` and `video:` may be overridden per node,
for that node only — `sceneMediaOf` in the engine is the one resolver, used by the snapshot
and the stage alike. An override that leaked forward would make the picture depend on the path
the audience voted down, and one scene per shot would re-trigger the scene's audio on every
beat.

**Anything the audience is looking at is a beat the client clocks.** The result of a poll used
to be a `setTimeout` inside the display and nothing else knew about it, so the next line's
`hold` started while the projector was still showing the bar chart — every first line after a
vote lost 2.6 seconds. `REVEAL_MS` is a real beat with a `revealing` phase, and the stage
renders what it is told. A client-side animation that holds the screen is a second clock, and
the two will disagree in front of a room.

**A phase is restored, never assumed.** `pollClosed` enters the node the vote chose and then
sits on the reveal, so the node is already correct while the bar chart is up. `restingPhase`
is the one place that says what a node settles into afterwards — and `Room.apply` opens a poll
on *entering the polling phase* rather than on the node id changing, because by the time the
reveal ends the node has not changed for some time. Keyed the old way, a vote leading into a
second poll left that poll's deadline at the zero it is stamped with on entry, and it never
closed.

**A poll's record reads the tally, not the result.** `Room` keeps a `PollRecord` per decided
poll and puts it on the snapshot. `forceBranch` builds its result from the ballot box, which
is deliberately **empty while linked** — live ballots live in the relay's database. A record
built from `result.counts` would report forty people as having cast nothing, on precisely the
night it mattered. `remember()` reads `tally()`, and a test injects a relay tally with an empty
box to prove it.

**A record is evidence or it is litter.** The Room's poll history dies with the show, and
writing it to disk is a separate, deliberate act offered only once a poll has been taken in a
real room. A rehearsal's voters are imaginary people who can be asked again by pressing the
button again; a file per afternoon of them is a folder of records nobody can cite, in a
directory that syncs to somebody's cloud drive.

**The audio gesture has to happen in the window that makes the sound.** This is the one
genuinely new failure the merge created. Autoplay wants a gesture in the stage window, and
Start is pressed in the board — so the first voice line was silent with nothing saying so.
The stage reports `displayAudio` alongside `displayReady`, and Start is disabled with *"click
the stage window once"* until it does. `startBlockedBecause` returns a sentence rather than a
boolean, because a disabled button with no explanation is a bug report.

**Pausing has to stop the voice, or it is not a pause.** The clock suspends the beat's `hold`,
but a voice clip is a media element with a clock of its own: it read straight on through a
pause and then sat silent for the rest of the line when the show resumed. Only the voice — the
beds and the muted scene loop are the room's atmosphere rather than the story, and a held beat
with the sea still moving under it reads as a stopped show where a frozen frame over dead air
reads as a crashed one. `setPaused` resumes only a clip it stopped itself, because `play()` on
one that had already finished restarts it and the line is read twice.

**The projector is a control surface, and its keyboard is the whole of it.** The person in
front of the room may have no console to reach: one laptop, one screen, the show already on
it. `DISPLAY_COMMANDS` in `shared/show/protocol.ts` is exactly the keys the stage has.
`reset` and `jump` are deliberately absent — reset puts the show back to the beginning and on
the board it sits behind a confirm a key press has no equivalent of; jump needs a node id a
projector can neither offer nor check. **This list stopped being a security boundary when both
surfaces became windows on one machine** — the client's socket is loopback and both ends are
windows this process opened — so it is now a UI decision about a keyboard on a lectern. The
rule, the list and `tests/control.test.ts` are all unchanged and the *why* is completely
different. The test is what holds it up: it reads every command literal out of the stage and
checks it against the array, and without it a key wired to `reset` would typecheck, run, and
fail as a key that silently does nothing — which is the worst of the three ways it could go,
because the presenter presses it again.

**A key acknowledges itself; only the snapshot says what happened.** `flashCue` confirms the
press and disappears; the "Paused" badge is set from `snapshot.phase`, never from the keystroke
that asked for it. A projector that announced "Paused" off its own key press would be a second
opinion about the state of the show, and the two would disagree in front of a room the first
time the server said no — which it does for a pause during a vote, during a reveal, and on a
stale beat. That handler sits *ahead* of the same-beat guard on purpose: pausing does not move
the beat number, so a pause arrives as a snapshot for the beat already on screen, which is
precisely the kind that guard exists to throw away. Space during a poll sends nothing at all
and says which key does work instead, because a key that is refused in silence is
indistinguishable from a broken one.

**The stage is letterboxed by arithmetic, never by CSS centring.** Everything is authored
against a fixed 1920x1080 surface and scaled to whatever projector turns up. `place-items:
center` did the centring and did nothing useful once the window was narrower than 1920:
centring an item larger than its area is unsafe overflow, so the browser pins it to the start
edge — and `transform-origin: center` then scaled about a centre that was already in the wrong
place, putting the picture half its own overflow to the right and clipping that much off the
edge. True on every screen under 1920 wide and no projector, which is exactly why it survived
until somebody presented off a laptop panel. `fitStage` computes the offset and the scale
together, with `transform-origin: top left` so the two cannot disagree.

**The lobby has an unlinked state, and it must look deliberate.** A show now runs start to
finish with no relay, so the absence of a room code is ordinary rather than broken. The code
can also arrive **mid-show**, because going live is something that happens to a show already
on the wall — `renderJoinInfo` redraws the QR when `snapshot.room` changes rather than at
startup.

**A wait that says nothing is indistinguishable from a hang.** The stage pulls a few hundred
megabytes before it reports ready. Every asset used to be started at once and raced against
its own timeout, but a browser opens about six connections to a host, so the rest waited in a
queue with their clocks already running: at twenty seconds the whole queue timed out together
and the display announced ready while it was still downloading. `pooled` in
`client/web/lib/pool.ts` is the fix and the reason it is a fix — work starts when its turn
comes, so a per-item deadline bounds a download rather than a wait for a turn. The stall timer
is not vestigial and its main case is now local: **project folders live in OneDrive**, so a
placeholder is a file that is present, zero bytes, and hydrates over the network when opened.
`displayReady` carries what never arrived, because a missing decoration must never stop a show
but `ready` over eleven assets that 404'd is a lie in a different place.

**Everything the scenario can declare has to reach the room.** `music`, `ambience` and `sfx`
were in the schema from the beginning: the checker validated them, the board tracked them, the
projector prefetched them — and nothing ever opened one. A scenario could declare a harbour bed,
the board could report it finished and green, and the audience heard silence with nothing
anywhere saying why. Voice was the only audio that ever played. A field is cheap to add to a
schema and the half that consumes it lives in another window, so `tests/playback.test.ts` reads
the stage as text and insists every `ASSET_SECTIONS` entry is named there — crude on purpose,
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

**A gate is a beat with no duration, and that absence is the whole design.**
`schedule()` sets a timer from a beat's `durationMs`, so a beat that reports none is a beat
no clock can end — it leaves on an `advance` that only the board sends. That is what makes a
presentation possible: the room asks a question, somebody arrives late, and the title card
stays up until a person says otherwise. Deliberately its own node type rather than a `pause`
with the number left out, because an omitted number reads as a mistake and the failure it
causes is a show sitting still in front of an audience while nobody knows a button is waiting.
Two traps are pinned by tests. `beatDeadline` is `Infinity` on every path that schedules
nothing — left stale, `pause` would compute a remainder from the *previous* beat and `resume`
would release the gate on its own, which is the one thing a gate exists to prevent. And
`continue` is a separate command from `skip` even though both reduce to `advance`: `skip` cuts
a beat short, this is the beat arriving on time, and a moderator who has to press "Skip" to
begin their own presentation has been handed the wrong button.

**Cast and Force are not the same thing.** `castVotes` puts synthetic ballots in the box and
lets the poll close on its own clock through `resolvePoll`, which is the only one of the two
that proves a poll's `default:`, its tie-break and the reveal beat work before an audience is
the thing testing them. `forceBranch` hands `closePoll` a decided result, so it never runs
`resolvePoll` and never draws a truthful bar chart — it is the override for the night a vote
goes wrong. `count` on a cast is a **target, not an increment**, and each option owns its own
simulated voters: one shared pool dedupes for free and is wrong at the only moment anybody
uses this, because asking for five Left and two Right would hand back three and two.

### The asset pipeline

**An asset's production section comes from the schema field that referenced it**, never from
its extension. A `.mp3` in `voice:` and a `.mp3` in `music:` are different work made by
different models. `assetReferencesOf` is the single walk both `assetsOf` and the board are
built from — two walks would eventually disagree, and the board's would be the one that
disagreed silently.

**Assets are filed by media type, in the name the scenario declares.** `voice/tran-d5-01.mp3`,
not `tran-d5-01.mp3` under a rule the display works out for itself. A layout convention would
have to live in the stage, the validator and the board at once, and the first time the three
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
cannot be checked by reading) and a sub-tab for each half.

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

**The board plays what it made — and shows it.** A board that can only describe a clip is a
board whose selection step is guesswork, and a pipeline nobody can hear ships the first reading
of every line. Choosing between six jetties by filename is worse than guesswork. `resolveMedia`
in `client/app/projects.ts` resolves a take, a published file or a reference clip from
structured parts and checks the result is under the project — the client browses the whole disk
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

**The board and the stage must agree on filenames.** The stage opens exactly the names in
`scenario.yaml`, so the board may never invent one. Seeding prompts from a storyboard keys
every row to `assetReferencesOf(scenario)` and reports anything it cannot place; a prompt
written against a name of the board's own choosing would belong to a file nothing ever loads.
The one place names *are* invented is `scaffold.ts`, which is writing the scenario that will
reference them — so the two files still agree. Tests guard both routes.

The same rule governs what a voice clip *says*: `text` on a voice row is the scenario's line,
never the storyboard's blockquote. A storyboard quotes a whole delivery at once where the
scenario splits it into the lines the display shows, so reading the storyboard by position puts
one line's words in another line's clip. The storyboard contributes the *Delivery:* note and
nothing else — matched by speaker, since one note covers every line split out of its block.

**`assetBase` goes down to `assets/`.** The stage joins it to a name straight out of
`scenario.yaml`, so a base one level short makes every asset a 404. It was one level short for
months and nothing noticed, because no scenario had a single asset made — the first would have
been a missing picture in front of a room. `client/app/show/assets.ts` is now the one route that
answers this for takes, published files and the projector alike, which is the merge's clearest
win: the two implementations that disagreed are one. A test fetches every declared name against the
manifest's own `assetBase`, which is the only form of this assertion that could have caught it.

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
`makeReferenceClip` in `client/app/generate.ts` uses the character's *own* lines,
because a reference is copied in register as much as in timbre — a voice sampled reading
"the quick brown fox" comes back as an audiobook rather than a watch-keeper. The preset
that made it is written beside it, so the clip can be made again.

**Voice is the only section with a generator, and that is permanent.** `generate.ts` throws
for anything else. Image and video generation never existed here — only prompt scaffolding for
it did, and that scaffolding is deleted. A row's `prompt` is a note to whoever makes the
picture, still in the recipe hash, because for hand-made art the note going stale is exactly
the reminder you want.

**A portrait is a cutout, so it is a transparent PNG.** The stage draws it over the scene with
a `drop-shadow`, which follows the alpha; a JPEG has no outline, only four corners, so it arrives
as a bust card with a shadow around all four sides — a failure that reads as a deliberate frame,
which is why it would survive to a projector. `isPortrait` in `size.ts` is the one predicate, and
both consequences hang off it: the size (`PORTRAIT` rather than `STAGE`) and the cutout.
`portrait` is on the Recipe, so it is in the hash — and it comes from the scenario, which means
every caller of `resolveRecipe` must derive it the same way (`portraitFilesOf`) or the board and
the generator will disagree about what is finished. Re-pointing an existing `.jpg` is a rename, so
`carryRename` takes the recipe row, the ledger entry, the takes folder and the published file
with it; a portrait aimed at some other name is the author's and is left alone.

The one thing that survives from prompt composition is `asksForBackground` in `prompt.ts`, and
it survives because it was never about composition: a character sheet is written as a
*reference* image on a neutral field, which is right for a reference and wrong for the file the
display floats over a harbour at dawn. Worth one warning; not worth a machine rewriting the
sentence, which is how prose that was already true eventually gets rewritten too.

**Every picture declares a size, and the file is measured against it.** Art is made in another
program and dropped into the takes folder, and every web UI opens on a square — so a still
arrives 1024x1024, lands in a 16:9 show, and is letterboxed or cropped through the subject with
nothing anywhere saying so. `size.ts` takes its defaults from the stage's own geometry (a
1920x1080 surface; a portrait 460 wide with 740 above the dialogue box) rather than from taste,
and writes them onto the row so the choice is in the file the author reads. It reads a real
file's dimensions from the header only — stills, never video, because a clip's dimensions live
several nested atoms deep and reporting a correct clip as wrong shape sends someone off to
re-render something that was already right.

**Who gets a portrait is the storyboard's decision.** `sprites.ts` declares a `sprite:` for each
character the document drew a *character sheet* for, and only those. Arctic Sentinel has six
speaking parts and three sheets: the narrator has no face, the ship is a ship, and the Russian
officer is "heard only over radio; never seen as a face". Wiring every speaker would invent three
faces the author deliberately withheld, and one of them would be a person for a warship. Matching
a sheet labelled `Beaudoin` to `beau` is the one guess, so it is narrow — the id outright, or a
whole word of the name — and ambiguity is refused rather than resolved.

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

**Generating never publishes, and never steals a selection.** A take is added; the published
file changes only when someone presses Publish. Re-rolling has to be free or nobody does it,
and then the first acceptable reading of every line is the one that ships.

**A regenerated take asks to be chosen, not generated again.** Generating never steals a
selection, which is what keeps re-rolling free — but it left the asset reporting `stale` with
the answer already sitting in its own takes folder, under a heading whose button made a *third*
take of a line that already had the right one. `matchingTake` on the view is a take whose hash
equals the current recipe and is not the one selected, and `reselect` sits ahead of `stale` in
the command centre because the two ask for opposite things. `use-newest` picks the take that
matches the recipe rather than the last one in the list: newest is only a guess at that, and it
is the wrong guess the moment anything else was rolled afterwards.

**Publishing writes down which take it shipped.** `ready` means the selected take matches the
recipe and says nothing about whether anyone ever copied it to the name the player opens, so a
project could be entirely green while the room heard the previous reading of every re-recorded
line. Nothing on the board could see it, because nothing recorded it. `LedgerEntrySchema.published`
closes that, and `republish` is only ever claimed against a recorded take — a file with no record
of how it got there was put there by hand, and telling somebody to overwrite it would be guessing
at work they did deliberately.

**`republish` falls back to comparing the files.** The ledger is exact where it has a record,
but it cannot see back past the day it started keeping one — and choosing a newer reading of an
already-shipped line then moved it to `ready` and asked for nothing while the room went on
hearing the old one. Where no take is recorded, a published file of a different size than the
selected take is certainly not that take. Matching sizes are taken as the same file rather than
hashed: two readings of one line landing on the same byte count is a coincidence, and re-reading
ninety published files on every board build to rule it out is a cost paid every time.

**A hash records the whole recipe object of the day it was written**, because `canonical`
filters `undefined` and nothing else. So dropping a field from `Recipe` moves every recorded
hash at once — 208 rows across three finished shows, all `ready`, all exposure, and
`adoptTakes` only rescues `unmanaged` rows so a row pushed to `stale` that way has no route
back short of re-recording it. `migrate-recipes.ts` is the route back, and everything under
its "frozen old world" heading is a **copy** and never an import: the entire job is to compute
what the old code computed, so the new code has to be free to change out from under it. The
order inside is load-bearing — compute the legacy hashes while `project.yaml` still has the
fields, rewrite the ledger, and only then strip the keys. Interrupted after the rewrite it is
correct and re-runnable; in the other order it is unrecoverable. What decides whether a project
still needs migrating is whether `project.yaml` still carries the removed keys, because that is
the question with no false positives; `LedgerSchema.version` is a record that the re-stamp
happened, not a gate.

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

**The board knows where each row actually renders.** `rowsFor` gives voice clips to the
Characters tab and portraits to a character's other sub-tab, so a link that sends somebody to
Assets for either lands them on a tab that does not contain the row — which is worse than no
link, because it reads as the row having been deleted. `homeOf` in the client is the one place
that answers this, and it uses the same `asset.row.voice ?? UNCAST` fallback `byActor` groups
by, so the sheet it opens is the sheet the row is really in.

**A clip's runtime is checked against the beat it has to fit in.** Nothing on the clock's side
ever opens an audio file — a beat ends when `hold` says it does — so a `hold` a second short
cuts the reading off mid-word in front of a room, and the only way to find out was to sit
through every clip with a stopwatch. Every `hold` starts as a reading-speed estimate and a
generated clip is routinely a second or two away from it. `duration.ts` reads the length from
the header only, with no dependency, for the same reason `size.ts` does: the board's job is to
read a file the show will play, not to own a codec. It is the one bridge between the two halves
of the program — the half that makes a clip measuring it for the half that clocks it. A second
of headroom rather than none, because equal is not safe. Undefined means *could not tell* and
must never warn: sending somebody to re-cut a line that was already right is worse than not
telling them. Two ways to get it wrong are both pinned by tests — MPEG 2 halves the Layer III
frame, and a wav's byte rate is four bytes past its sample rate; either mistake reports every
clip at exactly twice its length, which turns a real overrun into silence.

**A beat is the clip plus a gap, and the board writes it.** The two numbers only agree if
somebody puts them in agreement — which meant reading a runtime off the board, doing the
addition and typing it into `scenario.yaml`, eighty times, without transposing any of them.
`retimeInto` in `timing.ts` writes `hold:` by source offset like every other scenario action,
so a comment beside a beat stays exactly where it is; which of those comments the change has
made *wrong* is reported by line number and never reworded. One decimal throughout: clip
runtimes are real numbers and rounding a beat down to the whole second below it is how a line
gets cut off by a rounding decision nobody made. `holdMatches` compares at that same precision,
or a hold of 5.8 against a target of 5.800000000000001 is a mismatch no edit can ever fix and
the board asks for it forever.

**The gap is per clip, and it is timing rather than audio.** A second is the default because
the last word of a line needs somewhere to land, but a beat before a poll wants to breathe and
a three-word interruption wants to land on top of what follows — so `gap` is a field on the
asset row. It is deliberately **not** in `resolveRecipe`, and a test says so: it changes how
long a beat lasts and nothing whatever about the audio, so folding it into the hash would mark
ninety finished clips stale for a timing edit and make re-timing a show cost a re-record of it.
An empty box clears the field rather than writing zero, because a gap of nothing is a real
choice and has to stay distinguishable from never having made one.

**The client sends which clips to retime, never what to.** The target is computed server-side
from the runtime the board measured and the gap the row declares. A page that could send the
number itself is a page that can write a beat nothing on the board agrees with — and the
arithmetic would then exist in two places, which is one more than it can be right in.

**A model process talks over a pipe, never a socket.** A pipe dies with its parent, so a
force-quit client cannot strand a process holding sixteen gigabytes of VRAM — the failure
whose only apparent cure is a reboot. It also avoids a Windows firewall prompt for someone
who wanted to hear a line read aloud. `stopAllSidecars` runs *before* the server closes on
SIGINT, for the same reason.

**Where models live is the machine's business, not the project's.** `project.yaml` travels
to other machines and is opened a year later, so it names a model (`chatterbox`) while the
machine config at `~/.interactive-scenario/editor.json` holds the path. The workspace, the
models root, the relay URL and the relay key are all there for the same reason, and **the
relay key must never reach `project.yaml`**. The room *name* is the deliberate exception: it
belongs to the show rather than the machine, so it lives in `project.yaml` beside the title.

### Editing the author's files

**The machine never rewrites `project.yaml` wholesale.** It is the author's file, full of
hand-tuned prompts and comments recording why. Field edits go through YAML's document API
(`client/app/projects.ts`); parsing to an object and re-serialising strips every comment in
the file the first time anyone touches a text box. A test guards this.

**A storyboard that arrives after `project.yaml` has to be recorded in it.** `pathsOf` reads
the `storyboard:` key, and nothing re-scans the folder once the project file exists — the
name-sniffing in `defaultProject` only runs while there is no project file at all. So a
project set up for asset work before it had a storyboard had no key, and writing
`storyboard.md` beside it put a document on disk that the Storyboard tab went on reporting as
absent and seeding went on refusing to read. The file was there; the only record of what it
was had never been written. `saveStoryboardSource` sets the key when it creates the file and
the project has no opinion yet, through the document API and never over one already there — an
author who pointed `storyboard:` at `script.md` meant it, and a second document the board read
instead would be the empty one. This became reachable the day the walkthrough started making
the folder before the storyboard.

**Anything the pipeline needs done to a project, the client does.** If a scenario has to be
hand-edited or a script run once to get an asset onto the board, the ecosystem has a hole in it
and the two halves will drift. Declaring `voice:` on every line is `wireVoice`; giving each
storyboard shot its own `background:`/`video:` — and folding away the stand-in scenes that
existed only to carry one — is `migrateShotsInto`; removing a recipe the scenario stopped
referencing is `pruneOrphans`; creating a project at all is `POST /api/projects`, which is the
newest member of this list and the one whose absence used to send somebody to a terminal.
All are buttons, all are idempotent, and all edit by source offset rather than by
re-serialising, so the author's comments and hand-wrapped folded scalars survive.
`client/app/yaml-edit.ts` is the one home for that technique; a second copy of it would
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

**A node is a block of source, and a block moves whole.** `nodeBlocks` in
`client/app/nodes.ts` carves the `nodes:` sequence into contiguous, non-overlapping spans —
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
board and the stage agreeing on filenames, failing quietly. `declaredAssets` is the same
`assetReferencesOf` walk the board is built from and not a second one; what is on disk and
unclaimed comes from the `strays` the overview already found, appended after, since a picture
somebody rendered and never wired up is not rubbish until they say so and the board otherwise
only offers to delete it. Offered as a **datalist**, never a `<select>`: an asset is routinely
declared before it is made — that is what puts it on the board to be made — so a control that
refused a new name would break the pipeline's own order of work.

**An action must not edit the author's prose.** A migration that removes a scene leaves any
comment describing it factually wrong, and the temptation is to fix the sentence — but a
machine that rewrites prose to keep it true will eventually rewrite prose that was already
true. `migrateShotsInto` reports the line numbers and stops.

**An action that rewrites `scenario.yaml` must also push the new source back into the editor
pane and wait for the re-analysis before reporting.** The pane holds its own copy: refresh it
late and the analysis overwrites the action's status line; do not refresh it at all and the
next Save quietly reverts everything the action just did.

### The walkthrough

**A tick is never derived.** The **Start here** tab's checklist is the person's, and the
program has no opinion about whether their storyboard is good enough. What it *can* see — no
`project.yaml` yet, no voice clips declared, nothing outstanding — is reported on a separate
line beside the tick, read off `boardFacts()`, which reads the board's own data rather than
walking the project again. The two must never make the same claim: a checkbox that ticks
itself from a heuristic is a checklist that lies, and a second walk of the project would be a
second opinion about what is finished with the disagreement invisible.

**The walkthrough links to buttons; it does not grow its own.** Its pipeline steps call
`goTo('assets')` and friends rather than the routes behind them. Two buttons that call one
route are two things to keep in step, and the one that falls behind is the one nobody is
looking at. A test asserts it calls no pipeline route of its own. The two boxes that hold a
document are the same rule one level further in: they write through `onApplyStoryboard` and
`onApplyScenario`, which *are* the functions behind the storyboard pane's Save and the source
pane's Save, rather than a second `PUT` of their own.

**The project is made first, and everything after it writes into a folder.** It used to be
step four, built out of the three boxes above it — which meant the first three steps of a new
show ran against whichever project happened to be open, and the two documents somebody had
just spent an afternoon on had nowhere of their own to be written until a create that might
never come. A folder made from nothing but a name is the starter scenario, which runs, so
creating first costs nothing. What it buys is that the storyboard lands in the project, the
scenario replaces the starter, and step seven's "seed the pictures" is unambiguous about whose
pictures. **The create sends a name and nothing else**, deliberately: carrying the pasted
scenario meant a scenario a model got slightly wrong refused the whole create, leaving
somebody with no project at all at the one moment they had nothing else to work with. Being
refused at step four costs a fix; being refused at step one costs the afternoon.

**The box is the buffer and the project is the destination, and they are separate on
purpose.** A scenario comes back refused with a list naming the node, and the text has to
still be in the box when it does — otherwise the fix for a missing `default:` is another round
trip through a chat window. So the boxes keep saving to the draft as they always did, and a
button underneath commits. What the refusal shows is the *list*, not the headline: the reply
has always carried the keys and nodes that are wrong and nothing was reading them, so "Scenario
does not match the expected format" was the whole of what anybody got — a sentence naming
nothing to go and fix.

**A button disabled by what is in a box has to notice the box filling up.** Typing deliberately
does not re-render — `render()` replaces the list, and a textarea replaced mid-paragraph takes
the caret and the undo history with it — so nothing was updating the buttons, and Create stayed
greyed out with a name typed into the field beside it. The tab looked like it had simply
refused, and the walkthrough went a whole release with no way to reach the thing it exists for.
`syncButtons` reads one `data-needs` attribute off each button so the enabling and the
disabling cannot drift apart.

**The briefs travel to where the work is, and there are two of the scenario one.** The
storyboard is written in a chat, and the chat that wrote it still has it — so pasting the full
brief *plus* ninety thousand characters of storyboard back into that same conversation spends
on context the room the model needs for the answer, which is the whole show. `scenario-short`
is the format reference for that chat and carries nothing with it; the full brief is for a
fresh one and carries the storyboard. It is **not a summary**: it is the same reference, and
the node-type test walks both, because the one most people will use quietly becoming the less
complete of the two is exactly how a brief starts producing files that will not load.

**The briefs are checked against the formats they describe.** `docs/prompts/*.md` are prose
handed to a language model, and prose drifts: the scenario schema gains a node type, the
storyboard parser learns a heading, and the document telling somebody what to write goes on
describing last year's file. `tests/guide.test.ts` walks `ScenarioNodeSchema.options` and
insists on a `### <type>` section for each **in both scenario briefs**, and checks the
storyboard brief spells every label its parser matches. It also asserts neither brief teaches `STYLE.`, because nothing expands it
any more — a prompt saying `STYLE.` now reaches a model as the word STYLE, and the brief is the
only place anybody would learn to write it.

**The brief route names its briefs rather than taking a filename.** It reads from a folder in
the repository, and a route that took a path would be a route that reads any file on the
machine.

### Making a project, and finding it again

**One route creates a project, and both ways in send a name.** The picker's **New** button
and the walkthrough's step one both arrive holding nothing else, and `createProject` scaffolds
a starter. Two routes would be two places for "what does a new project look like" to be
answered, and the one that fell behind would be the one nobody was looking at. The starter
goes through the same `parseScenarioSource` as anything pasted, which is what catches a
template broken by a change to the schema — on the first press of New rather than by whoever
gets the unopenable folder. The route still *accepts* a whole `scenario` and `storyboard`,
which is what makes a project out of a file somebody already has, and the tests hold that
branch; no button sends one any more, for the reason under **The project is made first**.

**A folder name is not a scenario id.** `NEW_PROJECT_NAME` allows spaces so a folder can be
called "My Show"; `idPattern` does not. `scenarioIdFor` derives one from the other, and the
starter's `title:` and its gate's `text:` go through the YAML serialiser rather than straight
into the template — a title of `Ethics: in practice` written literally is not YAML, and what
it produces is a folder the picker offers and the editor then refuses to open.

**Opening the folder is the one place this program runs another program, and it never uses a
shell.** `reveal.ts` gives `spawn` an argv array, so the path is one argument whatever is
inside it; through a shell a project folder called `Q3 & review` would run `review` as a
command, and a folder name is not a thing this program controls. The board sends a **name**
and the server makes the path, through the same `projectFolder` containment check every other
project route goes through. The exit code is deliberately not waited on — `explorer.exe`
exits 1 on success, routinely — and the reply carries the path, so on a machine with no file
manager the button still answers the question somebody actually had.

**`openProject` resolves when the window is really about that project.** It awaits
`onScenario`, which returns the analysis. Left unawaited the validation lands a moment later
and overwrites whatever the action that opened the project had to say about itself — which is
how "created — press Play" became "valid" with nothing to explain the change.

## Layout

| Path | What lives there |
|---|---|
| `shared/engine/` | Pure state machine, vote resolution, expression parser |
| `shared/scenario/` | Zod schema, YAML loader, graph checker, `validate` CLI |
| `shared/show/protocol.ts` | Board/stage message unions; `ShowCommandSchema`, `DISPLAY_COMMANDS`, `PollRecord` |
| `shared/relay/protocol.ts` | The relay wire. Room codes and names, poll frames, `PlayerState` |
| `server/` | The relay — Fastify, rooms, keys, SQLite, admin auth. No scenario, no engine, no YAML |
| `server/keys.ts` | Passphrases: a 256-word list, five words, and the rate limiter behind them |
| `server/web/` | `player/` phone, `status/` live rooms, `keys/` issue and revoke |
| `client/app/` | The local process: the board's API, the asset pipeline, the show |
| `client/app/show/` | `room.ts` the clock, `session.ts` the one show and the project lock, `link.ts` the relay wire, `ws.ts` the loopback socket, `assets.ts` the one asset route, `record.ts` the written record |
| `client/app/guide.ts` | The walkthrough's briefs and the draft it keeps |
| `client/app/workspace.ts` | The machine's own config: workspace, models root, relay URL and key |
| `client/app/project.ts` | Asset projects: `project.yaml` (author-owned) + `.ledger.json` (machine-owned) |
| `client/app/sections.ts` | The status board — scenario, recipes, ledger and disk reconciled |
| `client/app/nodes.ts` | Nodes as structure: reorder, add, remove, rename, retype, edit any field |
| `client/app/reconcile.ts` | What the scenario owns on a recipe row, re-derived on every save |
| `client/app/outstanding.ts` | The command centre — the board projected into one list of what is left |
| `client/app/duration.ts` | How long a clip runs, from its header — the other half of the `hold` check |
| `client/app/timing.ts` | Clip + gap = beat, and writing it into `scenario.yaml` |
| `client/app/migrate-recipes.ts` | A frozen copy of the old recipe shape, and the re-stamp |
| `client/app/models.ts` | Which generators exist and whether this machine has their weights |
| `client/app/sidecar.ts` | Owning a generator process; stdio JSON, one request at a time |
| `client/web/board/` | The board — vanilla ES modules over `dom.js`, served raw |
| `client/web/stage/` | The projector — TypeScript, Vite-bundled, runs the production engine |
| `client/web/lib/` | `pool.ts`, `fetch-asset.ts`, `connection.ts` — shared by the stage |
| `client/voice/` | The text-to-speech sidecar. Python, uv-managed, client-only |
| `docs/prompts/` | The LLM briefs the walkthrough hands out: a storyboard one, and two of the scenario one |
| `scenarios/` | Content, and the client's default workspace |
| `tests/` | At the root rather than in a workspace, because several exist to join two |

`shared/scenario/check.ts` holds the graph integrity Zod cannot express: dangling `next`,
unreachable nodes, unknown characters and scenes, poll defaults that are not options,
unknown `$placeholder`s. Run `npm run validate` after touching a scenario.
`parseScenarioSource` in `shared/scenario/load.ts` is the shared validation path — the board
and the show must never disagree about what a valid scenario is, and since the show loads
through it that is now true by construction rather than by care.

**`server/web/lib/connection.ts` is a copy of `client/web/lib/connection.ts`, not a shared
module**, and a comment says so or it reads as an accident. The relay's player page and the
client's stage both want it; they are in different workspaces with different bundlers, and the
two copies *should* diverge — one talks the relay protocol, one talks the show protocol.

The client browses the whole disk for its workspace picker, which is a picker a person drives.
It binds to loopback only: it writes files, runs a show and has no authentication, so it has no
business being reachable from anywhere but the machine it runs on.

## Conventions

Comments explain **why**, not what — several in this codebase record the failure that
motivated the code, and that is the house style. Match it rather than stripping it.

Tests are `node:test` + `node:assert/strict`, colocated in `tests/`, named for the behaviour
rather than the function. The relay tests drive real sockets against a real relay on an
ephemeral port and the show tests do the same against the client's loopback server; prefer
extending those over mocking. Several tests read source files as text — the command surface,
the playback sections, the walkthrough's step keys, the relay's import graph, the Dockerfile.
They are crude on purpose: a check that needs a browser or a container is a check nobody runs.

Writing files: use Read/Edit or a Python script with raw strings rather than Bash heredocs when
the content contains backslashes, and preserve the file's existing line endings — one Python
`write_text` flipped a source file to CRLF and made every later patch miss.

## Deployment notes

The Docker host is `192.168.1.149`, reachable over SSH, running Docker Desktop on Windows.
**Rebuilding remotely does not work**: Docker Desktop's `credsStore: desktop` requires an
interactive Windows logon session, so `docker compose up -d --build` over SSH fails with
"A specified logon session does not exist" — even for an anonymous pull of a public base
image. `DOCKER_CONFIG` and `--config` do not get around it. The rebuild has to be run by
the user in their own terminal on that machine.

`.env` is gitignored and the user maintains it on the server; `docker-compose.yml` reads it
via `${VAR:-}` defaults. Do not edit the server's compose file to hardcode values, and do not
add a `RELAY_KEY` to it — see the invariant above, and the comment already sitting where one
would go.

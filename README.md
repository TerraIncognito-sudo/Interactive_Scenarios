# Interactive Scenario

An autoplaying interactive presentation engine. Characters discuss an idea through
scripted dialogue, scenes change as the story calls for them, and at set points the
audience votes from their phones — the story then branches on what the room chose,
without anyone driving it.

## Why voting is built in

Mentimeter and Slido cannot feed live results to a story engine, which is the whole
premise of automatic branching. Mentimeter has no public API; Slido's Data Access API
is Enterprise-only, needs 100+ seats, and is built for reports after the event. Reading
either live would mean scraping an undocumented endpoint that can break without warning.

So the vote surface is part of the app. The audience experience is the same — scan a QR
code, tap a choice — but the engine owns the tally, so branching is instant and works
offline.

## How it fits together

One server holds authoritative state; three browser surfaces render it.

| Surface | Who | Needs |
|---|---|---|
| `/` | the audience | nothing — it's the join screen |
| `/admin` | whoever runs the session | host password |
| `/display` | the projector | display token |
| `/host` | whoever runs the session | host token |
| `/join/CODE` | the audience, on phones | room code only |

The server is the single source of truth. Any surface can crash, reload, and resync to
the exact current beat. The display holds the whole scenario and renders forward on its
own between server beats, so a brief dropout doesn't stutter the show.

## Requirements

Node 24 or newer. The server runs TypeScript directly — Node strips the types natively,
so there is no build step for server code.

## Getting started

```bash
npm install
```

Check your scenarios before you rely on them:

```bash
npm run validate
```

Run the tests:

```bash
npm test
```

Typecheck:

```bash
npm run typecheck
```

## Writing a scenario

A scenario is a folder under `scenarios/` containing `scenario.yaml` and an `assets/`
directory. Adding a scenario means adding a folder — no code changes.

### Node types

A scenario is a list of nodes and the pointers between them. There are six kinds, and the
difference that matters most is **what ends the beat** — that is what lets one server, a
projector and forty phones stay on the same moment with nobody holding a stopwatch.

| Type | What it is | The beat ends when |
|---|---|---|
| `dialogue` | Lines of speech or narration, one beat each | each line's `hold` elapses |
| `gate` | A held screen waiting on a person | the moderator presses the button |
| `pause` | A silent beat of a fixed length | its `duration` elapses |
| `poll` | The audience votes; the winner chooses what happens next | the voting window closes |
| `branch` | Invisible. Reads a variable and routes | immediately — it takes no time at all |
| `end` | A finish | never — the show stops here |

Every node has an `id`, and every node may carry `scene:`, `background:` and `video:` (see
[Voice-over and motion](#voice-over-and-motion)). Everything else depends on the type.

Every node except `poll`, `branch` and `end` leaves by a single `next:`. A poll leaves by
whichever option won, a branch by whichever condition matched, and an `end` does not leave.

#### dialogue

The workhorse. Each entry under `lines:` is its own beat on the projector, with the
speaker's nameplate and colour taken from `characters:`. Omit `who:` for narration — a
fiction notice, a title card — and no nameplate is drawn.

```yaml
- id: a1_jetty
  type: dialogue
  scene: halifax
  lines:
    - text: Zero four hundred, Halifax. The pier is busy the way it always is.
      hold: 5.6
      voice: voice/narr-a1-01.mp3
    - who: beau
      text: Every system aboard is green. She just does not have anyone on her.
      hold: 4.2
      voice: voice/beau-a1-01.mp3
      sfx: sfx/gull.mp3
  next: a3_cell
```

`hold` is seconds, and it is the beat's whole clock: **nothing on the server opens the
audio file**, so a `hold` a second short of the clip cuts the reading off mid-word in front
of a room. Leave it out and a reading-speed estimate decides. `npm run validate` warns
about any voiced line that does, and the editor measures the real clips and offers to write
the numbers for you.

#### gate

A beat that ends when a person says so. The projector holds the screen, the host console
grows a button labelled from `label:`, and **nothing counts down** — pressing it (or the
spacebar) is the only way forward.

This is what makes a presentation possible rather than only a film. The room asks a
question, somebody arrives late, the moderator wants the title card up until they have
finished talking over it.

```yaml
- id: welcome_hold
  type: gate
  text: Team Union — Ethics in Practice
  label: Start          # what the moderator's button says
  next: intro
```

`label` matters more than it looks: "Continue" is right for a beat in the middle and wrong
for the one at the top, where the whole point is that nothing has started yet.

Deliberately its own type rather than a `pause` with the duration left out. An omitted
number reads as a mistake at a glance, and the failure it causes is the worst kind here — a
show sitting still in front of an audience while nobody in the room knows a button is
waiting.

#### pause

A silent beat of a fixed length. A held frame, a breath before a vote, or four wordless
seconds of a sound.

```yaml
- id: f3_burst
  type: pause
  duration: 4
  background: images/standoff_missile.png
  sfx: sfx/ciws.mp3
  next: f4_silence
```

`sfx:` on a pause is the one place an effect does not hang off a line, because a pause is a
beat whose entire content can be a sound — and those are the beats where one matters most.
Without it the only way to give such a beat audio was to make it dialogue, which draws the
text box the pause exists to leave off.

#### poll

The audience votes from their phones; the winning option chooses what happens next. Two to
six options.

```yaml
- id: vote_approach
  type: poll
  question: How should the crew respond?
  prompt: There is no right answer. Decide as a crew.
  duration: 120          # seconds of open voting
  options:
    - { key: reply,  label: Broadcast a reply, next: path_reply }
    - { key: silent, label: Maintain silence,  next: path_silent }
  default: silent        # required — a poll with no votes must never deadlock
  tiebreak: random       # first | random | weighted
  set:
    approach: $winner    # later branch nodes can read this
```

`default:` is required rather than optional, and that is on purpose: a poll that receives
zero votes must never be able to stall a live show. The validator refuses a default that is
not one of the options.

`set:` writes the outcome into scenario variables that later `branch` nodes read. That is
what gives the story memory of earlier votes without the script exploding into an
unmanageable tree. Values may be a literal, or one of `$winner`, `$winnerLabel`, `$total`.

After the vote closes the display shows the result for a couple of seconds before the next
beat starts — that reveal is a real beat the server clocks, so the line after a poll gets
its full `hold`.

##### Tie-break modes

- **first** — highest count, ties go to the earliest option declared
- **random** — highest count, ties broken uniformly among the tied
- **weighted** — every option is a candidate with probability equal to its vote share,
  so a 60/40 split genuinely goes the minority way 40% of the time

#### branch

Invisible to the audience and takes no time at all. It reads the variables polls have
written and sends the story one way or another. Conditions are tried in order and the first
match wins, so ordering is precedence.

```yaml
- id: ending_branch
  type: branch
  when:
    - if: approach == 'reply' && disclosure == 'everyone'
      next: ending_open
    - if: disclosure == 'nobody'
      next: ending_quiet
  else: ending_measured
```

`else:` is required for the same reason `default:` is: there is always a path out.

Conditions are a deliberately tiny expression language: `==`, `!=`, `&&`, `||`, `!`,
parentheses, and the variables polls have set. There is no `eval`, no property access and no
function calls — scenario files are content, and content must never execute code.

#### end

The show stops here. A scenario may have several — that is the point of branching — and
each can say its own closing words.

```yaml
- id: finish
  type: end
  text: Thank you for playing.
```

`scenarios/first-contact/` is a short reference that exercises `dialogue`, `poll`, `branch`,
`pause` and `end`; `scenarios/team-union/` is a full presentation and is where to look for
`gate` in use.

### Voice-over and motion

A line can carry spoken audio, and a scene can carry a looping clip:

```yaml
scenes:
  harbour:
    background: images/harbour.jpg  # the poster frame — paints while the clip decodes
    video: video/harbour.mp4        # muted, looping, drawn over the still
    ambience: ambience/harbour.mp3  # a bed, mixed under the voice
    music: music/cold-open.mp3

nodes:
  - id: open
    type: dialogue
    scene: harbour
    lines:
      - text: Zero four hundred, Halifax.
        voice: voice/narr-01.mp3
        hold: 7                     # say how long, or the estimate decides for you
    next: a2_absence
```

Everything the scenario names is prefetched before the display reports ready, so nothing
streams in live in front of the room. The host console shows the download as it runs — a
count and the bytes — because a projector pulling a few hundred megabytes takes a minute or
two, and a wait that says nothing is indistinguishable from a hang.

Assets are filed by media type — `assets/voice/`, `assets/images/` — and the name in
`scenario.yaml` is the name on disk. A flat name still works, because every scenario written
before the convention is one.

A **scene is a place**, and a place gets several shots. Any node may carry its own
`background:` and `video:`, overriding the scene's for as long as it plays:

```yaml
nodes:
  - id: a2_absence
    type: dialogue
    background: images/a2-flank.jpg  # this shot only
    video: video/a2-flank.mp4
    lines:
      - text: Except there is no brow. No gangway.
        hold: 5
    next: a3_cell
```

The scene's `music:` and `ambience:` keep playing throughout — they belong to the
place, not the shot — and the next node without an override falls back to the
scene's still.

**Give every voiced line a `hold`.** Nothing on the server opens the audio file, so
the beat still ends when `hold` — or failing that, the reading-speed estimate — says
it does. Get it wrong and the narrator is cut off, or the room watches a still frame
in silence. `npm run validate` warns about any voiced line that leaves it to the
estimate.

Scene video is muted, which is what lets it autoplay. Voice is not, and browsers
refuse audible playback until the page has been interacted with — so the display
shows a **Click to enable sound** button the first time a clip is blocked. Click it
once when you open the projector window.

### The editor

A separate local tool, deliberately not part of the game server:

```bash
npm run editor
```

It opens on `http://localhost:8890` and reads the folders in your workspace straight off
disk. It is a row of tabs rather than a text editor with a preview beside it —
**Characters**, **Nodes**, **Variables**, **Simulate**, **Assets**, **Storyboard**,
**scenario.yaml**, and a command centre that lists everything still standing between the
project and a show.

#### Building the story in the Nodes tab

The Nodes tab is where a scenario is built. Every control writes `scenario.yaml` the moment
you use it, so there is no save step and nothing to keep in sync.

- **Add a node.** Choose a type in the toolbar and press **Add at end**, or `+` on any node
  to insert below that one. It arrives valid — a dialogue with a line, a poll with two options and a
  default, a branch with a condition and an else — and threaded into the beat above and
  below.
- **Delete a node.** `✕` mends the chain across the hole: whatever led here now leads to
  whatever this led to.
- **Reorder by dragging.** The grip on a node's header moves it, and the list top to bottom
  is what the room sees first to last. Dragging rewrites the linear `next` pointers around
  the move and **never** touches a poll option or a branch condition — those are deliberate
  jumps somebody authored, and the ones it leaves alone are reported rather than guessed at.
- **Change what a node is.** The `type` dropdown in a node's editor turns a dialogue into a
  gate, a pause into a poll, and so on. Fields the new type cannot hold are dropped and the
  status line says which; fields it insists on are supplied, so the node is valid the moment
  it lands. One line's words carry across into a gate's or a pause's `text:` and back again.
- **Edit every field.** `Edit` opens a form covering everything the schema allows for that
  type, including dialogue lines, poll options and their `set:` writes, and branch
  conditions — each with add and remove.
- **Reorder lines by dragging.** Lines, poll options and branch conditions each have their
  own grip. The whole entry moves, so a line's `hold`, `voice` and `sfx` travel with its
  words. For options this is the order phones show them in; for conditions it is evaluation
  precedence.
- **Pick assets from a list.** `scene`, `background`, `video`, `sfx` and a line's `voice`
  offer what the scenario already names, then anything sitting unclaimed in `assets/`.
  Reuse is the common case — a scene is a place and a place gets several shots — and typing
  a filename again is how a show ends up with one name on the board and a slightly different
  one in the file the projector opens. You can still type a name that does not exist yet,
  because declaring an asset is what puts it on the board to be made.

Edits are written **by source offset**, never by re-serialising, so comments and
hand-wrapped folded scalars survive a drag or a retyped line — the file stays yours to read.
Anything structural is parsed before it is written and refused, with the problems, if the
result would not load.

#### Checking it before the night

Two questions worth asking before an event, and the tabs that answer them:

- **What goes in and out of each node** — which variables it reads, which it writes, where
  every exit leads and what would take it, and which nodes nothing points at.
- **How it reacts** — pick an outcome for each vote and run the whole story. You get the
  route it took, the dialogue in order, what each poll wrote, and the runtime. A poll left
  on *no votes* resolves through its `default`, which is the path hardest to rehearse and
  worst to discover live.

The simulator runs the **real engine**, not a model of it — the same `reduce` the server
uses on the night. Validation happens as you type, and it is the same check the server
applies at load time, so the editor cannot bless a scenario the server would reject.

It binds to loopback only, and it **works only on projects in a workspace folder you
choose**. A project is any folder with a `scenario.yaml`; the editor reads and writes
nothing outside the workspace and has no path of its own into the repo. Point the workspace
at `scenarios/` and you author the shows this server serves, in place — `.gitignore` keeps
the editor's own files (`project.yaml`, `.ledger.json`, `generated/`, `voices/`) out of
version control, so the folder is the show to git and the whole project to the editor. Point
it somewhere else and nothing you build can disturb a server that may be mid-show, which is
the safer arrangement while one is actually running.

## Configuration

Everything that differs between a container host and a laptop is an environment
variable, so the same process runs in both places.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8880` | Rare enough to avoid collisions, still on Cloudflare's proxyable HTTP port list |
| `HOST` | `0.0.0.0` | |
| `PUBLIC_URL` | derived from the request | Only needed when the audience's address differs from the one the server sees |
| `ADMIN_PASSWORD` | generated | Gates `/admin` and session creation |
| `DATA_DIR` | `./data` | SQLite lives here |
| `SCENARIOS_DIR` | `./scenarios` | |
| `ROOM_TTL_MINUTES` | `240` | Idle rooms are swept after this |

Links are derived from the address each request arrives on, so browsing to a LAN IP
gives LAN links and a Cloudflare-proxied request gives public ones. `PUBLIC_URL` is
an override for the rare case where those differ.

## Running it

Build the client once, then start the server:

```bash
npm run build
```

```bash
npm start
```

`http://localhost:8880/` is the audience join screen. To run a session, go to
`/admin` — it asks for the host password, then hands you three links: the display for
the projector, the host console for your phone, and a code the audience joins with.

`/admin` also lists every session currently running, with its links, so a host console
lost to a closed tab or a flat battery can be recovered — and lets you restart a session
from the top or end it outright. If there is no second device to put the console on, the
display drives the show from its own keyboard; see below.

Set the password with `ADMIN_PASSWORD`. Leave it unset and a readable one is
generated and printed at startup, so the server is never accidentally left open.

### Running it from the projector

The host console assumes a second device — a phone in your hand, a laptop beside the one
driving the picture. When there isn't one, the display page takes keystrokes of its own, so
a presenter can run the whole show from the machine it is already playing on.

| Key | What it does |
|---|---|
| <kbd>Space</kbd> | Starts the show in the lobby. On a `gate`, releases it — the legend shows the gate's own label. Otherwise pauses, and resumes when paused. |
| <kbd>→</kbd> | The next beat. During a vote it closes the poll on the votes cast so far; while paused it resumes and moves on. |
| <kbd>←</kbd> | Back a beat. |
| <kbd>1</kbd>–<kbd>9</kbd> | While a vote is open, ends it and makes that option win, in the order the options are on screen. Ignored the rest of the time. |
| <kbd>?</kbd> | Shows the key legend, bottom right. <kbd>Esc</kbd> hides it. |

Pressing a key confirms itself in the bottom-left corner for a moment, and **Paused** stays
there until the show moves again — from the third row a held beat and a stopped one are the
same picture. Both are deliberately small: this is a screen an audience is looking at.

The display and the host console drive the same room and see the same state, so it is fine
to use both, or to hand the console to someone else and keep the keyboard.

Two commands are **not** on the keyboard and stay on the console: resetting the show to the
top, and jumping to a named node. A reset in front of an audience should cost more than one
key, and there is nothing on a projector to pick a node with.

### Offline fallback

If a venue's connection is dead, the same server runs on the presenting laptop and
the audience joins over the room's wifi:

```bash
npm run local
```

It prints a QR code in the terminal and picks the LAN address phones are most likely
to reach — virtual adapters from VPNs, WSL and Docker are ranked out of the way,
since a QR pointing at one of those is unreachable from the room.

### Deploying

See [DEPLOY.md](DEPLOY.md).

## Status

Working end to end: scenario authoring and validation, the story engine, the room
server, all three client surfaces, live voting with automatic branching, host
overrides, moderator-held `gate` beats for running a scenario as a presentation,
keyboard control from the projector itself for presenting off a single screen, the
password-gated admin console with live session control, recovery from a server restart
mid-show, the offline fallback, and the scenario editor — its graph inspector, its
simulator, its asset pipeline, and a Nodes tab that builds and reorders the story
without opening the YAML. 535 tests, including a run with fifty simultaneous voters
and a full restart with votes already cast.

Not built yet: creating a poll's first `set:` block still needs the `scenario.yaml`
tab, and `scenarios/first-contact/` ships without artwork, so its scenes render as
gradients.

## License

MIT

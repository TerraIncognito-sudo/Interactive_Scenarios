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

Two programs. One of them is optional.

**The client** is the program: a local process on your own machine plus two browser
windows. The **board** is where you write a scenario, make its artwork and voice clips,
rehearse it and drive it; the **stage** is the window you drag onto the projector. It
holds the story, the engine and the clock, and it runs a whole show start to finish with
no network at all.

**The relay** is a small container that carries votes. It hands out a room code, phones
join at that code, and the votes come back. It holds no scenario, no engine and not even a
YAML parser — it could not read a story if you handed it one. The client connects
**outbound** to it, which is the point: the laptop running the show sits behind a domestic
router with nothing forwarded, and the relay is the thing with a hostname.

| Surface | Where | Who | Needs |
|---|---|---|---|
| board | client, `localhost:8890` | you | nothing — it is your own machine |
| stage | client, a popup window | the projector | nothing |
| `/` and `/join/CODE` | relay | the audience, on phones | a room code |
| `/status` | relay | you | console password |
| `/keys` | relay | you | console password |

Going live is an *addition* to a show that is already on the projector. You press Play,
drag the stage across, rehearse with simulated votes, and only then ask for a code — and
if the relay never answers, the show carries on without it.

## Requirements

Node 24 or newer. Everything that runs in Node is TypeScript that Node executes directly
by stripping the types, so there is no build step except for the two browser bundles.

## Getting started

```bash
npm install
```

Start the client:

```bash
npm run editor
```

It opens on `http://localhost:8890`, binds to loopback only, and asks for a **workspace**
folder the first time — any folder whose subfolders contain `scenario.yaml` files.
Pointing it at this repo's `scenarios/` is the usual answer.

If you have never made a scenario before, the **Start here** tab is the whole route from
an idea to a room full of people voting. It hands you two briefs to paste into a language
model — one that turns a description into a storyboard, one that turns a storyboard into a
`scenario.yaml` — creates the project folder for you, and then walks you through the asset
board and out onto the projector.

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

A scenario is a folder containing `scenario.yaml` and an `assets/` directory. Adding a
scenario means adding a folder — no code changes.

### Node types

A scenario is a list of nodes and the pointers between them. There are six kinds, and the
difference that matters most is **what ends the beat** — that is what lets the projector
and forty phones stay on the same moment with nobody holding a stopwatch.

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

`hold` is seconds, and it is the beat's whole clock: **nothing opens the audio file to
find out how long it is**, so a `hold` a second short of the clip cuts the reading off
mid-word in front of a room. Leave it out and a reading-speed estimate decides.
`npm run validate` warns about any voiced line that does, and the board measures the real
clips and offers to write the numbers for you.

#### gate

A beat that ends when a person says so. The projector holds the screen, the board grows a
button labelled from `label:`, and **nothing counts down** — pressing it (or the spacebar
on the projector) is the only way forward.

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
beat starts — that reveal is a real beat the clock owns, so the line after a poll gets its
full `hold`.

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

Everything the scenario names is prefetched before the stage reports ready, so nothing
streams in live in front of the room. The board shows the download as it runs — a count and
the bytes — because a wait that says nothing is indistinguishable from a hang, and because
project folders usually live in a synced drive where a file can be present, zero bytes, and
still on its way down.

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

Scene video is muted, which is what lets it autoplay. Voice is not, and browsers refuse
audible playback until the page has been interacted with — so **click the stage window once
after you open it**. The board will not let you press Start until you have, and says so.

## The client

`npm run editor` starts it. It is a row of tabs: **Start here**, **Characters**, **Nodes**,
**Scenes**, **Variables**, **Simulate**, **Assets**, **Storyboard**, **scenario.yaml**,
**Show**, and a command centre listing everything still standing between the project and a
night.

### Start here

The tab for the step everything else assumes. Four boxes and ten steps: describe the
scenario in your own words, copy a brief into a language model to get a storyboard back,
tidy the storyboard until you like it, copy a second brief to turn it into a
`scenario.yaml`, and press a button to make the project folder. The remaining six steps
walk from there to a live show — declare the voice clips, seed the images, make and publish
the assets, rehearse, go live — each one linking to the tab that actually does the work.

The ticks are yours. The program will not tick one for you: whether a storyboard is *good
enough* is not a thing it can know. What it *can* see sits on its own line beside each
step — "no `project.yaml` yet", "14 voice clips declared, 0 made" — read off the same board
the Assets tab renders, so the two can never disagree.

### Building the story in the Nodes tab

Every control writes `scenario.yaml` the moment you use it, so there is no save step and
nothing to keep in sync.

- **Add a node.** Choose a type in the toolbar and press **Add at end**, or `+` on any node
  to insert below that one. It arrives valid — a dialogue with a line, a poll with two
  options and a default, a branch with a condition and an else — and threaded into the beat
  above and below.
- **Delete a node.** `✕` mends the chain across the hole: whatever led here now leads to
  whatever this led to.
- **Reorder by dragging.** The grip on a node's header moves it, and the list top to bottom
  is what the room sees first to last. Dragging rewrites the linear `next` pointers around
  the move and **never** touches a poll option or a branch condition — those are deliberate
  jumps somebody authored, and the ones it leaves alone are reported rather than guessed at.
- **Change what a node is.** The `type` dropdown turns a dialogue into a gate, a pause into
  a poll, and so on. Fields the new type cannot hold are dropped and the status line says
  which; fields it insists on are supplied, so the node is valid the moment it lands. One
  line's words carry across into a gate's or a pause's `text:` and back again.
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

### Checking it before the night

Two questions worth asking before an event, and the tabs that answer them:

- **What goes in and out of each node** — which variables it reads, which it writes, where
  every exit leads and what would take it, and which nodes nothing points at.
- **How it reacts** — pick an outcome for each vote and run the whole story. You get the
  route it took, the dialogue in order, what each poll wrote, and the runtime. A poll left
  on *no votes* resolves through its `default`, which is the path hardest to rehearse and
  worst to discover live.

The simulator runs the **real engine**, not a model of it — the same `reduce` the show uses
on the night. Validation happens as you type, and it is the same check the show applies when
it loads, so nothing can bless a scenario the show would reject.

### Making the assets

The **Assets** and **Characters** tabs are the workshop. A part is the unit of work: a
character's sheet carries their voice, every line they speak, and their portrait, because
those halves are made weeks apart by different models and used to be joined only by an id
you carried in your head.

Voice clips are generated here — see
[docs/voice-generation.md](docs/voice-generation.md) for setting that up. Everything else is
made in whatever program you like and dropped into the takes folder; the board records what
you brought in, checks its format, its dimensions and its runtime against what the row asks
for, plays it back to you, and publishes the take you chose to the name the projector opens.

Generating never publishes and never steals a selection, so re-rolling a line is free. The
command centre is the list of what is left, and it is a projection of the board rather than a
second opinion about it: when it is empty, the show is ready.

## Running a show

Open the **Show** tab and press **Play**. That loads the scenario, takes the project folder's
lock, and opens the **stage** — a separate window, not a tab, so you can drag it onto the
projector and put it into fullscreen. **Click it once** so the browser will let it make sound;
the board will not let you press Start until you have. If it gets lost behind something, the
**Stage** button brings it back.

The board carries the beat readout, the phase, and Start / Pause / Resume / Back / Skip /
Continue, plus Reset behind a confirm. The projector has its own keyboard for the night there
is no second device:

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

Resetting to the top and jumping to a named node are **not** on the keyboard. A reset in
front of an audience should cost more than one key, and there is nothing on a projector to
pick a node with.

### Rehearsing a vote

Two ways to decide a poll, and they are not the same thing.

**Cast** puts imaginary voters in the box and lets the poll close on its own clock. It is
the only one that proves a poll's `default:`, its tie-break and the reveal beat before an
audience is the thing testing them. The counts are targets rather than increments, so asking
for five Left and two Right gives you exactly that, and asking for zero is how you watch a
`default:` fire.

**Force** ends the vote and declares a winner. It never runs the resolver and never draws a
truthful bar chart — it is the override for the night a vote goes wrong.

Casting is refused while you are linked to a relay, and the tab says which room is live.
Otherwise the rehearsal control would stuff a live ballot, which would happen exactly once:
in front of a room, five minutes after going live having simulated all afternoon.

### Going live

Press **Go live**. The first time, the board asks for the relay's address and a key; after
that it remembers both and just links. You get a room code, a join URL and a QR on the
projector's lobby, and the phones start arriving.

You can name the room. Leave the box empty and the relay mints six characters from an
alphabet with no `O/0`, `I/1`, `S/5` or `Z` in it, because those get read off a projector
from the back of a room. Type something and you get `ARCTIC-SENTINEL` instead — which is
worth doing for more than memorability: **if the client crashes, asking for the same name
with the same key walks you back into the same room**, with the open question and every
ballot under it intact. A minted code cannot do that, because nothing can ask for it again.
A different key is refused: a name is written on a wall.

The name is remembered in the project, so the next rehearsal of the same show goes live
under the same code.

The code can arrive mid-show. Going live is something that happens to a show already on the
wall, so the lobby grows a QR without anybody reloading the projector — and a show with no
relay at all is an ordinary state rather than a broken one.

After a live poll, **Save this to the project** writes a dated markdown record of what the
room decided — counts, shares, and a note where you overrode a vote — into the project's
`records/` folder. Rehearsals do not get the button: a file per afternoon of imaginary voters
is a folder of records nobody can cite.

## The relay

```bash
npm start
```

Runs it locally on 8880 for development. In practice it lives in a container — see
[DEPLOY.md](DEPLOY.md), which covers the first-run sequence and the offline fallback.

The short version: bring it up, sign into `/keys` with the console password, generate a key
with a label saying which machine it is for, and paste it into the client once. A fresh
relay has no keys and opens no rooms until you do — an empty value must never quietly mean
the permissive thing.

Keys are revoked one at a time from the same page. Revoking refuses the *next* room and
never the running one, so it is safe to do during a show; `/status` lists every live room,
which key opened it, and has an **End** button for the one a crashed client left holding a
code.

## Status

Working end to end: scenario authoring and validation, the story engine, the asset pipeline,
voice generation, the walkthrough from an idea to a project folder, local playback with a
projector window and keyboard control, simulated voting, live voting with automatic
branching through a relay, operator overrides, moderator-held `gate` beats, a written record
of what the room decided, revocable relay keys with a console to issue and end things from,
named rooms that survive a client crash, and recovery from a relay restart mid-show. 635
tests, including the whole product end to end — relay, client, two phone sockets and a real
tally — a run with fifty simultaneous voters, and a full restart with votes already cast.

Not built yet: `scenarios/first-contact/` ships without artwork, so its scenes render as
gradients. Image and video generation is deliberately absent — those are made in whatever
program you like and brought in, and the board's job is to check them rather than to own an
encoder.

## License

MIT

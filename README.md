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
directory. Adding a scenario means adding a folder — no code changes. See
`scenarios/first-contact/` for a reference that exercises every node type.

Node types are `dialogue`, `poll`, `branch`, `pause`, and `end`.

### Voice-over and motion

A line can carry spoken audio, and a scene can carry a looping clip:

```yaml
scenes:
  harbour:
    background: harbour.jpg    # the poster frame — paints while the clip decodes
    video: harbour.mp4         # muted, looping, drawn over the still

nodes:
  - id: open
    type: dialogue
    scene: harbour
    lines:
      - text: Zero four hundred, Halifax.
        voice: narration-01.mp3
        hold: 7                # say how long, or the estimate decides for you
```

Both are prefetched before the display reports ready, so nothing streams in live
in front of the room.

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

It opens on `http://localhost:8890` and reads `scenarios/` straight off disk. The left
half is the YAML; the right half answers the two questions worth asking before an event:

- **What goes in and out of each node** — which variables it reads, which it writes, where
  every exit leads and what would take it, and which nodes nothing points at.
- **How it reacts** — pick an outcome for each vote and run the whole story. You get the
  route it took, the dialogue in order, what each poll wrote, and the runtime. A poll left
  on *no votes* resolves through its `default`, which is the path hardest to rehearse and
  worst to discover live.

The simulator runs the **real engine**, not a model of it — the same `reduce` the server
uses on the night. Validation happens as you type, and it is the same check the server
applies at load time, so the editor cannot bless a scenario the server would reject.

It binds to loopback only. It is the one process here that writes to `scenarios/`, and it
writes atomically.

```yaml
- id: vote_approach
  type: poll
  question: How should the crew respond?
  duration: 120
  options:
    - { key: reply,  label: Broadcast a reply,   next: path_reply }
    - { key: silent, label: Maintain silence,    next: path_silent }
  default: silent        # required — a poll with no votes must never deadlock
  tiebreak: random       # first | random | weighted
  set:
    approach: $winner    # later branch nodes can read this
```

`set:` writes the outcome into scenario variables, and `branch` nodes read them. That
gives the story memory of earlier votes without the script exploding into an
unmanageable tree.

### Tie-break modes

- **first** — highest count, ties go to the earliest option declared
- **random** — highest count, ties broken uniformly among the tied
- **weighted** — every option is a candidate with probability equal to its vote share,
  so a 60/40 split genuinely goes the minority way 40% of the time

### Branch conditions

A deliberately tiny expression language: `==`, `!=`, `&&`, `||`, `!`, parentheses,
and variables set by polls. There is no `eval`, no property access and no function
calls — scenario files are content, and content must never execute code.

```yaml
- id: ending_branch
  type: branch
  when:
    - if: approach == 'reply' && disclosure == 'everyone'
      next: ending_open
  else: ending_measured
```

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
from the top or end it outright.

Set the password with `ADMIN_PASSWORD`. Leave it unset and a readable one is
generated and printed at startup, so the server is never accidentally left open.

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
overrides, the password-gated admin console with live session control, recovery
from a server restart mid-show, the offline fallback, and the scenario editor with
its graph inspector and simulator. 123 tests, including a run with fifty
simultaneous voters and a full restart with votes already cast.

Not built yet: the editor edits YAML directly rather than offering a node graph you
can drag, and the demo scenario ships without artwork, so scenes render as gradients.

## License

MIT

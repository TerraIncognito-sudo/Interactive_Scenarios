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
| `PUBLIC_URL` | derived | Base URL encoded into the join QR code — must be what a phone can actually reach |
| `DATA_DIR` | `./data` | SQLite lives here |
| `SCENARIOS_DIR` | `./scenarios` | |
| `ROOM_TTL_MINUTES` | `240` | Idle rooms are swept after this |

`PUBLIC_URL` matters: the QR code has to encode a hostname the audience's phones can
resolve, which is not the container's internal address.

## Running it

Build the client once, then start the server:

```bash
npm run build
```

```bash
npm start
```

Open `http://localhost:8880/`, pick a scenario, and you get three links: the display
for the projector, the host console for your phone, and a join code for the audience.

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
overrides, and the offline fallback. 87 tests, including a run with fifty
simultaneous voters.

Not built yet: crash-recovery replay after a server restart mid-show is persisted
but not yet exercised by a test, and there is no visual scenario editor.

## License

MIT

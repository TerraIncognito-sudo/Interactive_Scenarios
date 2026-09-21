# Brief: turn a storyboard into `scenario.yaml`

You are converting a storyboard into the file a presentation engine plays. The storyboard is
below this brief. Read all of it before writing anything.

Hand back **one YAML document in one fenced block**, and nothing else. No explanation above or
below it, no commentary inside it beyond ordinary YAML comments. It is going to be pasted
straight into an editor that will refuse it if it is wrong.

---

## The contract

The file is validated strictly. **An unknown key is an error, not a warning** — `nxt:` does not
quietly become `next:`, it stops the file loading. Use only the keys listed here.

```yaml
id: arctic-sentinel          # letters, numbers, hyphens, underscores
title: Arctic Sentinel
description: One sentence.   # optional
start: a1_jetty              # the id of the first node
lobby: halifax               # optional: the scene shown before anyone presses start

settings:                    # all optional; these are the defaults
  wordsPerMinute: 160
  minLineSeconds: 2
  maxLineSeconds: 14
  charsPerSecond: 45         # typewriter reveal speed; 0 turns it off

characters:
  narr:
    name: Narrator
    color: '#B0BEC5'         # quoted, or YAML reads the # as a comment
  beau:
    name: LCdr Élise Beaudoin
    color: '#4FC3F7'
    sprite: images/beau.png  # optional portrait, drawn over the scene

scenes:
  halifax:
    background: images/halifax-jetty.png
    video: video/halifax-jetty.mp4    # optional looping clip over the still
    music: music/cold-open.mp3        # optional bed, persists across the scene
    ambience: ambience/harbour.mp3    # optional second bed

nodes:
  - …
```

### Asset paths

Every filename is **relative to the scenario's own `assets/` folder**, with forward slashes,
and may not climb out of it. File them by kind: `voice/`, `images/`, `video/`, `music/`,
`ambience/`, `sfx/`.

Declare the files the show *will* need even though none of them exist yet. That is the point:
the list of assets is built from this file, and declaring them is what puts them on the board
to be made.

---

## The nodes

`nodes:` is a list. Every node has an `id`, a `type`, and — except for `end` — something that
says where the story goes next. Any node may also carry:

- `scene:` — move to a place. The scene's music and ambience start and persist.
- `background:` / `video:` — this node's own still and clip, **for this node only**. A scene is
  a place and a node is a shot, so several shots in one room share a scene and override the
  picture. Do not make a new scene per shot; that re-triggers the music every beat.

### dialogue

```yaml
  - id: a1_jetty
    type: dialogue
    scene: halifax
    background: images/a1-jetty.png
    lines:
      - who: narr
        text: Zero four hundred, Halifax. The pier is busy the way it always is.
        hold: 4.5
        voice: voice/narr-a1-01.mp3
      - who: narr
        text: Fuel lines. Weather brief. A last cup of coffee that nobody finishes.
        hold: 3.8
        voice: voice/narr-a1-02.mp3
    next: a2_absence
```

- `who:` is a character id, and may be left out for narration with no nameplate.
- `hold:` is seconds. **Nothing opens the audio file**, so the beat lasts exactly this long
  whatever the clip does — a hold a second short cuts a line off mid-word in front of a room.
  Set it from the storyboard's own timing and expect to correct it later with real clips.
- `voice:` and `sfx:` are optional files.

One line per sentence or two, not one line per shot. The display shows a line at a time.

### poll

```yaml
  - id: p1_severance
    type: poll
    scene: control_cell
    question: The link is down. What should the ship do?
    prompt: You have ninety seconds.
    duration: 90
    options:
      - { key: defend, label: Defend itself, next: p1_defend }
      - { key: hold,   label: Hold and wait, next: p1_hold }
      - { key: back,   label: Withdraw,      next: p1_back }
    default: hold
    tiebreak: first        # first | random | weighted
    set:
      severance: $winner   # $winner, $winnerLabel, $total, or a literal
```

- Two to six options. Keys are short and id-shaped; labels are what the phones show.
- **`default:` is required and must be one of the keys.** It is what happens when nobody votes,
  and a poll that could deadlock in front of an audience is the one failure this format refuses
  to allow.
- `set:` writes the outcome into variables a later `branch` can read. This is how a vote still
  matters three scenes on, and it is worth using at least once.

### branch

```yaml
  - id: decide
    type: branch
    when:
      - { if: "severance == 'defend'", next: e1_strike }
      - { if: "severance == 'hold' && escalated == 'yes'", next: e2_boarded }
    else: e3_quiet
```

The condition language is tiny and deliberate: `==`, `!=`, `&&`, `||`, `!`, parentheses,
identifiers, quoted strings, numbers, `true`/`false`. **There is no arithmetic, no property
access and no function calls.** `else:` is required.

A branch is invisible and instant — it is routing, not a beat.

### pause

A beat with no words: a held image, four seconds of a sound.

```yaml
  - id: f3_gunfire
    type: pause
    scene: open_sea
    duration: 4
    sfx: sfx/cws-burst.mp3
    next: f4_after
```

`text:` is optional. Leave it out for a beat that is purely picture and sound — writing it as
dialogue would draw a dialogue box over the thing the pause exists to show.

### gate

A beat that ends when **a person** says so, not when a clock does. Use it for a title card the
moderator talks over, or a question to the room.

```yaml
  - id: title
    type: gate
    scene: halifax
    text: Arctic Sentinel
    label: Start          # what the moderator's button says
    next: a1_jetty
```

Nothing counts down on a gate. That is the whole point — and it is why it is its own type
rather than a pause with the number left out.

### end

```yaml
  - id: e1_strike
    type: end
    scene: control_cell
    text: The ship fired. Nobody in the room had authorised it.
```

An `end` has no `next:`. Every path through the story must reach one.

---

## What will be checked, and will fail

The file is validated the moment it is pasted. These are errors:

- a `next:`, an option's `next:`, a branch's `next:` or `else:`, or `start:` naming a node that
  does not exist;
- a `who:` naming a character that is not in `characters:`;
- a `scene:` naming a scene that is not in `scenes:`;
- a poll whose `default:` is not one of its own option keys;
- a node id used twice;
- a node nothing can reach;
- any key not listed in this brief.

Assets that do not exist yet are a **warning**, not an error. That is deliberate: declaring the
art before making it is what puts it on the board.

---

## How to do the conversion

1. **One shot, one node.** A storyboard shot becomes a `dialogue` node with the shot's lines,
   or a `pause` if it has none. Take the node id from the shot's `**Node:**` if it has one, and
   otherwise from its shot id: `Shot A.1` → `a1`. Prefer a readable id — `a1_jetty`.
2. **Scenes are places.** Collect the distinct `**Scene:**` values into `scenes:`. Give each a
   `background:`. Put each shot's own picture on the node as `background:`, not as a new scene.
3. **Chain them.** Each node's `next:` is the following shot, until a poll, a branch or an end.
4. **Split the dialogue.** A storyboard quotes a whole delivery as one blockquote; the display
   shows a line at a time, so break it into the lines the audience will read. Give each a
   `hold:` derived from the shot's total hold, divided across its lines.
5. **Name the voice clips.** Every spoken line gets `voice: voice/<who>-<shot>-<n>.mp3` —
   `voice/narr-a1-01.mp3`. Be consistent; these are filenames somebody will generate.
6. **Name the pictures.** `images/<shot>-<slug>.png` for stills, `video/<shot>-<slug>.mp4` for
   clips the storyboard's `**MOTION**` describes as a real loop.
7. **Wire the polls and branches** exactly as the storyboard specifies them, including the
   default.
8. **Walk every path to an ending** before you hand it back.

Keep your comments. A `#` comment above a poll saying what it is for survives every later edit
the editor makes, and is read by whoever picks this up in a year.

---

## Check before you answer

- [ ] Every `next:`, `else:`, option `next:` and `start:` names a node that exists.
- [ ] Every `who:` is in `characters:`; every `scene:` is in `scenes:`.
- [ ] Every poll has a `default:` that is one of its own keys.
- [ ] Every path reaches an `end`.
- [ ] Every hex colour is quoted.
- [ ] Every asset path is relative, forward-slashed, and inside a kind folder.
- [ ] No key appears that is not in this brief.
- [ ] One fenced YAML block, nothing else.

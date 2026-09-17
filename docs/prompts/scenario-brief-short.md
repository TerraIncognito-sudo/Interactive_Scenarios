# Brief: now turn that storyboard into `scenario.yaml`

You wrote the storyboard earlier in this conversation. Convert it — all of it — into the file
the presentation engine plays. Do not summarise it, do not sample it, and do not stop partway:
every shot in the document becomes a node.

Hand back **one YAML document in one fenced block**, and nothing else. No explanation above or
below it, no commentary inside it beyond ordinary YAML comments. It is going to be pasted
straight into an editor that will refuse it if it is wrong.

If the show is long enough that you cannot finish it in one reply, say so in a single line
*before* the block, hand back the first part ending on a complete node, and continue in the
next reply from exactly where you stopped. A truncated file that looks finished is the one
outcome worth avoiding: the editor will load it, and the show will simply stop in the middle.

---

## The contract

Validated strictly. **An unknown key is an error, not a warning** — `nxt:` does not quietly
become `next:`, it stops the file loading. Use only the keys below.

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
```

Every filename is relative to the scenario's own `assets/` folder, forward-slashed, and filed
by kind: `voice/`, `images/`, `video/`, `music/`, `ambience/`, `sfx/`. Declare the files the
show *will* need even though none of them exist yet — that is what puts them on the board to
be made.

Any node may also carry `scene:` (move to a place; its music and ambience start and persist)
and `background:` / `video:` (this node's own picture, **for this node only**). A scene is a
place and a node is a shot: several shots in one room share a scene and override the picture.
A new scene per shot re-triggers the music every beat.

---

## The nodes

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
        text: Fuel lines. Weather brief. A last cup of coffee nobody finishes.
        hold: 3.8
        voice: voice/narr-a1-02.mp3
    next: a2_absence
```

`who:` is a character id, and may be left out for narration with no nameplate. `hold:` is
seconds and **nothing opens the audio file** — the beat lasts exactly this long whatever the
clip does. One line per sentence or two, not one line per shot; the display shows a line at a
time. `voice:` and `sfx:` are optional files.

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
    default: hold
    tiebreak: first        # first | random | weighted
    set:
      severance: $winner   # $winner, $winnerLabel, $total, or a literal
```

Two to six options; keys are short and id-shaped, labels are what the phones show.
**`default:` is required and must be one of the keys** — it is what happens when nobody votes.
`set:` writes the outcome into a variable a later `branch` can read; use it at least once.

### branch

```yaml
  - id: decide
    type: branch
    when:
      - { if: "severance == 'defend'", next: e1_strike }
      - { if: "severance == 'hold' && escalated == 'yes'", next: e2_boarded }
    else: e3_quiet
```

`==`, `!=`, `&&`, `||`, `!`, parentheses, identifiers, quoted strings, numbers, `true`/`false`
— **no arithmetic, no property access, no function calls**. `else:` is required. A branch is
routing, not a beat: invisible and instant.

### pause

A beat with no words — a held image, four seconds of a sound. `text:` is optional; leave it
out for a beat that is purely picture and sound.

```yaml
  - id: f3_gunfire
    type: pause
    scene: open_sea
    duration: 4
    sfx: sfx/cws-burst.mp3
    next: f4_after
```

### gate

A beat that ends when **a person** says so, not when a clock does — a title card the moderator
talks over, a question to the room. Nothing counts down.

```yaml
  - id: title
    type: gate
    scene: halifax
    text: Arctic Sentinel
    label: Start          # what the moderator's button says
    next: a1_jetty
```

### end

```yaml
  - id: e1_strike
    type: end
    scene: control_cell
    text: The ship fired. Nobody in the room had authorised it.
```

No `next:`. Every path through the story must reach one.

---

## Converting

One shot, one node — a `dialogue` with the shot's lines, or a `pause` if it has none. Take the
id from the shot's `**Node:**`, or from its shot id: `Shot A.1` → `a1_jetty`. Collect the
distinct `**Scene:**` values into `scenes:`. Chain each node's `next:` to the following shot
until a poll, a branch or an end. Split each blockquote into the lines the audience will read
and divide the shot's hold across them. Name every clip `voice/<who>-<shot>-<n>.mp3` and every
picture `images/<shot>-<slug>.png`. Keep your comments — a `#` above a poll saying what it is
for survives every later edit the editor makes.

## Check before you answer

- [ ] Every shot in the storyboard has a node. Nothing was skipped or abbreviated.
- [ ] Every `next:`, `else:`, option `next:` and `start:` names a node that exists.
- [ ] Every `who:` is in `characters:`; every `scene:` is in `scenes:`.
- [ ] Every poll has a `default:` that is one of its own keys.
- [ ] Every path reaches an `end`, and no node is unreachable.
- [ ] Every hex colour is quoted.
- [ ] No key appears that is not in this brief.
- [ ] One fenced YAML block, nothing else.

# Brief: write a storyboard

You are writing a **storyboard** for an autoplaying illustrated scenario — a short film that
plays itself on a projector, narrated and voiced, and that stops once or twice to let the
audience vote from their phones on what happens next.

The storyboard is the document everything else is made from. A person reads it to make the
pictures; a program reads it to build the list of assets the show needs. So it has to be good
prose *and* it has to follow the shape below exactly. Where the two conflict, follow the shape.

Write the whole thing in one reply, as a single markdown document, in a fenced code block so
nothing is reformatted on the way out.

---

## 1. What the piece is

Ask yourself these before writing a line, and answer them in the document:

- **What is the question the room argues about afterwards?** A scenario is a delivery
  mechanism for a decision. If the audience leaves agreeing with each other, the votes were
  not worth taking.
- **Where do the votes go?** Each poll must lead somewhere genuinely different. A vote whose
  branches reconverge in four seconds is a vote the room can feel was decorative.
- **How long is it?** Aim for 8–15 minutes of story plus 60–120 seconds per poll. That is
  roughly 25–45 shots.

If the material is invented but resembles something real — a military operation, a medical
emergency, a company — open with a **fiction notice** to be shown on screen before the first
shot. Put it in a blockquote near the top.

---

## 2. The document's shape

### The head

Start with a title, then a short block of facts, then the fiction notice if there is one, then
the cast table, then the visual style. None of this is parsed; it is for the people who will
make the thing. Write it properly anyway — it is what keeps forty images looking like one film.

```
# TITLE — Storyboard & Production Script

**Working title:** …
**Scenario id (proposed):** `kebab-case-id`
**Runtime:** ~11 min of story + 2 polls ≈ 14 min wall clock
**Audience:** …
```

### The cast

A markdown table. One row per speaking part, with the **id** the scenario will use, the name
as it appears on screen, and a **voice direction** — register, pace, accent, what happens to
the voice under pressure. The voice direction is used later to generate the speech, so write
it as direction to a performer, not as biography.

Give every character a hex colour for their nameplate. List them after the table:

```
`narr` `#B0BEC5` · `beau` `#4FC3F7` · `tran` `#FFB74D`
```

Ids are short, lowercase, and may contain letters, numbers, hyphens and underscores.

### Character sheets

For each character whose **face the audience will see**, define a reference portrait prompt:

```
- **Beaudoin sheet:** `Character reference sheet, neutral slate background. A woman in her
  early forties, dark hair pulled back tight, unlined navy working uniform with no visible
  insignia, calm level gaze. Three-quarter view, even soft key light.`
```

The label before the word "sheet" is matched to a character id later, so use either the id
itself or a distinctive whole word of the name.

**Only draw sheets for characters who are actually seen.** A narrator has no face. A voice
heard only over a radio has no face. A ship is not a person. Every sheet you write becomes a
portrait somebody has to make, and inventing a face the piece deliberately withheld is worse
than leaving one out.

### The style

Write the visual style out as prose, once, before the shots. It is the single biggest thing
standing between you and forty pictures that do not look like the same film: palette, light,
lens, medium, and an explicit list of what must never appear (text, logos, watermarks, real
insignia).

**Then write it into every IMAGE prompt.** Earlier versions of this system expanded a `STYLE.`
shorthand automatically; nothing does that now, so a prompt saying `STYLE.` reaches the image
model as the word "STYLE" and returns a picture with none of the palette. Each prompt must
stand alone.

---

## 3. Shots — the part that is parsed

A shot is **one camera setup**: one still image, held for a few seconds, with narration or
dialogue over it. A shot is not a scene. A **scene is a place**, and a place gets many shots.

Group shots under act headings, which are any `##` line:

```
## ACT A — The jetty
```

Then each shot, exactly like this:

~~~
### Shot A.1 — Cold open, the jetty
**Hold:** 8 s · **Scene:** `halifax`

**IMAGE**
```
Pre-dawn at a working naval jetty, low tide, wet concrete reflecting sodium light. The
uncrewed warship lies alongside, black and windowless, dwarfing the two small figures on the
pier beside it. Mist off the water. Wide establishing shot, camera low and slightly aft of
the bow. [then the full style, written out: palette, light, lens, and the list of things
that must never appear]
```
**MOTION** Slow parallax push toward the bow; mist drifts left to right.

**VO — `narr`**
> Zero four hundred, Halifax. The pier is busy the way it always is before a ship sails.
> Fuel lines. Weather brief. A last cup of coffee that nobody finishes.

*Delivery: unhurried, matter-of-fact, no menace.*
~~~

The rules, each of which matters:

| Element | Rule |
|---|---|
| `### Shot A.1 — Title` | Shot id, then an em dash, then a title. The id becomes part of every filename this shot produces, so keep it short: `A.1`, `D.5`. |
| `**Hold:** 8 s` | How long the shot stays on screen. Estimate honestly — 2–3 seconds per short line of narration, more for a beat with no words. |
| `**Scene:** \`halifax\`` | **Required on every shot.** The place. Several shots share one scene; that is the normal case and the reason scenes exist. |
| `**Node:** \`p1_defend\`` | Only when the shot's node cannot be inferred from its id — the first beat after a poll branch, for instance. |
| `**IMAGE**` | **Required on every shot.** A fenced block underneath holding the complete image prompt. |
| `**MOTION**` | Optional. What moves: a parallax push, a looping element, drifting mist. Written inline after the label or in a fence. |
| `**SFX**` | Optional. One sound effect for this beat. |
| `**VO — \`id\`**` | The speaker, then the line as a `>` blockquote. The id goes *inside* the bold. |
| `*Delivery: …*` | Optional note on how the line is read. Applies to the line above it. |

For several speakers in one shot, write the id on its own line before each quote:

```
`beau`:
> Say again your last.

`tran`:
> Link's gone, ma'am. Both paths.
```

A line with **no speaker** is narration with no nameplate — a fiction notice, a title card.
Write those under `**VO — \`narr\`**` if you have a narrator; a quote with no speaker at all is
dropped.

### Endings and special beats

Beats with no shot number use their own heading form and must state their node:

```
### ENDING A — the strike
**Node:** `end_strike` · **Scene:** `control_cell`
```

Only `ENDING`, `EPILOGUE`, `PROLOGUE`, `CODA` and `DEBRIEF` are recognised. Any other `###`
heading is treated as prose and ignored, which is deliberate — a document written for people
is full of headings that are furniture.

---

## 4. The polls

Write each poll out in full, in its own section, with:

- the **question** as it will appear on the phones, short enough to read on a small screen;
- an optional supporting line;
- **two to six options**, each with a short key (`defend`, `hold`, `wait`), the label the
  audience sees, and the shot the story goes to if it wins;
- which option is taken if **nobody votes** — this is required, and it must be one of the
  options. A poll that can deadlock in front of an audience is the worst failure this format
  has;
- how long voting is open, in seconds.

Then write the branches. Every option leads to shots of its own. If two branches reconverge,
say where and why.

Consider giving at least one poll a real consequence later in the story — a variable the vote
writes, read by a branch two acts on. That is what makes a vote feel like it mattered.

---

## 5. What to hand back

One markdown document, fenced, containing: the head, the fiction notice if any, the cast table
and colours, the character sheets, the style, then every shot in order under act headings, and
the polls written out in full.

Do not write YAML. Do not write code. A later step turns this into a scenario file, and it can
only do that if this document is complete and honest about its own timings.

Before you finish, check:

- [ ] Every shot has a `**Scene:**` and an `**IMAGE**`.
- [ ] Every image prompt stands alone — no `STYLE.` shorthand, no references to other prompts.
- [ ] Every character who speaks is in the cast table with an id, a colour and a voice direction.
- [ ] Only characters who are seen have sheets.
- [ ] Every poll names its options, its default, and where each option goes.
- [ ] Every branch eventually reaches an ending.

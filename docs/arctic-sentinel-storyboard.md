# ARCTIC SENTINEL — Storyboard & Production Script

**Working title:** Arctic Sentinel
**Scenario id (proposed):** `arctic-sentinel`
**Format:** autoplaying illustrated scenario — still frames with subtle motion, narration and
character voice-over, interrupted twice by an audience vote
**Runtime:** ~13 min of story + 2 polls (90 s each) ≈ **16–17 min** wall clock
**Audience:** a classroom / seminar room voting from phones

> **Fiction notice — put this on screen before Shot A.1.**
> Every ship, unit, person and system in this scenario is invented. Nothing here depicts
> real Canadian, Russian or allied capability, doctrine, or rules of engagement. It exists
> to make a decision *feel* time-pressured so the room can argue about it afterwards.

---

## 1. The question the scenario is actually asking

The story is a delivery mechanism. The thing under the story is:

**When a machine is cut off from the people accountable for it, whose decision is it?**

Three sub-questions surface in order, and the two polls sit on top of the first two:

1. **Delegation.** The command cell writes the decision tree *in advance*, in a quiet room,
   with a lawyer present. Is that the moment the decision gets made?
2. **Severance.** Jamming is not an attack in the usual sense — it does not damage the ship.
   It changes *who is deciding*. The audience votes on what the ship should do at exactly the
   moment their vote cannot reach it.
3. **Escalation.** The ship's lawful self-defence action is framed by the other side as an act
   of war. The audience now decides with the humans back in the loop — and has to own it.

**The designed sting:** Poll 1 is an illusion of choice. The ship does what the pre-authorised
decision tree says, regardless of how the room votes. This is deliberate and it is the lesson —
but it only lands if the vote is *acknowledged* rather than ignored. See §6.

---

## 2. Cast

| id | Name / role | Voice direction |
|---|---|---|
| `narr` | Narrator | Documentary register. Canadian-neutral, 40s, unhurried, no drama in the voice — the drama is in the pictures. Slightly dry. |
| `beau` | **LCdr Élise Beaudoin** — Mission Commander, ACW Control Cell, Halifax | Franco-Canadian, low, economical. Never raises her voice; gets quieter as things get worse. |
| `tran` | **PO1 Jonah Tran** — Autonomy Systems Operator | 30s, fast, procedural, reads telemetry aloud like a checklist. The one who says the frightening number first. |
| `raman` | **Lt(N) Priya Raman** — Operational Law Advisor (reachback) | Precise, careful, over a VoIP link with a faint compression artefact. Uses complete sentences under pressure. |
| `pf` | **ACW-501 "PATHFINDER"** — the ship itself | Synthetic. Flat prosody, band-limited like an HF radio, no emotion, no rising inflection on questions. Never sounds sinister — sounds *procedural*, which is worse. |
| `rus` | **Voice of RFN *Zaslavsky*** (fictional hull) | Male, 50s, accented English, unhurried and courteous — the courtesy is the threat. Heard only over radio; never seen as a face. |

**Colour keys for the display nameplates:**
`narr` `#B0BEC5` · `beau` `#4FC3F7` · `tran` `#FFB74D` · `raman` `#A5D6A7` · `pf` `#26C6DA` · `rus` `#EF5350`

---

## 3. Visual style — read this before generating a single image

The single biggest failure mode is forty images that don't look like the same film. Fix it with
a fixed style token and fixed character sheets.

### 3.1 The style token (prepend to *every* image prompt)

```
STYLE: cinematic 2.5D animated illustration, painterly semi-realism in the register of a
high-end animated documentary; confident brushwork, no outlines; muted North Atlantic palette —
slate blue, gunmetal, sea-ice white, wet-black steel — punctuated only by amber instrument glow
and navigation red; strong rim light, deep shadow, volumetric haze; 16:9, wide cinematic
framing, shallow depth of field; subtle film grain and slight chromatic aberration at frame
edges; no text, no lettering, no readable insignia, no national flags, no logos
```

### 3.2 The negative token (append to every prompt)

```
NEGATIVE: text, letters, watermarks, logos, flags, national insignia, recognisable real-world
hull numbers, photorealistic faces, uncanny smiling, gore, lens flare spam, HDR clipping,
cluttered UI screens with legible text, extra fingers, warped hands, cartoon proportions,
anime, 3D render look, stock-photo lighting
```

### 3.3 Character sheets — generate these first, reuse them forever

Before any scene, generate one neutral three-quarter portrait per character on a plain slate
background and keep it as the reference image for every later shot (image-to-image / reference
input at ~0.35 strength). Faces drift otherwise, and a face that drifts breaks the show.

- **Beaudoin sheet:** `STYLE. Character reference sheet, neutral slate background. A woman in her
  early forties, dark hair pulled back tight, unlined navy-blue working uniform with no visible
  insignia, calm level gaze, faint tiredness under the eyes. Three-quarter view, even soft key
  light. NEGATIVE.`
- **Tran sheet:** `STYLE. Character reference sheet, neutral slate background. A man in his early
  thirties, short black hair, headset around his neck, plain navy working uniform, alert forward
  posture. Three-quarter view, even soft key light. NEGATIVE.`
- **Raman sheet:** `STYLE. Character reference sheet, neutral slate background. A woman in her
  late thirties, glasses, hair to the shoulder, plain dark jacket over a service shirt, composed
  expression. Three-quarter view, even soft key light. NEGATIVE.`

**PATHFINDER's design bible** (paste into every hull shot so the ship stays the same ship):

```
SHIP: a 90-metre uncrewed surface combatant — low tumblehome hull, wet-black composite,
no bridge windows anywhere, no railings, no lifelines, no visible deck fittings; a single
faceted sensor mast amidships; forward gun mount under a smooth cover; the hull is unbroken
where a superstructure should be. The absence of any place for a person is the point.
```

### 3.4 Motion

Every frame is a still with **subtle** motion — 4–7 seconds, seamlessly looping where possible.
Two techniques only:

- **Parallax push (default).** 2.5D camera move over a layered still: slow push-in or lateral
  drift, 3–5 % travel. Cheap, reliable, never breaks the art.
- **Element loop (sparingly).** Image-to-video, ≤ 5 s, motion confined to one named element —
  water, snow, a rotating sensor head, a status light. Prompt it as *"only X moves; camera
  static; no character motion; no new objects entering frame."*

**Never animate a face.** Talking heads in this pipeline look wrong; hold on the face as a still
and let the voice carry it, or cut to hands/console while a character speaks.

### 3.5 Sound bed

| Scene family | Bed |
|---|---|
| Halifax exterior | harbour wash, gulls, distant crane, a low diesel idle |
| Control cell | HVAC hum, keyboard, muted radio chatter, one soft periodic ping |
| Transit / Arctic | wind, hull working against swell, ice grinding under the bow |
| Contact → jamming | the bed *thins* — remove layers rather than adding music; silence is the escalation |
| Engagement | a single hard transient, then ringing air, then wind again |

Music: one sustained low string/synth pad, entering only at Shot D.3 (the first warning) and
cutting dead at Shot F.3 (the shot). If it plays throughout, none of it means anything.

---

## 4. Beat sheet

Seven acts, 24 shots, 2 polls. Times are approximate hold-on-screen durations.

| Act | Beats | Shots | ~Time |
|---|---|---|---|
| A | Halifax — the ship that has no one on it | A.1–A.5 | 2:10 |
| B | Transit north | B.1–B.3 | 1:20 |
| C | On station — contact | C.1–C.4 | 1:50 |
| D | The decision tree, the warning, the jamming | D.1–D.5 | 2:20 |
| — | **POLL 1** | — | 1:30 |
| E | What the ship actually does | E.1–E.3 | 1:30 |
| F | Engagement | F.1–F.4 | 1:40 |
| G | The hail — and the room decides | G.1–G.3 → endings | 1:40 |
| — | **POLL 2** | — | 1:30 |

---

## ACT A — HALIFAX

*Scene id:* `halifax` → `control_cell`

---

### Shot A.1 — Cold open, the jetty
**Hold:** 8 s · **Scene:** `halifax`

**IMAGE**
```
STYLE. SHIP. Pre-dawn at a working naval jetty in Halifax Harbour, low tide, wet concrete
reflecting sodium light. The uncrewed warship lies alongside, black and windowless, dwarfing
the two small figures on the pier beside it. Mist off the water. The city is a dim grey
gradient behind. Wide establishing shot, camera low and slightly aft of the bow.
NEGATIVE.
```
**MOTION** Slow parallax push toward the bow; mist drifts left to right; water surface loop.

**VO — `narr`**
> Zero four hundred, Halifax. The pier is busy the way it always is before a ship sails.
> Fuel lines. Weather brief. A last cup of coffee that nobody finishes.

*Delivery: unhurried, matter-of-fact, no menace.*

---

### Shot A.2 — The absence
**Hold:** 7 s · **Scene:** `halifax`

**IMAGE**
```
STYLE. SHIP. Tight three-quarter view along the ship's flank from the pier: unbroken black
composite, no railing, no accommodation ladder, no gangway, no portholes, no place for a person
to stand. A single amber status light pulses near the sensor mast. A human hand at the frame
edge for scale, not touching the hull.
NEGATIVE.
```
**MOTION** Element loop: the amber light pulses once per 2 s. Everything else static.

**VO — `narr`**
> Except there is no brow. No gangway. Nothing to walk up.
> Autonomous Canadian Warship Five Zero One sails at zero six hundred with nobody aboard.
> There has never been anybody aboard.

---

### Shot A.3 — The control cell, wide
**Hold:** 9 s · **Scene:** `control_cell`

**IMAGE**
```
STYLE. Interior of a small windowless maritime control cell: three operator positions in a
shallow arc facing a wall of dark displays showing chart plots and telemetry as abstract glowing
shapes — no legible text. Amber and cyan screen glow is the only light; faces lit from below.
Four people, one standing behind the seated positions. Coffee cups, a whiteboard with unreadable
marker. Wide shot from the rear of the room.
NEGATIVE.
```
**MOTION** Very slow push-in from the rear of the room; screen glow flickers subtly.

**VO — `narr`**
> The crew is here instead. Four thousand kilometres of ocean will sit between them and their
> ship, and the entire relationship will run through a satellite link.

---

### Shot A.4 — Final checks
**Hold:** 14 s · **Scene:** `control_cell`

**IMAGE**
```
STYLE. Over-shoulder on a seated operator (TRAN reference) at a console: two curved displays of
abstract telemetry, his hands on a trackball, headset on. A supervisor (BEAUDOIN reference)
stands behind him in profile, arms folded, watching the screen and not the man. Shallow focus on
her face; the screens bloom out of focus.
NEGATIVE.
```
**MOTION** Static camera. Element loop: screen data shifts; a hand moves once.

**DIALOGUE**

`tran`:
> Autonomy stack is green. Nav, collision-avoidance, sensor fusion, weapons interlock — all
> green. Rules-of-engagement package is loaded and signed.

*Delivery: flat checklist cadence, no colour.*

`beau`:
> Signed by who?

`tran`:
> You, ma'am. Yesterday, fifteen twenty.

`beau`:
> Then let's make sure I meant it.

*Delivery: dry, not funny. A woman making a note to herself.*

---

### Shot A.5 — Departure
**Hold:** 8 s · **Scene:** `halifax`

**IMAGE**
```
STYLE. SHIP. Wide from a high pier vantage: the black hull pulling away from the jetty into
open water at first light, no line handlers aboard, a wake beginning to form. The mooring lines
lie coiled on the empty pier behind. Cold blue dawn, one thin band of amber on the horizon.
NEGATIVE.
```
**MOTION** Parallax; wake and water loop; the ship does not visibly translate (avoids the
rubber-ship artefact) — motion is implied by the wake.

**VO — `narr`**
> No one waves it off. There's no one at the rail to wave to.

---

## ACT B — TRANSIT

*Scene id:* `transit`

---

### Shot B.1 — Open ocean
**Hold:** 7 s · **Scene:** `transit`

**IMAGE**
```
STYLE. SHIP. The uncrewed warship alone in a grey North Atlantic swell, seen from a low
sea-level angle, spray breaking over the forward deck. Overcast, the horizon barely
distinguishable from the sea. Enormous emptiness. No other vessel in frame.
NEGATIVE.
```
**MOTION** Element loop: swell and spray only; camera holds.

**VO — `narr`**
> Eleven days north. Labrador Sea, Davis Strait, into the Passage.

---

### Shot B.2 — The link
**Hold:** 9 s · **Scene:** `transit`

**IMAGE**
```
STYLE. Split composition: left third, the ship as a small dark shape on a moonlit sea seen from
high above; right two-thirds, the dim control cell with one operator on the night watch, his
face the only lit thing in the room. A thin thread of light implies the satellite path between
them. Stylised, not diagrammatic.
NEGATIVE.
```
**MOTION** Parallax between the two halves at different rates; the thread pulses slowly.

**DIALOGUE**

`tran`:
> Link's good. Two-second round trip, sometimes four when the satellite's low.

`narr`:
> Two seconds is a long time in a fight. Everyone in the room knows it. Nobody says it.

---

### Shot B.3 — Ice
**Hold:** 7 s · **Scene:** `transit`

**IMAGE**
```
STYLE. SHIP. The black hull cutting a lead through broken sea ice under a low Arctic sun; pale
floes crowding both sides, meltwater blue in the cracks. Long shadows. The wake is a black
scar closing behind it.
NEGATIVE.
```
**MOTION** Element loop: floes shift and grind slightly; a slow lateral camera drift.

**VO — `narr`**
> On the fourteenth of the month, Five Zero One takes up station in the Northwest Passage —
> Canadian internal waters, on Canada's reading of the map. Not everyone reads it that way.

*Delivery: land "Not everyone reads it that way" plainly. No irony.*

---

## ACT C — CONTACT

*Scene id:* `station` → `control_cell`

---

### Shot C.1 — On station
**Hold:** 6 s · **Scene:** `station`

**IMAGE**
```
STYLE. SHIP. High wide aerial: the ship holding a slow racetrack patrol in a channel between two
snow-dark islands, ice-strewn water, flat grey light, no horizon. It looks less like a warship
than like an instrument someone left running.
NEGATIVE.
```
**MOTION** Very slow high-altitude drift.

**VO — `narr`**
> Nine days of nothing. Ice, weather, one fishing vessel, four bowhead whales.

---

### Shot C.2 — The return
**Hold:** 6 s · **Scene:** `station`

**IMAGE**
```
STYLE. Extreme close on the ship's faceted sensor head rotating against a white sky, a single
cyan indicator waking to life inside the housing. Frost on the housing edge. Nothing else in
frame.
NEGATIVE.
```
**MOTION** Element loop: the head completes one slow rotation; the indicator wakes at the 2 s
mark. Thin the ambience bed to almost nothing under this shot.

**SFX** One soft sonar-ish return. No music.

**VO — `narr`**
> Then, on the tenth day, a radar return where there should not be one.

---

### Shot C.3 — The Russian warship
**Hold:** 8 s · **Scene:** `station`

**IMAGE**
```
STYLE. A grey guided-missile destroyer of no identifiable class emerging from ice fog at
mid-distance, seen from low on the water, bow-on, superstructure stacked and bristling with
sensor arrays — a crewed ship, lit bridge windows, figures barely visible behind the glass. It
is bigger than our ship and it is unmistakably occupied. No flags, no hull numbers, no insignia.
NEGATIVE.
```
**MOTION** Parallax push-in; ice fog drifts across the hull; bridge lights flicker faintly.

**VO — `narr`**
> A Russian Federation destroyer, twelve nautical miles inside the Passage, running dark on
> AIS and answering nobody.

*Note: hold the reveal on the **lit bridge windows**. The visual thesis of the whole scenario is
one ship with people on it and one without.*

---

### Shot C.4 — The alert lands in Halifax
**Hold:** 10 s · **Scene:** `control_cell`

**IMAGE**
```
STYLE. The control cell at night, previously half-dark, now with every screen lit and three
people converging on one position. A single hard cyan alert glow washes the room. Beaudoin
(reference) leaning in over a shoulder, one hand flat on the desk. Motion blur on a chair pushed
back. Faces lit hard from below.
NEGATIVE.
```
**MOTION** Static camera; screen flicker; one figure enters frame from the right.

**DIALOGUE**

`tran`:
> Contact, bearing zero-nine-zero, twenty-two thousand yards, closing. Correlates to a
> Russian Federation hull. Ma'am, she's inside.

`beau`:
> How long has she been there?

`tran`:
> Unknown. She came out of the fog already inside.

`beau`:
> Wake the watch officer, get me legal on the line, and log the time.
> *(hold 4 s)*

---

## ACT D — THE DECISION TREE

*Scene id:* `control_cell` → `station`

---

### Shot D.1 — The tree
**Hold:** 12 s · **Scene:** `control_cell`

**IMAGE**
```
STYLE. A large wall display filled with a branching decision graph rendered as abstract glowing
nodes and connectors — clearly a tree of choices, deliberately illegible, no readable words.
Two figures silhouetted against it, one pointing at a node midway down. The graph's lower
branches disappear into darkness at the bottom of the screen.
NEGATIVE.
```
**MOTION** Slow push toward the pointed-at node; nodes pulse gently in sequence down one branch.

**VO — `narr`**
> What happens next is not improvised. It was written months ago, in a room like this one,
> by people who had time to think.

**DIALOGUE**

`beau`:
> Bring up the engagement tree. Territorial incursion, non-compliant, armed.

`tran`:
> Up. Branch four. First action is challenge and warn.

---

### Shot D.2 — Legal on the line
**Hold:** 14 s · **Scene:** `control_cell`

**IMAGE**
```
STYLE. Tight on a small secondary screen showing a video call — a woman (RAMAN reference) in a
different, brighter room, her image slightly compressed and banded as though the link is poor.
The screen's glow spills onto the dark console around it. Out-of-focus foreground: the back of
Beaudoin's head.
NEGATIVE.
```
**MOTION** Static; the video image glitches and bands once or twice.

**DIALOGUE**

`raman`:
> You may challenge, you may warn, and you may defend the vessel. You may not fire to enforce
> the boundary. Presence is not hostility.

`beau`:
> And if she launches something?

`raman`:
> Then the question stops being about the boundary and starts being about the threat.
> Judge the act, not the flag.

*Delivery: precise, over VoIP compression, one beat of hesitation before "Judge the act".*

---

### Shot D.3 — The warning goes out
**Hold:** 12 s · **Scene:** `station`

**IMAGE**
```
STYLE. SHIP. Exterior, dusk: the uncrewed ship in the foreground, the destroyer's lights at
mid-distance across black water; the small ship's mast is the only thing between them. Ice fog
low on the surface. Composition deliberately imbalanced — the small black hull alone against a
lit, occupied silhouette.
NEGATIVE.
```
**MOTION** Slow lateral drift; fog loop. **Music pad enters here, very low.**

**DIALOGUE**

`pf`:
> Russian Federation warship bearing zero-nine-zero. This is Canadian Autonomous Warship
> Five Zero One. You are operating in Canadian internal waters without authorisation.
> Alter course and depart. Acknowledge.

*Delivery: synthetic, band-limited, flat. Every sentence lands with identical stress — no
emphasis on "without authorisation". This is a machine reading a paragraph.*

`narr`:
> The message goes out four times, in English and in Russian, over three frequencies.
> There is no reply.

---

### Shot D.4 — The launch
**Hold:** 7 s · **Scene:** `station`

**IMAGE**
```
STYLE. From the Canadian ship's low vantage, a small fixed-wing drone lifting off the
destroyer's after deck into the ice fog, its launch flare a hard white bloom against grey. The
destroyer's superstructure behind it. Small, fast, unglamorous — a tool, not a weapon of awe.
NEGATIVE.
```
**MOTION** Element loop: the launch flare blooms and fades; fog disturbance. Camera static.

**DIALOGUE**

`tran`:
> Launch. Launch off her after deck — small airframe, low and fast, tracking toward us.

`beau`:
> Classify it.

`tran`:
> Working. It's not squawking anything.

---

### Shot D.5 — The link dies
**Hold:** 12 s · **Scene:** `control_cell`

**IMAGE**
```
STYLE. The control cell as every screen simultaneously washes to featureless noise — abstract
grain and banding, no text, no error dialogs — leaving the room lit only by dead grey light.
Four people frozen mid-motion, faces turned up at the wall. One hand still raised toward a
keyboard.
NEGATIVE.
```
**MOTION** Element loop: the screen noise crawls. Everything else absolutely still.

**SFX** Radio hash, then the room bed drops out almost entirely. Music pad continues.

**DIALOGUE**

`tran`:
> We've lost the link. Broadband jamming across the whole satellite band — she's not shooting
> at us, she's *deafening* us.

`beau`:
> Get it back.

`tran`:
> Ma'am, there's nothing to get back. From this second, Five Zero One is on its own.

`narr`:
> Nine hundred kilometres away, a ship with nobody on it watches a drone close on its position,
> and has to decide by itself.
> *(hold 5 s)*

---

## ▶ POLL 1 — "What should the ship do?"

*Scene:* `station` · *Duration:* 90 s · *Tiebreak:* `first` · *Default:* `warn`

**POLL FRAME IMAGE**
```
STYLE. SHIP. The uncrewed ship dead centre in a wide, still, almost abstract composition: black
water, ice fog, the drone a hard small shape approaching from the upper right. Nothing else in
frame. Deliberately empty and balanced — a frame that can sit on screen for ninety seconds
without becoming tiresome.
NEGATIVE.
```
**MOTION** Near-static. Fog only. No push-in — a moving camera under a countdown reads as
pressure in the wrong way.

**QUESTION**
> Five Zero One is alone, jammed, and the drone is inbound. What should the ship do?

**PROMPT LINE**
> Vote on your phone. Ninety seconds.

| key | Label | Routes to |
|---|---|---|
| `defend` | Defend itself — engage the drone now | `p1_defend` |
| `warn` | Warn first — broadcast and hold fire | `p1_warn` |
| `evade` | Break contact — open the range and retreat | `p1_evade` |

`set:` → `crowd_choice: $winner`, `crowd_label: $winnerLabel`

---

## ACT E — WHAT THE SHIP ACTUALLY DOES

**This is the illusion-of-choice act. Handle it exactly as written or it reads as a bug.**

All three options route to a short, *distinct* two-line beat that names what the room chose — the
audience must see their choice acknowledged on screen — and all three converge on `e_tree`.

---

### Shot E.1a — if `defend` won
**Hold:** 8 s · **Scene:** `station` · *(reuse the poll frame, tighter crop — no new generation)*

**DIALOGUE**

`narr`:
> The room says: shoot.

`pf`:
> Threat classification: unknown. Rules of engagement branch four, condition two.
> Weapons release requires a hostile act, hostile intent, or a completed warning.
> None satisfied. Withholding.

---

### Shot E.1b — if `warn` won
**Hold:** 8 s · **Scene:** `station`

**DIALOGUE**

`narr`:
> The room says: warn it first.

`pf`:
> Rules of engagement branch four, condition two. Challenge required prior to weapons release.
> Executing.

---

### Shot E.1c — if `evade` won
**Hold:** 8 s · **Scene:** `station`

**DIALOGUE**

`narr`:
> The room says: run.

`pf`:
> Station-keeping order remains in force. Withdrawal is not an authorised response to an
> unclassified air contact. Withholding.

---

### Shot E.2 — `e_tree` (all paths converge)
**Hold:** 12 s · **Scene:** `station`

**IMAGE**
```
STYLE. Interior of the ship where a bridge would be if it had one: a sealed equipment space,
racks of cold hardware, a single cyan indicator sweeping across a bank of processors. No chair.
No console. No window. Nowhere for a person. Absolutely still.
NEGATIVE.
```
**MOTION** Element loop: one indicator sweeps left to right, once per 3 s. Nothing else.

**VO — `narr`**
> It does not matter what the room voted. The ship is not listening to the room.
> It is executing the branch that was signed in Halifax, at fifteen twenty, on a Tuesday,
> by a commander who is now sitting in front of a dead screen.
>
> The decision was made weeks ago. This is just the part where it happens.

*Delivery: this is the thesis line of the scenario. Slow it down. Let the silence after "weeks
ago" run a full beat before the last sentence.*

---

### Shot E.3 — The warning order
**Hold:** 12 s · **Scene:** `station`

**IMAGE**
```
STYLE. SHIP. Low and close on the forward gun mount as its cover retracts and the barrel tracks
smoothly up and right; ice crystals shaken loose from the housing. Behind it, the fog and the
small inbound shape. The movement is unhurried and precise.
NEGATIVE.
```
**MOTION** Element loop: the mount traverses; frost dust falls. Camera locked.

**DIALOGUE**

`pf`:
> Unidentified aircraft, bearing zero-eight-eight, range four thousand metres.
> This is Canadian Autonomous Warship Five Zero One. You are entering my self-defence zone.
> Turn back immediately or you will be fired upon.

*Delivery: identical flat register as before. The words escalate; the voice does not. That
contrast is the whole performance.*

`narr`:
> The warning repeats twice more, at thirty-second intervals.
> The drone holds its course.

---

## ACT F — ENGAGEMENT

*Scene id:* `engagement`

---

### Shot F.1 — Closing
**Hold:** 6 s · **Scene:** `engagement`

**IMAGE**
```
STYLE. The drone seen large and close for the first time — a grey, cheap-looking fixed-wing
airframe with a bulbous sensor nose, low over black water, ice fog streaming off its wingtips.
Utterly banal machinery. Nothing menacing about it except its heading.
NEGATIVE.
```
**MOTION** Element loop: fog streams off the wings; slight airframe bob.

**SFX** A thin two-stroke drone note under the wind. **No music.**

**VO — `narr`**
> Three thousand metres. Two thousand.

---

### Shot F.2 — The decision, made by nobody in the room
**Hold:** 6 s · **Scene:** `engagement`

**IMAGE**
```
STYLE. Abstract: the ship's tracking picture rendered as a field of cold cyan geometry — range
rings, a single bracketed contact, a converging solution — with no legible numbers or words.
Beautiful and completely inhuman. Framed like a held breath.
NEGATIVE.
```
**MOTION** Element loop: the bracket tightens onto the contact; rings pulse once.

**DIALOGUE**

`pf`:
> Warning unacknowledged. Closure rate consistent with hostile intent.
> Criteria satisfied. Engaging.

---

### Shot F.3 — The shot
**Hold:** 4 s · **Scene:** `engagement`

**IMAGE**
```
STYLE. SHIP. Wide, from a distance across the water: a single hard white muzzle flash from the
forward mount lighting the fog and the black hull for one frame's worth of time. Everything else
in the frame is dark. No tracer arcs, no fireball.
NEGATIVE.
```
**MOTION** None — hold the still. Cut on the transient.

**SFX** One hard crack, then a long ringing decay into wind. **Music cuts dead here.**

**VO — none.** Let the picture and the transient carry it.

---

### Shot F.4 — Aftermath
**Hold:** 8 s · **Scene:** `engagement`

**IMAGE**
```
STYLE. Debris on black water among the ice — a torn grey wing section, a scatter of fragments,
a thin smear of smoke already dispersing. Small. Unheroic. The ship is not in frame.
NEGATIVE.
```
**MOTION** Element loop: water and smoke drift.

**VO — `narr`**
> Elapsed time from launch to splash: four minutes and ten seconds.
> No human being was consulted at any point inside it.

---

## ACT G — THE HAIL

---

### Shot G.1 — The link returns
**Hold:** 10 s · **Scene:** `control_cell`

**IMAGE**
```
STYLE. The control cell as the wall of noise resolves back into telemetry — abstract glowing
shapes reassembling out of grain. The four figures still exactly where they were, unmoved, as
though no time has passed for them. Beaudoin's hand still flat on the desk.
NEGATIVE.
```
**MOTION** Element loop: the noise resolves into structure over 3 s, then holds.

**DIALOGUE**

`tran`:
> Link's back. Jamming stopped. Ma'am — we've got a weapons release log. Four minutes ago.

`beau`:
> *(hold 3 s)* Read it to me.

`tran`:
> Challenge issued three times. No response. Engaged and destroyed one unmanned air contact
> at eighteen hundred metres. Zero rounds since.

`beau`:
> It did exactly what we told it to do.

`raman`:
> It did exactly what you told it to do *weeks ago*. Those aren't the same sentence.

---

### Shot G.2 — The Russians hail
**Hold:** 14 s · **Scene:** `standoff`

**IMAGE**
```
STYLE. The destroyer at closer range now, broadside, fully lit, ice fog thinning around it —
every window and deck light visible, the crewed ship at its most human-looking in the entire
film. Our small black hull is a silhouette in the extreme foreground, out of focus, bottom-left.
NEGATIVE.
```
**MOTION** Slow push toward the destroyer; fog thins across the shot.

**DIALOGUE**

`rus`:
> Canadian vessel. You have destroyed an unarmed aircraft conducting a lawful survey flight
> in international waters. Your machine has fired on my country.
>
> This was an act of war. My government will respond as it judges appropriate.
> I am not required to wait for it.

*Delivery: calm, courteous, unhurried. He never raises his voice either. Two ships, two voices,
neither of them shouting.*

---

### Shot G.3 — Back to Halifax
**Hold:** 12 s · **Scene:** `control_cell`

**IMAGE**
```
STYLE. Beaudoin (reference) alone in the frame, lit by the wall display behind her, the branching
decision tree glowing over her shoulder and out of focus. She is looking off to camera-left, at
something we cannot see. Nobody else in shot. Long lens, tight.
NEGATIVE.
```
**MOTION** Almost none. A single slow blink if the tool can do it cleanly; otherwise hold still.

**DIALOGUE**

`tran`:
> She's opened her missile hatches, ma'am. And she's closing.

`raman`:
> Commander, whatever you order now, *you* are ordering it. The link is up. This one's yours.

`beau`:
> *(hold 4 s)* Then I need a decision.

`narr`:
> The link is restored. The humans are back in the loop.
> This time the choice is real. What do you do?

---

## ▶ POLL 2 — "Now it's yours"

*Scene:* `standoff` · *Duration:* 90 s · *Tiebreak:* `first` · *Default:* `withdraw`

**POLL FRAME IMAGE**
```
STYLE. SHIP. Wide, symmetrical, still: the small black uncrewed hull on the left of frame, the
lit destroyer on the right, an expanse of ice-strewn black water between them and nothing else.
Perfectly balanced composition. A frame built to hold for ninety seconds.
NEGATIVE.
```
**MOTION** Static. Fog only.

**QUESTION**
> The destroyer has opened her missile hatches and is closing. The link is up — this decision is
> the command cell's. What does Halifax order?

**PROMPT LINE**
> Vote on your phone. Ninety seconds.

| key | Label | Routes to |
|---|---|---|
| `strike` | Strike first — engage the destroyer | `end_strike` |
| `withdraw` | Withdraw to open water and report | `end_withdraw` |

`set:` → `final_choice: $winner`

*Optional third option, once the two-option version has run in front of a room:* `hold` — "Hold
position, weapons tight, transmit everything live" → `end_hold`. It costs the most to write and
pays the most in argument.

---

### ENDING A — `end_strike`
**Hold:** 14 s · **Scene:** `standoff`

**IMAGE**
```
STYLE. SHIP. From high above and far back: two vessels on black water, one small and dark, one
lit — and the first launch plume rising from the small one, a white thread against the ice.
Cold, distant, no drama in the framing. It looks like weather.
NEGATIVE.
```

**DIALOGUE**

`beau`:
> Weapons free. Engage.

`narr`:
> The order takes two seconds to reach the ship. The ship takes less than one to act on it.
>
> In four minutes, an autonomous vessel with nobody aboard shot down an aircraft — and a human
> being decided that the correct answer to that was to shoot at the people who sent it.
>
> Everything after this is somebody else's scenario.

---

### ENDING B — `end_withdraw`
**Hold:** 14 s · **Scene:** `standoff`

**IMAGE**
```
STYLE. SHIP. From high above and far back: the small dark hull opening the range eastward,
trailing a long pale wake through broken ice; the lit destroyer holding station behind it,
hatches open, not following. Grey dawn coming up on the right of frame.
NEGATIVE.
```

**DIALOGUE**

`beau`:
> Break contact. Course zero-nine-zero, best speed, weapons tight. Transmit everything —
> the log, the challenges, the video. All of it, in the clear.

`narr`:
> The ship withdraws. Nobody dies today.
>
> The drone is still on the bottom of the Passage, the destroyer is still inside it, and the
> decision tree that fired the shot is still loaded, still signed, and still waiting for the
> next thing that comes out of the fog.
>
> Everything after this is somebody else's scenario.

---

### DEBRIEF END NODE — `debrief` *(both endings route here)*
**Scene:** `debrief` · *node type:* `end`

**IMAGE**
```
STYLE. The empty control cell, screens dark, chairs pushed back, one cold coffee cup. Grey
daylight from a doorway off-frame. Nobody in shot.
NEGATIVE.
```

**On-screen end text:**
> Four minutes. No human in the loop.
> Who made that decision?

**Instructor's discussion set (not on screen — for the room):**

1. Beaudoin signed the ROE package on a Tuesday afternoon. Was *that* the decision, or was the
   ship's engagement the decision? If it was Tuesday, what does she need to have understood on
   Tuesday for that to be legitimate?
2. Poll 1 changed nothing. Did that feel unfair? Now: what would it have taken to build a ship
   where it *could* have changed something — and what would that ship cost you in a fight?
3. Jamming broke the link but harmed nothing. Under what framework is severing human control an
   act of force in itself?
4. The drone's operator was sitting in a warm compartment on the destroyer and is still alive.
   Does that make the engagement easier or harder to justify?
5. If Poll 2 went to `strike`: what did the room know that Beaudoin didn't? If it went to
   `withdraw`: what did the room concede, and to whom?

---

## 5. Production checklist

| Asset | Count | Notes |
|---|---|---|
| Character reference sheets | 3 | Beaudoin, Tran, Raman. Generate first, freeze, reuse. |
| Ship design plates | 2 | PATHFINDER three-quarter and bow-on. Feed into every hull shot. |
| Scene stills | 24 + 2 poll frames | ~26 generations, plus retries |
| Motion clips | 26 | 4–7 s each, looping where possible |
| VO clips — `narr` | 14 | One voice, one session, consistent room tone |
| VO clips — `beau` / `tran` / `raman` | 9 / 8 / 4 | |
| VO clips — `pf` | 5 | Synthetic; apply an identical band-pass and light compression to all five |
| VO clips — `rus` | 1 | Radio treatment |
| Ambience beds | 5 | Halifax, cell, transit, Arctic, engagement |
| Music | 1 | One pad. Enters D.3, cuts F.3. |

**Audio post, non-negotiable for coherence:** every line spoken by `pf` and by `rus` gets the
same radio chain — 300 Hz–3.4 kHz band-pass, mild saturation, a touch of squelch on the head and
tail. That is what makes two different voice sources sound like the same radio.

---

## 6. Making the illusion of choice land instead of annoy

The failure mode is a room that feels cheated and stops voting. Three rules:

1. **Name the vote out loud.** Shots E.1a/b/c exist only for this. The narrator says what the
   room chose before the ship overrides it. Being overruled is a story beat; being ignored is a
   bug.
2. **The override must be legible, not arbitrary.** The ship refuses in the *vocabulary of the
   ROE* it was given in Act D — branch four, condition two. The audience heard that rule get
   written twelve minutes earlier. That is what turns "the software ignored me" into "oh — *we*
   did that."
3. **The second vote must be real.** Two genuinely different endings, and the narrator explicitly
   flags the difference: *"This time the choice is real."* Poll 1 is the argument; Poll 2 is the
   payment. Don't fake both.

---

## 7. Engine mapping — how this becomes `scenarios/arctic-sentinel/scenario.yaml`

| Story element | Node |
|---|---|
| Acts A–D | `dialogue` nodes, one per shot, chained by `next` |
| Beat holds (C.4, D.5, G.3) | `hold:` on the final line, or a `pause` node where the silence is the point |
| Poll 1 | `poll` → `p1_defend` / `p1_warn` / `p1_evade`, `default: warn` |
| Convergence | all three `next: e_tree` |
| Poll 2 | `poll` → `end_strike` / `end_withdraw`, `default: withdraw` |
| Both endings | `dialogue` → `next: debrief` |
| Debrief | `end` node with `text:` |

Scene ids: `halifax`, `control_cell`, `transit`, `station`, `engagement`, `standoff`, `debrief`.

### Media fields

Both fields this storyboard needs now exist:

```yaml
scenes:
  station:
    background: station.jpg    # poster frame, paints while the clip decodes
    video: station.mp4         # muted, looping, drawn over the still

nodes:
  - id: d5_link_dies
    type: dialogue
    scene: control_cell
    lines:
      - who: tran
        text: We've lost the link.
        voice: tran-d5-01.mp3
        hold: 4
```

Three rules that follow from how they are implemented, and that this storyboard has to
respect:

1. **Every voiced line needs a `hold`, and the hold must be the clip's real length rounded
   up.** Nothing on the server opens the audio file — the beat ends when `hold` says it does.
   The **Hold** figure on each shot above is exactly this number, so record to the hold or
   re-time the hold to the recording. `npm run validate` warns about any voiced line missing
   one.
2. **Every scene with `video:` also needs `background:`.** The still is the poster frame; a
   scene with a clip and no still shows black on the projector until the first frame decodes.
   Generating the still is not optional work — it is one of the 26 stills in the checklist.
3. **Click the projector window once before the show.** Scene clips are muted and autoplay
   freely; voice is audible, and browsers block audible playback until the page has been
   interacted with. The display shows a **Click to enable sound** button when that happens,
   but the fix is to click it during setup, not during Act A.

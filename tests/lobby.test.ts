/**
 * The lobby, which is on the projector longer than any shot in the show.
 *
 * A room fills over several minutes with this on screen, and it is the one
 * stretch nobody is watching for problems because the show has not started. So
 * both halves are pinned here: that a name which resolves to nothing is caught
 * at load rather than discovered by an audience, and that the display actually
 * paints it — the same reason `playback.test.ts` exists, since a field is cheap
 * to add to a schema and the half that consumes it lives in another program.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseScenarioSource } from '../src/scenario/load.ts';

const BASE = `id: demo
title: Demo
start: opening

characters:
  narr: { name: Narrator }

scenes:
  foyer: { background: images/foyer.png, video: video/foyer.mp4 }

nodes:
  - id: opening
    type: dialogue
    scene: foyer
    lines:
      - who: narr
        text: A line.
    next: done
  - id: done
    type: end
    text: Finished.
`;

test('a scenario may name no lobby at all', () => {
  const result = parseScenarioSource(BASE);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.scenario.lobby, undefined);
});

test('a lobby naming a real scene loads', () => {
  const result = parseScenarioSource(BASE.replace('start: opening', 'start: opening\nlobby: foyer'));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.scenario.lobby, 'foyer');
});

test('a lobby naming a scene that does not exist is an error, not a warning', () => {
  const result = parseScenarioSource(
    BASE.replace('start: opening', 'start: opening\nlobby: nowhere'),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.problems.some((p) => /lobby/.test(p) && /nowhere/.test(p)),
      `expected a problem naming the lobby, got: ${result.problems.join(' | ')}`,
    );
  }
});

test('the lobby is painted from both directions, not just the beat', () => {
  // The race this pins: the `idle` beat arrives over the socket and
  // `loadScenario` is a separate async job. Whichever finishes second is the one
  // that can paint — an early snapshot finds `scenario` still undefined, paints
  // nothing, and a lobby then sits there with no further snapshot ever coming to
  // correct it. Painting only from the beat gave a black lobby on every
  // projector that connected before its download finished, which is all of them.
  const source = readFileSync(
    join(import.meta.dirname, '..', 'src', 'client', 'display', 'main.ts'),
    'utf8',
  );
  const calls = source.match(/paintLobby\(\)/g) ?? [];
  assert.ok(
    calls.length >= 3,
    `expected paintLobby to be defined and called from both the idle beat and the end of loadScenario, found ${calls.length} mentions`,
  );
  // And the load-side call must be guarded, or a scenario finishing mid-show
  // would repaint the shot the audience is looking at.
  assert.match(source, /if \(!views\.lobby\.hidden\) paintLobby\(\);/);
});

test('the display paints the lobby scene rather than only showing the panel', () => {
  // Read as text for the same reason playback.test.ts is: a check that needs a
  // browser is a check nobody runs. The failure this catches is the whole
  // feature silently doing nothing — a `lobby:` the schema accepts, the board
  // tracks, and the projector never looks at.
  const source = readFileSync(
    join(import.meta.dirname, '..', 'src', 'client', 'display', 'main.ts'),
    'utf8',
  );
  const idle = source.slice(source.indexOf("case 'idle':"));
  const body = idle.slice(0, idle.indexOf('return;'));
  assert.match(body, /paintLobby\(\)/, 'the idle beat must paint the lobby scene');
  // And `paintLobby` must resolve it through the same resolver every other place
  // uses, so the lobby gets the still, the clip and the bed for free.
  assert.match(source, /function paintLobby\(\)[^}]*applyScene\(scenario\?\.lobby\)/s);
});

test('the join block carries its own ground, so a bright lobby clip cannot hide it', () => {
  // The QR, the URL and the room code are the only things on this screen the
  // audience has to be able to read, and `lobby:` can name a daylight clip —
  // white-on-white is a room that cannot join. A full-panel scrim also solves
  // it and throws away the picture that made anyone want a lobby scene, so the
  // ground belongs to this block alone.
  const css = readFileSync(
    join(import.meta.dirname, '..', 'src', 'client', 'display', 'display.css'),
    'utf8',
  );
  const block = css.slice(css.indexOf('.join-block {'));
  const body = block.slice(0, block.indexOf('}'));
  assert.match(body, /background:/, '.join-block must paint its own background');
  // Sized to its contents rather than the panel, or it is a scrim again.
  assert.match(body, /width:\s*fit-content/);
});

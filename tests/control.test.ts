/**
 * The projector's keyboard, and the list that bounds it.
 *
 * `DISPLAY_COMMANDS` used to be a security boundary: the display was a page on
 * a public server, holding a token somebody had been handed, and the socket
 * refused anything off the list. That is gone. Both surfaces are now windows
 * this process opened on the operator's own machine, so the transport checks
 * nothing and says so — and **this file is what is left holding the decision
 * up.**
 *
 * Which does not make the list less useful, only differently useful. It is now
 * a decision about what belongs on a keyboard at a lectern: `reset` puts the
 * show back to the beginning and on the console it sits behind a confirm that
 * a keystroke has no equivalent of, and `jump` needs a node id a projector can
 * neither offer nor check. A key wired to either would typecheck, run, and
 * fail only in front of an audience — as a key that quietly does nothing,
 * which is the worst of the three ways it could go, because the presenter
 * presses it again.
 *
 * Read as text, like `playback.test.ts` and for the same reason: the other
 * side of this is a browser, and a check that needs a browser is a check
 * nobody runs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DISPLAY_COMMANDS, HostCommandSchema, isDisplayCommand } from '../shared/show/protocol.ts';

const root = join(import.meta.dirname, '..');
const display = readFileSync(join(root, 'client', 'web', 'stage', 'main.ts'), 'utf8');
const markup = readFileSync(join(root, 'client', 'web', 'stage', 'index.html'), 'utf8');
const ws = readFileSync(join(root, 'client', 'app', 'show', 'ws.ts'), 'utf8');
const clientServer = readFileSync(join(root, 'client', 'app', 'server.ts'), 'utf8');

/** Every command name the schema actually has, taken from the schema itself. */
const ALL_COMMANDS = HostCommandSchema.shape.command.options.map(
  (option) => option.shape.name.value as string,
);

describe('what a display is allowed to send', () => {
  test('every name on the list is a command that exists', () => {
    // A typo here fails open in the quietest possible way: the name matches
    // nothing, so the allowlist silently shrinks by one and the key it was
    // for stops working.
    for (const name of DISPLAY_COMMANDS) {
      assert.ok(ALL_COMMANDS.includes(name), `${name} is not a command`);
    }
  });

  test('the destructive ones are not on it', () => {
    // Named rather than derived. Deriving "everything except reset and jump"
    // from the same list this is checking would assert nothing at all, and the
    // point of writing them out is that adding a third one is a decision
    // somebody has to make here, on purpose.
    assert.ok(!isDisplayCommand({ name: 'reset' }), 'a keystroke must not restart the show');
    assert.ok(
      !isDisplayCommand({ name: 'jump', nodeId: 'anywhere' }),
      'a projector cannot name a node, so it must not be able to go to one',
    );
    assert.ok(
      !isDisplayCommand({ name: 'castVotes', optionKey: 'a', count: 1 }),
      'a stray keystroke must never be able to put ballots in a box',
    );
  });

  test('the only thing that can send one is a window on this machine', () => {
    // What replaced the token check. The socket carrying commands no longer
    // authorises anybody, so the whole of what stops a stranger driving the
    // show is the address it is bound to — which makes that bind an invariant
    // rather than a default, and one nothing else in the suite is watching.
    assert.match(clientServer, /server\.listen\(PORT, '127\.0\.0\.1'/);

    // And the transport says why it checks nothing, rather than looking like
    // somewhere the check was dropped.
    assert.match(ws, /DISPLAY_COMMANDS/);
  });

  test('a vote is refused on the operator\'s own socket', () => {
    // The other half of the same boundary. Votes come from the relay; a frame
    // claiming to be one here is either a bug or somebody who got to the port.
    assert.match(ws, /Votes arrive from the relay/);
  });
});

describe('the projector binds the keys a presenter reaches for', () => {
  const KEYS: Record<string, RegExp> = {
    space: /event\.key === ' '|CONTROL_KEYS = \[' '/,
    right: /'ArrowRight'/,
    left: /'ArrowLeft'/,
    'the digits': /\[1-9\]/,
    'the legend': /event\.key === '\?'/,
  };

  for (const [name, pattern] of Object.entries(KEYS)) {
    test(`${name} is handled`, () => {
      assert.match(display, pattern);
    });
  }

  test('it listens for them at all', () => {
    assert.match(display, /addEventListener\('keydown'/);
  });

  test('and it sends nothing the server would refuse', () => {
    // The join between the two halves, and the only reason this file exists —
    // now more so, because nothing at the far end of the socket is checking any
    // more. Every command literal in the projector, against the list it is
    // supposed to be bounded by, so a key wired to something off that list is a
    // failed test rather than a dead key on the night.
    const sent = new Set(
      [...display.matchAll(/\{ name: '([a-zA-Z]+)'/g)].map((match) => match[1] as string),
    );
    assert.ok(sent.size > 0, 'the matcher found no commands, so it is proving nothing');
    for (const name of sent) {
      assert.ok(
        (DISPLAY_COMMANDS as readonly string[]).includes(name),
        `the display sends ${name}, which is not a key a projector may have`,
      );
    }
  });

  test('and the keys it does bind are the ones the legend names', () => {
    // The legend is read under pressure by somebody who cannot ask anyone.
    // A key that works and is not listed is a feature nobody finds; a key
    // listed and not wired is worse.
    for (const id of ['key-space', 'key-right', 'key-number']) {
      assert.ok(markup.includes(`id="${id}"`), `${id} is missing from the display`);
      assert.match(display, new RegExp(`el\\('${id}'\\)`), `${id} is never filled in`);
    }
  });
});

describe('nothing the presenter needs is on the wall by default', () => {
  test('the cue and the legend both start hidden', () => {
    // Everything in this file renders onto a projector in front of an
    // audience. The connection badge set the rule — intrude only when there is
    // something true to say — and these two are held to it.
    assert.match(markup, /<div class="cue" id="cue" hidden>/);
    assert.match(markup, /<aside class="keys" id="keys" hidden>/);
  });

  test('the pause badge is driven by the snapshot, not by the key', () => {
    // A projector that announced "Paused" off its own keystroke would be a
    // second opinion about the state of the show, and the two would disagree
    // the first time the Room refused one — which it does for a pause during a
    // vote, during a reveal, and on a stale beat.
    const rest = display.slice(display.indexOf('function restCue'));
    assert.match(
      rest.slice(0, rest.indexOf('function flashCue')),
      /latest\?\.phase === 'paused'/,
    );
  });
});

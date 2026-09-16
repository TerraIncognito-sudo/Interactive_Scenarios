/**
 * The projector's keyboard, and the list on the server that bounds it.
 *
 * These are two halves of one decision written in two files, and the halves
 * are checked by different things: the server refuses a command a display may
 * not send, and the display never sends one. Nothing joins them up. So a key
 * bound to `reset` would typecheck, run, and fail only in front of an audience
 * — as a key that quietly does nothing, which is the worst of the three ways
 * it could go wrong, because the presenter presses it again.
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
const ws = readFileSync(join(root, 'server', 'ws.ts'), 'utf8');

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
  });

  test('the server asks before it acts on one', () => {
    // The check has to be in the transport, not only in the client: the client
    // is the untrusted end of this connection and always was.
    assert.match(ws, /isDisplayCommand\(message\.command\)/);
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
    // The join between the two halves, and the only reason this file exists.
    // Every command literal in the projector, checked against the list the
    // server bounds it by — so a key wired to something off that list is a
    // failed test rather than a dead key on the night.
    const sent = new Set(
      [...display.matchAll(/\{ name: '([a-zA-Z]+)'/g)].map((match) => match[1] as string),
    );
    assert.ok(sent.size > 0, 'the matcher found no commands, so it is proving nothing');
    for (const name of sent) {
      assert.ok(
        (DISPLAY_COMMANDS as readonly string[]).includes(name),
        `the display sends ${name}, which the server will refuse`,
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
    // the first time the server refused one.
    const rest = display.slice(display.indexOf('function restCue'));
    assert.match(
      rest.slice(0, rest.indexOf('function flashCue')),
      /latest\?\.phase === 'paused'/,
    );
  });
});

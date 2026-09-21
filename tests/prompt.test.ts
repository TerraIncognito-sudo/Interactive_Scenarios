/**
 * What a brief says, and what it is for.
 *
 * A storyboard defines its style and its design bibles once, hundreds of
 * characters each, and every shot refers to them by name:
 *
 *     STYLE. SHIP. Pre-dawn at a working naval jetty…
 *
 * Nothing expands those any more. The composer that spliced them into what a
 * model was handed went with the generators it fed, so a prompt is now a brief
 * for whoever makes the picture — and a person reading `STYLE.` knows perfectly
 * well where the style is written down.
 *
 * What still has to be true is that the document is read faithfully and the
 * shot's own words are never touched. The blocks are still parsed, because a
 * reader that silently drops a section of a document is a reader that lies
 * about it; they simply have nowhere to be copied to.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseStoryboard } from '../client/app/storyboard.ts';

const STORYBOARD = [
  '## 3. Visual style',
  '',
  '### 3.1 The style token (prepend to *every* image prompt)',
  '',
  '```',
  'STYLE: cinematic 2.5D animated illustration, muted North Atlantic palette;',
  'strong rim light, deep shadow; no text, no lettering',
  '```',
  '',
  '### 3.2 The negative token',
  '',
  '```',
  'NEGATIVE: text, letters, watermarks, photorealistic faces, extra fingers',
  '```',
  '',
  "**PATHFINDER's design bible** (paste into every hull shot):",
  '',
  '```',
  'SHIP: a 90-metre uncrewed surface combatant — low tumblehome hull,',
  'no bridge windows anywhere, no railings. The absence of a place for a person is the point.',
  '```',
  '',
  '```yaml',
  '# Furniture: a config sample, not a definition.',
  'id: arctic-sentinel',
  '```',
  '',
  '## ACT A',
  '',
  '### Shot A.1 — Cold open',
  '**Hold:** 8 s · **Scene:** `halifax`',
  '',
  '**IMAGE**',
  '```',
  'STYLE. SHIP. Pre-dawn at a working naval jetty, wet concrete.',
  'NEGATIVE.',
  '```',
  '',
  '**MOTION** Slow parallax push toward the bow.',
  '',
].join('\n');

describe('what a storyboard defines once', () => {
  test('the named blocks are read, and the furniture is not', () => {
    const { tokens } = parseStoryboard(STORYBOARD);
    assert.deepEqual(Object.keys(tokens).sort(), ['NEGATIVE', 'SHIP', 'STYLE']);
    assert.match(tokens.STYLE!, /muted North Atlantic palette/);
    assert.match(tokens.SHIP!, /90-metre uncrewed surface combatant/);
    // A storyboard is full of fenced blocks that are examples, tables and
    // config samples. A rule that took all of them would fill the project file
    // with furniture.
    assert.equal(tokens.id, undefined);
  });

  test('the shot keeps its prompt exactly as the author wrote it', () => {
    const shot = parseStoryboard(STORYBOARD).shots[0]!;
    // Not expanded at import. The whole point of a name is that the thing it
    // names can be edited in one place afterwards.
    assert.match(shot.image!, /^STYLE\. SHIP\./);
    assert.match(shot.image!, /NEGATIVE\.$/);
  });
});

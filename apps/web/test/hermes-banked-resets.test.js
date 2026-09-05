/**
 * The banked resets, as one line instead of three.
 *
 * Hermes reports the same fact twice in its free-text `details` — "2 banked
 * resets on this account" and "you have 2 resets banked - use ... reset to
 * active" — and the card used to draw a green badge above both of them. What
 * it draws now is a single grey "2 reset tickets", and these tests pin all
 * three halves of that: the wording, the filtering, and the colour.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { bankedResetLine, usageDetailLines } from '../js/hermes-panel.js';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

describe('the line the card draws', () => {
  test('a count becomes "N reset tickets"', () => {
    assert.equal(bankedResetLine(2), '2 reset tickets');
    assert.equal(bankedResetLine(7), '7 reset tickets');
  });

  test('one is singular', () => {
    assert.equal(bankedResetLine(1), '1 reset ticket');
  });

  test('nothing banked is no line at all, not a zero', () => {
    assert.equal(bankedResetLine(0), null);
    assert.equal(bankedResetLine(null), null);
    assert.equal(bankedResetLine(undefined), null);
    assert.equal(bankedResetLine(NaN), null);
    assert.equal(bankedResetLine('2'), null);
  });
});

describe('the verbose sentences it replaces', () => {
  test('both of Hermes’ phrasings are dropped', () => {
    assert.deepEqual(
      usageDetailLines([
        '2 banked resets on this account',
        'you have 2 resets banked - use /reset to make one active',
      ]),
      []
    );
  });

  test('a singular phrasing is dropped too', () => {
    assert.deepEqual(usageDetailLines(['1 banked reset on this account']), []);
  });

  test('unrelated provider details survive', () => {
    assert.deepEqual(
      usageDetailLines([
        'Credit balance: $12.40',
        '2 banked resets on this account',
        'Weekly window resets Monday',
      ]),
      ['Credit balance: $12.40', 'Weekly window resets Monday']
    );
  });

  test('a plain reset sentence is not mistaken for a banked one', () => {
    assert.deepEqual(usageDetailLines(['Your limit resets in 3 hours']), [
      'Your limit resets in 3 hours',
    ]);
  });

  test('blanks and non-lists come back as nothing', () => {
    assert.deepEqual(usageDetailLines(['   ', '']), []);
    assert.deepEqual(usageDetailLines(null), []);
    assert.deepEqual(usageDetailLines(undefined), []);
  });
});

describe('the card renders it grey, from the count', () => {
  test('the banked row uses the rail’s dim grey, not green', () => {
    const rule = css.slice(css.indexOf('.hermes__usage-banked'));
    const block = rule.slice(0, rule.indexOf('}'));
    assert.match(block, /color:\s*var\(--rail-fg-dim\)/);
    assert.match(block, /text-align:\s*right/);
    assert.ok(!/#86efac/i.test(block), 'no green emphasis');
  });

  test('app.js draws the line from the helper, not its own sentence', () => {
    assert.ok(app.includes('bankedResetLine('), 'the wording comes from one place');
    assert.ok(app.includes('usageDetailLines('), 'the details are filtered');
    assert.ok(!app.includes('banked reset${'), 'no inline phrasing left behind');
  });
});

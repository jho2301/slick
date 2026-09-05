/**
 * Where an @mention starts, what it matches, and what the box reads once one
 * is picked.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { findMention, insertMention, mentionMatches } from '../src/features/messages/mentions.ts';

const agents = [{ id: 'claude', hint: '#deploys · 2m ago' }, { id: 'reviewer' }, { id: 'clara' }];

test('an @ at the start of a word opens a mention', () => {
  assert.deepEqual(findMention('hello @cl', 9), { start: 6, query: 'cl' });
  assert.deepEqual(findMention('@', 1), { start: 0, query: '' });
});

test('an @ inside a word or an address is not a mention', () => {
  assert.equal(findMention('mail me@example', 15), null, 'no space before it');
  assert.equal(findMention('@claude said', 12), null, 'the caret has left the token');
});

test('agents are matched on the typed prefix, at most eight', () => {
  assert.deepEqual(
    mentionMatches(agents, 'cl').map((a) => a.id),
    ['claude', 'clara']
  );
  assert.deepEqual(mentionMatches(agents, 'x'), []);
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `agent${i}` }));
  assert.equal(mentionMatches(many, 'agent').length, 8);
});

test('picking one replaces the token and puts the caret after the space', () => {
  const anchor = findMention('ask @cl about it', 7);
  assert.ok(anchor);
  assert.deepEqual(insertMention('ask @cl about it', anchor, 'claude'), {
    value: 'ask @claude  about it',
    caret: 12,
  });
});

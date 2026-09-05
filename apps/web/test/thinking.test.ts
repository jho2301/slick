/**
 * The thinking blob — specifically, the two things about it that are invisible
 * until they are wrong.
 *
 * The first is that a step never moves. Every step passes through pending,
 * in_progress and complete in the few seconds its box is on screen, and each
 * of those transitions arrives as its own chunk. If a chunk about a step the
 * box already has appends instead of updating, the list grows a duplicate of
 * every step; if it updates but re-sorts, the line the user is reading slides
 * out from under them. Neither shows up in a screenshot.
 *
 * The second is that a finished transcript holds no live spinner. A stream
 * ends by stopping, so whatever the last chunk said about a running step is
 * what the message keeps forever unless something lands it.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { test } from 'vitest';

// The other half of the invariant at the bottom of this file: core's own fold,
// reached through the one entry point that opens no database.
import { mergeThinking } from '@slick/core/thinking';
import type { ThinkingTrace } from '@slick/core';

import {
  applyChunk,
  emptyThink,
  readThinking,
  settle,
  stepStatusLabel,
  THINK_KEY,
} from '../src/features/thinking/thinking.ts';

/** A real `hermes` reply, minus everything this module does not look at. */
function reply(metadata: Record<string, unknown> | null) {
  return { id: 'msg_test', author: { id: 'hermes', kind: 'agent' }, createdAt: 1787457959755, metadata };
}

test('a message with nothing to show has no box', () => {
  strictEqual(readThinking(reply(null)), null, 'no metadata at all');
  strictEqual(readThinking(reply({})), null, 'metadata, but no blob');
  strictEqual(readThinking(reply({ _model: 'gpt-5.6-luna' })), null, 'a stamp is not a blob');
  strictEqual(readThinking(undefined), null, 'not even a message');
});

test('junk where the blob should be is nothing, not an empty box', () => {
  // An agent that posted `{}` should leave no trace in the transcript, and
  // neither should one that posted a string, a number, or a bare phase.
  strictEqual(readThinking(reply({ [THINK_KEY]: 'thinking…' })), null);
  strictEqual(readThinking(reply({ [THINK_KEY]: 12 })), null);
  strictEqual(readThinking(reply({ [THINK_KEY]: [] })), null);
  strictEqual(readThinking(reply({ [THINK_KEY]: {} })), null);
  strictEqual(readThinking(reply({ [THINK_KEY]: { p: 'done' } })), null, 'a phase with nothing under it');
  strictEqual(readThinking(reply({ [THINK_KEY]: { s: 'nope' } })), null, 'steps that are not steps');
});

test('the short wire keys never leave this module', () => {
  const think = readThinking(
    reply({
      [THINK_KEY]: {
        t: 'Adding the final pieces…',
        p: 'streaming',
        s: [
          {
            id: 't1',
            t: 'Searching the web…',
            st: 'complete',
            d: ['query: slick', '3 hits'],
            o: 'Found the changelog',
            src: [{ u: 'https://example.test/', t: 'example' }],
          },
        ],
      },
    })
  );

  deepStrictEqual(think, {
    title: 'Adding the final pieces…',
    phase: 'streaming',
    steps: [
      {
        id: 't1',
        title: 'Searching the web…',
        status: 'complete',
        details: ['query: slick', '3 hits'],
        output: 'Found the changelog',
        sources: [{ url: 'https://example.test/', title: 'example' }],
      },
    ],
  });
});

test('a title on its own is enough to be worth drawing', () => {
  const think = readThinking(reply({ [THINK_KEY]: { t: 'Thinking…' } }));
  deepStrictEqual(think, { title: 'Thinking…', phase: 'streaming', steps: [] });
});

test('a step with no id of its own is still addressable', () => {
  const think = readThinking(reply({ [THINK_KEY]: { s: [{ t: 'Reading the repo…' }, { t: 'Writing…' }] } }));
  deepStrictEqual(
    think!.steps.map((step) => step.id),
    ['s0', 's1']
  );
  // …and addressable means a later chunk about it lands on it.
  applyChunk(think, { s: [{ id: 's1', st: 'complete' }] });
  strictEqual(think!.steps.length, 2);
  strictEqual(think!.steps[1]!.status, 'complete');
});

test('a chunk about a step the box already has updates it and adds no row', () => {
  const think = emptyThink();
  applyChunk(think, { s: [{ id: 't1', t: 'Searching the web…', st: 'pending' }] });
  applyChunk(think, { s: [{ id: 't1', st: 'in_progress' }] });
  applyChunk(think, { s: [{ id: 't1', t: 'Searched the web', st: 'complete', o: 'Found the changelog' }] });

  strictEqual(think.steps.length, 1, 'three chunks, one step');
  deepStrictEqual(think.steps[0], {
    id: 't1',
    title: 'Searched the web',
    status: 'complete',
    details: [],
    output: 'Found the changelog',
    sources: [],
  });
});

test('a status-only chunk does not blank what is already on screen', () => {
  const think = emptyThink();
  applyChunk(think, { s: [{ id: 't1', t: 'Searching the web…', d: ['query: slick'] }] });
  applyChunk(think, { s: [{ id: 't1', st: 'in_progress' }] });

  strictEqual(think.steps[0]!.title, 'Searching the web…');
  deepStrictEqual(think.steps[0]!.details, ['query: slick']);
});

test('a step never moves', () => {
  // The live repro: three steps announced, the first one finishing last. A
  // sorted list would put it at the bottom, under two steps the user watched
  // it start above.
  const think = emptyThink();
  applyChunk(think, {
    s: [
      { id: 'a', t: 'Searching the web…', st: 'in_progress' },
      { id: 'b', t: 'Reading the repo…', st: 'pending' },
    ],
  });
  applyChunk(think, {
    s: [
      { id: 'b', st: 'complete' },
      { id: 'c', t: 'Writing…', st: 'in_progress' },
    ],
  });
  applyChunk(think, { s: [{ id: 'a', st: 'complete' }] });

  deepStrictEqual(
    think.steps.map((step) => step.id),
    ['a', 'b', 'c'],
    'announced order, whatever order they finish in'
  );
  deepStrictEqual(
    think.steps.map((step) => step.status),
    ['complete', 'complete', 'in_progress']
  );
});

test('a chunk can carry the title and the phase alone', () => {
  const think = applyChunk(emptyThink(), { t: 'Adding the final pieces…' });
  strictEqual(think.title, 'Adding the final pieces…');
  strictEqual(think.phase, 'streaming', 'a chunk that said nothing about the phase changed nothing');
  applyChunk(think, { p: 'done' });
  strictEqual(think.phase, 'done');
  strictEqual(think.title, 'Adding the final pieces…', 'and said nothing about the title either');
});

test('a phase or a status nobody knows lands somewhere harmless', () => {
  const think = applyChunk(emptyThink(), { p: 'wat', s: [{ id: 't1', t: 'Hmm…', st: 'thonking' }] });
  strictEqual(think.phase, 'streaming');
  strictEqual(think.steps[0]!.status, 'pending', 'the one state that claims nothing');
});

test('junk handed to applyChunk leaves the blob alone', () => {
  const think = applyChunk(emptyThink(), { t: 'Thinking…' });
  strictEqual(applyChunk(think, null), think);
  strictEqual(applyChunk(think, 'nope'), think);
  strictEqual(applyChunk(think, []), think);
  deepStrictEqual(think, { title: 'Thinking…', phase: 'streaming', steps: [] });
});

test('settling a finished turn leaves no spinner behind', () => {
  const think = emptyThink();
  applyChunk(think, {
    s: [
      { id: 'a', t: 'Searched the web', st: 'complete' },
      { id: 'b', t: 'Reading the repo…', st: 'in_progress' },
      { id: 'c', t: 'Writing…', st: 'pending' },
    ],
  });

  settle(think, 'done');
  strictEqual(think.phase, 'done');
  deepStrictEqual(
    think.steps.map((step) => step.status),
    ['complete', 'complete', 'complete']
  );
});

test('a turn that failed does not quietly complete its outstanding steps', () => {
  const think = emptyThink();
  applyChunk(think, {
    s: [
      { id: 'a', t: 'Searched the web', st: 'complete' },
      { id: 'b', t: 'Reading the repo…', st: 'in_progress' },
      { id: 'c', t: 'Writing…', st: 'pending' },
    ],
  });

  settle(think, 'error');
  strictEqual(think.phase, 'error');
  deepStrictEqual(
    think.steps.map((step) => step.status),
    ['complete', 'error', 'error'],
    'a step that already landed keeps where it landed'
  );
});

test('settling mid-stream is not settling', () => {
  const think = applyChunk(emptyThink(), { s: [{ id: 'a', t: 'Reading the repo…', st: 'in_progress' }] });
  settle(think, 'streaming');
  strictEqual(think.phase, 'streaming');
  strictEqual(think.steps[0]!.status, 'in_progress');
  strictEqual(settle(null, 'done'), null, 'and nothing to settle is not an error');
});

test('every state a step can be in says so out loud', () => {
  strictEqual(stepStatusLabel({ status: 'pending' }), ', pending');
  strictEqual(stepStatusLabel({ status: 'in_progress' }), ', in progress');
  strictEqual(stepStatusLabel({ status: 'complete' }), ', done');
  strictEqual(stepStatusLabel({ status: 'error' }), ', failed');
  // The marks are aria-hidden, so a step with no readable status is a step
  // with no status at all to anyone not looking at it — but silence beats
  // announcing a state this module does not recognise.
  strictEqual(stepStatusLabel({}), '');
  strictEqual(stepStatusLabel(null), '');
});

test('a source with no url is not a link', () => {
  const think = readThinking(
    reply({
      [THINK_KEY]: { s: [{ id: 't1', t: 'Searched', src: [{ t: 'nowhere' }, { u: 'https://x.test/' }] }] },
    })
  );
  deepStrictEqual(think!.steps[0]!.sources, [{ url: 'https://x.test/', title: 'https://x.test/' }]);
});

/**
 * Core's blob in the browser's vocabulary.
 *
 * The two modules hold the same transcript in two shapes: the server writes
 * the short wire keys down, the browser expands them and fills in the fields a
 * patch never mentioned. Core leaves those out — an absent `t` on a step is
 * how "the patch said nothing about the title" survives a merge — so putting
 * the defaults back is all it takes to compare them.
 */
function expand(blob: ThinkingTrace | null) {
  if (!blob) return emptyThink();
  return {
    title: blob.t ?? '',
    phase: blob.p,
    steps: (blob.s ?? []).map((step) => ({
      id: step.id,
      title: step.t ?? '',
      status: step.st,
      details: step.d ?? [],
      output: step.o ?? '',
      sources: (step.src ?? []).map((source) => ({ url: source.u, title: source.t || source.u })),
    })),
  };
}

/** The same patches, in the same order, through both folds. */
function agree(patches: unknown[], note: string) {
  let core: ThinkingTrace | null = null;
  const web = emptyThink();
  for (const patch of patches) {
    core = mergeThinking(core, patch);
    applyChunk(web, patch);
  }
  deepStrictEqual(web, expand(core), note);
  return web;
}

/**
 * The one thing about this module nothing else can check on its own.
 *
 * `applyChunk` and core's `mergeThinking` are folding the same patches into
 * the same transcript from opposite ends of the wire — the browser assembling
 * an answer as it streams, the server writing down what the answer turned out
 * to be. When the message finally lands, the box on screen is thrown away and
 * redrawn from the stored blob. If the two folds disagree by so much as a step
 * order, that redraw is a visible flinch at the exact moment the reader is
 * looking at it, and neither module's own tests can see it happening.
 *
 * So these are the sequences core is tested with, run through this side.
 */
test('the browser and the server fold the same patches the same way', () => {
  // A step through its whole life: announced, running, finished with output.
  const one = agree(
    [
      { t: 'Working…', s: [{ id: 't1', t: 'Searching the web…', st: 'pending' }] },
      { s: [{ id: 't1', st: 'in_progress' }] },
      { s: [{ id: 't1', st: 'complete', o: 'Found the changelog', d: ['3 hits'] }] },
    ],
    'a repeated id updates in place on both sides'
  );
  strictEqual(one.steps.length, 1, 'three patches, one step');
  strictEqual(one.title, 'Working…', 'and the title neither patch mentioned still stands');

  // Three steps, the first one finishing last: the order they were announced
  // in is the order both sides keep.
  const many = agree(
    [
      { s: [{ id: 'a', st: 'pending' }] },
      { s: [{ id: 'b', st: 'pending' }] },
      { s: [{ id: 'c', st: 'pending' }] },
      { s: [{ id: 'b', st: 'in_progress' }] },
      { s: [{ id: 'c', st: 'complete' }] },
      { s: [{ id: 'a', st: 'complete' }] },
    ],
    'insertion order survives pending -> in_progress -> complete on both sides'
  );
  deepStrictEqual(
    many.steps.map((step) => step.id),
    ['a', 'b', 'c']
  );

  // A new id appends, and two mentions of one step inside a single patch
  // collapse into that step rather than into two rows.
  const dupes = agree(
    [
      { s: [{ id: 'a', st: 'complete' }] },
      {
        s: [
          { id: 'b', t: 'B' },
          { id: 'b', st: 'complete' },
          { id: 'c', t: 'C' },
        ],
      },
    ],
    'a new id appends and duplicates inside one patch collapse on both sides'
  );
  deepStrictEqual(
    dupes.steps.map((step) => step.id),
    ['a', 'b', 'c']
  );

  // Title and phase overwrite when the patch carries them, and only then.
  agree(
    [
      { t: 'Working…', p: 'streaming', s: [{ id: 'a', st: 'pending' }] },
      { s: [{ id: 'a', st: 'complete' }] },
      { t: 'Almost there…' },
      { p: 'nonsense' },
      { p: 'done' },
    ],
    'title and phase move together on both sides'
  );

  // A step with sources, which is the one field whose shape differs on the
  // wire — `{u, t}` there, `{url, title}` here.
  const sourced = agree(
    [
      {
        s: [
          {
            id: 't2',
            t: 'Compared the two images',
            st: 'complete',
            src: [{ u: 'https://example.test/91', t: 'build 91' }],
          },
        ],
      },
    ],
    'sources survive the crossing'
  );
  deepStrictEqual(sourced.steps[0]!.sources, [{ url: 'https://example.test/91', title: 'build 91' }]);
});

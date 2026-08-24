/**
 * The thinking blob: the caps that keep a scratchpad from becoming a payload
 * problem, and the merge rule that keeps a step from becoming two.
 *
 * Almost all of this is pure — that is the point of `thinking.js` having no
 * database in it. Only the last block opens a workspace, because "a message
 * with no `_think` is byte-for-byte what it was yesterday" is a claim about
 * what `messages.post` writes down, and nothing smaller can check it.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { THINK_KEY, normalizeThinking, mergeThinking } from '../src/index.js';
import { Workspace } from '../src/workspace.js';

const stepIds = (think) => think.s.map((s) => s.id);
const bytes = (think) => Buffer.byteLength(JSON.stringify(think), 'utf8');

describe('normalizeThinking clamps', () => {
  test('a chatty agent loses its tail, not its reply', () => {
    const think = normalizeThinking({
      t: 'T'.repeat(500),
      p: 'streaming',
      s: Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, t: 'x'.repeat(400), st: 'complete' })),
    });
    assert.equal(think.t.length, 200);
    assert.equal(think.s.length, 50);
    assert.equal(think.s[0].t.length, 200);
    // Dropped from the tail, so the trace still reads from the start.
    assert.equal(think.s[0].id, 't0');
    assert.equal(think.s.at(-1).id, 't49');
  });

  test('details, output and sources are capped per step', () => {
    const think = normalizeThinking({
      s: [
        {
          id: 'a',
          t: 'Searching the web…',
          st: 'in_progress',
          d: Array.from({ length: 14 }, (_, i) => `bullet ${i} ${'d'.repeat(900)}`),
          o: 'o'.repeat(4000),
          src: Array.from({ length: 15 }, (_, i) => ({
            u: `https://example.test/${i}/${'u'.repeat(900)}`,
            t: 'S'.repeat(400),
          })),
        },
      ],
    });
    const [step] = think.s;
    assert.equal(step.d.length, 10);
    assert.ok(step.d.every((line) => line.length <= 500));
    assert.equal(step.o.length, 2000);
    assert.equal(step.src.length, 10);
    assert.ok(step.src.every((s) => s.u.length <= 500 && s.t.length <= 120));
    // The head of each list survives; it is the tail that goes.
    assert.ok(step.d[0].startsWith('bullet 0'));
    assert.ok(step.src[0].u.startsWith('https://example.test/0/'));
  });

  test('nothing in here throws, whatever it is handed', () => {
    for (const junk of [null, undefined, 0, 'thinking', [], () => {}, Symbol.iterator]) {
      assert.doesNotThrow(() => normalizeThinking(junk));
    }
    // A step list full of nonsense is nonsense, not an exception.
    assert.doesNotThrow(() => normalizeThinking({ t: 'ok', s: [null, 3, 'x', [], { d: 5, src: 7 }] }));
  });

  test('the whole blob fits in 16 KB, by dropping steps from the tail', () => {
    const think = normalizeThinking({
      t: 'Working…',
      s: Array.from({ length: 50 }, (_, i) => ({
        id: `t${i}`,
        t: `step ${i}`,
        st: 'complete',
        d: Array.from({ length: 10 }, () => 'd'.repeat(500)),
      })),
    });
    assert.ok(bytes(think) <= 16 * 1024, `blob was ${bytes(think)} bytes`);
    assert.ok(think.s.length > 0 && think.s.length < 50, 'some steps kept, some dropped');
    assert.equal(think.s[0].id, 't0');
    assert.equal(think.t, 'Working…');
  });
});

describe('normalizeThinking rejects and repairs', () => {
  test('junk shapes are null, not a half-built blob', () => {
    assert.equal(normalizeThinking(null), null);
    assert.equal(normalizeThinking(undefined), null);
    assert.equal(normalizeThinking('streaming'), null);
    assert.equal(normalizeThinking(42), null);
    assert.equal(normalizeThinking([{ id: 't1' }]), null);
    assert.equal(normalizeThinking({}), null);
    assert.equal(normalizeThinking({ p: 'done' }), null, 'a phase alone says nothing');
    assert.equal(normalizeThinking({ t: '   ', s: 'not a list' }), null);
    assert.equal(normalizeThinking({ s: [null, 'x', 7] }), null, 'no usable step, no title');
  });

  test('a title with no steps is still worth keeping', () => {
    assert.deepEqual(normalizeThinking({ t: 'Adding the final pieces…' }), {
      t: 'Adding the final pieces…',
      p: 'streaming',
      s: [],
    });
  });

  test('missing ids come from the index, unknown enums fall back', () => {
    const think = normalizeThinking({
      p: 'pondering',
      s: [{ t: 'first' }, { t: 'second', st: 'thinking-really-hard' }, { id: 'kept', st: 'error' }],
    });
    assert.equal(think.p, 'streaming');
    assert.deepEqual(stepIds(think), ['s0', 's1', 'kept']);
    assert.equal(think.s[0].st, 'pending');
    assert.equal(think.s[1].st, 'pending');
    assert.equal(think.s[2].st, 'error');
  });

  test('normalizing an already normalized blob changes nothing', () => {
    const once = normalizeThinking({ t: 'Hi', p: 'done', s: [{ id: 'a', t: 'A', st: 'complete' }] });
    assert.deepEqual(normalizeThinking(once), once);
    assert.equal(JSON.stringify(normalizeThinking(once)), JSON.stringify(once));
  });
});

describe('mergeThinking upserts by id', () => {
  test('a repeated id updates in place and does NOT append a second row', () => {
    let think = mergeThinking(null, {
      t: 'Working…',
      s: [{ id: 't1', t: 'Searching the web…', st: 'pending' }],
    });
    assert.deepEqual(stepIds(think), ['t1']);

    think = mergeThinking(think, { s: [{ id: 't1', st: 'in_progress' }] });
    assert.equal(think.s.length, 1, 'still one step');
    assert.equal(think.s[0].st, 'in_progress');
    // The status-only patch said nothing about the title, so the title stands.
    assert.equal(think.s[0].t, 'Searching the web…');

    think = mergeThinking(think, {
      s: [{ id: 't1', st: 'complete', o: 'Found the changelog', d: ['3 hits'] }],
    });
    assert.equal(think.s.length, 1);
    assert.deepEqual(think.s[0], {
      id: 't1',
      t: 'Searching the web…',
      st: 'complete',
      d: ['3 hits'],
      o: 'Found the changelog',
    });
  });

  test('insertion order survives pending -> in_progress -> complete', () => {
    let think = mergeThinking(null, { s: [{ id: 'a', st: 'pending' }] });
    think = mergeThinking(think, { s: [{ id: 'b', st: 'pending' }] });
    think = mergeThinking(think, { s: [{ id: 'c', st: 'pending' }] });
    // 'a' finishes last; it must not move to the end because of it.
    think = mergeThinking(think, { s: [{ id: 'b', st: 'in_progress' }] });
    think = mergeThinking(think, { s: [{ id: 'c', st: 'complete' }] });
    think = mergeThinking(think, { s: [{ id: 'a', st: 'complete' }] });
    assert.deepEqual(stepIds(think), ['a', 'b', 'c']);
    assert.deepEqual(
      think.s.map((s) => s.st),
      ['complete', 'in_progress', 'complete']
    );
  });

  test('a new id appends, and duplicates inside one patch collapse', () => {
    const think = mergeThinking(
      { s: [{ id: 'a', st: 'complete' }] },
      { s: [{ id: 'b', t: 'B' }, { id: 'b', st: 'complete' }, { id: 'c', t: 'C' }] }
    );
    assert.deepEqual(stepIds(think), ['a', 'b', 'c']);
    assert.equal(think.s[1].t, 'B');
    assert.equal(think.s[1].st, 'complete');
  });

  test('title and phase overwrite when the patch has them, and only then', () => {
    const base = normalizeThinking({ t: 'Working…', p: 'streaming', s: [{ id: 'a' }] });
    assert.equal(mergeThinking(base, { s: [{ id: 'a', st: 'complete' }] }).t, 'Working…');
    assert.equal(mergeThinking(base, { s: [{ id: 'a', st: 'complete' }] }).p, 'streaming');
    assert.equal(mergeThinking(base, { t: 'Almost there…' }).t, 'Almost there…');
    assert.equal(mergeThinking(base, { p: 'done' }).p, 'done');
    assert.equal(mergeThinking(base, { p: 'nonsense' }).p, 'streaming', 'junk never overwrites');
  });

  test('an empty or junk patch leaves the base alone; an empty base takes the patch', () => {
    const base = normalizeThinking({ t: 'Working…', s: [{ id: 'a', st: 'complete' }] });
    assert.deepEqual(mergeThinking(base, {}), base);
    assert.deepEqual(mergeThinking(base, null), base);
    assert.deepEqual(mergeThinking(base, 'nope'), base);
    assert.deepEqual(mergeThinking(null, { s: [{ id: 'a', st: 'complete' }] }), {
      p: 'streaming',
      s: [{ id: 'a', st: 'complete' }],
    });
    assert.equal(mergeThinking(null, {}), null);
    assert.equal(mergeThinking('junk', 'junk'), null);
  });

  test('the caps hold across a merge, not just a normalize', () => {
    let think = null;
    for (let i = 0; i < 80; i++) {
      think = mergeThinking(think, { s: [{ id: `t${i}`, t: `step ${i}`, st: 'complete' }] });
    }
    assert.equal(think.s.length, 50);
    assert.equal(think.s[0].id, 't0');
    assert.ok(bytes(think) <= 16 * 1024);
  });
});

describe('a blob on a message', () => {
  /** @type {string} */
  let home;
  /** @type {Workspace} */
  let ws;

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'slick-think-'));
    ws = Workspace.open({ file: join(home, 'w.db'), home });
  });

  after(() => {
    ws?.close();
    rmSync(home, { recursive: true, force: true });
  });

  test('round-trips through post/get with the blob intact', () => {
    const think = {
      t: 'Adding the final pieces…',
      p: 'done',
      s: [
        {
          id: 't1',
          t: 'Searched the web',
          st: 'complete',
          d: ['query: slick', '3 hits'],
          o: 'Found the changelog',
          src: [{ u: 'https://example.test/changelog', t: 'changelog' }],
        },
      ],
    };
    const posted = ws.messages.post({
      channel: 'general',
      text: 'here is the answer',
      metadata: { _model: 'opus', [THINK_KEY]: think },
    });
    const fetched = ws.messages.get(posted.id);
    assert.deepEqual(fetched.metadata[THINK_KEY], think);
    assert.equal(fetched.metadata._model, 'opus', 'every other key is untouched');
  });

  test('a junk blob costs the scratchpad, never the message', () => {
    const posted = ws.messages.post({
      channel: 'general',
      text: 'still posts',
      metadata: { _model: 'opus', [THINK_KEY]: 'not a blob' },
    });
    assert.equal(posted.text, 'still posts');
    assert.deepEqual(posted.metadata, { _model: 'opus' });
  });

  test('an oversized blob is clamped on the way in', () => {
    const posted = ws.messages.post({
      channel: 'general',
      text: 'chatty',
      metadata: {
        [THINK_KEY]: {
          t: 'Working…',
          s: Array.from({ length: 200 }, (_, i) => ({
            id: `t${i}`,
            t: `step ${i}`,
            d: Array.from({ length: 10 }, () => 'd'.repeat(500)),
          })),
        },
      },
    });
    const stored = ws.messages.get(posted.id).metadata[THINK_KEY];
    assert.ok(stored.s.length < 200);
    assert.ok(bytes(stored) <= 16 * 1024);
  });

  test('a message posted WITHOUT _think is unchanged in every way', () => {
    const metadata = { _model: 'opus', _effort: 'high', nested: { a: [1, 2, 3] } };
    const posted = ws.messages.post({ channel: 'general', text: 'no scratchpad', metadata });
    const fetched = ws.messages.get(posted.id);
    // Same keys, same values, same order — this is the byte-for-byte claim.
    assert.equal(JSON.stringify(fetched.metadata), JSON.stringify(metadata));
    assert.ok(!(THINK_KEY in fetched.metadata), 'no key invented');

    // And the shapes that were always allowed still are.
    const bare = ws.messages.post({ channel: 'general', text: 'nothing at all' });
    assert.equal(ws.messages.get(bare.id).metadata, null);
    const nulled = ws.messages.post({ channel: 'general', text: 'explicit null', metadata: null });
    assert.equal(ws.messages.get(nulled.id).metadata, null);
  });

  test('update() normalizes the blob it merges, and only the blob', () => {
    const posted = ws.messages.post({
      channel: 'general',
      text: 'streaming answer',
      metadata: { _model: 'opus', [THINK_KEY]: { p: 'streaming', s: [{ id: 't1', t: 'Searching…' }] } },
    });
    const updated = ws.messages.update(posted.id, {
      metadata: {
        _effort: 'high',
        [THINK_KEY]: { p: 'done', s: [{ id: 't1', t: 'Searched', st: 'complete' }] },
      },
    });
    assert.deepEqual(updated.metadata, {
      _model: 'opus',
      _effort: 'high',
      [THINK_KEY]: { p: 'done', s: [{ id: 't1', t: 'Searched', st: 'complete' }] },
    });

    // A patch that never mentions `_think` leaves what is there alone.
    const again = ws.messages.update(posted.id, { metadata: { _model: 'sonnet' } });
    assert.deepEqual(again.metadata[THINK_KEY], updated.metadata[THINK_KEY]);
    assert.equal(again.metadata._model, 'sonnet');
  });
});

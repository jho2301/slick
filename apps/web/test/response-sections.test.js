/**
 * Cutting a reply into its boxes.
 *
 * The invariant that matters most is the negative one: an agent that has never
 * heard of these labels must get its text back byte for byte. Everything else
 * here — four fields, an empty section drawing nothing, a list surviving the
 * cut intact — is downstream of that, because the parser is only safe to run
 * on every message in the transcript if it is a no-op on almost all of them.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseSections, readSections, SECTION_CARDS } from '../js/response-sections.js';

describe('parseSections', () => {
  test('text with no recognized label comes back unchanged', () => {
    const raw = '# Deploy notes\n\nRan the migration.\n\n## Rollback\n\n- flip the flag\n';
    const cut = parseSections(raw);
    assert.equal(cut.answer, raw, 'not a byte moved');
    assert.deepEqual(
      { reasoning: cut.reasoning, process: cut.process, assumptions: cut.assumptions },
      { reasoning: '', process: '', assumptions: '' }
    );
  });

  test('a bolded word mid-sentence is not a label', () => {
    const raw = 'The **process** matters here.';
    assert.equal(parseSections(raw).answer, raw);
    assert.equal(parseSections(raw).process, '');
  });

  test('a labelled reply fills all four fields', () => {
    const cut = parseSections(
      [
        '## Answer',
        '',
        'Yes — the cache was cold.',
        '',
        '## Reasoning summary',
        '',
        'Latency tracked cache misses exactly.',
        '',
        '## Process',
        '',
        '- read the traces',
        '- diffed the two deploys',
        '',
        '## Assumptions',
        '',
        'The traces are complete.',
      ].join('\n')
    );
    assert.deepEqual(cut, {
      answer: 'Yes — the cache was cold.',
      reasoning: 'Latency tracked cache misses exactly.',
      process: '- read the traces\n- diffed the two deploys',
      assumptions: 'The traces are complete.',
    });
  });

  test('the labels are case- and whitespace-insensitive, and take either form', () => {
    const cut = parseSections('  ###   aNSWER :  \nhi\n**Reasoning**\nbecause\nPROCESS:\n1. looked');
    assert.equal(cut.answer, 'hi');
    assert.equal(cut.reasoning, 'because');
    assert.equal(cut.process, '1. looked');
  });

  test('prose before the first label stays in the answer', () => {
    const cut = parseSections('Shipped it.\n\n## Process\n\n- pushed\n');
    assert.equal(cut.answer, 'Shipped it.');
    assert.equal(cut.process, '- pushed');
  });

  test('a label with nothing under it is empty, not whitespace', () => {
    const cut = parseSections('## Answer\nDone.\n## Assumptions\n\n   \n## Process\n- ran it');
    assert.equal(cut.assumptions, '', 'an empty section draws no card');
    assert.equal(cut.process, '- ran it');
    assert.equal(cut.reasoning, '', 'a label that never appeared draws no card');
  });

  test('a process list keeps its markers, nesting and blank lines', () => {
    const list = '1. read the log\n   - the first half\n   - the second\n\n2. rewrote the query';
    assert.equal(parseSections(`## Process\n\n${list}\n`).process, list);
  });

  test('nothing to parse is four empty fields', () => {
    assert.deepEqual(parseSections(''), { answer: '', reasoning: '', process: '', assumptions: '' });
    assert.deepEqual(parseSections(undefined).answer, '');
  });
});

describe('readSections', () => {
  test('a message with no metadata is just its parsed text', () => {
    assert.deepEqual(readSections({ text: 'plain' }), {
      answer: 'plain',
      reasoning: '',
      process: '',
      assumptions: '',
    });
  });

  test('a declared _response wins over the text, field by field', () => {
    const cut = readSections({
      text: 'Yes.\n## Process\n- looked',
      metadata: { _response: { reasoning: 'the log said so', process: '   ' } },
    });
    assert.equal(cut.answer, 'Yes.');
    assert.equal(cut.reasoning, 'the log said so');
    assert.equal(cut.process, '- looked', 'a blank declared field falls back to the text');
  });

  test('junk where the blob should be is ignored', () => {
    assert.equal(readSections({ text: 'hi', metadata: { _response: 'nope' } }).answer, 'hi');
  });
});

test('every card the UI draws is a field the parser produces', () => {
  const fields = Object.keys(parseSections(''));
  for (const card of SECTION_CARDS) assert.ok(fields.includes(card.key), card.key);
  assert.ok(!SECTION_CARDS.some((card) => card.key === 'answer'), 'the answer is never collapsible');
});

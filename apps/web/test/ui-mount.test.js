/**
 * Appending children to a node that already exists.
 *
 * `el` has always dropped absent children, but a node built earlier and filled
 * in later was being handed `panel.append(cond ? node : null)` — and the DOM's
 * own `append` stringifies, so "no note" was drawn in the rail as the word
 * `null`. `mount` is `el`'s child rules for that case; these tests are the
 * observed bug written down.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The two globals the child rules touch. Set before anything calls them.
class FakeElement {}
globalThis.Node = FakeElement;
globalThis.document = { createTextNode: (text) => ({ text: String(text) }) };

const { mount } = await import('../js/ui.js');

/** A stand-in for a DOM node, recording exactly what got put in it. */
function host() {
  const kids = [];
  return { kids, append: (...children) => kids.push(...children) };
}

const texts = (node) => node.kids.filter((kid) => !(kid instanceof FakeElement)).map((kid) => kid.text);

describe('mount', () => {
  test('an absent child is not drawn as the text "null"', () => {
    const panel = host();
    const acts = new FakeElement();
    const scope = new FakeElement();
    const note = null; // the hermes panel with nothing to say

    mount(panel, acts, scope, note);

    assert.deepEqual(panel.kids, [acts, scope]);
    assert.deepEqual(texts(panel), [], 'nothing was stringified into the rail');
  });

  test('undefined and false are absent too, but 0 and "" are content', () => {
    const panel = host();
    mount(panel, undefined, false, 0, '');
    assert.deepEqual(texts(panel), ['0', '']);
  });

  test('arrays are flattened and their gaps dropped', () => {
    const panel = host();
    const one = new FakeElement();
    const two = new FakeElement();
    mount(panel, [one, null, [two, undefined]]);
    assert.deepEqual(panel.kids, [one, two]);
  });

  test('strings become text nodes and elements are passed through as they are', () => {
    const panel = host();
    const kid = new FakeElement();
    mount(panel, 'Saved to the work profile.', kid);
    assert.deepEqual(texts(panel), ['Saved to the work profile.']);
    assert.equal(panel.kids[1], kid);
  });

  test('the node is handed back, so it can be built and returned in one breath', () => {
    const panel = host();
    assert.equal(mount(panel), panel);
  });
});

describe('the hermes panel builds through it', () => {
  // The regression is one raw `panel.append(h.note ? … : null)`; keeping the
  // panel on `mount` is what stops it coming back.
  test('renderHermesPanel never appends to the panel directly', () => {
    const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
    const start = source.indexOf('function renderHermesPanel()');
    assert.ok(start > 0, 'the panel renderer is still in app.js');
    const body = source.slice(start, source.indexOf('\n}\n', start));
    assert.equal(body.includes('panel.append('), false, 'panel children go through mount, which drops the absent ones');
    assert.ok(body.includes('mount(panel'), 'and the panel is filled with mount');
  });
});

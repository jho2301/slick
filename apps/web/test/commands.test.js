import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createCommandMenu } from '../js/commands.js';

class FakeNode {
  constructor(tagName = 'node', text = '') {
    this.tagName = tagName;
    this.nodeType = tagName === '#text' ? 3 : 1;
    this._text = String(text);
    this.childNodes = [];
    this.listeners = new Map();
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.className = '';
    this.value = '';
    this.selectionStart = 0;
    this.selectionEnd = 0;
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get children() {
    return this.childNodes.filter((child) => child.nodeType === 1);
  }

  get textContent() {
    return this.nodeType === 3 ? this._text : this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.childNodes = [];
    this._text = String(value ?? '');
  }

  append(...children) {
    for (const child of children.flat(Infinity)) {
      if (child !== null && child !== undefined && child !== false) this.childNodes.push(child);
    }
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    return child;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, properties = {}) {
    const event = {
      type,
      ...properties,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  focus() {
    this.focused = true;
  }
}

function installDom() {
  const previousDocument = globalThis.document;
  const previousNode = globalThis.Node;
  globalThis.Node = FakeNode;
  globalThis.document = {
    createElement: (tagName) => new FakeNode(tagName),
    createTextNode: (text) => new FakeNode('#text', text),
  };
  return () => {
    globalThis.document = previousDocument;
    globalThis.Node = previousNode;
  };
}

function composer() {
  return { textarea: new FakeNode('textarea'), menu: new FakeNode('ul') };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('the menu stays visible and refreshes when its async command list arrives', async () => {
  const restore = installDom();
  try {
    const { textarea, menu } = composer();
    let commands = [];
    let resolveList;
    createCommandMenu(
      textarea,
      menu,
      () => commands,
      () => new Promise((resolve) => {
        resolveList = resolve;
      })
    );

    textarea.value = '/st';
    textarea.selectionStart = textarea.value.length;
    textarea.dispatch('input');
    assert.equal(menu.hidden, false);
    assert.match(menu.textContent, /Loading commands/);

    commands = [{ name: 'status', summary: 'Show status' }];
    resolveList();
    await flush();

    assert.equal(menu.hidden, false);
    assert.match(menu.textContent, /\/status/);
    assert.match(menu.textContent, /Show status/);
  } finally {
    restore();
  }
});

test('a command marked unavailable cannot be selected', () => {
  const restore = installDom();
  try {
    const { textarea, menu } = composer();
    createCommandMenu(textarea, menu, () => [{ name: 'config', where: 'terminal' }]);

    textarea.value = '/c';
    textarea.selectionStart = textarea.value.length;
    textarea.dispatch('input');
    assert.equal(menu.children.length, 1);
    assert.match(menu.children[0].className, /is-off/);

    menu.children[0].dispatch('mousedown');
    assert.equal(textarea.value, '/c');
  } finally {
    restore();
  }
});

test('a Slick picker command remains selectable even when its Hermes scope is session-only', () => {
  const restore = installDom();
  try {
    const { textarea, menu } = composer();
    createCommandMenu(textarea, menu, () => [{ name: 'model', where: 'session', picker: 'model' }]);

    textarea.value = '/m';
    textarea.selectionStart = textarea.value.length;
    textarea.dispatch('input');
    assert.equal(menu.children.length, 1);
    assert.doesNotMatch(menu.children[0].className, /is-off/);
    assert.match(menu.textContent, /choose provider and model/);

    menu.children[0].dispatch('mousedown');
    assert.equal(textarea.value, '/model ');
  } finally {
    restore();
  }
});

test('the thread composer includes the same command affordances as the main composer', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="command-menu-thread"/);
  assert.match(html, /id="thread-composer-out"/);
});

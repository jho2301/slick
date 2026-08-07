/**
 * @-mention autocomplete for a composer textarea. Type `@`, get a filtered
 * list of known agents anchored above the box; arrow keys move, Enter/Tab
 * pick, Escape or losing focus closes it.
 */

import { clear, el } from './ui.js';

const TOKEN_RE = /^[a-z0-9._-]*$/i;

/** Is the caret sitting inside an `@token`? If so, where does it start. */
function findMention(value, caret) {
  const at = value.lastIndexOf('@', caret - 1);
  if (at === -1) return null;
  const before = value[at - 1];
  if (before && !/\s/.test(before)) return null;
  const query = value.slice(at + 1, caret);
  if (!TOKEN_RE.test(query)) return null;
  return { start: at, query };
}

/**
 * @param {HTMLTextAreaElement} textarea
 * @param {HTMLElement} menuEl
 * @param {() => Array<{id: string, hint?: string}>} getAgents
 */
export function createMentionMenu(textarea, menuEl, getAgents) {
  let items = [];
  let index = 0;
  let anchor = null;

  function close() {
    anchor = null;
    items = [];
    menuEl.hidden = true;
  }

  function render() {
    clear(menuEl);
    items.forEach((item, i) => {
      menuEl.append(
        el(
          'li',
          {
            class: i === index ? 'is-sel' : '',
            onmousedown: (event) => {
              event.preventDefault();
              choose(i);
            },
            onmousemove: () => {
              if (index !== i) {
                index = i;
                render();
              }
            },
          },
          el('span', { class: 'what' }, `@${item.id}`),
          item.hint ? el('span', { class: 'where' }, item.hint) : null
        )
      );
    });
    menuEl.hidden = items.length === 0;
  }

  function choose(i = index) {
    const item = items[i];
    if (!item || !anchor) return;
    const value = textarea.value;
    const insert = `@${item.id} `;
    textarea.value = value.slice(0, anchor.start) + insert + value.slice(anchor.start + 1 + anchor.query.length);
    const caret = anchor.start + insert.length;
    textarea.setSelectionRange(caret, caret);
    close();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
  }

  function sync() {
    const found = findMention(textarea.value, textarea.selectionStart);
    if (!found) return close();
    anchor = found;
    index = 0;
    items = getAgents()
      .filter((a) => a.id.toLowerCase().startsWith(found.query.toLowerCase()))
      .slice(0, 8);
    render();
  }

  /** @returns {boolean} whether the event was consumed (caller should not also act on it) */
  function handleKeydown(event) {
    if (menuEl.hidden) return false;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      index = Math.min(index + 1, items.length - 1);
      render();
      return true;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      index = Math.max(index - 1, 0);
      render();
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      choose();
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return true;
    }
    return false;
  }

  textarea.addEventListener('input', sync);
  textarea.addEventListener('click', sync);
  textarea.addEventListener('blur', () => setTimeout(close, 120));

  return { handleKeydown, close };
}

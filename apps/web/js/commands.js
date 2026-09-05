/**
 * Slash-command autocomplete for a composer textarea.
 *
 * The vocabulary is the agent's, not Slick's — the list comes from whatever
 * the session's adapter answered — so this module knows only how to filter it
 * and put a name back in the box. Type `/` at the start of a line, get the
 * agent's commands; arrow keys move, Enter or Tab picks, Escape closes.
 *
 * A command the agent says it cannot run here is still listed. Hiding it would
 * be pretending it does not exist; showing it greyed, with the reason, is the
 * honest version and doubles as the agent's command reference.
 */

import { clear, el } from './ui.js';

const NAME_RE = /^[a-z0-9._:-]*$/i;

/**
 * Is the caret inside a `/command` at the very start of the box?
 *
 * Only at the start: a slash anywhere else is a path, a fraction, or the
 * middle of a sentence, and a menu that opens over those is a menu in the way.
 */
function findCommand(value, caret) {
  if (!value.startsWith('/')) return null;
  const head = value.slice(1, caret);
  if (!NAME_RE.test(head)) return null; // past the name; the arguments are the agent's business
  return { query: head };
}

/** What running this one would do, for the line under the name. */
const NOTE = {
  run: '',
  session: 'needs a live session',
  terminal: 'terminal only',
};

/**
 * @param {HTMLTextAreaElement} textarea
 * @param {HTMLElement} menuEl
 * @param {() => Array<{name: string, summary?: string, args?: string, aliases?: string[], where?: string, picker?: string}>} getCommands
 * @param {() => void|Promise<void>} [onOpen] called the first time a `/` menu is wanted, to go and fetch the list
 */
export function createCommandMenu(textarea, menuEl, getCommands, onOpen) {
  let items = [];
  let index = 0;
  let open = false;
  let loading = false;
  let loadToken = 0;

  function close() {
    open = false;
    loading = false;
    loadToken += 1;
    items = [];
    menuEl.hidden = true;
  }

  function render() {
    clear(menuEl);
    if (loading && items.length === 0) {
      menuEl.append(el('li', { class: 'is-loading', role: 'status' }, 'Loading commands…'));
    }
    items.forEach((item, i) => {
      const interactive = item.picker === 'model';
      const unavailable = item.where && item.where !== 'run' && !interactive;
      const note = interactive ? 'choose provider and model' : NOTE[item.where ?? 'run'] ?? item.where;
      menuEl.append(
        el(
          'li',
          {
            class: `${i === index ? 'is-sel' : ''}${unavailable ? ' is-off' : ''}`,
            role: 'option',
            'aria-selected': i === index ? 'true' : 'false',
            'aria-disabled': unavailable ? 'true' : null,
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
          el('span', { class: 'what' }, `/${item.name}${item.args ? ` ${item.args}` : ''}`),
          el('span', { class: 'where' }, note || item.summary || '')
        )
      );
    });
    menuEl.hidden = !loading && items.length === 0;
  }

  function choose(i = index) {
    const item = items[i];
    const interactive = item?.picker === 'model';
    if (!item || (item.where && item.where !== 'run' && !interactive)) return;
    // Just the name and a space: what follows is the command's own arguments,
    // and the hint in the menu already said what they look like.
    const insert = `/${item.name} `;
    textarea.value = insert + textarea.value.slice(1).replace(/^[a-z0-9._:-]*/i, '').replace(/^ /, '');
    const caret = insert.length;
    textarea.setSelectionRange(caret, caret);
    close();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
  }

  function sync() {
    const found = findCommand(textarea.value, textarea.selectionStart);
    if (!found) return close();
    if (!open) {
      open = true;
      const pending = onOpen?.();
      if (pending && typeof pending.then === 'function') {
        const token = ++loadToken;
        loading = true;
        Promise.resolve(pending).then(
          () => {
            if (open && token === loadToken) {
              loading = false;
              sync();
            }
          },
          () => {
            if (open && token === loadToken) {
              loading = false;
              sync();
            }
          }
        );
      }
    }
    index = 0;
    const query = found.query.toLowerCase();
    const all = getCommands();
    const matches = (item) =>
      item.name.toLowerCase().startsWith(query) ||
      (item.aliases ?? []).some((alias) => String(alias).toLowerCase().startsWith(query));
    // Runnable ones first: the list is long, and what you can actually do
    // should not be below what you cannot.
    items = all
      .filter(matches)
      .sort((a, b) => Number((a.where ?? 'run') !== 'run') - Number((b.where ?? 'run') !== 'run'))
      .slice(0, 10);
    render();
  }

  /** @returns {boolean} whether the event was consumed */
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

  return { handleKeydown, close, refresh: () => !menuEl.hidden && sync() };
}

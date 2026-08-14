/**
 * Small DOM helpers: element building, toasts, and the modal used for every
 * create/edit/confirm flow.
 */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/**
 * el('button', {class: 'chip', onclick: fn}, 'Save')
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {...(Node|string|null|false|undefined|Array<any>)} children
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(node, child);
    else node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// ---------------------------------------------------------------- toasts ---

export function toast(text, kind = '') {
  const host = $('#toasts');
  const node = el('div', { class: `toast${kind ? ` is-${kind}` : ''}` }, text);
  host.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 260);
  }, kind === 'error' ? 4200 : 2200);
}

// ----------------------------------------------------------------- modal ---

let modalResolve = null;

function closeModal(value) {
  const dialog = $('#modal');
  if (dialog.open) dialog.close();
  const resolve = modalResolve;
  modalResolve = null;
  resolve?.(value);
}

/**
 * @param {{
 *   title: string,
 *   fields?: Array<{name: string, label?: string, value?: string, type?: string,
 *                   placeholder?: string, help?: string, required?: boolean, rows?: number,
 *                   options?: Array<{value: string, label: string}>}>,
 *   note?: string,
 *   body?: string,
 *   okLabel?: string,
 *   danger?: boolean,
 *   extra?: Array<{label: string, value: string, danger?: boolean}>,
 * }} config
 * @returns {Promise<Record<string, string>|null>}
 */
export function openModal(config) {
  const dialog = $('#modal');
  const form = $('#modal-form');
  const body = clear($('#modal-body'));
  $('#modal-title').textContent = config.title;

  const ok = $('#modal-ok');
  ok.textContent = config.okLabel ?? 'Save';
  ok.className = `btn ${config.danger ? 'btn--danger' : 'btn--primary'}`;

  if (config.body) body.append(el('p', { style: { margin: '0', color: 'var(--fg-dim)' } }, config.body));
  if (config.note) body.append(el('div', { class: 'warn-note' }, config.note));

  for (const field of config.fields ?? []) {
    const id = `field-${field.name}`;
    const input =
      field.type === 'select'
        ? el(
            'select',
            { id, name: field.name },
            (field.options ?? []).map((option) => el('option', { value: option.value }, option.label))
          )
        : field.type === 'textarea'
          ? el('textarea', { id, name: field.name, rows: field.rows ?? 3, placeholder: field.placeholder ?? '' })
          : el('input', {
              id,
              name: field.name,
              type: field.type ?? 'text',
              placeholder: field.placeholder ?? '',
              autocomplete: 'off',
            });
    input.value = field.value ?? '';
    if (field.required) input.required = true;
    body.append(
      el(
        'div',
        { class: 'field' },
        field.label ? el('label', { for: id }, field.label) : null,
        input,
        field.help ? el('div', { class: 'help', html: field.help }) : null
      )
    );
  }

  // Secondary verbs ("Delete this category") that belong to the same form but
  // are not the primary action. They resolve with `_action` set to their value.
  const extras = clear($('#modal-extra'));
  extras.hidden = !config.extra?.length;

  return new Promise((resolve) => {
    modalResolve = resolve;
    const values = () => Object.fromEntries(new FormData(form).entries());
    for (const action of config.extra ?? []) {
      extras.append(
        el(
          'button',
          {
            type: 'button',
            class: `btn ${action.danger ? 'btn--danger' : 'btn--ghost'}`,
            onclick: () => closeModal({ ...values(), _action: action.value }),
          },
          action.label
        )
      );
    }
    form.onsubmit = (event) => {
      event.preventDefault();
      closeModal(values());
    };
    dialog.showModal();
    const first = body.querySelector('input, textarea, select');
    if (first) {
      first.focus();
      first.select?.();
    } else {
      ok.focus();
    }
  });
}

export function confirmModal({ title, body, okLabel = 'Delete', danger = true, note }) {
  return openModal({ title, body, note, okLabel, danger }).then(Boolean);
}

export function initModal() {
  const dialog = $('#modal');
  $('#modal-cancel').addEventListener('click', () => closeModal(null));
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeModal(null);
  });
  dialog.addEventListener('close', () => closeModal(null));
}

// ------------------------------------------------------------- textareas ---

/** Grow a composer with its content instead of scrolling a one-line box. */
export function autosize(textarea, max = 320) {
  const resize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, max)}px`;
  };
  textarea.addEventListener('input', resize);
  requestAnimationFrame(resize);
  return resize;
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to the old trick.
    const helper = el('textarea', { style: { position: 'fixed', opacity: '0' } });
    helper.value = text;
    document.body.append(helper);
    helper.select();
    const done = document.execCommand?.('copy');
    helper.remove();
    return Boolean(done);
  }
}

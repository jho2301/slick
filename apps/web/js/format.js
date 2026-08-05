/**
 * Turning message text into safe HTML, plus the small formatting helpers the
 * UI leans on.
 *
 * Everything is escaped *before* any markup is generated, and the only tags
 * ever produced are the ones written here — message text can never inject
 * HTML.
 */

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/g;

/**
 * A deliberately small markdown: fenced and inline code, bold, italic,
 * strikethrough, blockquotes, links and @mentions. Newlines survive because
 * the container is `white-space: pre-wrap`.
 */
export function renderText(raw) {
  // \u0000-delimited placeholders, stripped from the input first so no
  // message can forge one.
  const source = String(raw ?? '').split('\u0000').join('');
  /** @type {string[]} */
  const blocks = [];

  // Pull fenced code out first so nothing inside it gets formatted.
  let text = source.replace(/```([a-z0-9+-]*)\n?([\s\S]*?)```/gi, (_, _lang, code) => {
    blocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000BLOCK${blocks.length - 1}\u0000`;
  });

  text = escapeHtml(text);

  /** @type {string[]} */
  const inline = [];
  const keep = (html) => {
    inline.push(html);
    return `\u0000INLINE${inline.length - 1}\u0000`;
  };

  text = text.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${code}</code>`));
  text = text.replace(URL_RE, (url) => {
    const trimmed = url.replace(/[.,;:!?]+$/, '');
    const tail = url.slice(trimmed.length);
    return keep(`<a href="${trimmed}" target="_blank" rel="noreferrer noopener">${trimmed}</a>`) + tail;
  });
  text = text.replace(/(^|[\s(])@([a-z0-9][a-z0-9._-]*)/gi, (_, pre, name) =>
    `${pre}${keep(`<span class="mention">@${name}</span>`)}`
  );

  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?]|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/^&gt; ?(.*)$/gm, '<blockquote>$1</blockquote>');

  text = text.replace(/\u0000INLINE(\d+)\u0000/g, (_, i) => inline[Number(i)]);
  // The container is pre-wrap, so the newlines that surrounded a fenced block
  // would otherwise show up as blank lines on top of the block’s own margin.
  text = text.replace(/\n*\u0000BLOCK(\d+)\u0000\n*/g, (_, i) => blocks[Number(i)]);
  return text;
}

/** Highlight search terms in an already-escaped snippet. */
export function highlight(text, terms) {
  let html = escapeHtml(text);
  for (const term of terms ?? []) {
    if (!term) continue;
    const safe = escapeHtml(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(safe, 'gi'), (match) => `<mark>${match}</mark>`);
  }
  return html;
}

// ------------------------------------------------------------------ time ---

const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const clock = (ts) => TIME.format(new Date(ts));
export const fullStamp = (ts) => FULL.format(new Date(ts));

export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dayLabel(ts) {
  const now = Date.now();
  if (dayKey(ts) === dayKey(now)) return 'Today';
  if (dayKey(ts) === dayKey(now - 86400000)) return 'Yesterday';
  return DAY.format(new Date(ts));
}

export function ago(ts) {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  const steps = [
    [86400000 * 365, 'y'],
    [86400000 * 30, 'mo'],
    [86400000 * 7, 'w'],
    [86400000, 'd'],
    [3600000, 'h'],
    [60000, 'm'],
  ];
  for (const [ms, label] of steps) {
    if (diff >= ms) return `${Math.floor(diff / ms)}${label} ago`;
  }
  return 'just now';
}

// --------------------------------------------------------------- avatars ---

const AVATAR_COLORS = [
  '#4f46e5', '#0ea5e9', '#059669', '#d97706', '#db2777',
  '#7c3aed', '#dc2626', '#0891b2', '#65a30d', '#9333ea',
];

export function avatarColor(seed) {
  let hash = 0;
  for (const ch of String(seed)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export function initials(name) {
  const parts = String(name ?? '?')
    .replace(/[^a-z0-9\s-]/gi, '')
    .split(/[\s-]+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

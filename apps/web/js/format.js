/**
 * Turning message text into safe HTML, plus the small formatting helpers the
 * UI leans on.
 *
 * Rendering is delegated to markdown-it (vendored as a single dependency-free
 * ESM build under ./vendor — this app has no bundler, so an npm-installed
 * copy would not be loadable). `html: false` means raw HTML in a message is
 * always escaped rather than parsed, so message text can never inject
 * arbitrary markup; the one addition on top of stock markdown-it is the
 * @mention inline rule below.
 */

import MarkdownIt from './vendor/markdown-it.esm.min.mjs';

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** @mentions aren't standard markdown, so they get their own inline rule. */
function mentionPlugin(md) {
  md.inline.ruler.after('emphasis', 'mention', (state, silent) => {
    const start = state.pos;
    if (state.src.charCodeAt(start) !== 0x40 /* @ */) return false;
    const prev = start > 0 ? state.src[start - 1] : '';
    if (prev && !/[\s(]/.test(prev)) return false;
    const match = /^@([a-z0-9][a-z0-9._-]*)/i.exec(state.src.slice(start));
    if (!match) return false;
    if (!silent) state.push('mention', '', 0).content = match[1];
    state.pos += match[0].length;
    return true;
  });
  md.renderer.rules.mention = (tokens, idx) =>
    `<span class="mention">@${md.utils.escapeHtml(tokens[idx].content)}</span>`;
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true, // one Enter in the composer should read as a line break, not a new paragraph
});
md.use(mentionPlugin);

/**
 * Markdown collapses any run of blank lines into a single paragraph break, so
 * hitting Enter four times reads exactly like hitting it twice. In a chat box
 * those extra blank lines are deliberate spacing, so keep them: every blank
 * line past the first one adds a line of top margin to the block that follows.
 * Block tokens carry `map` = [startLine, endLine), which is what makes the gap
 * recoverable after parsing.
 */
const LINE = 1.5; // em; matches the body line-height, so one gap reads as one blank line
const MAX_GAP = 10; // a wall of Enters shouldn't be able to push content off-screen
function blankLineGaps(state) {
  let prevEnd = null;
  for (const token of state.tokens) {
    if (token.level !== 0 || !token.map) continue;
    if (prevEnd !== null) {
      const extra = Math.min(token.map[0] - prevEnd - 1, MAX_GAP);
      if (extra > 0) token.attrSet('style', `margin-top:${(0.9 + extra * LINE).toFixed(2)}em`);
    }
    prevEnd = token.map[1];
  }
}
md.core.ruler.push('blank_line_gaps', blankLineGaps);

// Bare and [text](url) links both go through link_open — force them to open
// in a new tab without leaking a referrer.
const defaultLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noreferrer noopener');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

/**
 * Markdown for chat: headings, ordered/unordered lists, tables, blockquotes,
 * fenced/inline code, bold/italic/strikethrough, rules, autolinked URLs, and
 * @mentions.
 */
export function renderText(raw) {
  return md.render(String(raw ?? ''));
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

// ---------------------------------------------------------------- models ---

/** The suffixes a local weight file wears, and the only dots worth cutting. */
// Case-insensitive on purpose. macOS and Windows filesystems are, so the same
// weights legitimately arrive spelled `.gguf` or `.GGUF` depending on which
// host stamped the name, and a normaliser that is fussy about the spelling of
// a file extension has only done half its job.
const WEIGHT_FILE = /\.(?:gguf|ggml|safetensors|bin|pt|pth)$/i;

/**
 * A model name, as a name rather than as a file. Adapters already trim these
 * on the way in — that is what `reply.model`'s `pattern` is for — but a name
 * can reach the badge without having passed one, so the same weights show up
 * as both `Qwen3.8-27B-UD-IQ4_XS` and `Qwen3.8-27B-UD-IQ4_XS.gguf`.
 *
 * Only a known weight suffix goes. Hosted names are full of dots — `gpt-4.1`,
 * `claude-3.5-sonnet` — and cutting at the last one would quietly eat the
 * version. Directories are left alone too: nothing sends one, and stripping a
 * path nobody uses is a guess this can do without.
 *
 * Purely cosmetic, and deliberately kept that way: what a model is *called*
 * is not what a model *is*. Grouping and the hover both read the untrimmed
 * name, so two builds of one architecture — `llama-3-70b.gguf` beside
 * `llama-3-70b.safetensors` — stay two models everywhere it matters, and only
 * the chip gets shorter.
 */
export function trimModelName(name) {
  if (name == null) return '';
  if (typeof name !== 'string') return String(name);
  const trimmed = name.replace(WEIGHT_FILE, '');
  // A name that is nothing but a suffix keeps it — an empty badge says less,
  // and `.trim()` rather than a truthiness check because a name of one space
  // renders as a pill with nothing in it just as surely as an empty one does.
  return trimmed.trim() ? trimmed : name;
}

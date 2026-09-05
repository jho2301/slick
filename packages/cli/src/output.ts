/**
 * Terminal presentation.
 *
 * Two rules: colour only when a human is watching (TTY, no NO_COLOR), and
 * `--json` means *only* JSON on stdout so an agent can pipe it into a parser
 * without stripping anything.
 */

import type { Channel, Message } from '@slick/core';

const FORCE_COLOR = process.env.FORCE_COLOR === '1';
let colorEnabled = FORCE_COLOR || (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);

export function setColor(enabled: boolean): void {
  colorEnabled = enabled;
}

type Painter = (text: unknown) => string;

const wrap =
  (open: number, close: number): Painter =>
  (text) =>
    colorEnabled ? `[${open}m${String(text)}[${close}m` : String(text);

export const style = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  bgYellow: wrap(43, 49),
};

/** Stable per-name colour so the same author always looks the same. */
const NAME_COLORS: Painter[] = [style.cyan, style.green, style.yellow, style.magenta, style.blue, style.red];
export function nameColor(name: unknown): Painter {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return NAME_COLORS[hash % NAME_COLORS.length] ?? style.cyan;
}

export function stripAnsi(text: unknown): string {
  // eslint-disable-next-line no-control-regex -- the escape byte is what is being stripped
  return String(text).replace(/\[[0-9;]*m/g, '');
}

export function width(text: unknown): number {
  return stripAnsi(text).length;
}

export function pad(text: string, size: number): string {
  const diff = size - width(text);
  return diff > 0 ? text + ' '.repeat(diff) : text;
}

// ------------------------------------------------------------------ time ---

const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const DAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

export function clock(ts: number): string {
  return TIME_FMT.format(new Date(ts));
}

export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dayLabel(ts: number): string {
  const today = dayKey(Date.now());
  const yesterday = dayKey(Date.now() - 86_400_000);
  const key = dayKey(ts);
  if (key === today) return 'Today';
  if (key === yesterday) return 'Yesterday';
  return DAY_FMT.format(new Date(ts));
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  const units: [number, string][] = [
    [86_400_000 * 365, 'y'],
    [86_400_000 * 30, 'mo'],
    [86_400_000 * 7, 'w'],
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
    [1000, 's'],
  ];
  for (const [ms, suffix] of units) {
    if (Math.abs(diff) >= ms) return `${Math.floor(Math.abs(diff) / ms)}${suffix} ago`;
  }
  return 'just now';
}

// --------------------------------------------------------------- writing ---

export function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

export function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function ndjson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export const icon = {
  ok: style.green('✓'),
  warn: style.yellow('!'),
  err: style.red('✗'),
  bullet: style.dim('·'),
  agent: '🤖',
};

export function ok(text: string): void {
  line(`${icon.ok} ${text}`);
}

export function note(text: string): void {
  line(style.dim(text));
}

export function warn(text: string): void {
  process.stderr.write(`${icon.warn} ${text}\n`);
}

// ---------------------------------------------------------------- tables ---

export interface Column {
  key: string;
  label: string;
  align?: 'right';
}

export function table(data: Record<string, string>[], columns: Column[]): void {
  if (data.length === 0) return;
  const widths = columns.map((col) =>
    Math.max(width(col.label), ...data.map((rowData) => width(String(rowData[col.key] ?? ''))))
  );
  line(columns.map((col, i) => style.dim(pad(col.label.toUpperCase(), widths[i] ?? 0))).join('  '));
  for (const rowData of data) {
    line(
      columns
        .map((col, i) => {
          const cell = String(rowData[col.key] ?? '');
          const size = widths[i] ?? 0;
          return col.align === 'right' ? ' '.repeat(Math.max(0, size - width(cell))) + cell : pad(cell, size);
        })
        .join('  ')
        .trimEnd()
    );
  }
}

// -------------------------------------------------------------- messages ---

const TERM_WIDTH = () => Math.min(process.stdout.columns || 100, 110);

/** Soft-wrap a paragraph to the terminal, preserving intentional newlines. */
export function reflow(text: string, indent = '', maxWidth = TERM_WIDTH()): string {
  const limit = Math.max(20, maxWidth - indent.length);
  const out: string[] = [];
  for (const paragraph of String(text).split('\n')) {
    if (paragraph.length <= limit) {
      out.push(indent + paragraph);
      continue;
    }
    let current = '';
    for (const word of paragraph.split(' ')) {
      if (current && current.length + word.length + 1 > limit) {
        out.push(indent + current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) out.push(indent + current);
  }
  return out.join('\n');
}

function authorTag(message: Message): string {
  const label = message.author.label || message.author.id;
  const colored = style.bold(nameColor(label)(label));
  if (message.author.kind === 'agent') return `${colored} ${style.dim('[agent]')}`;
  if (message.author.kind === 'system') return `${style.dim(label)} ${style.dim('[system]')}`;
  return colored;
}

/** Light markdown so `**bold**` and `` `code` `` read the way they were typed. */
export function inlineMarkdown(text: string): string {
  if (!colorEnabled) return text;
  return String(text)
    .replace(/`([^`\n]+)`/g, (_, code: string) => style.cyan(code))
    .replace(/\*\*([^*\n]+)\*\*/g, (_, b: string) => style.bold(b))
    .replace(
      /(^|\s)@([a-z0-9][a-z0-9._-]*)/gi,
      (_, pre: string, name: string) => `${pre}${style.bgYellow(style.bold(`@${name}`))}`
    );
}

export interface RenderOptions {
  showId?: boolean;
  indent?: string;
  highlight?: string[];
}

export function renderMessage(message: Message, opts: RenderOptions = {}): string {
  const indent = opts.indent ?? '';
  const head = `${indent}${authorTag(message)}  ${style.dim(clock(message.createdAt))}${
    message.editedAt ? style.dim(' (edited)') : ''
  }`;
  const body = message.deleted
    ? `${indent}  ${style.dim(style.italic('(message deleted)'))}`
    : reflow(inlineMarkdown(message.text), `${indent}  `);

  const meta: string[] = [];
  if (opts.showId !== false) meta.push(style.dim(message.id));
  if (message.replyCount > 0) {
    meta.push(style.blue(`${message.replyCount} ${message.replyCount === 1 ? 'reply' : 'replies'}`));
  }
  if (message.metadata) meta.push(style.dim(`meta ${JSON.stringify(message.metadata)}`));

  const lines = [head, body];
  if (meta.length) lines.push(`${indent}  ${meta.join(style.dim(' · '))}`);
  return lines.join('\n');
}

/**
 * A channel transcript with day separators.
 */
export function renderTranscript(messages: Message[], opts: RenderOptions = {}): string {
  const out: string[] = [];
  let lastDay: string | null = null;
  for (const message of messages) {
    const key = dayKey(message.createdAt);
    if (key !== lastDay) {
      const label = dayLabel(message.createdAt);
      const rule = '─'.repeat(Math.max(4, TERM_WIDTH() - label.length - 6));
      out.push(style.dim(`── ${label} ${rule}`));
      lastDay = key;
    }
    out.push(renderMessage(message, opts));
    out.push('');
  }
  return out.join('\n').trimEnd();
}

export function channelHeading(channel: Channel): string {
  const bits = [style.bold(`#${channel.slug}`)];
  if (channel.archived) bits.push(style.yellow('(archived)'));
  if (channel.topic) bits.push(style.dim(`— ${channel.topic}`));
  return bits.join(' ');
}

/**
 * The four labels an answer is allowed to be cut along.
 *
 * Agents have started writing replies as `## Answer` / `## Reasoning summary`
 * / `## Process` / `## Assumptions`, and a transcript that renders those as
 * headings is four headings where the reader wanted one answer and three
 * boxes they can open. This module is the rule that decides where the cuts
 * are — and, just as importantly, when there are none.
 *
 * It is strict on purpose. Only these labels, alone on their own line, as a
 * heading or a bolded line, count; any other heading is part of the answer and
 * is left exactly where the agent put it. A reply with no recognized label
 * comes back byte-for-byte unchanged, so nothing that has never used these
 * labels can be reshaped by accident.
 */

export type SectionKey = 'answer' | 'reasoning' | 'process' | 'assumptions';

export type Sections = Record<SectionKey, string>;

/** Canonical field name for each label the parser answers to. */
const LABELS = new Map<string, SectionKey>([
  ['answer', 'answer'],
  ['reasoning summary', 'reasoning'],
  ['reasoning', 'reasoning'],
  ['process', 'process'],
  ['assumptions', 'assumptions'],
]);

/**
 * A whole line that is nothing but one of the labels. Either a heading
 * (`## Process`) or a bolded line (`**Process:**`), with the colon optional
 * and whitespace anywhere it can be ignored.
 */
const LABEL_LINE = /^[ \t]*(?:#{1,6}[ \t]*|\*\*[ \t]*)?([A-Za-z][A-Za-z ]*?)[ \t]*:?[ \t]*(?:\*\*)?[ \t]*$/;

const EMPTY: Sections = { answer: '', reasoning: '', process: '', assumptions: '' };

/** The label this line is, or null if it is ordinary text. */
function labelOf(line: string): SectionKey | null {
  const match = LABEL_LINE.exec(line);
  if (!match) return null;
  // Reject `**Process` — an opening bold with no close is a line mid-sentence,
  // not a label.
  const bolded = line.trimStart().startsWith('**');
  if (bolded !== line.trimEnd().endsWith('**')) return null;
  return LABELS.get((match[1] ?? '').trim().toLowerCase()) ?? null;
}

/** Trim the blank lines a cut leaves behind, keeping interior blanks. */
const tidy = (lines: string[]): string => lines.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');

/**
 * Split assistant text into `{ answer, reasoning, process, assumptions }`.
 *
 * Text before the first recognized label stays in `answer`, so a reply that
 * opens with prose and only later says `## Process` keeps its opening. With no
 * recognized label anywhere, `answer` is the input unchanged and the other
 * three are `''`.
 */
export function parseSections(raw: unknown): Sections {
  const text = typeof raw === 'string' ? raw : '';
  if (!text) return { ...EMPTY };

  const lines = text.split('\n');
  const found: Record<SectionKey, string[]> = { answer: [], reasoning: [], process: [], assumptions: [] };
  let current: SectionKey = 'answer';
  let seen = false;

  for (const line of lines) {
    const label = labelOf(line);
    if (label) {
      current = label;
      seen = true;
      continue;
    }
    found[current].push(line);
  }

  if (!seen) return { ...EMPTY, answer: text };
  return {
    answer: tidy(found.answer),
    reasoning: tidy(found.reasoning),
    process: tidy(found.process),
    assumptions: tidy(found.assumptions),
  };
}

/** A field the sender put in `metadata._response`, if it is usable text. */
const fromMeta = (value: unknown): string => (typeof value === 'string' && value.trim() ? value.trim() : '');

/**
 * The sections for one message: whatever the sender declared in
 * `metadata._response` wins, and anything it left out is parsed out of the
 * text. A sender that declares nothing is exactly `parseSections(text)`.
 */
export function readSections(message: { text?: unknown; metadata?: unknown } | null | undefined): Sections {
  const metadata = message?.metadata;
  const declared: unknown =
    metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>)._response : null;
  const parsed = parseSections(message?.text);
  if (!declared || typeof declared !== 'object') return parsed;
  const field = declared as Record<string, unknown>;
  return {
    answer: fromMeta(field.answer) || parsed.answer,
    reasoning: fromMeta(field.reasoning) || parsed.reasoning,
    process: fromMeta(field.process) || parsed.process,
    assumptions: fromMeta(field.assumptions) || parsed.assumptions,
  };
}

/** The three collapsible sections, in the order they are drawn. */
export const SECTION_CARDS: readonly { key: Exclude<SectionKey, 'answer'>; label: string }[] = [
  { key: 'reasoning', label: 'Reasoning summary' },
  { key: 'process', label: 'Process' },
  { key: 'assumptions', label: 'Assumptions' },
];

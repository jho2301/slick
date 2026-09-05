/**
 * What an agent showed of its working — the steps it took on the way to an
 * answer — read off a message and folded together as more of it arrives.
 *
 * This lives apart from the UI for grouping.ts's reason: it is the rule that
 * decides whether a message has a thinking box at all, and a rule that decides
 * whether something is drawn should be checkable without drawing it.
 *
 * It is also where the wire's short keys stop. The blob is embedded in full in
 * every hydrated frame for its message, forever, so it is written down as
 * `t`/`p`/`s`/`st`/`d`/`o`/`src` — `ThinkingTrace` in @slick/core — but a
 * renderer that reads `s[0].st` is a renderer nobody can review. The
 * abbreviations are expanded here, once, and the app only ever sees
 * `{ title, phase, steps: [{ id, title, status, details, output, sources }] }`.
 */

import type { StepStatus, ThinkingPhase } from '@slick/core';

/** Where the blob hangs off a message's metadata. Mirrors core's own key. */
export const THINK_KEY = '_think';

const PHASES: ReadonlySet<string> = new Set<ThinkingPhase>(['streaming', 'done', 'error']);
const STATUSES: ReadonlySet<string> = new Set<StepStatus>(['pending', 'in_progress', 'complete', 'error']);

const isPhase = (value: string): value is ThinkingPhase => PHASES.has(value);
const isStatus = (value: string): value is StepStatus => STATUSES.has(value);

export interface ThinkingSourceView {
  url: string;
  title: string;
}

export interface ThinkingStepView {
  id: string;
  title: string;
  status: StepStatus;
  details: string[];
  output: string;
  sources: ThinkingSourceView[];
}

/** The trace with every abbreviation expanded and every field present. */
export interface ThinkingView {
  title: string;
  phase: ThinkingPhase;
  steps: ThinkingStepView[];
}

/** One step of a patch: only the fields the patch actually mentioned. */
type StepPatch = { id: string } & Partial<Omit<ThinkingStepView, 'id'>>;

/**
 * The step's state, said out loud. Screen readers get this and nothing else:
 * the marks beside the steps are `aria-hidden`, so a spinner that never says
 * it is a spinner is a step with no state at all to anyone not looking at it.
 *
 * Leading comma because it is a suffix on the step's own title, and reads as
 * one sentence — "Searching the web…, in progress" — rather than as a second
 * unattached announcement.
 */
const STATUS_LABELS: Record<StepStatus, string> = {
  pending: ', pending',
  in_progress: ', in progress',
  complete: ', done',
  error: ', failed',
};

/** A blob with nothing in it yet — what a stream that opened with a step builds on. */
export function emptyThink(): ThinkingView {
  return { title: '', phase: 'streaming', steps: [] };
}

export function stepStatusLabel(step: { status?: string } | null | undefined): string {
  const status = step?.status;
  return status && isStatus(status) ? STATUS_LABELS[status] : '';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * The first of these that was actually written down, or null for "the patch
 * said nothing about this".
 *
 * The distinction is the whole reason this exists: a chunk carrying only
 * `{ id, st }` is how a step moves to complete, and defaulting its missing
 * title to `''` on the way through would blank the title already on screen.
 */
function firstString(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string') return candidate;
  }
  return null;
}

function readDetails(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((line): line is string => typeof line === 'string');
}

/** `src: [{u, t}]` — a link, and what to call it when the url is unreadable. */
function readSources(value: unknown): ThinkingSourceView[] | null {
  if (!Array.isArray(value)) return null;
  const sources: ThinkingSourceView[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const url = firstString(raw.u, raw.url);
    if (!url) continue;
    sources.push({ url, title: firstString(raw.t, raw.title) || url });
  }
  return sources;
}

/**
 * One step of a patch, carrying only the fields the patch actually mentioned.
 *
 * A step with no id of its own is given one from where it sat, which is the
 * same rule core uses — an unidentified step still has to be addressable, or
 * the next chunk about it appends a duplicate instead of updating it.
 */
function readStep(raw: unknown, index: number): StepPatch | null {
  if (!isRecord(raw)) return null;
  const patch: StepPatch = { id: (firstString(raw.id) ?? '').trim() || `s${index}` };

  const title = firstString(raw.t, raw.title);
  if (title !== null) patch.title = title;

  const status = firstString(raw.st, raw.status);
  // An unknown status is a producer we do not know, not a reason to drop the
  // step: it lands on `pending`, which is the one state that claims nothing.
  if (status !== null) patch.status = isStatus(status) ? status : 'pending';

  const details = readDetails(raw.d ?? raw.details);
  if (details) patch.details = details;

  const output = firstString(raw.o, raw.output);
  if (output !== null) patch.output = output;

  const sources = readSources(raw.src ?? raw.sources);
  if (sources) patch.sources = sources;

  return patch;
}

/** A step before any patch has touched it — every field present, none of them said. */
function blankStep(id: string): ThinkingStepView {
  return { id, title: '', status: 'pending', details: [], output: '', sources: [] };
}

/**
 * Fold a chunk into a blob, and hand back the blob.
 *
 * Upsert by id, and only ever in place or on the end. The temptation is to
 * keep the list tidy — finished steps up top, the running one last — and it is
 * exactly wrong: a step that moves while the user is reading it is a step they
 * lose, and every step passes through pending, in_progress and complete during
 * the few seconds the box is on screen. So the order is the order the agent
 * announced them in, and nothing reorders it.
 *
 * The blob is mutated rather than copied because this runs once per delta on
 * an answer that is deliberately not re-rendered per token; the streaming
 * store hands React a fresh snapshot on its own clock.
 */
export function applyChunk(think: ThinkingView | null | undefined, chunk: unknown): ThinkingView {
  const target = think && Array.isArray(think.steps) ? think : emptyThink();
  if (!isRecord(chunk)) return target;

  const title = firstString(chunk.t, chunk.title);
  if (title !== null) target.title = title;

  // A phase we do not recognise leaves the one we had alone, rather than
  // falling back to `streaming`. The difference only shows on a finished box,
  // and there it matters: a single malformed frame arriving after the answer
  // landed would otherwise restart a spinner that has nothing left to wait
  // for. `emptyThink` already starts at `streaming`, so a blob that never
  // names a phase at all still reads as live — which is the same answer
  // `normalizeThinking` gives it in @slick/core, and these two have to agree.
  const phase = firstString(chunk.p, chunk.phase);
  if (phase !== null && isPhase(phase)) target.phase = phase;

  const steps: unknown[] = Array.isArray(chunk.s) ? chunk.s : Array.isArray(chunk.steps) ? chunk.steps : [];
  steps.forEach((raw, index) => {
    const patch = readStep(raw, index);
    if (!patch) return;
    const existing = target.steps.find((step) => step.id === patch.id);
    if (existing) Object.assign(existing, patch);
    else target.steps.push(Object.assign(blankStep(patch.id), patch));
  });

  return target;
}

/**
 * The blob stored on a message, or null when the message has no working to
 * show — which is almost every message, so this is the cheap answer first.
 *
 * Something object-shaped that turns out to hold neither a title nor a single
 * step is treated as nothing rather than drawn as an empty box: an agent that
 * posted `{}` should leave no trace in the transcript.
 */
export function readThinking(message: { metadata?: unknown } | null | undefined): ThinkingView | null {
  const metadata = message?.metadata;
  const raw: unknown = isRecord(metadata) ? metadata[THINK_KEY] : null;
  if (!isRecord(raw)) return null;
  const think = applyChunk(emptyThink(), raw);
  return think.title || think.steps.length ? think : null;
}

/** Nothing to show is not the same as a box with nothing in it. */
export const hasThinking = (think: ThinkingView | null | undefined): think is ThinkingView =>
  Boolean(think && (think.title || think.steps.length));

/**
 * Land the blob on a final phase, taking any step still claiming to be running
 * with it.
 *
 * A stream ends by stopping, not by tidying up after itself: the last chunk is
 * whatever the agent managed to say before it answered, and a step left on
 * in_progress spins forever in a transcript that is otherwise finished. Which
 * way the stragglers land depends on how the turn ended — a run that failed
 * did not quietly complete its outstanding steps.
 */
export function settle<T extends ThinkingView | null | undefined>(think: T, phase: string): T {
  if (!think || !Array.isArray(think.steps)) return think;
  if (isPhase(phase)) think.phase = phase;
  if (phase !== 'done' && phase !== 'error') return think;

  const landing: StepStatus = phase === 'error' ? 'error' : 'complete';
  for (const step of think.steps) {
    if (step.status === 'pending' || step.status === 'in_progress') step.status = landing;
  }
  return think;
}

/**
 * The thinking blob — an agent's reasoning trace, as it is stored and sent.
 *
 * One shape lives in three places: `message.metadata._think` on a finished
 * reply, the payload of an `agent.thinking` event, and the `think` field of a
 * streamed `agent.delta` frame. The keys are short (`t`, `p`, `s`, `st`) for
 * one reason only, and it is not tidiness: the blob rides along inside every
 * hydrated copy of that message, forever.
 *
 * Which is also why this one metadata key gets validated when no other one
 * does. `messages.ts` stringifies whatever metadata it is handed — no schema,
 * no size cap — and that has been fine, because metadata has been a handful
 * of bookkeeping keys an author wrote once. A reasoning trace is the first
 * payload that is machine-generated, unbounded, and re-sent on every read: a
 * chatty model can emit hundreds of steps in a minute, the message keeps them
 * all, and every subsequent hydration of that message carries them to every
 * client. So the caps live here, and they clamp rather than throw — an agent
 * that over-shares should lose the tail of its scratchpad, never its answer.
 *
 * This module has no imports on purpose: the web app runs the same code in
 * the browser, and the two copies of a merge have to agree.
 */

import type { StepStatus, ThinkingPhase, ThinkingSource, ThinkingStep, ThinkingTrace } from './types.ts';

export const THINK_KEY = '_think';

/** Per-field caps. The table in the contract; nothing here is negotiable. */
const MAX_TITLE = 200;
const MAX_STEP_TITLE = 200;
const MAX_OUTPUT = 2000;
const MAX_STEPS = 50;
const MAX_DETAILS = 10;
const MAX_DETAIL = 500;
const MAX_SOURCES = 10;
const MAX_SOURCE_URL = 500;
const MAX_SOURCE_TITLE = 120;

/** A step id is a map key, not prose; long enough for any sane generator. */
const MAX_ID = 120;

/**
 * The whole serialized blob, measured the way SQLite and the SSE writer will
 * measure it: bytes of UTF-8, not characters.
 */
const MAX_BLOB_BYTES = 16 * 1024;

const PHASES: ReadonlySet<string> = new Set<ThinkingPhase>(['streaming', 'done', 'error']);
const STEP_STATUSES: ReadonlySet<string> = new Set<StepStatus>([
  'pending',
  'in_progress',
  'complete',
  'error',
]);

const isPhase = (value: unknown): value is ThinkingPhase => typeof value === 'string' && PHASES.has(value);
const isStepStatus = (value: unknown): value is StepStatus =>
  typeof value === 'string' && STEP_STATUSES.has(value);
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A step as a patch says it: every field optional, because "absent" has to
 * mean "the patch said nothing about this". See `step` below.
 */
type StepPatch = Partial<ThinkingStep> & { id: string };

/** UTF-8 length without a Node dependency, so the browser can share this file. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** A trimmed string, cut to `max`, or '' for anything that is not one. */
function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Bullets: the first `count` usable strings, each cut to `max`. */
function bullets(value: unknown, count: number, max: number): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (out.length >= count) break;
    const line = text(entry, max);
    if (line) out.push(line);
  }
  return out.length ? out : null;
}

function sources(value: unknown): ThinkingSource[] | null {
  if (!Array.isArray(value)) return null;
  const out: ThinkingSource[] = [];
  for (const entry of value) {
    if (out.length >= MAX_SOURCES) break;
    if (!isObject(entry)) continue;
    const u = text(entry.u, MAX_SOURCE_URL);
    if (!u) continue;
    const t = text(entry.t, MAX_SOURCE_TITLE);
    out.push(t ? { u, t } : { u });
  }
  return out.length ? out : null;
}

/**
 * One step, with every field that was not usable simply left out.
 *
 * The omissions are load-bearing: `mergeThinking` spreads this over the step
 * it already has, so "absent" has to mean "the patch said nothing about this"
 * rather than "the patch reset it to the default". `normalizeThinking` puts
 * the defaults back afterwards, where a missing status really does mean
 * pending.
 */
function step(raw: unknown, index: number): StepPatch | null {
  if (!isObject(raw)) return null;
  const out: StepPatch = { id: text(raw.id, MAX_ID) || `s${index}` };
  const title = text(raw.t, MAX_STEP_TITLE);
  if (title) out.t = title;
  if (isStepStatus(raw.st)) out.st = raw.st;
  const d = bullets(raw.d, MAX_DETAILS, MAX_DETAIL);
  if (d) out.d = d;
  const o = text(raw.o, MAX_OUTPUT);
  if (o) out.o = o;
  const src = sources(raw.src);
  if (src) out.src = src;
  return out;
}

/** Key order is fixed so a blob that did not change also does not re-serialize. */
function settleStep(entry: StepPatch): ThinkingStep {
  // Assigned in this order on purpose: JSON.stringify emits keys in insertion
  // order, and the order is part of the "did it change" comparison.
  const out: Partial<ThinkingStep> & { id: string } = { id: entry.id };
  if (entry.t) out.t = entry.t;
  out.st = isStepStatus(entry.st) ? entry.st : 'pending';
  if (entry.d) out.d = entry.d;
  if (entry.o) out.o = entry.o;
  if (entry.src) out.src = entry.src;
  return out as ThinkingStep;
}

/**
 * Assemble the blob and make it fit.
 *
 * Two caps land here. The step count is the cheap one. The 16 KB total is the
 * one that matters, and it is enforced by dropping steps from the tail until
 * the serialized blob fits — the head of a trace is the part a reader can
 * still follow, and the title always survives, because a summary line with no
 * steps behind it is still a useful thing to render.
 */
function assemble(title: string, phase: ThinkingPhase, steps: StepPatch[]): ThinkingTrace | null {
  const kept = steps.slice(0, MAX_STEPS).map(settleStep);
  if (!title && kept.length === 0) return null;

  const build = (): ThinkingTrace => {
    const blob: ThinkingTrace = title ? { t: title, p: phase, s: kept } : { p: phase, s: kept };
    return blob;
  };

  let blob = build();
  while (kept.length > 0 && byteLength(JSON.stringify(blob)) > MAX_BLOB_BYTES) {
    kept.pop();
    blob = build();
  }
  // A title-only blob that is still over cap cannot happen — `t` is 200 chars
  // — but if the caps ever move, an oversized title is worth less than a
  // predictable ceiling.
  if (byteLength(JSON.stringify(blob)) > MAX_BLOB_BYTES) return null;
  return blob;
}

/**
 * Whatever an agent handed us, reduced to a blob that is safe to store and
 * cheap to re-send — or `null` when there is nothing here worth keeping.
 *
 * Junk in never throws. The callers are on the reply path: `messages.post`
 * writing an answer down, `agents.thinking` recording a live signal. A
 * malformed scratchpad is a cosmetic problem and must not become a failed
 * reply.
 */
export function normalizeThinking(value: unknown): ThinkingTrace | null {
  if (!isObject(value)) return null;

  const title = text(value.t, MAX_TITLE);
  const phase = isPhase(value.p) ? value.p : 'streaming';

  // Ids are unique within a blob, so a repeated one is an upsert here too —
  // the same rule `mergeThinking` follows, applied to a blob that arrived
  // with its own duplicates.
  const steps = new Map<string, StepPatch>();
  if (Array.isArray(value.s)) {
    for (const [index, raw] of value.s.entries()) {
      const entry = step(raw, index);
      if (!entry) continue;
      const existing = steps.get(entry.id);
      steps.set(entry.id, existing ? { ...existing, ...entry } : entry);
    }
  }

  return assemble(title, phase, [...steps.values()]);
}

/**
 * Fold a patch into a blob — the server-side twin of the browser's
 * `applyChunk`, and it has to agree with it exactly, because the transcript
 * the browser assembled live and the transcript the server wrote down are
 * meant to be the same transcript.
 *
 * A patch step whose id is already here updates that step **in place**: it
 * keeps its position and it does not appear twice. Fields the patch did not
 * mention keep the values they had, so a status-only patch ("t3 is complete
 * now") does not blank out the title and details t3 already carried. A new id
 * appends. Nothing is ever sorted or inserted mid-list: the order steps first
 * appeared in is the order they happened in, and that is the only order a
 * reader can follow.
 */
export function mergeThinking(base: unknown, patch: unknown): ThinkingTrace | null {
  const current = normalizeThinking(base);
  if (!isObject(patch)) return current;

  const steps = new Map<string, StepPatch>();
  for (const entry of current?.s ?? []) steps.set(entry.id, entry);

  if (Array.isArray(patch.s)) {
    for (const [index, raw] of patch.s.entries()) {
      const entry = step(raw, index);
      if (!entry) continue;
      const existing = steps.get(entry.id);
      // Map.set on a key it already holds keeps the original insertion slot,
      // which is precisely the in-place update this needs.
      steps.set(entry.id, existing ? { ...existing, ...entry } : entry);
    }
  }

  const title = text(patch.t, MAX_TITLE) || current?.t || '';
  const phase = isPhase(patch.p) ? patch.p : (current?.p ?? 'streaming');
  return assemble(title, phase, [...steps.values()]);
}

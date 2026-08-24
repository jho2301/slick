/**
 * What an agent showed of its working — the steps it took on the way to an
 * answer — read off a message and folded together as more of it arrives.
 *
 * This lives apart from the UI for grouping.js's reason: it is the rule that
 * decides whether a message has a thinking box at all, and a rule that decides
 * whether something is drawn should be checkable without drawing it.
 *
 * It is also where the wire's short keys stop. The blob is embedded in full in
 * every hydrated frame for its message, forever, so it is written down as
 * `t`/`p`/`s`/`st`/`d`/`o`/`src` — but a renderer that reads `s[0].st` is a
 * renderer nobody can review. The abbreviations are expanded here, once, and
 * the app only ever sees `{ title, phase, steps: [{ id, title, status,
 * details, output, sources }] }`.
 */

/** Where the blob hangs off a message's metadata. Mirrors core's own key. */
export const THINK_KEY = '_think';

const PHASES = new Set(['streaming', 'done', 'error']);
const STATUSES = new Set(['pending', 'in_progress', 'complete', 'error']);

/**
 * The step's state, said out loud. Screen readers get this and nothing else:
 * the marks beside the steps are `aria-hidden`, so a spinner that never says
 * it is a spinner is a step with no state at all to anyone not looking at it.
 *
 * Leading comma because it is a suffix on the step's own title, and reads as
 * one sentence — "Searching the web…, in progress" — rather than as a second
 * unattached announcement.
 */
const STATUS_LABELS = {
  pending: ', pending',
  in_progress: ', in progress',
  complete: ', done',
  error: ', failed',
};

/** A blob with nothing in it yet — what a stream that opened with a step builds on. */
export function emptyThink() {
  return { title: '', phase: 'streaming', steps: [] };
}

export function stepStatusLabel(step) {
  return STATUS_LABELS[step?.status] ?? '';
}

/**
 * The first of these that was actually written down, or null for "the patch
 * said nothing about this".
 *
 * The distinction is the whole reason this exists: a chunk carrying only
 * `{ id, st }` is how a step moves to complete, and defaulting its missing
 * title to `''` on the way through would blank the title already on screen.
 */
function firstString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string') return candidate;
  }
  return null;
}

function readDetails(value) {
  if (!Array.isArray(value)) return null;
  return value.filter((line) => typeof line === 'string');
}

/** `src: [{u, t}]` — a link, and what to call it when the url is unreadable. */
function readSources(value) {
  if (!Array.isArray(value)) return null;
  const sources = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
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
function readStep(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const patch = { id: (firstString(raw.id) ?? '').trim() || `s${index}` };

  const title = firstString(raw.t, raw.title);
  if (title !== null) patch.title = title;

  const status = firstString(raw.st, raw.status);
  // An unknown status is a producer we do not know, not a reason to drop the
  // step: it lands on `pending`, which is the one state that claims nothing.
  if (status !== null) patch.status = STATUSES.has(status) ? status : 'pending';

  const details = readDetails(raw.d ?? raw.details);
  if (details) patch.details = details;

  const output = firstString(raw.o, raw.output);
  if (output !== null) patch.output = output;

  const sources = readSources(raw.src ?? raw.sources);
  if (sources) patch.sources = sources;

  return patch;
}

/** A step before any patch has touched it — every field present, none of them said. */
function blankStep(id) {
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
 * The blob is mutated rather than copied because this runs once per delta on a
 * node that is deliberately not re-rendered; a fresh object per token would be
 * garbage for no one's benefit.
 */
export function applyChunk(think, chunk) {
  const target = think && Array.isArray(think.steps) ? think : emptyThink();
  if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) return target;

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
  if (phase !== null && PHASES.has(phase)) target.phase = phase;

  const steps = Array.isArray(chunk.s) ? chunk.s : Array.isArray(chunk.steps) ? chunk.steps : [];
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
export function readThinking(message) {
  const raw = message?.metadata?.[THINK_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const think = applyChunk(emptyThink(), raw);
  return think.title || think.steps.length ? think : null;
}

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
export function settle(think, phase) {
  if (!think || !Array.isArray(think.steps)) return think;
  if (PHASES.has(phase)) think.phase = phase;
  if (phase !== 'done' && phase !== 'error') return think;

  const landing = phase === 'error' ? 'error' : 'complete';
  for (const step of think.steps) {
    if (step.status === 'pending' || step.status === 'in_progress') step.status = landing;
  }
  return think;
}

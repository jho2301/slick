/**
 * `slick agent serve` — makes an agent *callable* instead of merely
 * pollable. It watches a session for events that address it (by default,
 * `@mentions`) and for each one spawns the real agent (the `claude` CLI in
 * headless print mode, by default) with the conversation as context, then
 * posts what it says back into the thread.
 *
 * The child process is stateless in *our* eyes — we do not ask it to touch
 * Slick itself. We gather context, hand it a prompt, and post its final
 * answer. Whatever tools it used to get there (or didn't, by default) is
 * between it and its own permission settings.
 *
 * One Slick thread is one child conversation. A thread is where a topic lives
 * here, so it is the unit the agent's own memory should follow: resuming per
 * thread keeps two parallel conversations from reading each other's turns —
 * and keeps one busy channel from growing a single transcript that every
 * thread has to pay for on every turn.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { readDaemonFile } from '@slick/server/daemon';
import {
  ConflictError,
  DEFAULT_ADAPTER,
  NotFoundError,
  SERVE_ADAPTER_KEY,
  SERVE_MODELS_AT_KEY,
  ValidationError,
  Workspace,
  buildAgentArgs,
  buildModelListArgs,
  errorCode,
  errorMessage,
  loadAdapter,
  lookupReported,
  normalizeModelChoices,
  parseAgentReply,
  readServeAdapter,
  readServeEffort,
  readServeModel,
  readServeLock,
  serveLockPath,
  slotFires,
  splitMessageText,
  supportsResume,
  type Adapter,
  type AgentReply,
  type HydratedEvent,
  type Message,
  type MessageMetadata,
  type ModelChoice,
  type SessionState,
  type StepStatus,
  type StreamFrame,
  type ThinkingPhase,
  type ThinkingStep,
  type TypingInput,
} from '@slick/core';

import { flagNumber, flagOn, flagText, type ArgSpec, type Flags } from '../args.ts';
import { RemoteWorkspace, type WorkspaceApi } from '../client.ts';
import { line, note, ok, style, warn } from '../output.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Longest we will wait between passes once something is going wrong. */
const MAX_BACKOFF_MS = 60_000;

/**
 * How many threads' child sessions we remember. Threads are cheap to start, so
 * an uncapped map would grow the session state forever; forgetting the least
 * recently used one costs that thread nothing but a fresh conversation if it
 * ever wakes up again.
 */
const THREAD_MEMORY = 50;

/** The single bucket every thread shares under `--shared-session`. */
const SHARED_THREAD = '*';

/**
 * How often we re-ask the binary which models it can run. Providers add and
 * retire models on their own schedule, so the answer goes stale — but not
 * within a day, and asking is a whole process spawn.
 */
const MODELS_TTL_MS = 6 * 60 * 60 * 1000;

/** Long enough for a provider round-trip, short enough to never hold a reply up. */
const MODELS_TIMEOUT_MS = 20_000;

/**
 * How long a pass waits when the daemon's event stream is doing the waking.
 * It is a fallback, not a cadence: the stream says "now" long before this
 * expires, and a watcher that has one should still look up once in a while in
 * case it missed a ring.
 */
const STREAM_IDLE_MS = 30_000;

/** How long to wait before dialling a daemon that was not there. */
const STREAM_RETRY_MS = 5_000;

/**
 * How fast a run is allowed to narrate itself.
 *
 * A model emits tokens far faster than anything should emit HTTP requests, and
 * a delta is worth exactly as much arriving eight times a second as it is
 * arriving eighty — nobody reads faster for the extra seventy. Whatever has
 * accumulated goes out on whichever of these two comes first, so a chatty run
 * costs a steady trickle of requests rather than a storm, and a slow one still
 * shows something inside a fifth of a second.
 */
const DELTA_EVERY_MS = 120;
const DELTA_EVERY_CHARS = 400;

/** The four the wire knows; anything else a binary invents means "running". */
const STEP_STATUSES: ReadonlySet<string> = new Set<StepStatus>([
  'pending',
  'in_progress',
  'complete',
  'error',
]);
const isStepStatus = (value: string | null): value is StepStatus =>
  value !== null && STEP_STATUSES.has(value);

/** Caps borrowed from the think blob's own, so nothing outgrows them here. */
const THINK_TITLE_MAX = 200;
const THINK_STEPS_MAX = 50;

/** How much reasoning is kept to find a line in. A long run reasons for pages. */
const REASONING_TAIL = 4000;

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * Errors that mean "the conversation we asked to resume is unusable" rather
 * than "that call failed, try again". Retrying these against the same
 * `--resume` id can never work: the transcript has outgrown the request limit,
 * or it is gone. The cure is a fresh session, not another identical attempt.
 */
const SESSION_FATAL = [
  /request too large/i,
  /conversation cannot continue/i,
  /prompt is too long/i,
  /exceeds? the maximum/i,
  /context (?:window|length) (?:exceeded|too long)/i,
  /no conversation found/i,
  /session .{0,80}? not found/i,
];

const isSessionFatal = (message: string | null | undefined): boolean =>
  SESSION_FATAL.some((re) => re.test(message ?? ''));

/** One child conversation, as remembered per thread under `_serveThreads`. */
interface ThreadEntry {
  sessionId: string | null;
  stateSig: string | null;
  /** How far into the conversation this session has been shown. */
  seq: number;
  at: number;
}

/** A `message.created` event that actually carries its message. */
type MessageEvent = HydratedEvent & { message: Message };

/**
 * One `serve` per history key, per machine. Two watchers sharing a key consume
 * each other's messages — AGENTS.md warns about it — and double every process
 * they spawn, which is how one wedged retry became two hot loops.
 */
function claimSession(home: string | undefined, key: string): () => void {
  // The path comes from the core because the lock is not private bookkeeping:
  // it is how everything else — the rail, the mention picker — knows this
  // session answers when you talk to it.
  const file = serveLockPath(key, home);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, 'wx'); // fails outright if someone holds it
      try {
        writeFileSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          if (readFileSync(file, 'utf8').trim() === String(process.pid)) unlinkSync(file);
        } catch {
          /* already gone */
        }
      };
      process.once('exit', release);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
        process.once(signal, () => {
          release();
          process.exit(signal === 'SIGINT' ? 130 : 143);
        });
      }
      return release;
    } catch (err) {
      // An unwritable home is not a reason to refuse to work.
      if (errorCode(err) !== 'EEXIST') return () => {};
      // Same reader the rest of Slick uses to decide whether this session has
      // a watcher, so "someone holds the lock" means one thing everywhere.
      const owner = readServeLock(key, home)?.pid ?? 0;
      if (owner && owner !== process.pid) {
        throw new ConflictError(
          `Another \`slick agent serve\` (pid ${owner}) is already watching "${key}".`,
          {
            hint: `Stop it first, or run this one against a different session. Lock: ${file}`,
          }
        );
      }
      // The holder is gone (crash, kill -9). Clear its lock and try again.
      try {
        unlinkSync(file);
      } catch {
        /* raced with another starter; the next attempt settles it */
      }
    }
  }
  return () => {};
}

function plainTranscript(messages: Message[]): string {
  return messages
    .filter((m) => !m.deleted)
    .map((m) => `[${timeFmt.format(m.createdAt)}] ${m.author.label}: ${m.text}`)
    .join('\n');
}

/**
 * The agent's own memory, minus our bookkeeping. `serve` keeps its resume id
 * (and the signature below) in the same bag the human writes to with
 * `slick agent state set`, and neither belongs in a prompt: the model cannot
 * use them, and they would make "has the state changed?" fire on our writes.
 */
function publicState(state: SessionState | null | undefined): SessionState {
  const out: SessionState = {};
  for (const [key, value] of Object.entries(state ?? {})) {
    if (!key.startsWith('_')) out[key] = value;
  }
  return out;
}

const stateSignature = (json: string): string => createHash('sha256').update(json).digest('hex').slice(0, 16);

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * The child sessions this watcher is holding, as stored under `_serveThreads`:
 * `threadId → {sessionId, stateSig, seq, at}`. It lives in the database rather than
 * in this process so a restart — or a `--once` cron run — picks every thread
 * back up where it left off instead of starting each one over.
 */
function loadThreads(state: SessionState | null | undefined): Map<string, ThreadEntry> {
  const threads = new Map<string, ThreadEntry>();
  const stored: unknown = state?._serveThreads;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return threads;
  for (const [threadId, entry] of Object.entries(stored as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    threads.set(threadId, {
      sessionId: stringOrNull(record.sessionId),
      stateSig: stringOrNull(record.stateSig),
      // Missing on an entry written before there was one, which reads as
      // "shown nothing" — one last full context block, then never again.
      seq: Number(record.seq) || 0,
      at: Number(record.at) || 0,
    });
  }
  return threads;
}

/** Drop the empty and the least recently used entries, in place. */
function prune(threads: Map<string, ThreadEntry>): Record<string, ThreadEntry> {
  for (const [threadId, entry] of threads) {
    if (!entry.sessionId && !entry.stateSig) threads.delete(threadId);
  }
  if (threads.size > THREAD_MEMORY) {
    const stale = [...threads.entries()].sort((a, b) => b[1].at - a[1].at).slice(THREAD_MEMORY);
    for (const [threadId] of stale) threads.delete(threadId);
  }
  return Object.fromEntries(threads);
}

/**
 * The conversation this thread's session should be shown: the thread itself.
 * The channel tail is the right context for a mention that *starts* a thread —
 * it is what orients a brand-new session — but once a thread has a session of
 * its own, other people's other threads are noise inside it.
 *
 * Null when the caller should use the channel tail.
 */
function threadContext(ws: Workspace, message: Message, limit: number): Message[] | null {
  if (limit <= 0 || !message.threadId || message.threadId === message.id) return null;
  try {
    const { root, replies } = ws.messages.thread(message.threadId);
    const earlier = [root, ...replies].filter((m) => !m.deleted && m.seq < message.seq);
    return earlier.length > 0 ? earlier.slice(-limit) : null;
  } catch {
    return null; // context is a nicety — never fail an answer over it
  }
}

interface PromptParts {
  event: MessageEvent;
  context: Message[];
  contextLabel: string;
  stateJson: string | null;
  extra: string | undefined;
}

/**
 * What we hand the model: the recent conversation, its memory, the message.
 * No standing "you are X, reply with only the post" preamble — every agent
 * behind `--cmd` already knows what it is from its own configuration, and one
 * resumed transcript would otherwise carry a fresh copy per message forever.
 */
function buildPrompt({ event, context, contextLabel, stateJson, extra }: PromptParts): string {
  const message = event.message;
  const parts: string[] = [];
  if (context.length > 0) parts.push(`${contextLabel}\n${plainTranscript(context)}`);
  if (stateJson) parts.push(`Your saved state from earlier runs:\n${stateJson}`);
  parts.push(`The message to answer, from ${message.author.label}:\n${message.text}`);
  if (extra) parts.push(extra);
  return parts.join('\n\n');
}

interface CallOptions {
  adapter: Adapter;
  cmd: string;
  prompt: string;
  resumeId: string | null;
  permissionMode: string | undefined;
  allowedTools: string | undefined;
  skipPermissions: boolean;
  model: string | null;
  effort: string | null;
  appendSystemPrompt: string | undefined;
  timeoutMs: number;
  onDelta: ((frame: StreamFrame) => void) | null;
}

/**
 * Spawn the agent binary and collect its reply.
 *
 * *How* to call it, and how to read it back, belong to the adapter: which
 * arguments carry the prompt and the resumed conversation, where in the output
 * the answer sits (see `adapters.ts`). What is left here is the part that needs
 * a process — the pipes, the timeout, and the rule that a binary which will not
 * start is a failed answer rather than a crashed watcher.
 *
 * `onDelta` is the one place where the answer is read before it is finished.
 * It changes nothing about what gets posted: the reply is still parsed once,
 * at `close`, out of everything that was printed. It only means somebody gets
 * to watch it being written.
 */
function callAgent({
  adapter,
  cmd,
  prompt,
  resumeId,
  permissionMode,
  allowedTools,
  skipPermissions,
  model,
  effort,
  appendSystemPrompt,
  timeoutMs,
  onDelta,
}: CallOptions): Promise<AgentReply> {
  return new Promise((resolve) => {
    const args = buildAgentArgs(adapter, {
      prompt,
      session: resumeId,
      permissionMode,
      allowedTools,
      skipPermissions,
      model,
      effort,
      system: appendSystemPrompt,
    });
    // The prompt is the largest thing we hand a child, and an argv has a length
    // a long thread will eventually find. An adapter that reads it on stdin
    // says so, and then nothing about the conversation rides in the arguments.
    const viaStdin = adapter.promptVia === 'stdin';

    // What the store already said for this conversation, before the call. An
    // adapter that reads its answer back out of a store needs this to tell a
    // fresh answer from the one that was already there.
    const priorAnswer =
      adapter.reply.text?.lookup && resumeId
        ? lookupReported(adapter, { sessionId: resumeId }, 'text')
        : null;

    const child = spawn(cmd, args, { stdio: [viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    // A killed child closes with no exit code, which reads as "exited with
    // code null" — true, useless, and the thing a human sees in the thread
    // when a long run runs out of time. Say what actually happened.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref();

    if (viaStdin && child.stdin) {
      // A child that died before reading its prompt is reported by `error`
      // below; the broken pipe on the way there is not news.
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    }
    // Everything the child prints, kept whole for the adapter to read at
    // `close`: half a JSON document says nothing, and which half arrived in
    // which chunk is an accident of the pipe.
    //
    // A streaming adapter reads the very same accumulating string a second
    // time, forward, a completed line at a time — `narrated` is how far that
    // reading has got, so no line is ever sent twice and a line split across
    // two chunks waits for its other half.
    const stream = adapter.stream;
    const narrating = Boolean(stream && onDelta);
    let narrated = 0;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (!narrating || !stream || !onDelta) return;
      const end = stdout.lastIndexOf('\n');
      if (end < narrated) return;
      const complete = stdout.slice(narrated, end).split('\n');
      narrated = end + 1;
      for (const printed of complete) {
        const frame = printed.trim();
        if (!frame) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(frame);
        } catch {
          // A line that is not JSON is display noise — a banner, a progress
          // bar, a deprecation warning — and a console is allowed to have
          // those. It is not an error, and it is not worth telling anyone
          // about: the answer is still read out of the whole of stdout.
          continue;
        }
        const delta = stream.read(parsed);
        if (delta) onDelta(delta);
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      // The one place an install hint helps: the binary is not there at all.
      const hint = adapter.installHint ? ` — ${adapter.installHint}` : '';
      clearTimeout(timer);
      resolve({
        text: '',
        sessionId: null,
        model: null,
        effort: null,
        error: `could not start "${cmd}": ${err.message}${hint}`,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        // SIGKILL leaves nothing to parse — everything the run printed is
        // discarded here along with it. Whatever was streamed on the way is
        // therefore the only surviving trace of a run that timed out, which
        // is most of the argument for streaming at all.
        const seconds = Math.round(timeoutMs / 1000);
        resolve({
          text: '',
          sessionId: null,
          model: null,
          effort: null,
          error: `${cmd} did not answer within ${seconds}s`,
        });
        return;
      }
      const reply = parseAgentReply(adapter, { stdout, stderr, code, cmd });
      // A console is a display. An agent that keeps its own record of the run
      // is asked for it once the session id is known: what it wrote down beats
      // what it drew, and the request we made is only a request.
      const rest = {
        model: reply.model ?? lookupReported(adapter, reply, 'model'),
        effort: reply.effort ?? lookupReported(adapter, reply, 'effort'),
      };
      if (reply.error || !adapter.reply.text?.lookup) {
        resolve({ ...reply, ...rest });
        return;
      }
      const recorded = lookupReported(adapter, reply, 'text');
      // A resumed conversation already had an answer in there. If the store
      // says the same thing it said before the call, this run wrote nothing —
      // posting that would be answering the new message with the old reply.
      const fresh = recorded !== null && recorded !== priorAnswer;
      resolve({
        ...reply,
        ...rest,
        text: fresh ? recorded : '',
        error: fresh
          ? null
          : `${cmd} finished without recording an answer${reply.sessionId ? ` for ${reply.sessionId}` : ''}`,
      });
    });
  });
}

/** How a delta reaches the daemon: a POST to one of its live routes. */
type PostDelta = (path: string, body: object) => Promise<unknown>;

/**
 * Where a delta goes.
 *
 * Everything else this watcher does it can do against the file: a message is a
 * row, and a row is there whether or not anything is running. A delta is the
 * one thing that is not written down anywhere — it exists only for as long as
 * it takes to reach a screen — so it has to be handed to the daemon, which is
 * the only thing holding the open connections to those screens.
 *
 * With no daemon running there is nobody watching, and a run costs exactly
 * what it cost before: nothing is spawned, nothing is dialled, and the answer
 * arrives as one finished message the way it always has.
 */
function openDeltas(home: string | undefined, token: string | undefined): PostDelta | null {
  const target = readDaemonFile(home);
  if (!target?.url) return null;
  const client = new RemoteWorkspace({
    url: target.url,
    token: token ?? process.env.SLICK_TOKEN ?? target.token ?? null,
  });
  return (path, body) => client.request('POST', path, body);
}

/** The blob as it is built here, in the wire's short keys; core clamps and stores it. */
interface LiveTrace {
  t: string | null;
  p: ThinkingPhase;
  s: ThinkingStep[];
}

interface Streamer {
  /** What `callAgent` calls for every frame it managed to read. */
  delta(frame: StreamFrame): void;
  /** The call is over; settle the blob and flush what is buffered. */
  finish(outcome: 'done' | 'error'): Promise<void>;
  /** The answer has landed (or never will); take the draft back. */
  close(): Promise<void>;
  /** The blob to stamp on the message, or null if the run never narrated. */
  think(): LiveTrace | null;
}

/**
 * One call's narration, throttled.
 *
 * Two things are being told at once and they are not the same kind of thing.
 * The text is the answer arriving early, and it is thrown away the moment the
 * real message lands. The thinking is a record: what the run did to get there
 * survives on the message itself, so a reader arriving an hour later still
 * sees which tools ran, in the order they ran.
 *
 * Because they are not the same kind of thing they do not share a clock.
 * Text goes out on the coalescing timer below, to an ephemeral route that
 * writes nothing down: a frame more or less costs a redraw. The steps go to
 * `/api/thinking`, which appends a durable row to the event log, so they are
 * posted when the step set actually moves — a step opened, or a step's status
 * settled — and never merely because more characters arrived. A turn changes
 * its steps a handful of times and its text thousands, and putting the
 * durable one on the fast clock is how an answer costs a megabyte of log.
 *
 * Both are posted through one promise chain, because a reader watching
 * characters appear out of order would rather they had not appeared at all.
 * Nothing here can fail a call: a delta the daemon refused, or a daemon that
 * died mid-answer, costs the display and not the reply.
 */
function openStreamer(
  post: PostDelta,
  { agentId, threadId }: { agentId: string; threadId: string }
): Streamer {
  /** Text waiting for the next flush. */
  let pending = '';
  let timer: NodeJS.Timeout | null = null;
  /** Posts are chained rather than fired, so they arrive in the order written. */
  let sending: Promise<void> = Promise.resolve();

  const think: LiveTrace = { t: null, p: 'streaming', s: [] };
  /** The tail of what has been reasoned, which is where the title comes from. */
  let reasoned = '';
  const steps = new Map<string, ThinkingStep>();
  /** Something about the blob changed since the last frame carried a copy. */
  let liveDirty = false;
  let thought = false;
  /** Whether anything at all was ever sent, which decides if there is an end. */
  let narrated = false;

  const send = (path: string, body: object): Promise<void> => {
    sending = sending.then(() =>
      post(path, { agentId, threadId, ...body }).then(
        () => undefined,
        () => undefined
      )
    );
    return sending;
  };

  // A fresh object each time: the blob keeps being edited after this one is
  // handed off, and a step that changed status in flight would rewrite a frame
  // that has already gone out.
  const snapshot = (): LiveTrace => ({ ...think, s: think.s.map((step) => ({ ...step })) });

  /**
   * The durable half, on the step set's own clock.
   *
   * Called the moment a step opens or settles, not from the timer: there are a
   * handful of these in a turn, they are each worth a row, and waiting a tick
   * to say a tool started is a tick the box spends lying about what is running.
   */
  const sendThinking = () => {
    liveDirty = false;
    void send('/api/thinking', { think: snapshot() });
  };

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending) return;
    const text = pending;
    pending = '';
    narrated = true;
    // The blob rides along on a frame that was going out anyway, so the
    // streaming bubble can draw its own box without a second request. Only
    // here: the title moves at reasoning speed, which is the one rate the
    // durable route must never see.
    const live = thought && liveDirty ? snapshot() : null;
    if (live) liveDirty = false;
    void send('/api/stream/delta', live ? { text, think: live } : { text });
  };

  const later = () => {
    if (timer) return;
    timer = setTimeout(flush, DELTA_EVERY_MS);
    timer.unref();
  };

  /** Whether the step set moved, which is what earns a row. */
  const noteStep = (title: string, status: string | null): boolean => {
    thought = true;
    const known = isStepStatus(status) ? status : null;
    const existing = steps.get(title);
    if (existing) {
      // The same step named twice is that step reporting back, never a second
      // row: a tool that says "running" and then "done" is one thing that
      // happened once.
      const settled = known ?? 'complete';
      if (existing.st === settled) return false; // it said the same thing twice
      existing.st = settled;
      return true;
    }
    if (think.s.length >= THINK_STEPS_MAX) return false; // the blob's own cap; the tail is dropped
    const step: ThinkingStep = {
      id: `s${think.s.length}`,
      t: title.slice(0, THINK_TITLE_MAX),
      st: known ?? 'in_progress',
    };
    steps.set(title, step);
    think.s.push(step);
    return true;
  };

  return {
    delta({ text, reasoning, step, stepStatus }) {
      if (text) {
        pending += text;
        if (pending.length >= DELTA_EVERY_CHARS) flush();
        else later();
      }
      if (reasoning) {
        thought = true;
        // Reasoning arrives a few tokens at a time and the blob wants one
        // line, so the summary is the last line of what has been reasoned so
        // far: what the model is working on now, rather than a transcript of
        // everything it has ever thought. Only the tail is kept, because that
        // is the only part the line can ever be taken from.
        reasoned = (reasoned + reasoning).slice(-REASONING_TAIL);
        const trailing = reasoned
          .split('\n')
          .map((part) => part.trim())
          .filter(Boolean)
          .at(-1);
        if (trailing && trailing.slice(0, THINK_TITLE_MAX) !== think.t) {
          think.t = trailing.slice(0, THINK_TITLE_MAX);
          // A new summary line is not a new step, so it buys no row of its own.
          // It goes out with the next piece of text, or with the steps the next
          // time they move, or in the worst case on the message itself.
          liveDirty = true;
        }
      }
      if (step && noteStep(step, stepStatus)) sendThinking();
    },

    /**
     * The call is over. Whatever is still buffered goes out, and the blob is
     * settled first: a finished transcript must never be left holding a step
     * that is still spinning, and a settled blob drops out of the live snapshot
     * so the indicator clears on its own.
     *
     * How it ended decides what the stragglers become. A run that was killed at
     * the timeout, that failed to spawn, or that came back with an error was in
     * the middle of one of these steps when it stopped, and marking that step
     * `complete` would put "Finished thinking" over the exact moment the reader
     * needs to look at — so a failed call lands them on `error`, which is also
     * the one phase the box opens itself for.
     */
    async finish(outcome) {
      if (thought) {
        // A step is `complete` or `error`; only the trace itself is `done`.
        // (Stamping the trace's word on the steps used to read as an unknown
        // status, which core settles to `pending` — a finished run whose
        // tools all showed as never having started.)
        const settled: StepStatus = outcome === 'error' ? 'error' : 'complete';
        for (const step of think.s) if (step.st === 'pending' || step.st === 'in_progress') step.st = settled;
        think.p = outcome;
        sendThinking();
      }
      flush();
      await sending;
    },

    /**
     * The answer has landed; there is nothing left to stream.
     *
     * This is deliberately not part of `finish()`. The call ends before the
     * reply is posted, and a `done` frame sent there blanks the streaming
     * bubble one whole round trip before the real message can replace it —
     * the reader watches a finished answer disappear and come back.
     * `message.created` already clears the bubble for the agent that was
     * streaming, so by the time this is sent the frame is only insurance for
     * the paths where no message is ever posted at all: a call that ran out
     * of attempts, a thread that went away.
     */
    async close() {
      // A run that never showed anything has nothing to take back, and its
      // "done" would be the only frame anyone ever saw.
      if (narrated) void send('/api/stream/delta', { done: true });
      await sending;
    },

    think: () => (thought ? snapshot() : null),
  };
}

interface Doorbell {
  /** `pollMs` with no stream to listen to; `idleMs` with one — a backstop, not a cadence. */
  wait(pollMs: number, idleMs: number): Promise<void>;
  close(): void;
}

/**
 * A doorbell on the daemon's event stream.
 *
 * The watcher reads the database directly, so it is its own clock: it looks
 * again every `--interval` whether or not anything happened, which is a write
 * per pass for an idle session and up to a whole interval of latency for a
 * busy one. The daemon already knows the moment a row lands — its own writes
 * wake it, everyone else's it sees within a poll — so when one is running,
 * let it say when.
 *
 * It stays a *doorbell*, never a data path: a ring only means "look now", and
 * the pass that follows is the same `resume()` with the same filters and the
 * same cursor as before. That way a missed frame, a dead daemon or a stream
 * that never connects costs nothing but the interval we would have waited
 * anyway.
 */
function openDoorbell(home: string | undefined): Doorbell | null {
  const target = readDaemonFile(home);
  if (!target?.url) return null; // no daemon: the interval is the only clock

  const url = `${String(target.url).replace(/\/+$/, '')}/api/stream`;
  const headers: Record<string, string> = {
    accept: 'text/event-stream',
    ...(target.token ? { authorization: `Bearer ${target.token}` } : {}),
  };

  let connected = false;
  let pending = false;
  let wake: (() => void) | null = null;
  let closed = false;
  let controller: AbortController | null = null;

  /** Something happened. If a pass is waiting, cut the wait short; if not, remember. */
  const ring = () => {
    pending = true;
    wake?.();
  };

  async function listen(): Promise<void> {
    const decoder = new TextDecoder();
    while (!closed) {
      controller = new AbortController();
      try {
        const res = await fetch(url, { headers, signal: controller.signal });
        if (!res.ok || !res.body) throw new Error(`stream answered ${res.status}`);
        connected = true;
        let buffer = '';
        for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
          if (closed) break;
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          // Which event it was is the next pass's business. Heartbeats are
          // comment lines (`: keepalive`), so they ring nothing.
          if (lines.some((l) => l.startsWith('data:'))) ring();
        }
      } catch {
        /* the daemon went away, or we did */
      }
      connected = false;
      if (closed) return;
      // A reconnect may have slept through a write, so the next pass looks
      // regardless — one wasted poll is cheaper than one lost message.
      ring();
      await sleep(STREAM_RETRY_MS);
    }
  }

  void listen();

  return {
    wait(pollMs, idleMs) {
      if (pending || closed) {
        pending = false;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          wake = null;
          pending = false;
          resolve();
        };
        const timer = setTimeout(done, connected ? idleMs : pollMs);
        timer.unref();
        wake = done;
      });
    },
    close() {
      closed = true;
      controller?.abort();
      wake?.();
    },
  };
}

/**
 * Ask the agent binary what it can run, the way its adapter says to ask.
 *
 * An adapter with no `listModels` group is not asked at all — no flag, no
 * process. One that is asked may still have never heard of the flag (the
 * `claude` CLI, today) and fail or print something else, and that is a fine
 * answer too: it just means this session types its model rather than picking
 * it.
 *
 * Null when the binary did not answer with a list.
 */
function askModels(adapter: Adapter, cmd: string): Promise<ModelChoice[] | null> {
  const listArgs = buildModelListArgs(adapter);
  if (!listArgs) return Promise.resolve(null);
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, listArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve(null);
      return;
    }
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), MODELS_TIMEOUT_MS);
    timer.unref();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', () => {}); // drained so a chatty binary cannot block
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      try {
        const choices = normalizeModelChoices(JSON.parse(stdout));
        resolve(choices.length > 0 ? choices : null);
      } catch {
        resolve(null);
      }
    });
  });
}

export interface ServeContext {
  agentId: string | undefined;
  flags: Flags;
  json: boolean;
}

/**
 * The watcher's bookkeeping is written straight into the database, and its
 * typing indicator has to be switchable off from an `exit` handler, which is
 * only possible when the write is synchronous. Both mean a local workspace.
 */
function localWorkspace(ws: WorkspaceApi): Workspace {
  if (ws instanceof Workspace) return ws;
  throw new ValidationError('`slick agent serve` needs a local workspace.', {
    hint: 'Run it on the machine that holds the database, without --remote.',
  });
}

/** Run the watch-and-respond loop for one session. */
export async function serve(api: WorkspaceApi, ref: string, ctx: ServeContext): Promise<void> {
  const ws = localWorkspace(api);
  const { flags } = ctx;
  const session = ws.agents.get(ref, { agentId: ctx.agentId });
  const respondAgentId = ctx.agentId ?? session.agentId;

  const interval = Math.max(flagNumber(flags, 'interval') ?? 2000, 500);
  const once = flagOn(flags, 'once');
  const all = flagOn(flags, 'all');
  const dryRun = flagOn(flags, 'dry-run');
  const contextLimit = flagNumber(flags, 'context') ?? 20;
  // Which calling convention this binary speaks. `--cmd` still names the
  // binary; an adapter is about *how* it is called, not where it lives.
  const adapter = loadAdapter(flagText(flags, 'adapter') ?? DEFAULT_ADAPTER, ws.home);
  const cmd = flagText(flags, 'cmd') ?? adapter.cmd;
  if (!cmd) {
    throw new ValidationError(`The "${adapter.name}" adapter does not name a binary to run.`, {
      hint: `Say which one: slick agent serve --adapter ${adapter.name} --cmd ./my-agent`,
    });
  }
  // Write down which convention this session is being served with. The
  // daemon has no way to see a launch flag, and it needs the same adapter to
  // answer "what commands does this agent have?".
  if (readServeAdapter(session.state) !== adapter.name) {
    try {
      ws.agents.setState(ref, { [SERVE_ADAPTER_KEY]: adapter.name }, { agentId: ctx.agentId, merge: true });
    } catch (err) {
      warn(`Could not record the adapter on this session: ${errorMessage(err)}`);
    }
  }
  // An agent that cannot be handed a conversation starts every message fresh,
  // so there is no id worth saving and no memory to assume it is holding.
  const canResume = supportsResume(adapter);
  const timeoutMs = flagNumber(flags, 'timeout') ?? 10 * 60 * 1000;
  const maxAttempts = Math.max(flagNumber(flags, 'max-attempts') ?? 3, 1);
  const shared = flagOn(flags, 'shared-session');

  const scopeFlag = flagText(flags, 'scope');
  const scope: 'session' | 'workspace' | undefined =
    scopeFlag === 'session' || scopeFlag === 'workspace'
      ? scopeFlag
      : flagOn(flags, 'this-channel')
        ? 'session'
        : undefined;
  const readOpts = { agentId: ctx.agentId, channel: flagText(flags, 'channel'), scope };

  const asJson = ctx.json || !process.stdout.isTTY;
  if (!asJson) {
    note(
      `Serving as ${style.bold(respondAgentId)} — ${all ? 'every message' : '@mentions only'}, ` +
        `via \`${cmd}\`${adapter.name === DEFAULT_ADAPTER ? '' : ` (${adapter.label})`} — ` +
        `${canResume ? (shared ? 'one shared conversation' : 'one conversation per thread') : 'no memory between messages'}` +
        ', ctrl-c to stop.'
    );
    line();
  }

  /**
   * One child conversation per thread, and against each the signature of the
   * state that conversation has already been shown — a resumed transcript is
   * still holding the copy we sent it, so re-sending unchanged memory would
   * just be paid for again on every turn.
   */
  const threads = loadThreads(session.state);
  // Before this was per-thread there was a single id for the whole watcher.
  // Which thread it belongs to is unknowable now, so it is only worth keeping
  // when this watcher is deliberately still sharing one conversation.
  const legacyId = stringOrNull(session.state._serveSessionId);
  const legacySig = stringOrNull(session.state._serveStateSig);
  if (shared && legacyId && !threads.has(SHARED_THREAD)) {
    threads.set(SHARED_THREAD, { sessionId: legacyId, stateSig: legacySig, seq: 0, at: Date.now() });
  }
  let staleKeys = legacyId != null || session.state._serveStateSig != null;
  /** What the last pass used, so a change is announced once, not per pass. */
  let activeModel = readServeModel(session.state) ?? flagText(flags, 'model') ?? null;
  let activeEffort = readServeEffort(session.state) ?? flagText(flags, 'effort') ?? null;
  let threadsChanged = false;
  /** message id → consecutive failed attempts, so one bad message cannot wedge the queue. */
  const failures = new Map<string, number>();
  let backoff = interval;

  /**
   * The typing indicator this watcher has switched on, if any.
   *
   * `finally` covers every way a *call* can end, but not a way the *process*
   * can: ctrl-c runs the lock's handler, which calls `process.exit` while the
   * await is still suspended, so the finally never runs and the indicator is
   * left on. An `exit` listener does run, and against a local workspace the
   * write is synchronous, which is the only kind of write that can still land
   * from here.
   */
  let showingTyping: TypingInput | null = null;
  process.once('exit', () => {
    if (!showingTyping) return;
    try {
      ws.agents.typing(ref, { ...showingTyping, on: false });
    } catch {
      /* going down anyway; the snapshot's lock check is the other backstop */
    }
  });

  // Only an adapter that can describe its frames has anything to send, so an
  // agent that says nothing about streaming never even looks for a daemon.
  const postDelta = adapter.stream ? openDeltas(ws.home, flagText(flags, 'token')) : null;

  const release = flagOn(flags, 'no-lock') ? () => {} : claimSession(ws.home, session.key);
  // A single pass has nothing to wait for, so it never opens one.
  const doorbell = once ? null : openDoorbell(ws.home);
  try {
    for (;;) {
      const resumed = ws.agents.resume(ref, { ...readOpts, contextLimit, limit: 200 });
      const created = resumed.missed.filter(
        (e): e is MessageEvent => e.type === 'message.created' && Boolean(e.message)
      );
      const targets = all ? created : created.filter((e) => e.message.mentions.includes(respondAgentId));

      // A message we failed to answer, and everything after it, stays unread —
      // we would rather retry (and risk a duplicate reply once the trouble
      // clears) than silently skip something nobody ever saw.
      let failedAtSeq: number | null = null;

      // Keep the app's model picker stocked. It is the watcher that knows how
      // to reach the binary, so it is the watcher that asks — on the way past,
      // at most once a TTL, and never at the cost of an answer.
      if (!dryRun && Date.now() - Number(resumed.state[SERVE_MODELS_AT_KEY] ?? 0) > MODELS_TTL_MS) {
        const choices = await askModels(adapter, cmd);
        try {
          // The timestamp is written either way: a binary with no such flag
          // must be asked once a TTL, not once a pass.
          ws.agents.setModelChoices(ref, choices, { agentId: ctx.agentId });
          if (choices && !asJson) note(`${cmd} offers ${choices.length} model(s)`);
        } catch (err) {
          warn(`Could not save the model list: ${errorMessage(err)}`);
        }
      }

      // Re-read every pass, so `slick agent model` reaches a running watcher.
      const model = readServeModel(resumed.state) ?? flagText(flags, 'model') ?? null;
      if (model !== activeModel) {
        if (!asJson) note(`Model → ${style.bold(model ?? `${cmd} default`)}`);
        activeModel = model;
      }
      const effort = readServeEffort(resumed.state) ?? flagText(flags, 'effort') ?? null;
      if (effort !== activeEffort) {
        if (!asJson) note(`Effort → ${style.bold(effort ?? `${cmd} default`)}`);
        activeEffort = effort;
      }

      const memory = publicState(resumed.state);
      const stateJson = Object.keys(memory).length > 0 ? JSON.stringify(memory) : null;
      const currentSig = stateJson ? stateSignature(stateJson) : null;

      for (const event of targets) {
        const threadKey = shared ? SHARED_THREAD : event.message.threadId || event.message.id;
        const thread: ThreadEntry = threads.get(threadKey) ?? {
          sessionId: null,
          stateSig: null,
          seq: 0,
          at: 0,
        };

        // A fresh session has never seen the agent's memory; a resumed one is
        // still holding the copy we sent it, so it only needs the new value
        // when the human (or the agent) has actually changed something.
        const includeState = (fresh: boolean): boolean =>
          Boolean(stateJson) && (fresh || !thread.sessionId || currentSig !== thread.stateSig);
        const inThread = shared ? null : threadContext(ws, event.message, contextLimit);
        // The channel tail is a plain window on the channel, so it holds the
        // message we are about to quote in full underneath it. One copy is
        // enough. (`threadContext` already stops short of it.)
        const tail = (inThread ?? resumed.context).filter((m) => m.id !== event.message.id);
        // The same reasoning, for the conversation itself. A resumed transcript
        // is already holding every turn we sent it, so re-sending the whole
        // tail made each message carry another copy of the last twenty: the
        // prompt grew with the thread until the child compacted itself in the
        // middle of it. What it has *not* seen is what arrived since the
        // message it last answered — the quiet messages nobody mentioned it
        // in, another agent's reply — so that is what it gets. The watermark,
        // not the window.
        const contextFor = (fresh: boolean): Message[] => {
          const seen = fresh || !thread.sessionId ? 0 : thread.seq;
          return seen > 0 ? tail.filter((m) => m.seq > seen) : tail;
        };
        const promptFor = (fresh: boolean): string =>
          buildPrompt({
            event,
            context: contextFor(fresh),
            contextLabel: inThread
              ? 'Earlier in this thread:'
              : `Recent conversation in #${event.channelSlug ?? event.message.channelSlug ?? '?'}:`,
            stateJson: includeState(fresh) ? stateJson : null,
            extra: flagText(flags, 'system'),
          });

        if (dryRun) {
          line(style.dim(`--- would call ${cmd} for ${event.message.id} ---`));
          line(promptFor(false));
          line();
          continue;
        }

        const typingOpts: TypingInput = {
          agentId: ctx.agentId,
          threadId: event.message.threadId,
          channelId: event.message.channelId,
        };
        // A thread can vanish out from under us (the human deletes it, a
        // race with the API, ...) between resume() handing us the event and
        // reply() landing — that must not take the whole watcher down.
        // The narration outlives the call it narrates: the frame that says no
        // more is coming belongs after the reply has landed, and the reply is
        // posted well below the `finally` that ends the call.
        let streamer: Streamer | null = null;
        try {
          showingTyping = typingOpts;
          ws.agents.typing(ref, { ...typingOpts, on: true });
          // One narration per message answered, not per watcher: the thread it
          // belongs to is the thing being answered, and the blob it collects
          // is stamped on the answer below.
          streamer = postDelta
            ? openStreamer(postDelta, { agentId: respondAgentId, threadId: event.message.threadId })
            : null;
          let result: AgentReply | undefined;
          let sentState = includeState(false);
          try {
            const narrator = streamer;
            const call = (resumeId: string | null, prompt: string) =>
              callAgent({
                adapter,
                cmd,
                prompt,
                resumeId,
                permissionMode: flagText(flags, 'permission-mode'),
                allowedTools: flagText(flags, 'allowed-tools'),
                skipPermissions: flagOn(flags, 'dangerously-skip-permissions'),
                model,
                effort,
                appendSystemPrompt: flagText(flags, 'append-system-prompt'),
                timeoutMs,
                onDelta: narrator ? (frame) => narrator.delta(frame) : null,
              });
            result = await call(thread.sessionId, promptFor(false));

            // A thread's transcript is resumed for every message in it, so it
            // only ever grows. Once it outgrows the request limit every later
            // call fails identically — and because the id is saved, restarting
            // picks the same dead conversation right back up. Retire it and
            // answer from a clean session instead of retrying into the wall.
            if (result.error && thread.sessionId && isSessionFatal(result.error)) {
              warn(`Retiring the resumed ${cmd} session for ${threadKey} — ${result.error}`);
              thread.sessionId = null;
              thread.stateSig = null; // the new transcript starts out knowing nothing
              threads.delete(threadKey);
              // The whole map goes out, so nothing another thread earned
              // earlier in this pass is left waiting to be written.
              ws.agents.setState(
                ref,
                { _serveThreads: prune(threads) },
                { agentId: ctx.agentId, merge: true }
              );
              threadsChanged = false;
              sentState = includeState(true);
              result = await call(null, promptFor(true));
            }
          } finally {
            showingTyping = null;
            // The narration ends with the call, however the call ended — a
            // failure, a retired session, a timeout. Anything else leaves a
            // half-written answer on screen with nothing coming to replace it.
            // How it ended goes with it: `result` is unset only if the call
            // threw, which is not a run that finished thinking either.
            await streamer?.finish(result && !result.error ? 'done' : 'error');
            ws.agents.typing(ref, { ...typingOpts, on: false });
          }
          // The call threw if this is still unset, and a throw lands in the
          // catch below before this line is ever reached.
          if (!result) continue;

          // Only a session that worked is worth remembering. Saving the id from
          // a failed call is what let the unusable one survive every restart.
          // Likewise, only a call that landed proves the memory got through.
          if (!result.error && result.sessionId && canResume) {
            threads.set(threadKey, {
              sessionId: result.sessionId,
              stateSig: sentState ? currentSig : thread.stateSig,
              // It has now seen everything up to the message it just answered.
              seq: Number(event.seq) || thread.seq || 0,
              at: Date.now(),
            });
            threadsChanged = true;
          }

          if (result.error) {
            const attempts = (failures.get(event.message.id) ?? 0) + 1;
            failures.set(event.message.id, attempts);
            warn(`${cmd} failed on ${event.message.id} (${attempts}/${maxAttempts}): ${result.error}`);
            if (attempts < maxAttempts) {
              failedAtSeq = event.seq;
              break;
            }
            // Out of attempts. Holding the cursor here forever hides every
            // message behind this one, so say so in the thread and move on.
            failures.delete(event.message.id);
            try {
              ws.agents.reply(ref, event.message.threadId, {
                agentId: ctx.agentId,
                text: `⚠️ I could not answer this after ${maxAttempts} attempts. Last error: ${result.error}`,
              });
            } catch (err) {
              warn(`Could not post the failure note for ${event.message.id}: ${errorMessage(err)}`);
            }
            continue;
          }
          failures.delete(event.message.id);

          // An answer too long for one message is still an answer. Posting it
          // whole used to throw, which the retry below reads as "the call
          // failed" — so a long reply cost three runs of the model and was then
          // dropped without a word. It goes in as several messages instead.
          // The limit is the far end's when the adapter names one, and Slick's
          // own cap otherwise.
          const pieces = splitMessageText(result.text, adapter.maxMessageLength);
          // Which model wrote it, underscore-prefixed like the rest of Slick's
          // bookkeeping: the app renders it beside the author instead of
          // dumping it as metadata. What the child reported beats what we asked
          // for — an alias, a fallback, or a binary that ignored `--model` all
          // land here — and what we asked for counts only if there was
          // somewhere to ask it, since an adapter with no model group never
          // carried the request. One answer says it once, so the first piece
          // carries it and the rest say nothing.
          const badge = result.model || (slotFires(adapter, 'model', model) ? model : null);
          // Effort reads the other way round from the model. `--effort` is a
          // per-run override the agent applies to *this* call, while a level in
          // its own records can predate it — Hermes writes a session's config
          // once, when the session is created, and a resume leaves it alone. So
          // where we asked at all, what we asked for is the honest answer.
          const level = (slotFires(adapter, 'effort', effort) ? effort : null) || result.effort;
          // What it was doing while it wrote, if it narrated at all. The
          // stream itself is gone the moment it is drawn, so the blob on the
          // message is all anyone arriving late — or reloading the page — has
          // of the steps that produced the answer.
          const thinking = streamer?.think() ?? null;
          const stamp: MessageMetadata | null =
            badge || level || thinking
              ? {
                  ...(badge ? { _model: badge } : {}),
                  ...(level ? { _effort: level } : {}),
                  ...(thinking ? { _think: thinking } : {}),
                }
              : null;
          let posted: Message | null = null;
          for (const [index, piece] of pieces.entries()) {
            posted = ws.agents.reply(ref, event.message.threadId, {
              agentId: ctx.agentId,
              text: piece,
              metadata: index === 0 ? stamp : null,
            }).message;
            if (asJson) line(JSON.stringify({ repliedTo: event.message.id, message: posted }));
          }
          if (!posted) continue; // splitMessageText always yields at least one piece
          // Our own answer is a message in this thread too, and the child does
          // not need to be told what it just said — the watermark moves past
          // it rather than up to it.
          const entry = threads.get(threadKey);
          if (entry && posted.seq > entry.seq) {
            entry.seq = posted.seq;
            threadsChanged = true;
          }
          if (!asJson) {
            const parts = pieces.length > 1 ? ` in ${pieces.length} messages` : '';
            ok(`Replied in thread ${style.dim(posted.threadId)}${parts}`);
          }
        } catch (err) {
          // A message that has been hard-removed can never be answered — retrying
          // it forever would wedge every mention behind it. Anything else (a
          // transient claude failure, a DB hiccup) keeps the existing
          // retry-and-block behavior in case the trouble clears.
          if (err instanceof NotFoundError) {
            warn(`Skipping ${event.message.id}: ${err.message}`);
            failures.delete(event.message.id);
            continue;
          }
          const attempts = (failures.get(event.message.id) ?? 0) + 1;
          failures.set(event.message.id, attempts);
          warn(`Could not answer ${event.message.id} (${attempts}/${maxAttempts}): ${errorMessage(err)}`);
          if (attempts >= maxAttempts) {
            failures.delete(event.message.id);
            continue;
          }
          failedAtSeq = event.seq;
          break;
        } finally {
          // Whatever happened — the answer went in, the thread was gone, we ran
          // out of attempts — the streaming reply is over. It is said here
          // rather than beside each of those endings because every one of
          // them leaves a bubble on somebody's screen otherwise.
          await streamer?.close();
        }
      }

      if (!dryRun) {
        const patch: SessionState = {};
        if (threadsChanged) patch._serveThreads = prune(threads);
        // The one-session-for-everything bookkeeping this replaced. Nothing
        // reads it any more, so clear it rather than leave a dead id behind
        // that looks like it is still in use.
        if (staleKeys) {
          patch._serveSessionId = null;
          patch._serveStateSig = null;
        }
        if (Object.keys(patch).length > 0) {
          ws.agents.setState(ref, patch, { agentId: ctx.agentId, merge: true });
          threadsChanged = false;
          staleKeys = false;
        }
        const safeCount =
          failedAtSeq == null
            ? resumed.missed.length
            : resumed.missed.findIndex((e) => e.seq === failedAtSeq);
        if (safeCount > 0) {
          ws.agents.pull(ref, { ...readOpts, limit: safeCount });
        }
      }

      if (once) return;
      // A pass that got stuck waits longer each time, so a persistent failure
      // settles into a patient watcher rather than a hot loop that spawns a
      // process every couple of seconds.
      backoff = failedAtSeq == null ? interval : Math.min(backoff * 2, MAX_BACKOFF_MS);
      // A pass that got stuck waits the whole backoff. A ring means "a new
      // message landed", which is the one thing a wedged watcher must not go
      // chasing — so it only shortens the wait of a pass that is well.
      if (doorbell && failedAtSeq == null) await doorbell.wait(interval, STREAM_IDLE_MS);
      else await sleep(backoff);
    }
  } finally {
    doorbell?.close();
    release();
  }
}

export const SERVE_SPEC = {
  booleans: ['dry-run', 'dangerously-skip-permissions', 'no-lock', 'shared-session'],
  strings: [
    'adapter',
    'effort',
    'cmd',
    'system',
    'timeout',
    'permission-mode',
    'allowed-tools',
    'model',
    'append-system-prompt',
    'max-attempts',
  ],
} satisfies ArgSpec;

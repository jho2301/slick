/**
 * Slick desktop UI.
 *
 * State lives in one object, the timeline is patched incrementally (so live
 * messages never steal your scroll position or interrupt an edit), and every
 * change — yours, the CLI's, or an agent's — arrives through the same SSE
 * stream.
 */

import { Api, ApiError } from './api.js';
import {
  ago,
  avatarColor,
  clock,
  dayKey,
  dayLabel,
  fullStamp,
  highlight,
  initials,
  renderText,
  trimModelName,
} from './format.js';
import {
  $,
  autosize,
  clear,
  confirmModal,
  copyToClipboard,
  el,
  initModal,
  mount,
  openModal,
  toast,
} from './ui.js';
import { isGrouped } from './grouping.js';
import { applyChunk, emptyThink, readThinking, settle, stepStatusLabel } from './thinking.js';
import { createCommandMenu } from './commands.js';
import { readSections, SECTION_CARDS } from './response-sections.js';
import {
  findModelChoice,
  groupModelChoices,
  modelCommandPreview,
  modelPickerDefaults,
  modelsForProvider,
  parseModelCommandArgs,
} from './model-picker.js';
import {
  bankedResetLine,
  hermesEfforts,
  hermesModels,
  shouldRefreshUsageAfter,
  usageDetailLines,
  usageLimitRows,
  usageLimitText,
  usageStatus,
  withConfigured,
} from './hermes-panel.js';
import { createHermesStore } from './hermes-store.js';
import { createMentionMenu } from './mentions.js';
import { initPaneResizer, reflowPanes } from './panes.js';
import { currentSubscription, disablePush, enablePush, pushSupported } from './push.js';

const api = new Api();
/**
 * The Hermes rail panel. It owns its own state — including the ordering rules
 * that keep one profile's answer off another profile's panel — and asks for a
 * re-draw when any of it moves.
 */
const hermes = createHermesStore({ api, onChange: () => renderHermes() });
const LAST_CHANNEL_KEY = 'slick.channel';
// A stuck "on" with no matching "off" (the agent process died mid-call)
// should not leave the indicator spinning forever.
const TYPING_TIMEOUT_MS = 5 * 60 * 1000;

const state = {
  workspace: null,
  channels: [],
  categories: [],
  /** Channel id being dragged between categories, if any. */
  dragging: null,
  sessions: [],
  /** Daemon version, fetched the first time Settings is opened. */
  version: null,
  current: null,
  messages: [],
  hasMore: false,
  oldestSeq: null,
  thread: null,
  unread: new Map(),
  editing: null,
  atBottom: true,
  /** The agent's own slash commands, fetched the first time one is typed. */
  commands: { key: null, list: [], loading: false },
  /** threadId -> Map<agentId, timeout handle> */
  typing: new Map(),
  /**
   * An answer being streamed at us, per thread, before it is a message.
   * Modelled on `typing` above and torn down the same three ways: the
   * producer says it is done, the message it was building lands, or the same
   * backstop timer gives up on a process that died mid-sentence.
   * @type {Map<string, {text: string, think: object, agentId: string, at: number, timer: any}>}
   */
  drafts: new Map(),
  /**
   * The Hermes rail panel, straight off the store above. `saved` is what the
   * profile's config.yaml said the last time it was read; `draft` is what the
   * two selects are showing. They differ only while someone is mid-decision,
   * which is exactly when the save button has something to do.
   */
  hermes: hermes.state,
  seq: 0,
};

/** message id -> rendered row, so live updates can patch in place. */
const nodes = new Map();

/**
 * Whether each thinking box is open, and which phase it was in when we last
 * decided that. Keyed by message id, or by `draft-<threadId>` for the box on
 * an answer that is still arriving.
 *
 * It sits out here beside `nodes` rather than on the row because
 * `patchMessage` rebuilds a row wholesale — on every `message.updated`, every
 * reply-count bump, every typing flip three rows down — so a box that kept its
 * own state in the node would slam shut every time an agent so much as
 * started typing. Out here, a rebuild reconstructs the right state for free
 * and `patchMessage` goes on knowing nothing about any of this.
 * @type {Map<string, {open: boolean, sawPhase: string}>}
 */
const thinkUi = new Map();

/** Steps past this many are folded away behind one "Show all" row. */
const STEP_SOFT_CAP = 12;

/** How close to the bottom still counts as reading live, in both panes. */
const NEAR_BOTTOM_PX = 60;

// ============================================================== rendering ===

function avatar(author, extraClass = '') {
  const label = author.label || author.id;
  return el(
    'div',
    {
      class: `avatar${author.kind === 'agent' ? ' avatar--agent' : ''}${extraClass}`,
      style: { background: avatarColor(label) },
      title: label,
    },
    initials(label)
  );
}

function dayDivider(ts) {
  return el('div', { class: 'day' }, el('span', {}, dayLabel(ts)));
}

function messageActions(message, { inThread }) {
  const editable = message.author.kind !== 'system';
  const scope = inThread ? 'thread' : 'timeline';
  // The bar rides a full-height rail so it can stick to the top of the
  // scrollport while a long message is still on screen.
  return el(
    'div',
    { class: 'msg__rail' },
    el(
      'div',
      { class: 'msg__actions' },
      !inThread && message.isThreadRoot
        ? el('button', { onclick: () => openThread(message.id), title: 'Reply in thread' }, 'Reply')
        : null,
      editable ? el('button', { onclick: () => startEdit(message.id, scope), title: 'Edit' }, 'Edit') : null,
      el('button', { onclick: () => copyId(message.id), title: 'Copy message id' }, 'Copy id'),
      editable
        ? el('button', { class: 'is-danger', onclick: () => removeMessage(message), title: 'Delete' }, 'Delete')
        : null
    )
  );
}

function threadSummary(message) {
  return el(
    'button',
    { class: 'msg__thread', onclick: () => openThread(message.id) },
    el('span', { class: 'stack' }, avatar(message.author)),
    `${message.replyCount} ${message.replyCount === 1 ? 'reply' : 'replies'}`,
    el('span', { class: 'when' }, message.lastReplyAt ? ago(message.lastReplyAt) : '')
  );
}

const typingDots = () => el('span', { class: 'typing-dots' }, el('span'), el('span'), el('span'));

function typingLabel(agentIds) {
  return `${agentIds.join(', ')} ${agentIds.length === 1 ? 'is' : 'are'} typing`;
}

/** The little pill under a channel-row message, in place of the reply count while an agent works on it. */
function typingChip(agentIds, threadId) {
  return el(
    'button',
    { class: 'msg__thread msg__thread--typing', onclick: () => openThread(threadId) },
    el('span', { class: 'stack' }, agentIds.map((id) => avatar({ id, label: id, kind: 'agent' }))),
    typingLabel(agentIds),
    typingDots()
  );
}

/** A transient row at the bottom of an open thread, styled like a message. */
function typingBubble(agentIds) {
  return el(
    'div',
    { class: 'msg is-typing' },
    el('div', { class: 'msg__gutter' }, agentIds.map((id) => avatar({ id, label: id, kind: 'agent' }))),
    el('div', {}, el('div', { class: 'msg__body msg__body--typing' }, typingLabel(agentIds), typingDots()))
  );
}

/**
 * The disclosure box above an agent's answer — or nothing at all, which is by
 * far the common case.
 *
 * The `null` is the whole graceful-degradation story, and it is structural
 * rather than a rule a caller has to remember: a message with no `_think` in
 * its metadata produces no box, no wrapper and no class, and `el` drops null
 * children, so the row around it is byte-for-byte the row this app has always
 * drawn.
 */
function thinkingBox(message, surface) {
  const think = readThinking(message);
  return think ? thinkingView(think, message.id, surface) : null;
}

/** Nothing to show is not the same as a box with nothing in it. */
const hasThinking = (think) => Boolean(think && (think.title || think.steps?.length));

/** What the mark beside the summary line is doing, in step vocabulary. */
const phaseStatus = (phase) => (phase === 'done' ? 'complete' : phase === 'error' ? 'error' : 'in_progress');

/**
 * The summary line when the agent authored none. Present progressive while it
 * runs, past tense once it has stopped — and never a duration, which would
 * quietly turn "here is my working" into "here is how long I took".
 */
const phaseTitle = (phase) =>
  phase === 'done' ? 'Finished thinking' : phase === 'error' ? 'Thinking stopped' : 'Thinking…';

/**
 * Open or shut, decided here rather than in the click handler.
 *
 * The handler only ever sees the presses; the interesting transitions arrive
 * as rebuilds, so this is the one place that can see both. `sawPhase` is what
 * makes a rebuild different from a phase change: the row is reconstructed
 * dozens of times per answer and only the handful of those that actually move
 * the phase are allowed to overrule the reader.
 */
function thinkOpenState(key, phase) {
  const seen = thinkUi.get(key);
  // Born collapsed — unless it is already broken. "Born collapsed" is the
  // default, and the error rule overrules it here for exactly the reason it
  // overrules a manual collapse below: the step that failed is the one thing
  // in the box worth showing unasked, and a reload or a switch away and back
  // arrives here rather than at the transition underneath.
  if (!seen) {
    const born = phase === 'error';
    thinkUi.set(key, { open: born, sawPhase: phase });
    return born;
  }
  // Nothing moved, so whatever the reader last chose stands. That one line is
  // both the latch during the stream and the permanence after it.
  if (seen.sawPhase === phase) return seen.open;
  // The phase turned over. Finishing hands the space back to the answer that
  // is arriving; failing does the exact opposite, because a failure is
  // precisely when someone needs to see which step broke.
  const open = phase === 'error';
  thinkUi.set(key, { open, sawPhase: phase });
  return open;
}

/**
 * In place, and deliberately not a re-render. The row has not changed — a
 * disclosure was pressed — and rebuilding it would throw away the transition
 * the stylesheet runs on `.think__body` and hand the reader a repaint for a
 * chevron.
 */
function toggleThink(key) {
  const seen = thinkUi.get(key);
  const open = !seen?.open;
  thinkUi.set(key, { open, sawPhase: seen?.sawPhase ?? 'streaming' });
  // Every copy of this box, not just the one that was pressed. A thread root
  // is on screen twice while the pane is open — once in the channel, once at
  // the top of the pane — and both read their state from this one key, so a
  // toggle wired to a single node leaves the other copy saying the opposite of
  // what it is doing.
  for (const box of document.querySelectorAll(`.think[data-think-key="${CSS.escape(key)}"]`)) {
    // `aria-expanded` and nothing else: the stylesheet collapses the body off
    // the head's own attribute, so this is the state and the animation at
    // once. Setting `hidden` here as well would take the steps out of the
    // accessibility tree and out of the transition with them.
    box.querySelector('.think__head')?.setAttribute('aria-expanded', String(open));
    const chev = box.querySelector('.think__chev');
    if (chev) chev.textContent = open ? '▾' : '▸';
  }
}

/** key -> what this box's live region last said, and when. */
const thinkSaid = new Map();

/** At most one spoken update per box per this long. */
const ANNOUNCE_EVERY_MS = 1500;

/** What a screen reader should be told is happening, in one short line. */
function announcement(think) {
  if (think.phase === 'done') return 'Finished thinking';
  if (think.phase === 'error') return 'Thinking stopped on an error';
  const running = [...(think.steps ?? [])].reverse().find((step) => step.status !== 'complete');
  return running?.title || think.title || 'Thinking…';
}

/**
 * Say the step, not the characters.
 *
 * Two rules are doing the work here. Assistive tech watches a live region for
 * *changes*, and the first content of a brand-new node is not a change — so
 * text that is worth announcing goes in one turn after the box is built, once
 * the region is really in the document, and text that has already been said
 * goes in synchronously, before insertion, where it stays silent. And a box
 * with a dozen quick steps would otherwise talk over itself, so nothing is
 * announced twice within `ANNOUNCE_EVERY_MS` — except a phase change, which is
 * the one update nobody should miss.
 */
function announce(region, key, think) {
  const text = announcement(think);
  const said = thinkSaid.get(key);
  // Scrolling back through a channel is not a channel full of things
  // finishing. A box whose very first sight is already done or failed has no
  // transition to report, so it is recorded as said without ever being said —
  // otherwise opening a channel with a dozen old answers queues a dozen
  // "Finished thinking"s at a reader who asked for none of them.
  if (!said && think.phase !== 'streaming') {
    thinkSaid.set(key, { text, phase: think.phase, at: Date.now() });
    region.textContent = text;
    return;
  }
  if (said?.text === text) {
    region.textContent = text;
    return;
  }
  if (said && said.phase === think.phase && Date.now() - said.at < ANNOUNCE_EVERY_MS) return;
  thinkSaid.set(key, { text, phase: think.phase, at: Date.now() });
  setTimeout(() => {
    region.textContent = text;
  }, 0);
}

function thinkStep(step) {
  const details = step.details ?? [];
  const sources = step.sources ?? [];
  return el(
    'li',
    { class: 'think__step', dataset: { status: step.status, id: step.id } },
    el('span', { class: 'think__mark', dataset: { status: step.status }, 'aria-hidden': 'true' }),
    el('span', { class: 'think__step-title' }, step.title),
    // The mark is decoration and says so; this is the same information as
    // plain text, sitting inside the step it belongs to.
    el('span', { class: 'think__sr' }, stepStatusLabel(step)),
    details.length > 0 ? el('ul', { class: 'think__details' }, details.map((line) => el('li', {}, line))) : null,
    step.output ? el('p', { class: 'think__output' }, step.output) : null,
    sources.length > 0
      ? el(
          'ul',
          { class: 'think__sources' },
          // `_blank` and a stripped referrer, the same terms every link the
          // markdown renderer emits goes out on.
          sources.map((source) =>
            el(
              'li',
              {},
              el(
                'a',
                { class: 'think__source', href: source.url, target: '_blank', rel: 'noreferrer noopener' },
                source.title
              )
            )
          )
        )
      : null
  );
}

/**
 * The steps, with the oldest ones folded away past the soft cap.
 *
 * The tail is what stays visible rather than the head: a running box appends
 * its newest step at the bottom, and a cap that kept the first twelve would
 * leave a live box frozen on twelve finished rows while the interesting one
 * happens off-list. The way back to the rest sits where they were cut.
 */
function thinkSteps(steps) {
  const list = el('ol', { class: 'think__steps' });
  const folded = [];
  steps.forEach((step, index) => {
    const row = thinkStep(step);
    if (index < steps.length - STEP_SOFT_CAP) {
      row.hidden = true;
      folded.push(row);
    }
    list.append(row);
  });
  if (folded.length > 0) {
    const more = el(
      'li',
      { class: 'think__more' },
      el(
        'button',
        {
          type: 'button',
          onclick: () => {
            for (const row of folded) row.hidden = false;
            more.remove();
          },
        },
        `Show all ${steps.length} steps`
      )
    );
    list.prepend(more);
  }
  return list;
}

/**
 * The box itself, shared by a finished message and a draft still arriving —
 * they are the same thing at different phases, and `key` is only how the
 * disclosure state finds its way back to the right one.
 */
function thinkingView(think, key, surface = 'timeline') {
  // A stream ends by stopping, so a finished blob can still be carrying a step
  // that claims to be running. A transcript must never hold a live spinner.
  const shown = think.phase === 'streaming' ? think : settle(think, think.phase);
  const open = thinkOpenState(key, shown.phase);
  // The surface is in the id and not in the key, and the split is the point: a
  // thread root is drawn in the channel and again at the top of the pane, so
  // the two copies must not both claim the id their heads point `aria-controls`
  // at — while the open state stays keyed on the message alone, because they
  // are the same box and opening one opens the other.
  const bodyId = `think-${surface}-${key}-body`;

  const chev = el('span', { class: 'think__chev', 'aria-hidden': 'true' }, open ? '▾' : '▸');
  // No `hidden`: collapse is the stylesheet's `0fr` row, which keeps the steps
  // in the accessibility tree and gives the disclosure something to animate.
  // `[hidden]` is `display: none !important` in this app and would quietly
  // take both away.
  const body = el(
    'div',
    { class: 'think__body', id: bodyId, role: 'group', 'aria-label': 'Thinking steps' },
    thinkSteps(shown.steps ?? [])
  );
  const head = el(
    'button',
    {
      class: 'think__head',
      type: 'button',
      'aria-expanded': String(open),
      'aria-controls': bodyId,
      onclick: () => toggleThink(key),
    },
    el('span', { class: 'think__mark', dataset: { status: phaseStatus(shown.phase) }, 'aria-hidden': 'true' }),
    el('span', { class: 'think__title' }, shown.title || phaseTitle(shown.phase)),
    chev
  );
  // A sibling of the body, never inside it: a region that is collapsed away
  // with the thing it describes announces nothing at the moment it matters.
  const region = el('p', { class: 'think__live', 'aria-live': 'polite', 'aria-atomic': 'true' });
  announce(region, key, shown);

  return el('div', { class: 'think', dataset: { phase: shown.phase, thinkKey: key } }, head, body, region);
}

/**
 * A live answer, in the shape of the message it is about to become.
 *
 * It replaces the typing chip or bubble rather than sitting beside it: they
 * say the same thing, and "claude is typing" under two paragraphs of claude's
 * answer reads like a second agent. The body keeps the typing dots only while
 * there is no text yet, so a draft that is all thinking still looks alive.
 */
// A draft is deliberately not cut into sections. Its text arrives a chunk at
// a time and is appended into `.msg__body` by `innerHTML` on every chunk, so a
// label half-typed as `## Assum` would open a box that closes again a keypress
// later, and a body that is re-parsed per chunk cannot be appended to. The cut
// happens once, when the finished message replaces the draft.
function draftBubble(threadId, surface) {
  const draft = state.drafts.get(threadId);
  if (!draft) return null;
  const author = { id: draft.agentId, label: draft.agentId, kind: 'agent' };
  return el(
    'div',
    { class: 'msg is-typing msg--draft', dataset: { thread: threadId } },
    el('div', { class: 'msg__gutter' }, avatar(author)),
    el(
      'div',
      {},
      hasThinking(draft.think) ? thinkingView(draft.think, `draft-${threadId}`, surface) : null,
      draft.text
        ? el('div', { class: 'msg__body msg__body--draft', html: renderText(draft.text) })
        : el(
            'div',
            { class: 'msg__body msg__body--typing msg__body--draft' },
            typingLabel([draft.agentId]),
            typingDots()
          )
    )
  );
}

/**
 * The session a message was posted through. Agents stamp their history key on
 * every message, so that is the exact answer; an agent that posted some other
 * way falls back to its session only when it has exactly one, because guessing
 * between several would put the wrong model next to someone's words.
 */
function sessionForMessage(message) {
  if (message.sessionKey) {
    const exact = state.sessions.find((session) => session.key === message.sessionKey);
    if (exact) return exact;
  }
  const mine = state.sessions.filter((session) => session.agentId === message.author?.id);
  return mine.length === 1 ? mine[0] : null;
}

/**
 * What an agent message says it was answered by — this stands in for the old
 * `agent` badge, so every agent message gets one. Nothing records which model
 * wrote a given message, so it is the session's current setting under the
 * agent's own name for it, same as the rail. A session we cannot pin down, or
 * one on its default, still says something rather than reading like a human.
 */
function messageModel(message) {
  if (message.author?.kind !== 'agent') return null;
  // What actually answered, as `serve` recorded it when the reply was posted.
  // That is history and stays true; everything below is only today's setting.
  // Deliberately the untrimmed name: this is the identity, and `badgeLabel`
  // hands it to the grouping rule. `llama-3-70b.gguf` and
  // `llama-3-70b.safetensors` are one architecture in two builds, and letting
  // them shorten to the same string here would tuck them under one header
  // whose single badge then claims one model answered both. `modelChip` is
  // where the name gets shortened, because that is where it is only a label.
  const answered = message.metadata?._model;
  if (typeof answered === 'string' && answered.trim()) return answered.trim();
  const session = sessionForMessage(message);
  if (!session) return 'agent';
  return modelLabel(session, serveModel(session));
}

/**
 * Metadata worth dumping under a message. Slick's own bookkeeping is
 * underscore-prefixed (`_model`, as on `_serveModel`) and gets rendered
 * properly elsewhere — the raw line is for what the agent chose to attach.
 */
function visibleMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const entries = Object.entries(metadata).filter(([key]) => !key.startsWith('_'));
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/**
 * How hard the agent was thinking, if anything says. Recorded on the message
 * by `serve` when the reply was posted — that is history and stays true —
 * and otherwise the session's setting today, same fallback as the model.
 */
function messageEffort(message) {
  if (message.author?.kind !== 'agent') return null;
  const level = message.metadata?._effort;
  if (typeof level === 'string' && level.trim()) return level.trim();
  // A reply `serve` stamped says what it says. It writes `_model` and `_effort`
  // together, so `_model` alone means "answered at no particular level" — not
  // "we do not know" — and today's setting must not be painted over yesterday.
  if (message.metadata && '_model' in message.metadata) return null;
  const session = sessionForMessage(message);
  return session ? serveEffort(session) : null;
}

/**
 * What the badges say, and what hovering them explains.
 *
 * Two chips rather than one string: the model is a name and the level is a
 * setting, they change independently, and a reader scanning a thread for
 * which answers were thought hard about should find a column rather than read
 * to the end of every id. They sit in one wrapper so the pair travels, and
 * wraps, together.
 *
 * @returns {{model: string|null, effort: string|null, title: string}|null}
 */
function messageBadge(message) {
  const model = messageModel(message);
  const effort = messageEffort(message);
  if (!model && !effort) return null;
  const answered = model ? `Answered by ${model}` : 'Answered';
  return { model, effort, title: effort ? `${answered}, thinking ${effort}` : answered };
}

/**
 * One string standing for both chips, for the grouping rule. A grouped row has
 * no header and so no chips at all, so two replies differing in either half
 * must not be tucked under one heading: the level counts as much as the name.
 */
const badgeLabel = (message) => {
  const badge = messageBadge(message);
  return badge ? `${badge.model ?? ''} ${badge.effort ?? ''}` : null;
};

/** The pair, as they sit beside the author. */
function modelChip(badge) {
  if (!badge) return null;
  return el(
    'span',
    // `badge.title` keeps the untrimmed name on purpose: the chip is short
    // enough to scan a thread with, and the hover is where you go when you
    // need to know exactly which weights answered.
    { class: 'msg__badges', title: badge.title },
    badge.model ? el('span', { class: 'msg__badge msg__model' }, trimModelName(badge.model)) : null,
    badge.effort ? el('span', { class: 'msg__badge msg__effort' }, badge.effort) : null
  );
}

/**
 * Put the chip on a row that is already on screen. Sessions load — and change —
 * after messages render, and re-rendering the timeline for that would throw the
 * reader's scroll position away.
 */
function syncModelChip(row, message) {
  const head = row?.querySelector('.msg__head');
  if (!head) return; // a grouped row has no header to hang it off
  const badge = messageBadge(message);
  const existing = head.querySelector('.msg__badges');
  if (!badge) {
    existing?.remove();
    return;
  }
  // The pair is replaced rather than patched: there are four ways two optional
  // chips can change, and rebuilding one small wrapper is both shorter and
  // harder to get wrong than four transitions that must also keep them in order.
  const fresh = modelChip(badge);
  if (existing) {
    existing.replaceWith(fresh);
    return;
  }
  const author = head.querySelector('.msg__author');
  if (author) author.after(fresh);
  else head.append(fresh);
}

/** Every chip in the timeline, after the sessions behind them moved. */
function syncModelChips() {
  for (const message of state.messages) {
    const row = nodes.get(message.id);
    if (row) syncModelChip(row, message);
  }
}

/** A fingerprint of "which model is each session on", to spot real changes. */
function modelFingerprint() {
  // The effort belongs in here too: it is half of what the badge says, and
  // the chips only get repaired when this string changes.
  //
  // Raw names, not trimmed ones. This is asking what each session is set to,
  // not what the chip reads, and two settings that only look alike after
  // trimming are still a change worth redrawing for.
  return state.sessions
    .map((session) => `${session.key}:${serveModel(session) ?? ''}:${serveEffort(session) ?? ''}`)
    .join('|');
}

/**
 * The collapsible boxes under an answer — reasoning, process, assumptions.
 *
 * Real `<details>` rather than a scripted box: closed is the default state of
 * the element itself, the summary is already a button to a screen reader, and
 * find-in-page opens the one it matched. Nothing here carries `.msg__body`,
 * for `startEdit`'s reason above.
 */
function sectionCards(sections) {
  return SECTION_CARDS.map(({ key, label }) =>
    sections[key]
      ? el(
          'details',
          { class: 'rsec', dataset: { section: key } },
          el('summary', { class: 'rsec__head' }, el('span', { class: 'rsec__title' }, label)),
          el('div', { class: 'rsec__body', html: renderText(sections[key]) })
        )
      : null
  );
}

/**
 * One message row. `previous` decides whether it is visually grouped under
 * the message above it.
 */
function messageRow(message, previous, opts = {}) {
  const grouped = !opts.standalone && isGrouped(message, previous, badgeLabel);
  const row = el('div', {
    class: `msg${grouped ? ' is-grouped' : ''}`,
    dataset: { id: message.id },
  });

  row.append(
    grouped
      ? el('div', { class: 'msg__gutter' }, el('span', { class: 'msg__stamp' }, clock(message.createdAt)))
      : el('div', { class: 'msg__gutter' }, avatar(message.author))
  );

  const main = el('div', {});
  if (!grouped) {
    main.append(
      el(
        'div',
        { class: 'msg__head' },
        el('span', { class: 'msg__author' }, message.author.label || message.author.id),
        modelChip(messageBadge(message)),
        message.author.kind === 'system' ? el('span', { class: 'msg__badge msg__badge--system' }, 'system') : null,
        el('span', { class: 'msg__time', title: fullStamp(message.createdAt) }, clock(message.createdAt))
      )
    );
  }

  if (message.deleted) {
    main.append(el('div', { class: 'msg__body msg__deleted' }, 'This message was deleted'));
  } else {
    // Two constraints hold this line where it is. It goes in `main` and not in
    // `row` because `.msg` is a two-column grid — avatar, then body — and a
    // third in-flow child would wrap under the avatar gutter instead of
    // sitting above the answer it explains. And nothing inside the box may
    // carry `.msg__body`: `startEdit` finds the editable node with
    // `row.querySelector('.msg__body')`, first match wins, and a box drawn
    // above the real body would hand the editor the wrong node.
    const think = thinkingBox(message, opts.inThread ? 'thread' : 'timeline');
    if (think) main.append(think);
    const sections = readSections(message);
    main.append(el('div', { class: 'msg__body', html: renderText(sections.answer) }));
    mount(main, sectionCards(sections));
    if (message.editedAt) main.append(el('span', { class: 'msg__edited' }, '(edited)'));
    const meta = visibleMetadata(message.metadata);
    if (meta) main.append(el('div', { class: 'msg__meta' }, JSON.stringify(meta)));
  }

  if (!opts.inThread) {
    const typers = typingAgents(message.threadId);
    // An answer already arriving says everything the typing pill would, so it
    // takes the pill's place rather than stacking on top of it.
    if (state.drafts.has(message.threadId)) main.append(draftBubble(message.threadId, 'timeline'));
    else if (typers.length > 0) main.append(typingChip(typers, message.threadId));
    else if (message.replyCount > 0) main.append(threadSummary(message));
  }

  row.append(main);
  if (!message.deleted) row.append(messageActions(message, { inThread: opts.inThread }));
  return row;
}

function emptyState(title, ...lines) {
  return el('div', { class: 'empty' }, el('h2', {}, title), lines.map((text) => el('p', { html: text })));
}

function renderTimeline({ sameChannel = false } = {}) {
  const host = clear($('#messages'));
  nodes.clear();
  // Every row is about to be rebuilt either way, but "load earlier" is the
  // same channel and the same conversation: a box the reader opened should
  // still be open once sixty older messages arrive above it. Switching
  // channels is the opposite — those ids have left the screen for good, and
  // keeping their state would only leak.
  if (!sameChannel) {
    thinkUi.clear();
    thinkSaid.clear();
  }

  if (!state.current) {
    host.append(emptyState('No channel selected', 'Pick one on the left, or create your first channel.'));
    return;
  }
  if (state.messages.length === 0) {
    host.append(
      emptyState(
        `This is the start of #${state.current.slug}`,
        state.current.purpose || 'Say something to get it going.',
        `From a terminal: <code>slick send ${state.current.slug} "hello"</code>`
      )
    );
    return;
  }

  if (state.hasMore) {
    host.append(
      el(
        'div',
        { style: { textAlign: 'center', padding: '4px 0 10px' } },
        el('button', { class: 'chip', onclick: loadOlder }, 'Load earlier messages')
      )
    );
  }

  let previous = null;
  let lastDay = null;
  for (const message of state.messages) {
    const key = dayKey(message.createdAt);
    if (key !== lastDay) {
      host.append(dayDivider(message.createdAt));
      lastDay = key;
      previous = null;
    }
    const row = messageRow(message, previous);
    nodes.set(message.id, row);
    host.append(row);
    previous = message;
  }
}

function appendMessage(message) {
  if (nodes.has(message.id)) return;
  const host = $('#messages');
  if (state.messages.length === 0) clear(host);

  const previous = state.messages[state.messages.length - 1] ?? null;
  if (!previous || dayKey(previous.createdAt) !== dayKey(message.createdAt)) {
    host.append(dayDivider(message.createdAt));
  }
  const row = messageRow(message, previous);
  nodes.set(message.id, row);
  host.append(row);
  state.messages.push(message);
}

function patchMessage(message) {
  const index = state.messages.findIndex((m) => m.id === message.id);
  if (index === -1) return;
  state.messages[index] = message;
  const old = nodes.get(message.id);
  if (!old) return;
  const previous = state.messages[index - 1] ?? null;
  const fresh = messageRow(message, previous);
  old.replaceWith(fresh);
  nodes.set(message.id, fresh);
}

function dropMessage(id) {
  const index = state.messages.findIndex((m) => m.id === id);
  if (index !== -1) state.messages.splice(index, 1);
  nodes.get(id)?.remove();
  nodes.delete(id);
  thinkUi.delete(id);
  thinkSaid.delete(id);
}

// ---------------------------------------------------------------- layers ---

/**
 * On a phone the app is a stack: the channel list is home, a channel slides in
 * over it, and a thread slides in over that. Each layer puts a history entry
 * behind itself so the physical/gesture back button peels one off instead of
 * leaving the app. Every other way of closing a layer (a back arrow, Escape,
 * picking another channel) just plays that navigation itself, so the stack
 * never grows a trail of stale entries.
 *
 * Each entry records the whole stack rather than the one layer it added:
 * history can only pop from the top, so a close needs to know how deep its own
 * entry is buried to rewind the right amount.
 *
 * Wide viewports show list, channel and thread side by side, so nothing
 * stacks and nothing touches history — hence the breakpoint below, which has
 * to stay in step with the responsive one in styles.css.
 */
const stacks = () => window.matchMedia('(max-width: 900px)').matches;

let layers = [];

function pushLayer(name) {
  layers = [...layers, name];
  history.pushState({ layers }, '');
}

/**
 * Rewind past `name`'s entry — and any layer stacked on top of it, since those
 * sit between us and it. The resulting popstate is what actually tears their
 * UI down.
 */
function dropLayer(name) {
  const at = layers.indexOf(name);
  if (at === -1) return;
  const depth = layers.length - at;
  layers = layers.slice(0, at);
  history.go(-depth);
}

/** Bring the layers in line with the entry a back/forward landed us on. */
function syncLayers(entry) {
  layers = entry?.layers ?? [];
  if (!layers.includes('thread')) closeThread({ viaPopstate: true });
  if (!layers.includes('channel')) closeChannel({ viaPopstate: true });
}

/**
 * Reveal the channel over the list. The channel stays loaded underneath when
 * it is dismissed, so coming back to it costs nothing.
 */
function openChannel() {
  if (!stacks() || $('#app').classList.contains('with-channel')) return;
  $('#app').classList.add('with-channel');
  pushLayer('channel');
}

function closeChannel({ viaPopstate = false } = {}) {
  if (!$('#app').classList.contains('with-channel')) return;
  $('#app').classList.remove('with-channel');
  if (!viaPopstate) dropLayer('channel');
}

// ------------------------------------------------------------------ rail ---

const RAIL_HIDDEN_KEY = 'slick.rail-hidden';

/**
 * Collapse or restore the rail on wide viewports.
 *
 * Narrow ones stack instead: the rail *is* the first screen down there, so
 * there is nowhere to collapse it to and the control is hidden. The stored
 * preference is still kept — shrinking the window and pulling it wide again
 * gives back the state you left.
 */
function setRail(hidden, { remember = true } = {}) {
  $('#app').classList.toggle('rail-hidden', hidden);
  const button = $('#btn-rail');
  button.setAttribute('aria-expanded', String(!hidden));
  const label = hidden ? 'Show sidebar' : 'Hide sidebar';
  button.setAttribute('aria-label', label);
  button.title = `${label} (⌘B)`;
  if (remember) localStorage.setItem(RAIL_HIDDEN_KEY, hidden ? '1' : '');
  // The thread's clamp measures the rail, so the room that just opened up (or
  // went away) has to be handed to it — a class change fires no resize.
  reflowPanes();
}

function toggleRail() {
  // A collapse down here would hide the only thing on screen.
  if (stacks()) return;
  setRail(!$('#app').classList.contains('rail-hidden'));
}

function renderRail() {
  const active = state.channels.filter((c) => !c.archived);
  const archived = state.channels.filter((c) => c.archived);

  const sections = clear($('#category-sections'));
  for (const category of state.categories) {
    sections.append(categorySection(category, active.filter((c) => c.categoryId === category.id)));
  }

  const loose = active.filter((c) => !c.categoryId);
  const list = clear($('#channel-list'));
  for (const channel of loose) list.append(channelRow(channel));
  // An empty bucket is a heading over nothing, so it goes away — but it is also
  // the only way back out of a category, which is why the CSS brings it back
  // for as long as a channel is in the air.
  $('#channels-section').classList.toggle('is-empty', loose.length === 0);
  if (loose.length === 0 && state.categories.length > 0) {
    list.append(el('li', { class: 'chan-drop' }, 'Drag a channel here to take it out of its category'));
  }

  const archivedSection = $('#archived-section');
  archivedSection.hidden = archived.length === 0;
  const archivedList = clear($('#archived-list'));
  for (const channel of archived) archivedList.append(channelRow(channel));

  renderUnreadTitle();
}

function categorySection(category, channels) {
  const list = el('ul', { class: 'channel-list', hidden: category.collapsed || undefined });
  for (const channel of channels) list.append(channelRow(channel));
  if (channels.length === 0) list.append(el('li', { class: 'chan-drop' }, 'Empty — drag channels here'));

  const section = el(
    'section',
    { class: 'rail__section rail__section--category', dataset: { category: category.id } },
    el(
      'div',
      { class: 'rail__headrow' },
      el(
        'button',
        {
          class: 'rail__heading',
          'aria-expanded': String(!category.collapsed),
          onclick: () => toggleCategory(category),
          title: category.collapsed ? 'Expand' : 'Collapse',
        },
        el('span', { class: 'rail__chev' }, category.collapsed ? '▸' : '▾'),
        el('span', { class: 'rail__label' }, category.name),
        category.collapsed && channels.length
          ? el('span', { class: 'rail__tally' }, String(channels.length))
          : null
      ),
      el(
        'button',
        { class: 'rail__cog', title: `Edit ${category.name}`, onclick: () => editCategory(category) },
        '···'
      )
    ),
    list
  );
  dropTarget(section, category.id);
  return section;
}

/**
 * Make a rail section accept channels dropped anywhere inside it — heading
 * included, so a collapsed category is still a target.
 * @param {HTMLElement} section
 * @param {string|null} categoryId
 */
function dropTarget(section, categoryId) {
  section.addEventListener('dragover', (event) => {
    if (!state.dragging) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    section.classList.add('is-drop');
  });
  section.addEventListener('dragleave', (event) => {
    if (!section.contains(event.relatedTarget)) section.classList.remove('is-drop');
  });
  section.addEventListener('drop', async (event) => {
    event.preventDefault();
    section.classList.remove('is-drop');
    // A drop that lands ends the drag; waiting for dragend would leave an empty
    // bucket on screen if the browser never sends one.
    $('#rail').classList.remove('has-drag');
    const id = state.dragging ?? event.dataTransfer.getData('text/plain');
    state.dragging = null;
    const channel = state.channels.find((c) => c.id === id);
    if (!channel || channel.categoryId === categoryId) return;
    try {
      await api.updateChannel(channel.id, { category: categoryId });
    } catch (err) {
      fail(err, 'Could not move that channel');
    }
  });
}

function channelRow(channel) {
  const unread = state.unread.get(channel.id) ?? 0;
  const isActive = state.current?.id === channel.id;
  return el(
    'li',
    {},
    el(
      'button',
      {
        class: `chan${isActive ? ' is-active' : ''}${unread && !isActive ? ' is-unread' : ''}`,
        onclick: () => selectChannel(channel.slug),
        title: channel.topic || `#${channel.slug}`,
        draggable: 'true',
        ondragstart: (event) => {
          state.dragging = channel.id;
          event.dataTransfer.setData('text/plain', channel.id);
          event.dataTransfer.effectAllowed = 'move';
          event.currentTarget.classList.add('is-dragging');
          $('#rail').classList.add('has-drag');
        },
        ondragend: (event) => {
          state.dragging = null;
          event.currentTarget.classList.remove('is-dragging');
          $('#rail').classList.remove('has-drag');
        },
      },
      el('span', { class: 'chan__hash' }, '#'),
      el('span', { class: 'chan__name' }, channel.slug),
      unread && !isActive ? el('span', { class: 'chan__count' }, String(unread)) : null
    )
  );
}

/**
 * The sessions worth showing a human.
 *
 * A session only earns a place here if `slick agent serve` answers for it.
 * The rest are automations — the cron job that posts the morning digest owns
 * a history key and a cursor exactly like an agent does, but nothing is
 * watching it, so every affordance the rail offers (open its channel, pick
 * its model, @mention it) does nothing. They speak in their channels instead.
 */
function callableSessions() {
  return state.sessions.filter((session) => session.callable);
}

/**
 * The Hermes panel, in the rail.
 *
 * Three selects and a save button, for one setting: the provider and model a
 * Hermes profile hands out by default. That is a *global* — `model.provider`
 * and `model.default` in the profile's own `config.yaml` — and the panel says
 * so, because the rail used to hold the other kind of model setting entirely
 * and the two are easy to confuse.
 *
 * Draft and saved are kept apart: nothing is written until the button is
 * pressed, so backing out is closing the panel, and a provider change that
 * leaves no valid model to pair with disables the save rather than guessing.
 */
function renderHermes() {
  renderHermesPanel();
  renderHermesLimits();
}

/**
 * The folded half: the settings, and only the settings.
 */
function renderHermesPanel() {
  const panel = clear($('#hermes-panel'));
  const h = state.hermes;
  // A read or a write is out: the selects are answers about a profile that is
  // still being settled, so they are not something to move meanwhile.
  const busy = hermes.isBusy();

  if (h.loading && !h.loaded) return void mount(panel, el('div', { class: 'hermes__note' }, 'Asking Hermes…'));

  // Which profile is being edited, and — said plainly, because it is the one
  // thing about this panel that surprises people — what that does and does not
  // reach.
  mount(
    panel,
    hermesRow(
      'Profile',
      'hermes-profile',
      h.profiles.map((p) => ({ value: p.name, label: p.isDefault ? `${p.name} (HERMES_HOME)` : p.name })),
      h.profile ?? '',
      (event) => hermes.selectProfile(event.target.value),
      { disabled: busy }
    )
  );

  if (h.error) mount(panel, hermesProblem(h.error, busy));
  else {
    const providers = withConfigured(h.providers, h.saved);
    const models = hermesModels(providers, h.draft.provider);
    mount(
      panel,
      hermesRow(
        'Provider',
        'hermes-provider',
        providers.map((p) => ({ value: p.value, label: hermesLabel(p) })),
        h.draft.provider,
        (event) => hermes.setDraft({ provider: event.target.value, model: h.draft.model }),
        { disabled: busy }
      ),
      hermesRow(
        'Model',
        'hermes-model',
        models.map((m) => ({ value: m.value, label: hermesLabel(m) })),
        h.draft.model,
        (event) => hermes.setDraft({ provider: h.draft.provider, model: event.target.value }),
        { help: models.length === 0 ? 'This provider reports no models.' : null, disabled: busy }
      ),
      hermesRow(
        'Reasoning effort',
        'hermes-effort',
        hermesEfforts(h.efforts, h.draftEffort).map((e) => ({ value: e.value, label: hermesLabel(e) })),
        h.draftEffort,
        (event) => hermes.setEffort(event.target.value),
        {
          help: 'How hard this profile thinks by default. Leave it on “Hermes default” for no opinion.',
          disabled: busy,
        }
      ),
      h.catalogError
        ? el('div', { class: 'hermes__note is-warn' }, 'Catalog unavailable — only what is configured is listed.')
        : null
    );
  }

  // What the profile is on right now, straight from its config, so the rail
  // answers the question without anyone opening a menu. It stays put through a
  // failed re-read: the last thing Hermes said is still the last thing it said.
  mount(
    panel,
    el(
      'div',
      { class: 'hermes__current', title: 'The profile default, as its config.yaml reads now' },
      h.saved.model
        ? [el('span', { class: 'hermes__model' }, trimModelName(h.saved.model)), h.saved.provider ? el('span', { class: 'hermes__prov' }, h.saved.provider) : null]
        : // "Could not be read" and "is not set" look identical from here and
          // are not the same fact, so the panel says which one it is.
          el('span', { class: 'hermes__prov' }, h.error ? 'default unknown — Hermes could not be read' : 'no default set')
    ),
    el(
      'div',
      { class: 'hermes__acts' },
      el(
        'button',
        { class: 'hermes__save', disabled: !hermes.canSave(), onclick: () => hermes.save() },
        h.saving ? 'Saving…' : 'Save default'
      ),
      hermes.dirty() && !busy
        ? el('button', { class: 'hermes__undo', onclick: () => hermes.revert() }, 'Cancel')
        : null
    ),
    el(
      'div',
      { class: 'hermes__scope' },
      'Profile-wide default for new Hermes conversations. It does not change a chat that already has its own model (',
      el('code', {}, '/model'),
      '), and a running gateway keeps its model until it is restarted.'
    ),
    // `null` here is nothing to say. It reaches the panel through `mount`
    // rather than `append` because the DOM's own `append` would draw it as the
    // word "null".
    h.note ? el('div', { class: `hermes__note is-${h.note.kind}` }, h.note.text) : null
  );
}

/**
 * The limits, in a rail section of their own directly under the Hermes one.
 *
 * They used to hang off the bottom of the panel above, which meant they were
 * only ever on screen while somebody was editing a setting — the one moment
 * they are least interesting. A number the provider owns and moves on its own
 * belongs where it can be glanced at, so the section is its own and is not
 * foldable; what folds is the settings, which stay decided.
 *
 * The section is hidden outright until the profile has been read and its
 * provider turns out to have limits at all. Loading and error states are
 * shown — once applicability is known, silence would read as "nothing left".
 */
function renderHermesLimits() {
  const usage = state.hermes.usage;
  const section = $('#hermes-limits-section');
  section.hidden = !usage?.applicable;
  const panel = clear($('#hermes-limits'));
  const head = clear($('#hermes-limits-head'));
  if (section.hidden) return;
  mount(head, hermesUsageHead(usage));
  mount(panel, hermesUsage(usage));
}

/**
 * The plan and the one control, drawn into the section's own heading row.
 *
 * The heading already says what the block is, so the head carries no title of
 * its own: just which plan the account is on and the button that costs a
 * request.
 */
function hermesUsageHead(usage) {
  if (!usage?.applicable) return null;
  const plan = usage.answer?.usage?.plan ?? null;
  const label = usage.loading ? 'Checking usage…' : 'Refresh usage';
  return [
    plan ? el('span', { class: 'hermes__usage-plan' }, plan) : null,
    el('button', {
      class: 'hermes__usage-refresh',
      disabled: usage.loading,
      'aria-label': label,
      // Said out loud, because a button that looks like it did nothing is
      // worse than one that says why: the daemon floors how often a refresh
      // reaches the provider.
      title: `${label}. Refreshes are limited to one every few seconds.`,
      onclick: () => hermes.refreshUsage(),
      html: REFRESH_ICON,
    }),
  ];
}

/** An icon rather than a word, because the heading row has no room for one. */
const REFRESH_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false" fill="none" ' +
  'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2v3.2h-3.2"/></svg>';

/**
 * What this profile's account has left, when its provider reports such a thing.
 *
 * One row per window and nothing else: how much is left and how long it lasts.
 * Relative, not a date — "for 3d 2h" is the thing being asked, and a calendar
 * stamp makes the reader do the subtraction. Absent entirely for a provider with no limits API — an empty
 * block would read as a failure to fetch something that was never there.
 */
function hermesUsage(usage) {
  if (!usage?.applicable) return null;
  const answer = usage.answer;
  const status = usageStatus(answer);
  const rows = usageLimitRows(answer?.usage);
  const banked = bankedResetLine(answer?.usage?.bankedResets ?? null);

  if (usage.loading && !usage.loaded) {
    return el('div', { class: 'hermes__usage' }, el('div', { class: 'hermes__note' }, 'Asking the provider…'));
  }

  return el(
    'div',
    { class: 'hermes__usage' },
    status.kind === 'ok'
      ? // Both windows on one line, split by a visible slash: they are read as a
        // pair — "how much is left now" against "how much is left this week" —
        // and stacking them made the rail scroll for two short sentences.
        el(
          'div',
          { class: 'hermes__limits-line' },
          rows.map((row, i) => [
            i ? el('span', { class: 'hermes__limit-sep', 'aria-hidden': 'true' }, '/') : null,
            el(
              'div',
              { class: 'hermes__limit' },
              el('span', { class: 'hermes__limit-label' }, `${row.label}:`),
              el('span', { class: 'hermes__limit-value' }, usageLimitText(row))
            ),
          ])
        )
      : // Not a meter, and not silence: "not signed in", "this provider has no
        // limits API" and "it did not answer" are three different situations
        // and only one of them is worth a retry.
        el(
          'div',
          { class: `hermes__note ${status.kind === 'unsupported' ? '' : 'is-warn'}`.trim() },
          el('span', {}, status.text),
          status.retryable
            ? el(
                'button',
                { class: 'hermes__retry', disabled: usage.loading, onclick: () => hermes.refreshUsage() },
                usage.loading ? 'Checking…' : 'Try again'
              )
            : null
        ),
    banked ? el('div', { class: 'hermes__usage-banked' }, banked) : null,
    // Whatever else Hermes had to say — a credits balance, say. Passed through
    // rather than parsed: it is the provider's sentence and the panel is not
    // the place to second-guess it. Its own two phrasings of the banked resets
    // are the one exception, because the line above already says that.
    usageDetailLines(answer?.usage?.details).map((line) =>
      el('div', { class: 'hermes__usage-detail' }, line)
    ),
    answer?.note ? el('div', { class: 'hermes__note is-warn' }, answer.note) : null
  );
}

/** A label that admits when a value is only here because the config names it. */
const hermesLabel = (entry) => (entry.unlisted ? `${entry.label} (not in catalog)` : entry.label);

/**
 * A read that failed, and the one thing worth offering: ask again.
 *
 * Reading is the only thing it does — nothing about a profile is written by a
 * retry — so a Hermes that was busy, restarting, or briefly unreadable stops
 * being a panel someone has to close and reopen to get out of.
 */
const hermesProblem = (text, busy) =>
  el(
    'div',
    { class: 'hermes__note is-warn' },
    el('span', {}, text),
    el(
      'button',
      { class: 'hermes__retry', disabled: busy, title: 'Read this profile again', onclick: () => hermes.retry() },
      busy ? 'Retrying…' : 'Retry'
    )
  );

function hermesRow(label, id, options, value, onchange, { help = null, disabled = false } = {}) {
  const select = el(
    'select',
    { id, class: 'hermes__select', onchange },
    options.map((option) => el('option', { value: option.value }, option.label))
  );
  // Set after the options exist, and left blank rather than snapped to the
  // first entry when the value is not among them — a select that silently
  // reads as something else is how the wrong thing gets saved.
  select.value = value ?? '';
  if (options.length === 0 || disabled) select.disabled = true;
  return el(
    'label',
    { class: 'hermes__field' },
    el('span', { class: 'hermes__label' }, label),
    select,
    help ? el('span', { class: 'hermes__help' }, help) : null
  );
}

/**
 * The model this session's `serve` watcher is set to call, or null for
 * whatever the agent picks by itself. Mirrors `readServeModel` in the core —
 * underscore-prefixed because it is Slick's bookkeeping, not agent memory.
 */
function serveModel(session) {
  const value = session.state?._serveModel;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * How hard this session's watcher is set to think, or null for whatever the
 * agent's own configuration says. Mirrors `readServeEffort` in the core.
 */
function serveEffort(session) {
  const value = session.state?._serveEffort;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The models this agent told `serve` it can run (`<cmd> --list-models`), in
 * the shape the picker wants. Empty for an agent that never answered — those
 * get a text box instead, because a name typed by hand still works.
 */
function modelChoices(session) {
  const stored = session.state?._serveModelChoices;
  if (!Array.isArray(stored)) return [];
  return stored
    .map((entry) => (typeof entry === 'string' ? { id: entry, label: entry, group: null } : entry))
    .filter((entry) => entry && typeof entry.id === 'string')
    .map((entry) => ({ id: entry.id, label: entry.label || entry.id, group: entry.group ?? null }));
}

/**
 * What the rail calls the current model: the agent's own name for it.
 *
 * Untrimmed, because `messageModel` reads this too and there it is an
 * identity rather than a label. Its two callers shorten it themselves where
 * they paint it.
 */
function modelLabel(session, model) {
  if (!model) return 'default model';
  return modelChoices(session).find((choice) => choice.id === model)?.label ?? model;
}

/** The sentinel option that trades the menu for a text box. */
const CUSTOM_MODEL = '\u0000custom';

/**
 * Change the model without touching a terminal. The watcher re-reads this on
 * its next pass, so there is nothing to restart — and threads keep the
 * conversations they already have; only the model answering them changes.
 */
async function editAgentModel(session) {
  const current = serveModel(session);
  const choices = modelChoices(session);
  const wanted = choices.length > 0 ? await pickModel(session, current, choices) : await typeModel(current);
  if (wanted === null || wanted === (current ?? '')) return;
  try {
    const model = await api.setAgentModel(session.key, wanted || null);
    await refreshSessions();
    toast(model ? `${session.agentId} → ${model}` : `${session.agentId} is back on its default model`);
  } catch (err) {
    fail(err, 'Could not change that model');
  }
}

/**
 * Change how hard the agent thinks. Free text on purpose: the levels are the
 * agent's own vocabulary — `claude` takes five, Hermes eight — and a menu
 * built here would be a guess that goes stale.
 */
async function editAgentEffort(session) {
  const current = serveEffort(session);
  const values = await openModal({
    title: 'Reasoning effort',
    okLabel: 'Set effort',
    fields: [
      {
        name: 'effort',
        label: 'Effort',
        value: current ?? '',
        placeholder: 'e.g. high',
        help:
          'Passed to the agent on the next message it answers, and shown on the reply beside the model. ' +
          'The levels are the agent&rsquo;s own &mdash; claude takes low, medium, high, xhigh, max. ' +
          'Leave it empty for whatever the agent is configured to do.',
      },
    ],
  });
  if (!values) return;
  const wanted = (values.effort ?? '').trim();
  if (wanted === (current ?? '')) return;
  try {
    const level = await api.setAgentEffort(session.key, wanted || null);
    await refreshSessions();
    toast(level ? `${session.agentId} → thinking ${level}` : `${session.agentId} is back on its default effort`);
  } catch (err) {
    fail(err, 'Could not change that effort level');
  }
}

/** A menu of what the agent says it can run. @returns {Promise<string|null>} */
async function pickModel(session, current, choices) {
  // A model set before the list was fetched — or by hand — is still what this
  // agent is running, so it belongs in the menu rather than silently reset.
  const known = choices.some((choice) => choice.id === current);
  const values = await openModal({
    title: `Model for ${session.agentId}`,
    okLabel: 'Set model',
    fields: [
      {
        name: 'model',
        label: 'Model',
        type: 'select',
        value: current ?? '',
        options: [
          { value: '', label: "Default — whatever the agent runs on its own" },
          ...(current && !known ? [{ value: current, label: `${current} (set by hand)` }] : []),
          ...choices.map((choice) => ({ value: choice.id, label: choice.label, group: choice.group })),
          { value: CUSTOM_MODEL, label: 'Something else…' },
        ],
        help: `${choices.length} model(s), as the agent last reported them. Takes effect on the next message it answers.`,
      },
    ],
  });
  if (!values) return null;
  return values.model === CUSTOM_MODEL ? typeModel(current) : values.model;
}

/** The fallback for an agent that never advertised a list. @returns {Promise<string|null>} */
async function typeModel(current) {
  const values = await openModal({
    title: 'Model',
    okLabel: 'Set model',
    fields: [
      {
        name: 'model',
        label: 'Model',
        value: current ?? '',
        placeholder: 'e.g. anthropic/claude-sonnet-4',
        help:
          'Passed to the agent binary as <code>--model</code> on the next message it answers. ' +
          'Leave it empty for whatever the agent runs by default.',
      },
    ],
  });
  return values ? (values.model ?? '').trim() : null;
}

function modelPickerProviders(session) {
  return groupModelChoices(modelChoices(session));
}

/**
 * The Slick-side `/model` picker. Hermes' detached command bridge cannot mutate
 * a live session, so the final selection goes through the same authorized model
 * endpoint as the agent-rail model button.
 */
async function runModelPicker(args, outputId, session) {
  const parsed = parseModelCommandArgs(args);
  const current = serveModel(session);
  const providers = modelPickerProviders(session);

  if (providers.length === 0) {
    const wanted = await typeModel(current);
    await applyCommandModel(session, wanted, '', null, outputId);
    return;
  }

  const defaults = modelPickerDefaults(providers, {
    provider: parsed.provider,
    name: parsed.name,
    current,
  });
  const modelOptions = (provider) => [
    ...modelsForProvider(providers, provider).map((model) => ({
      value: model.value,
      label: model.label,
    })),
    { value: CUSTOM_MODEL, label: 'Something else…' },
  ];
  const providerOptions = providers.map((entry) => ({
    value: entry.value,
    label: `${entry.label} · ${entry.models.length} model${entry.models.length === 1 ? '' : 's'}`,
  }));

  const values = await openModal({
    title: 'Hermes model',
    body: 'Choose the provider and model. Both selections are sent as <code>--provider</code> and <code>--name</code>.',
    okLabel: 'Switch model',
    fields: [
      {
        name: 'provider',
        label: 'Provider (--provider)',
        type: 'select',
        value: defaults.provider,
        options: providerOptions,
        required: true,
        onchange: (event) => {
          const modelInput = $('#field-name');
          if (!modelInput) return;
          const nextProvider = event.target.value;
          const nextModels = modelsForProvider(providers, nextProvider);
          modelInput.replaceChildren(
            ...modelOptions(nextProvider).map((option) => el('option', { value: option.value }, option.label))
          );
          modelInput.value = nextModels[0]?.value ?? CUSTOM_MODEL;
        },
      },
      {
        name: 'name',
        label: 'Model (--name)',
        type: 'select',
        value: defaults.name || CUSTOM_MODEL,
        options: modelOptions(defaults.provider),
        required: true,
        help: 'The model list comes from the running agent. Choose “Something else…” to enter a name manually.',
      },
    ],
  });
  if (!values) return;

  const provider = values.provider;
  let choice = findModelChoice(providers, provider, values.name);
  let wanted = choice?.value ?? null;
  if (values.name === CUSTOM_MODEL) wanted = await typeModel(current);
  if (!choice && values.name !== CUSTOM_MODEL) {
    showEphemeral(outputId, '/model', 'That model is not in the selected provider catalog.', 'warn');
    return;
  }
  await applyCommandModel(session, wanted, provider, choice, outputId);
}

async function applyCommandModel(session, wanted, provider, choice, outputId) {
  if (wanted === null || wanted === undefined) return;
  const normalized = String(wanted).trim();
  if (normalized === (serveModel(session) ?? '')) return;

  showEphemeral(outputId, '/model', 'Switching model…');
  try {
    const model = await api.setAgentModel(session.key, normalized || null);
    await refreshSessions();
    if (!model) {
      showEphemeral(outputId, '/model', 'Hermes is back on its configured default model.');
      return;
    }
    const label = choice?.label ?? model;
    const via = provider ? ` via ${provider}` : '';
    const preview = choice ? `\n\n\`${modelCommandPreview(provider, choice)}\`` : '';
    showEphemeral(outputId, '/model', `Hermes will use **${label}**${via}.${preview}`);
  } catch (err) {
    showEphemeral(outputId, '/model', err.message ?? String(err), 'warn');
  }
}

/**
 * Known agents for the `@mention` picker: one entry per agent id, most
 * recently active first. Only the ones that answer — offering an automation
 * here would spell its name correctly and still be ignored.
 */
function agentSuggestions() {
  const byId = new Map();
  for (const session of callableSessions()) {
    const current = byId.get(session.agentId);
    if (!current || (session.lastSeenAt ?? 0) > (current.lastSeenAt ?? 0)) byId.set(session.agentId, session);
  }
  return [...byId.values()]
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
    .map((session) => ({
      id: session.agentId,
      hint: session.channelSlug ? `#${session.channelSlug} · ${ago(session.lastSeenAt)}` : ago(session.lastSeenAt),
    }));
}

function renderChannelHeader() {
  const channel = state.current;
  $('#chan-title').textContent = channel ? `#${channel.slug}` : 'Slick';
  $('#chan-topic').textContent = channel?.topic ?? '';
  $('#btn-archive-channel').textContent = channel?.archived ? 'Unarchive' : 'Archive';
  const disabled = !channel;
  for (const id of ['#btn-edit-channel', '#btn-archive-channel', '#btn-delete-channel']) {
    $(id).disabled = disabled;
  }
  $('#composer-input').disabled = !channel || channel.archived;
  $('#composer-input').placeholder = !channel
    ? 'Pick a channel'
    : channel.archived
      ? 'This channel is archived'
      : `Message #${channel.slug}`;
}

function renderUnreadTitle() {
  let total = 0;
  for (const [id, count] of state.unread) if (id !== state.current?.id) total += count;
  document.title = total > 0 ? `(${total}) Slick` : 'Slick';
}

// =============================================================== behaviour ===

/**
 * @param {{flash?: string, reveal?: boolean}} [opts] `reveal: false` loads the
 *   channel without bringing it to the front — how the phone restores the last
 *   channel behind the list on boot.
 */
async function selectChannel(ref, { flash, reveal = true } = {}) {
  const channel = state.channels.find((c) => c.slug === ref || c.id === ref);
  if (!channel) return;
  state.current = channel;
  state.unread.delete(channel.id);
  localStorage.setItem(LAST_CHANNEL_KEY, channel.slug);
  closeThread();
  renderRail();
  renderChannelHeader();
  if (reveal) openChannel();
  await loadMessages();
  scrollToBottom(true);
  if (flash) flashMessage(flash);
}

async function loadMessages() {
  const result = await api.listMessages(state.current.slug, { limit: 60 });
  state.messages = result.messages;
  state.hasMore = result.hasMore;
  state.oldestSeq = result.oldestSeq;
  renderTimeline();
}

async function loadOlder() {
  if (!state.hasMore || state.oldestSeq == null) return;
  const timeline = $('#timeline');
  const previousHeight = timeline.scrollHeight;
  const result = await api.listMessages(state.current.slug, { limit: 60, before: state.oldestSeq });
  state.messages = [...result.messages, ...state.messages];
  state.hasMore = result.hasMore;
  state.oldestSeq = result.oldestSeq ?? state.oldestSeq;
  renderTimeline({ sameChannel: true });
  // Keep the reading position steady while content grows above it.
  timeline.scrollTop = timeline.scrollHeight - previousHeight;
}

function scrollToBottom(force = false) {
  const timeline = $('#timeline');
  if (!force && !state.atBottom) return;
  timeline.scrollTop = timeline.scrollHeight;
  state.atBottom = true;
  $('#btn-jump').hidden = true;
}

function flashMessage(id) {
  const node = nodes.get(id);
  if (!node) return;
  node.scrollIntoView({ block: 'center' });
  node.classList.add('is-flash');
  setTimeout(() => node.classList.remove('is-flash'), 1500);
}

// -------------------------------------------------------------- composing ---

async function send(text) {
  if (!state.current || !text.trim()) return;
  try {
    await api.postMessage(state.current.slug, { text });
    scrollToBottom(true);
  } catch (err) {
    fail(err, 'Could not send that');
  }
}

async function sendThreadReply(text) {
  if (!state.thread || !text.trim()) return;
  try {
    await api.replyTo(state.thread.root.id, { text });
  } catch (err) {
    fail(err, 'Could not post that reply');
  }
}

/**
 * Inline editor. `scope` says which pane the click came from, so editing the
 * thread root edits the copy you are looking at rather than the one further
 * up the channel.
 * @param {string} id
 * @param {'timeline'|'thread'} scope
 */
function startEdit(id, scope = 'timeline') {
  const pool =
    scope === 'thread' && state.thread ? [state.thread.root, ...state.thread.replies] : state.messages;
  const message = pool.find((m) => m.id === id);
  if (!message) return;
  const host = scope === 'thread' ? $('#thread-body') : $('#messages');
  const row = host.querySelector(`.msg[data-id="${CSS.escape(id)}"]`);
  if (!row) return;

  const body = row.querySelector('.msg__body');
  if (!body || row.querySelector('.msg__edit')) return;

  const textarea = el('textarea', {}, message.text);
  const editor = el(
    'div',
    { class: 'msg__edit' },
    textarea,
    el(
      'div',
      { class: 'row' },
      el('span', { class: 'hint' }, 'Enter to save · Esc to cancel'),
      el('button', { class: 'btn btn--ghost', type: 'button', onclick: cancel }, 'Cancel'),
      el('button', { class: 'btn btn--primary', type: 'button', onclick: save }, 'Save')
    )
  );
  body.replaceWith(editor);
  state.editing = id;
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  autosize(textarea, 400);

  function cancel() {
    state.editing = null;
    editor.replaceWith(body);
  }
  async function save() {
    const text = textarea.value.trim();
    state.editing = null;
    if (!text || text === message.text) return cancel();
    try {
      await api.editMessage(id, { text });
    } catch (err) {
      cancel();
      fail(err, 'Could not save that edit');
    }
  }
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      save();
    }
  });
}

async function removeMessage(message) {
  // A message with replies leaves a tombstone so the thread keeps its anchor;
  // anything else disappears completely.
  const hasReplies = message.replyCount > 0;
  const okay = await confirmModal({
    title: 'Delete message?',
    body: hasReplies
      ? `This message has ${message.replyCount} repl${message.replyCount === 1 ? 'y' : 'ies'}. The replies stay; the message itself becomes "deleted".`
      : 'This cannot be undone.',
    okLabel: 'Delete',
  });
  if (!okay) return;
  try {
    await api.deleteMessage(message.id, !hasReplies);
  } catch (err) {
    fail(err, 'Could not delete that');
  }
}

async function copyId(id) {
  await copyToClipboard(id);
  toast(`Copied ${id}`);
}

// ---------------------------------------------------------------- threads ---

/**
 * The layer only goes on once the fetch succeeds — a thread that failed to
 * open is not something to back out of.
 */
/**
 * Jump to a channel, and optionally a thread inside it. The one place that
 * knows how a push notification's target becomes screen state.
 */
async function goTo(channel, thread) {
  if (channel) {
    const target = state.channels.find((c) => c.slug === channel && !c.archived);
    // A notification can outlive its channel. Land on the workspace rather
    // than failing silently — the message body was already in the banner.
    if (target) await selectChannel(target.slug, { reveal: true });
  }
  if (thread) await openThread(thread);
}

/**
 * A cold start from a notification carries its target in the query string.
 * Consume it once and strip it: a later reload should not re-open a thread
 * the user has since left, and the params would outlive the tap that set them.
 */
function takeDeepLink() {
  const url = new URL(location.href);
  const channel = url.searchParams.get('channel');
  const thread = url.searchParams.get('thread');
  if (!channel && !thread) return null;
  url.searchParams.delete('channel');
  url.searchParams.delete('thread');
  history.replaceState(history.state, '', url);
  return { channel, thread };
}

async function openThread(rootId) {
  const wasOpen = state.thread !== null;
  try {
    state.thread = await api.thread(rootId);
  } catch (err) {
    return fail(err, 'Could not open that thread');
  }
  $('#app').classList.add('with-thread');
  $('#thread').hidden = false;
  // Jumping straight from one thread to another stays on the same layer.
  if (!wasOpen && stacks()) pushLayer('thread');
  // Opening one has no reading position to preserve, so this is the one call
  // that still jumps to the bottom unconditionally.
  renderThread({ stick: true });
}

/** Close enough to the bottom of a scroller to count as following it. */
const nearBottom = (host) => host.scrollHeight - host.scrollTop - host.clientHeight < NEAR_BOTTOM_PX;

function renderThread({ stick } = {}) {
  if (!state.thread) return;
  const { root, replies } = state.thread;
  const pane = $('#thread-body');
  // Measured before the rebuild throws the pane away. This used to jump to the
  // bottom every time, which was harmless when a redraw meant a reply had
  // landed — but a draft redraws the pane as it grows, and yanking a reader
  // who has scrolled back down again on every frame is not a redraw, it is a
  // fight.
  const follow = stick ?? nearBottom(pane);
  // And where they were, for when they are not following. `clear()` empties
  // the pane, which clamps its scrollTop to 0, so leaving the restore to the
  // `follow` branch alone would send a reader who had scrolled up back to the
  // top of the thread every time anything at all redrew it.
  const prevTop = pane.scrollTop;
  $('#thread-sub').textContent = `#${state.thread.channel.slug}`;
  const host = clear(pane);
  host.append(messageRow(root, null, { inThread: true, standalone: true }));
  host.append(
    el(
      'div',
      { class: 'thread__divider' },
      replies.length === 0 ? 'No replies yet' : `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`
    )
  );
  let previous = null;
  for (const reply of replies) {
    host.append(messageRow(reply, previous, { inThread: true }));
    previous = reply;
  }
  const typers = typingAgents(root.id);
  if (state.drafts.has(root.id)) host.append(draftBubble(root.id, 'thread'));
  else if (typers.length > 0) host.append(typingBubble(typers));
  host.scrollTop = follow ? host.scrollHeight : prevTop;
}

function closeThread({ viaPopstate = false } = {}) {
  if (!state.thread) return;
  state.thread = null;
  $('#app').classList.remove('with-thread');
  $('#thread').hidden = true;
  if (!viaPopstate) dropLayer('thread');
}

// --------------------------------------------------------------- channels ---

/** The category picker shared by the create and edit dialogs. */
const NEW_CATEGORY = '__new__';

function categoryField(value = '') {
  return {
    name: 'category',
    label: 'Category',
    type: 'select',
    value,
    options: [
      { value: '', label: 'No category' },
      ...state.categories.map((c) => ({ value: c.id, label: c.name })),
      { value: NEW_CATEGORY, label: '＋ New category…' },
    ],
  };
}

/**
 * Turn what the picker returned into something the API takes. `null` clears
 * the category; picking "New category…" asks for a name first.
 * @returns {Promise<string|null|undefined>} undefined if the prompt was cancelled
 */
async function resolveCategoryChoice(choice) {
  if (choice !== NEW_CATEGORY) return choice || null;
  const created = await createCategory({ select: false });
  return created ? created.id : undefined;
}

async function createChannel() {
  const values = await openModal({
    title: 'Create a channel',
    okLabel: 'Create',
    fields: [
      {
        name: 'slug',
        label: 'Name',
        placeholder: 'e.g. deploys',
        required: true,
        help: 'Lowercase letters, digits, <code>-</code> and <code>_</code>.',
      },
      { name: 'topic', label: 'Topic', placeholder: 'What is this channel about?' },
      categoryField(state.current?.categoryId ?? ''),
    ],
  });
  if (!values) return;
  try {
    const category = await resolveCategoryChoice(values.category);
    if (category === undefined) return;
    const channel = await api.createChannel({ slug: values.slug, topic: values.topic, category });
    await refreshChannels();
    await selectChannel(channel.slug);
    toast(`Created #${channel.slug}`);
  } catch (err) {
    fail(err, 'Could not create that channel');
  }
}

async function editChannel() {
  const channel = state.current;
  if (!channel) return;
  const values = await openModal({
    title: `Edit #${channel.slug}`,
    fields: [
      { name: 'slug', label: 'Name', value: channel.slug, required: true },
      { name: 'topic', label: 'Topic', value: channel.topic },
      { name: 'purpose', label: 'Purpose', type: 'textarea', value: channel.purpose, rows: 3 },
      categoryField(channel.categoryId ?? ''),
    ],
  });
  if (!values) return;
  try {
    const category = await resolveCategoryChoice(values.category);
    if (category === undefined) return;
    const updated = await api.updateChannel(channel.id, {
      slug: values.slug,
      name: values.slug,
      topic: values.topic,
      purpose: values.purpose,
      category,
    });
    await refreshChannels();
    state.current = state.channels.find((c) => c.id === updated.id) ?? updated;
    renderRail();
    renderChannelHeader();
    toast('Channel updated');
  } catch (err) {
    fail(err, 'Could not update that channel');
  }
}

// ------------------------------------------------------------- categories ---

/**
 * @param {{select?: boolean}} [opts] `select: false` when this is a step inside
 *   another dialog rather than the thing the user asked for.
 */
async function createCategory({ select = true } = {}) {
  const values = await openModal({
    title: 'New category',
    okLabel: 'Create',
    fields: [
      {
        name: 'name',
        label: 'Name',
        placeholder: 'e.g. Engineering',
        required: true,
        help: 'A section in the sidebar. Channels can be dragged in and out of it.',
      },
    ],
  });
  if (!values) return null;
  try {
    const category = await api.createCategory({ name: values.name });
    await refreshCategories();
    renderRail();
    if (select) toast(`Created ${category.name}`);
    return category;
  } catch (err) {
    fail(err, 'Could not create that category');
    return null;
  }
}

async function editCategory(category) {
  const others = state.categories.filter((c) => c.id !== category.id);
  const index = state.categories.findIndex((c) => c.id === category.id);
  const values = await openModal({
    title: `Edit ${category.name}`,
    fields: [
      { name: 'name', label: 'Name', value: category.name, required: true },
      {
        name: 'after',
        label: 'Place it',
        type: 'select',
        value: index > 0 ? state.categories[index - 1].id : '',
        options: [{ value: '', label: 'First' }, ...others.map((c) => ({ value: c.id, label: `After ${c.name}` }))],
      },
    ],
    extra: [{ label: 'Delete', value: 'delete', danger: true }],
  });
  if (!values) return;
  if (values._action === 'delete') return deleteCategory(category);
  try {
    if (values.name !== category.name) await api.updateCategory(category.id, { name: values.name });
    const order = [...others.map((c) => c.id)];
    order.splice(values.after ? order.indexOf(values.after) + 1 : 0, 0, category.id);
    if (order.some((id, i) => state.categories[i]?.id !== id)) await api.reorderCategories(order);
    await refreshCategories();
    renderRail();
    toast('Category updated');
  } catch (err) {
    fail(err, 'Could not update that category');
  }
}

async function deleteCategory(category) {
  const inside = state.channels.filter((c) => c.categoryId === category.id).length;
  const okay = await confirmModal({
    title: `Delete ${category.name}?`,
    body: 'The section goes away. Every channel in it stays exactly where it is.',
    note: inside > 0 ? `${inside} channel${inside === 1 ? '' : 's'} will move to "Channels".` : undefined,
    okLabel: 'Delete category',
  });
  if (!okay) return;
  try {
    await api.deleteCategory(category.id);
    await Promise.all([refreshCategories(), refreshChannels()]);
    renderRail();
    toast(`Deleted ${category.name}`);
  } catch (err) {
    fail(err, 'Could not delete that category');
  }
}

async function toggleCategory(category) {
  // Optimistic: the fold should happen under the cursor, not a round trip later.
  category.collapsed = !category.collapsed;
  renderRail();
  try {
    await api.updateCategory(category.id, { collapsed: category.collapsed });
  } catch (err) {
    category.collapsed = !category.collapsed;
    renderRail();
    fail(err, 'Could not save that');
  }
}

async function toggleArchive() {
  const channel = state.current;
  if (!channel) return;
  try {
    await api.archiveChannel(channel.id, !channel.archived);
    await refreshChannels();
    state.current = state.channels.find((c) => c.id === channel.id) ?? null;
    renderRail();
    renderChannelHeader();
    toast(channel.archived ? `#${channel.slug} restored` : `#${channel.slug} archived`);
  } catch (err) {
    fail(err, 'Could not archive that channel');
  }
}

async function deleteChannel() {
  const channel = state.current;
  if (!channel) return;
  const count = channel.messageCount ?? 0;
  const okay = await confirmModal({
    title: `Delete #${channel.slug}?`,
    body: 'The channel and everything in it goes away for good.',
    note: count > 0 ? `${count} message${count === 1 ? '' : 's'} will be deleted too.` : undefined,
    okLabel: 'Delete channel',
  });
  if (!okay) return;
  try {
    await api.deleteChannel(channel.id, true);
    await refreshChannels();
    const next = state.channels.find((c) => !c.archived);
    state.current = null;
    if (next) await selectChannel(next.slug);
    else {
      renderRail();
      renderChannelHeader();
      renderTimeline();
    }
    toast(`Deleted #${channel.slug}`);
  } catch (err) {
    fail(err, 'Could not delete that channel');
  }
}

async function refreshChannels() {
  state.channels = await api.listChannels(true);
}

async function refreshCategories() {
  state.categories = await api.listCategories();
}

async function refreshSessions() {
  try {
    const before = modelFingerprint();
    state.sessions = await api.agentSessions();
    // Messages usually render before the sessions behind them are known, and a
    // human can switch a model mid-conversation — either way the chips already
    // on screen are stale until we say otherwise.
    if (modelFingerprint() !== before) {
      syncModelChips();
      if (state.thread) renderThread();
    }
  } catch {
    /* the agent list is decoration; never block the app on it */
  }
}

// ------------------------------------------------------------------ events ---

function bumpUnread(channelId) {
  if (!channelId || channelId === state.current?.id) return;
  state.unread.set(channelId, (state.unread.get(channelId) ?? 0) + 1);
  renderRail();
}

/**
 * Who is working right now, asked rather than waited for.
 *
 * The stream carries typing as a change; a tab that opens in the middle of a
 * reply never saw it, and shows nothing for the rest of the call. So the app
 * asks once on boot and again whenever a dropped stream comes back, and
 * reconciles rather than merges: an agent that stopped while we were away has
 * to stop here too.
 */
async function refreshTyping() {
  let current;
  try {
    current = await api.typing();
  } catch {
    return; // an older daemon, or one that is down: keep what we have
  }
  // Only ever adds. Switching an indicator *off* is the event stream's job —
  // a reconnect replays the "off" it missed — and the snapshot cannot see a
  // watcher whose lock lives on another machine, so a gap in it is not proof
  // that nobody is working. What it cannot correct, the timer will.
  for (const entry of current) setTyping(entry.threadId, entry.agentId, true);

  // The scratchpad has exactly the same hole in it, and the same fix. It is
  // asked for separately rather than in parallel because a daemon old enough
  // not to have this route still has the typing one, and losing typing to a
  // 404 on thinking would be a poor trade.
  let scratch;
  try {
    scratch = await api.thinkingSnapshot();
  } catch {
    return;
  }
  for (const entry of scratch) {
    if (!entry?.threadId || !entry.think) continue;
    setDraft(entry.threadId, { agentId: entry.agentId, think: entry.think });
    redrawThread(entry.threadId);
  }
}

function typingAgents(threadId) {
  return [...(state.typing.get(threadId)?.keys() ?? [])];
}

/** `off` normally arrives from the agent itself; the timeout is only a backstop for a process that died mid-call. */
function setTyping(threadId, agentId, on) {
  let entry = state.typing.get(threadId);
  if (on) {
    if (!entry) {
      entry = new Map();
      state.typing.set(threadId, entry);
    }
    clearTimeout(entry.get(agentId));
    entry.set(
      agentId,
      setTimeout(() => setTyping(threadId, agentId, false), TYPING_TIMEOUT_MS)
    );
  } else if (entry) {
    clearTimeout(entry.get(agentId));
    entry.delete(agentId);
    if (entry.size === 0) state.typing.delete(threadId);
  }
  redrawThread(threadId);
}

/**
 * Redraw the two places a thread's live indicator can show: the root's row in
 * the channel, and the thread pane when it happens to be that thread. Pulled
 * out of `setTyping` so a draft lands in exactly the same places by exactly
 * the same rules — including the one that matters, which is that a row being
 * edited is left alone rather than rebuilt out from under the editor.
 */
function redrawThread(threadId) {
  const message = state.editing === threadId ? null : state.messages.find((m) => m.id === threadId);
  if (message) patchMessage(message);
  if (state.thread?.root.id === threadId) renderThread();
}

/**
 * Start or extend the draft for a thread. Nothing here draws: `setDraft` is
 * called from the per-token path as well as the per-step one, and a render
 * per token is the thing this whole design exists to avoid.
 */
function setDraft(threadId, { agentId, think } = {}) {
  let draft = state.drafts.get(threadId);
  if (!draft) {
    draft = { text: '', think: emptyThink(), agentId: agentId ?? 'agent', at: Date.now(), timer: null };
    state.drafts.set(threadId, draft);
  }
  if (agentId) draft.agentId = agentId;
  if (think) draft.think = applyChunk(draft.think, think);
  draft.at = Date.now();
  // Same backstop as typing, for the same reason: the "done" frame is
  // ephemeral, so a producer that dies mid-answer sends nothing at all.
  clearTimeout(draft.timer);
  draft.timer = setTimeout(() => clearDraft(threadId), TYPING_TIMEOUT_MS);
  return draft;
}

/** The answer landed, or gave up. Either way the placeholder goes. */
function clearDraft(threadId) {
  const draft = state.drafts.get(threadId);
  if (!draft) return;
  clearTimeout(draft.timer);
  state.drafts.delete(threadId);
  thinkUi.delete(`draft-${threadId}`);
  thinkSaid.delete(`draft-${threadId}`);
  redrawThread(threadId);
}

/** Every draft bubble on screen for a thread — at most the channel row and the pane. */
const draftNodes = (threadId) => [...document.querySelectorAll(`.msg--draft[data-thread="${CSS.escape(threadId)}"]`)];

/**
 * A token, or a handful of them, written straight into the node.
 *
 * This is the whole point of a draft having its own state. `renderThread`
 * clears the pane and rebuilds the root and every reply; `patchMessage`
 * rebuilds a whole row. Either one per delta would mean a full rebuild and a
 * scroll jump several times a second, on a pane the reader is trying to read.
 * So the first frame pays for one render to put a bubble on screen, and every
 * frame after it mutates that bubble in place and returns.
 */
function applyDelta(event) {
  const threadId = event.threadId;
  if (!threadId) return;
  if (event.done) {
    clearDraft(threadId);
    return;
  }
  const fresh = !state.drafts.has(threadId);
  const draft = setDraft(threadId, { agentId: event.actor?.id, think: event.think });
  if (typeof event.text === 'string') draft.text += event.text;

  // Nothing in this app has ever re-scrolled for a row that was already on
  // screen and simply got taller, because until now nothing grew. A draft does,
  // a few characters at a time, and a reader parked at the bottom would
  // otherwise watch the answer walk up and off the screen. Both measurements
  // are taken before the node changes, or "was I at the bottom" answers itself.
  const pane = state.thread?.root.id === threadId ? $('#thread-body') : null;
  const followPane = pane ? nearBottom(pane) : false;
  const followTimeline = state.atBottom;

  if (fresh) {
    redrawThread(threadId);
  } else {
    for (const node of draftNodes(threadId)) {
      const body = node.querySelector('.msg__body--draft');
      if (body && draft.text) {
        // The dots were standing in for text that had not arrived; it has.
        body.classList.remove('msg__body--typing');
        body.innerHTML = renderText(draft.text);
      }
      // Steps move far more slowly than characters, so the box is only rebuilt
      // on a frame that actually carried one — and never while the reader has
      // its disclosure focused, since replacing the node would drop the focus.
      const box = node.querySelector('.think');
      if (event.think && box && !box.contains(document.activeElement)) {
        const surface = node.closest('#thread-body') ? 'thread' : 'timeline';
        box.replaceWith(thinkingView(draft.think, `draft-${threadId}`, surface));
      } else if (event.think && !box) {
        redrawThread(threadId);
        break;
      }
    }
  }

  if (followTimeline) scrollToBottom();
  if (followPane && pane) pane.scrollTop = pane.scrollHeight;
}

async function handleEvent(event) {
  if (event.type === 'stream.ready') {
    state.seq = event.seq;
    return;
  }
  if (event.type === 'agent.delta') {
    // Broadcast with no `id:` line and so no seq of its own: a delta is the one
    // frame in the app that was never written down, and there is nothing to
    // resume it from. It returns above the bookkeeping below rather than
    // through it, so a stray seq on an ephemeral frame can never move the
    // position we would reconnect at.
    applyDelta(event);
    return;
  }
  state.seq = Math.max(state.seq, event.seq ?? 0);

  switch (event.type) {
    case 'message.created': {
      const message = event.message;
      if (!message) return;
      // Whatever was streaming into a bubble is now a real message carrying
      // the whole text, so the stand-in goes before the row that replaces it
      // is drawn — but only for the agent that was writing it. A human
      // replying into the thread mid-answer must not wipe the answer. A
      // thread with no draft costs one map lookup.
      const drafting = state.drafts.get(message.threadId);
      if (drafting && drafting.agentId === message.author?.id) clearDraft(message.threadId);
      if (message.parentId) {
        if (state.thread?.root.id === message.parentId) {
          state.thread.replies.push(message);
          renderThread();
        }
        // Keep the "N replies" chip on the root message honest.
        const root = state.messages.find((m) => m.id === message.parentId);
        if (root) {
          patchMessage({
            ...root,
            replyCount: root.replyCount + 1,
            lastReplyAt: message.createdAt,
          });
        }
        if (message.channelId !== state.current?.id) bumpUnread(message.channelId);
      } else if (message.channelId === state.current?.id) {
        const stick = state.atBottom;
        appendMessage(message);
        if (stick) scrollToBottom(true);
        else showJump();
      } else {
        bumpUnread(message.channelId);
      }
      if (message.author.kind === 'agent') refreshSessions();
      // A finished agent turn is the one thing in the app that spends the
      // account, so the limits in the rail go stale exactly here. Past the
      // daemon's cache, because the whole point is the number it holds is now
      // one turn old.
      if (shouldRefreshUsageAfter(message, state.hermes.saved.provider)) void hermes.refreshUsage();
      return;
    }

    case 'message.updated': {
      const message = event.message;
      if (!message) return;
      if (state.editing === message.id) return; // do not yank the editor away
      patchMessage(message);
      if (state.thread) {
        if (state.thread.root.id === message.id) state.thread.root = message;
        const index = state.thread.replies.findIndex((m) => m.id === message.id);
        if (index !== -1) state.thread.replies[index] = message;
        renderThread();
      }
      return;
    }

    case 'message.deleted': {
      const id = event.messageId;
      if (event.payload?.hard) {
        dropMessage(id);
        if (state.thread?.root.id === id) closeThread();
        else if (state.thread) {
          state.thread.replies = state.thread.replies.filter((m) => m.id !== id);
          renderThread();
        }
      } else if (event.message) {
        patchMessage(event.message);
        if (state.thread) {
          if (state.thread.root.id === id) state.thread.root = event.message;
          const index = state.thread.replies.findIndex((m) => m.id === id);
          if (index !== -1) state.thread.replies[index] = event.message;
          renderThread();
        }
      }
      return;
    }

    case 'agent.typing': {
      if (!event.threadId) return;
      // Typing is a change, not a state, and it lives in the same durable log
      // as everything else, so a reconnect replays old ones. An "on" from long
      // enough ago describes a reply that has been finished for hours.
      const on = Boolean(event.payload?.on);
      if (on && Date.now() - (event.createdAt ?? 0) > TYPING_TIMEOUT_MS) return;
      setTyping(event.threadId, event.actor?.id ?? 'agent', on);
      return;
    }

    case 'agent.thinking': {
      if (!event.threadId) return;
      // Thinking rows are durable, exactly like typing, so a reconnect replays
      // the ones from an answer that finished hours ago. Same guard, same
      // reason: an old scratchpad describes a message that is already sitting
      // in the transcript with its working attached.
      if (Date.now() - (event.createdAt ?? 0) > TYPING_TIMEOUT_MS) return;
      const think = event.payload?.think;
      if (!think) return;
      setDraft(event.threadId, { agentId: event.actor?.id ?? 'agent', think });
      redrawThread(event.threadId);
      return;
    }

    case 'category.created':
    case 'category.updated':
    case 'category.deleted':
    case 'category.reordered': {
      await refreshCategories();
      // A deleted category leaves its channels behind pointing at nothing.
      if (event.type === 'category.deleted') await refreshChannels();
      renderRail();
      return;
    }

    case 'channel.created':
    case 'channel.updated':
    case 'channel.archived':
    case 'channel.unarchived':
    case 'channel.deleted': {
      await refreshChannels();
      if (state.current) {
        const still = state.channels.find((c) => c.id === state.current.id);
        if (!still) {
          state.current = state.channels.find((c) => !c.archived) ?? null;
          if (state.current) await loadMessages();
          else renderTimeline();
        } else {
          state.current = still;
        }
      }
      renderRail();
      renderChannelHeader();
      return;
    }

    default:
      if (event.type?.startsWith('agent.session')) refreshSessions();
  }
}

function showJump() {
  $('#btn-jump').hidden = false;
}

// ----------------------------------------------------------------- palette ---

const palette = {
  open: false,
  items: [],
  index: 0,
  timer: null,
};

function openPalette() {
  // A <dialog> sits in the top layer and would cover the palette whatever its
  // z-index, so the sheet gets out of the way first.
  closeSettings();
  palette.open = true;
  $('#palette').hidden = false;
  const input = $('#palette-input');
  input.value = '';
  input.focus();
  updatePalette('');
}

function closePalette() {
  palette.open = false;
  $('#palette').hidden = true;
}

async function updatePalette(query) {
  const term = query.trim();
  if (!term) {
    palette.items = state.channels
      .filter((c) => !c.archived)
      .map((c) => ({ kind: 'channel', label: `#${c.slug}`, hint: c.topic, ref: c.slug }));
  } else {
    const channels = state.channels
      .filter((c) => c.slug.includes(term.toLowerCase()))
      .map((c) => ({ kind: 'channel', label: `#${c.slug}`, hint: c.topic, ref: c.slug }));
    let hits = [];
    try {
      const result = await api.search(term, { limit: 12 });
      hits = result.results.map((message) => ({
        kind: 'message',
        label: message.author.label || message.author.id,
        hint: `#${message.channelSlug}`,
        snippet: message.text,
        terms: result.terms,
        message,
      }));
    } catch {
      /* searching is best-effort while typing */
    }
    palette.items = [...channels, ...hits];
  }
  palette.index = 0;
  renderPalette();
}

function renderPalette() {
  const list = clear($('#palette-results'));
  if (palette.items.length === 0) {
    list.append(el('li', { class: 'snippet' }, 'Nothing matched.'));
    return;
  }
  palette.items.forEach((item, index) => {
    list.append(
      el(
        'li',
        {
          class: index === palette.index ? 'is-sel' : '',
          onclick: () => choosePalette(index),
          onmousemove: () => {
            if (palette.index !== index) {
              palette.index = index;
              renderPalette();
            }
          },
        },
        el('span', { class: 'what' }, item.label),
        item.snippet
          ? el('span', { class: 'snippet', html: highlight(item.snippet, item.terms) })
          : el('span', { class: 'snippet' }, item.hint ?? ''),
        el('span', { class: 'where' }, item.kind === 'message' ? item.hint : '')
      )
    );
  });
}

async function choosePalette(index = palette.index) {
  const item = palette.items[index];
  if (!item) return;
  closePalette();
  if (item.kind === 'channel') return selectChannel(item.ref);
  const message = item.message;
  await selectChannel(message.channelSlug);
  if (message.parentId) openThread(message.parentId);
  else flashMessage(message.id);
}

// ================================================================== wiring ===

function fail(err, fallback) {
  const message = err instanceof ApiError ? err.message : fallback;
  toast(err instanceof ApiError && err.hint ? `${message} — ${err.hint}` : message, 'error');
  if (!(err instanceof ApiError)) console.error(err);
}

// ------------------------------------------------------------- commands ---

/**
 * The session a slash command is aimed at: an agent that is home in this
 * channel, or failing that any agent that is home at all. A command is asked
 * of an agent, so there has to be one.
 */
function commandSession() {
  const callable = state.sessions.filter((session) => session.serve?.callable);
  return callable.find((session) => session.channelSlug === state.current?.slug) ?? callable[0] ?? null;
}

/**
 * Fetch the agent's command vocabulary, once, the first time a `/` is typed.
 * Slick has no list of its own to fall back on — an agent that offers nothing
 * simply has no menu.
 */
async function loadCommands() {
  const session = commandSession();
  if (!session || state.commands.loading || state.commands.key === session.key) return;
  state.commands.loading = true;
  try {
    const answer = await api.agentCommands(session.key);
    state.commands = { key: session.key, list: answer.commands ?? [], loading: false };
  } catch {
    state.commands.loading = false; // no vocabulary, no menu; nothing to say about it
  }
}

/** Show a line only this person sees, above the composer. Not a message. */
function showEphemeral(outputId, title, body, kind = '') {
  const host = $(outputId);
  clear(host);
  host.hidden = false;
  host.className = `composer__out${kind ? ` is-${kind}` : ''}`;
  host.append(
    el(
      'div',
      { class: 'composer__out-head' },
      el('span', { class: 'composer__out-title' }, title),
      el('button', {
        class: 'composer__out-close',
        type: 'button',
        'aria-label': 'Dismiss',
        onclick: () => {
          host.hidden = true;
        },
      }, '×')
    ),
    body ? el('div', { class: 'composer__out-body', html: renderText(body) }) : null
  );
}

/**
 * Run one of the agent's own commands and show what it said.
 *
 * The output goes nowhere near the channel: it comes back in the response to
 * this one request and is drawn above the composer for the person who asked.
 */
async function runSlashCommand(line, outputId = '#composer-out') {
  const [word, ...rest] = line.slice(1).split(/\s+/);
  const args = line.slice(1 + word.length).trim();
  const session = commandSession();
  if (!session) {
    showEphemeral(outputId, `/${word}`, 'No agent is listening in this workspace, so there is nobody to ask.', 'warn');
    return;
  }
  if (word.toLowerCase() === 'model') {
    await runModelPicker(args, outputId, session);
    return;
  }
  showEphemeral(outputId, `/${word}`, '…', '');
  try {
    const answer = await api.runAgentCommand(session.key, word, args);
    if (answer.error) showEphemeral(outputId, `/${answer.command || word}`, answer.error, 'warn');
    else showEphemeral(outputId, `/${answer.command || word}`, answer.output || '(nothing to show)');
  } catch (err) {
    showEphemeral(outputId, `/${word}`, err.message ?? String(err), 'warn');
  }
}

function wireComposer(inputId, formId, buttonId, submit, menuId, commandMenuId, outputId = '#composer-out') {
  const input = $(inputId);
  const button = $(buttonId);
  const resize = autosize(input);
  const mentions = menuId ? createMentionMenu(input, $(menuId), agentSuggestions) : null;
  const commands = commandMenuId
    ? createCommandMenu(input, $(commandMenuId), () => state.commands.list, loadCommands)
    : null;
  const sync = () => {
    button.disabled = input.value.trim().length === 0 || input.disabled;
  };
  input.addEventListener('input', sync);
  input.addEventListener('keydown', (event) => {
    // Whichever menu is open gets the key first; only one ever is, since one
    // wants a `/` at the start of the box and the other an `@` after a space.
    if (mentions?.handleKeydown(event)) return;
    if (commands?.handleKeydown(event)) return;
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $(formId).requestSubmit();
    }
  });
  $(formId).addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value;
    if (!text.trim()) return;
    mentions?.close();
    commands?.close();
    input.value = '';
    resize();
    sync();
    // A line that is only a slash command is a question for the agent's
    // console, not a message for the channel. It leaves nothing behind.
    if (commands && /^\/[a-z0-9._:-]+/i.test(text.trim())) {
      await runSlashCommand(text.trim(), outputId);
      return;
    }
    await submit(text);
  });
  return sync;
}

function wire() {
  initModal();
  initPaneResizer();
  // The desktop build on macOS floats the traffic lights over the top-left
  // corner, which the header inherits the moment the rail collapses out from
  // under them. Nothing in CSS can see that window, so it is flagged here.
  $('#app').classList.toggle(
    'is-inset-titlebar',
    /Electron/.test(navigator.userAgent) && /Mac/i.test(navigator.platform ?? '')
  );
  // After the resizer, which owns the clamp `setRail` re-runs.
  setRail(Boolean(localStorage.getItem(RAIL_HIDDEN_KEY)), { remember: false });

  const syncMain = wireComposer(
    '#composer-input',
    '#composer',
    '#btn-send',
    send,
    '#mention-menu-main',
    '#command-menu-main'
  );
  wireComposer(
    '#thread-input',
    '#thread-composer',
    '#btn-thread-send',
    sendThreadReply,
    '#mention-menu-thread',
    '#command-menu-thread',
    '#thread-composer-out'
  );

  // The uncategorised bucket outlives every re-render, so it is wired once.
  dropTarget($('#channels-section'), null);
  $('#btn-edit-channel').addEventListener('click', editChannel);
  $('#btn-archive-channel').addEventListener('click', toggleArchive);
  $('#btn-delete-channel').addEventListener('click', deleteChannel);
  // Wrapped rather than passed straight through: closeThread takes an options
  // object, and a raw listener would hand it the click event instead.
  $('#btn-close-thread').addEventListener('click', () => closeThread());
  // Narrow viewports stack the views, so the thread's back arrow drops you to
  // the channel and the channel's drops you to the rail — one step each.
  $('#btn-thread-back').addEventListener('click', () => closeThread());
  $('#btn-rail').addEventListener('click', toggleRail);
  $('#btn-search').addEventListener('click', openPalette);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-close-settings').addEventListener('click', closeSettings);
  $('#settings').addEventListener('click', (event) => {
    // A dialog's backdrop counts as the dialog itself, so a click that lands
    // on no row at all is a click outside the sheet.
    if (event.target === $('#settings')) closeSettings();
  });
  $('#btn-jump').addEventListener('click', () => scrollToBottom(true));
  $('#btn-menu').addEventListener('click', () => closeChannel());
  window.addEventListener('popstate', (event) => syncLayers(event.state));
  $('#chan-topic').addEventListener('click', editChannel);

  for (const [button, list] of [
    ['#toggle-channels', '#channel-list'],
    ['#toggle-hermes', '#hermes-panel'],
    ['#toggle-archived', '#archived-list'],
  ]) {
    $(button).addEventListener('click', () => {
      const target = $(list);
      target.hidden = !target.hidden;
      $(button).setAttribute('aria-expanded', String(!target.hidden));
      $(button).querySelector('.rail__chev').textContent = target.hidden ? '▸' : '▾';
      // Asked for the first time it is actually looked at. Reading a profile
      // spawns an interpreter, and a panel nobody has unfolded has no reason
      // to have done that on every boot.
      if (list === '#hermes-panel' && !target.hidden && !state.hermes.loaded) hermes.load();
    });
  }

  const timeline = $('#timeline');
  timeline.addEventListener('scroll', () => {
    const distance = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
    state.atBottom = distance < NEAR_BOTTOM_PX;
    if (state.atBottom) $('#btn-jump').hidden = true;
    if (timeline.scrollTop < 80 && state.hasMore) loadOlder();
  });

  const paletteInput = $('#palette-input');
  paletteInput.addEventListener('input', () => {
    clearTimeout(palette.timer);
    const value = paletteInput.value;
    palette.timer = setTimeout(() => updatePalette(value), 130);
  });
  paletteInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      palette.index = Math.min(palette.index + 1, palette.items.length - 1);
      renderPalette();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      palette.index = Math.max(palette.index - 1, 0);
      renderPalette();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choosePalette();
    }
  });
  $('#palette').addEventListener('mousedown', (event) => {
    if (event.target === $('#palette')) closePalette();
  });

  document.addEventListener('keydown', (event) => {
    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      palette.open ? closePalette() : openPalette();
    } else if (meta && event.key.toLowerCase() === 'b') {
      // Bold is the other claim on ⌘B, but the composer is plain text — there
      // is nothing here for it to mark up.
      event.preventDefault();
      toggleRail();
    } else if (event.key === 'Escape') {
      // An open dialog closes itself on Escape; without this the layer behind
      // it would be dismissed by the same keypress.
      if ($('#modal').open || $('#settings').open) return;
      if (palette.open) closePalette();
      else if (state.thread) closeThread();
      else closeChannel();
    }
  });

  window.addEventListener('focus', () => {
    if (state.current) state.unread.delete(state.current.id);
    renderUnreadTitle();
  });

  syncMain();
}

// ---------------------------------------------------------------- settings ---

function openSettings() {
  const dialog = $('#settings');
  if (dialog.open) return;
  renderSettings();
  dialog.showModal();
}

function closeSettings() {
  const dialog = $('#settings');
  if (dialog.open) dialog.close();
}

function settingRow(name, hint, action) {
  return el(
    'div',
    { class: 'setting' },
    el('div', { class: 'setting__text' }, el('div', { class: 'setting__name' }, name), hint ? el('div', { class: 'setting__hint' }, hint) : null),
    action ?? null
  );
}

function settingGroup(title, ...rows) {
  return [el('h3', { class: 'settings__legend' }, title), ...rows];
}

/**
 * Creating things opens the shared modal, and two dialogs stacked on top of
 * each other is one Escape away from confusion — so this one steps aside first.
 */
function fromSettings(action) {
  return () => {
    closeSettings();
    action();
  };
}

function renderSettings() {
  const body = clear($('#settings-body'));
  const workspace = state.workspace;

  body.append(
    ...settingGroup(
      'Workspace',
      settingRow(workspace?.name ?? 'Slick', workspace ? `Signed in as ${workspace.user.name}` : 'Not connected yet'),
      versionRow(),
      cacheRow()
    ),
    ...settingGroup(
      'Channels',
      settingRow(
        'New channel',
        'A new place to talk, on its own or inside a category.',
        el(
          'button',
          { class: 'btn btn--primary', type: 'button', id: 'btn-new-channel', onclick: fromSettings(createChannel) },
          'Create'
        )
      ),
      settingRow(
        'New category',
        'A section in the sidebar. Channels can be dragged in and out of it.',
        el(
          'button',
          { class: 'btn', type: 'button', id: 'btn-new-category', onclick: fromSettings(() => createCategory()) },
          'Create'
        )
      )
    ),
    ...settingGroup('Notifications', notificationRow())
  );
}

/**
 * Which daemon this window is talking to. Asked for once and remembered — the
 * answer cannot change without the page reloading behind a restarted server.
 */
function versionRow() {
  const value = el('span', { class: 'setting__value' }, state.version ?? '…');
  // The build is the half that answers "am I up to date" — the version is
  // hand-written and the same across every build a phone would need to notice.
  // Shown side by side because only one of them is ever wrong.
  const row = settingRow('Version', 'The daemon this window is talking to.', value);
  if (state.version) return row;
  api
    .health()
    .then((health) => {
      const version = health?.version ? `v${health.version}` : 'unknown';
      state.version = health?.build ? `${version} · ${health.build}` : version;
      value.textContent = state.version;
    })
    .catch(() => {
      value.textContent = 'unknown';
    });
  return row;
}

/**
 * Throw away the offline copy of the app shell and come back on whatever the
 * daemon is serving now.
 *
 * The worker is already network-first, so this is not how a new build normally
 * arrives — it is the way out of the case where it did not: a half-written
 * cache entry, or an installed app that has been sitting on a dead daemon and
 * kept falling back to the same stale shell.
 */
function cacheRow() {
  if (!('serviceWorker' in navigator) || !('caches' in window)) {
    return settingRow('Offline copy', 'This browser keeps none, so there is nothing to refresh.');
  }
  const button = el('button', { class: 'btn', type: 'button', id: 'btn-refresh-cache' }, 'Refresh');
  button.addEventListener('click', () => refreshCache(button));
  return settingRow('Offline copy', 'Drop the cached app files and reload from the daemon.', button);
}

async function refreshCache(button) {
  button.disabled = true;
  button.textContent = 'Refreshing…';
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    // Ask for a newer worker first: if one is waiting, dropping the caches
    // underneath the old one only to have it rebuild them wastes the trip.
    await registration?.update();
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
    toast('Offline copy cleared — reloading');
    // Long enough for the toast to be read, short enough to still feel like
    // the button did it.
    setTimeout(() => location.reload(), 600);
  } catch (err) {
    button.disabled = false;
    button.textContent = 'Refresh';
    toast(err.message || 'Could not refresh the offline copy', 'error');
  }
}

function notificationRow() {
  if (!pushSupported()) {
    return settingRow('Push notifications', 'This browser cannot receive them.');
  }
  const button = el(
    'button',
    { class: 'btn', type: 'button', id: 'btn-notifications', disabled: true },
    'Checking…'
  );
  button.addEventListener('click', () => toggleNotifications(button));
  // The subscription lives in the service worker, so the label lands a tick
  // after the row does.
  syncNotificationButton(button);
  return settingRow('Push notifications', 'Get a ping when an agent replies to you.', button);
}

async function syncNotificationButton(button) {
  const subscription = await currentSubscription().catch(() => null);
  const on = Boolean(subscription) && Notification.permission === 'granted';
  button.disabled = false;
  button.textContent = on ? 'Turn off' : 'Enable';
  button.className = `btn${on ? '' : ' btn--primary'}`;
}

async function toggleNotifications(button) {
  const subscription = await currentSubscription().catch(() => null);
  button.disabled = true;
  try {
    if (subscription) {
      await disablePush(api);
      toast('Notifications turned off');
    } else {
      await enablePush(api);
      toast('Notifications on — you will get a ping when an agent replies');
    }
  } catch (err) {
    toast(err.message || 'Could not change notification settings', 'error');
  } finally {
    await syncNotificationButton(button);
  }
}

function setConnection(status) {
  const dot = $('#conn-dot');
  const label = $('#conn-label');
  dot.className = `dot${status === 'live' ? ' is-live' : status === 'closed' ? ' is-down' : ''}`;
  label.textContent = status === 'live' ? 'connected' : status === 'closed' ? 'disconnected' : 'reconnecting…';
}

async function boot() {
  wire();
  // A reload restores whichever entry was current, but none of the overlays it
  // describes are open any more — reset it so the first back press still counts.
  if (history.state?.layers) history.replaceState(null, '');
  try {
    const [workspace, channels, categories] = await Promise.all([
      api.workspace(),
      api.listChannels(true),
      api.listCategories(),
    ]);
    state.workspace = workspace;
    state.channels = channels;
    state.categories = categories;
    state.seq = workspace.seq;
    $('#workspace-name').textContent = workspace.name;
    $('#workspace-user').textContent = workspace.user.name;
  } catch (err) {
    $('#messages').append(
      emptyState(
        'Cannot reach the workspace',
        err instanceof ApiError && err.status === 401
          ? 'This page needs the daemon token. Open it with <code>slick app</code>.'
          : 'Is the daemon running? Try <code>slick daemon start</code>.'
      )
    );
    setConnection('closed');
    return;
  }

  await refreshSessions();
  renderRail();

  // The limits block below the Hermes section is only allowed to appear once
  // the profile has been read — that read is what says which provider, and so
  // whether there are limits at all. Not awaited: it spawns an interpreter and
  // takes seconds, and nothing on the way to the first channel depends on it.
  if (!state.hermes.loaded && !state.hermes.loading) void hermes.load();

  const deepLink = takeDeepLink();
  const preferred = deepLink?.channel ?? localStorage.getItem(LAST_CHANNEL_KEY);
  const target =
    state.channels.find((c) => c.slug === preferred && !c.archived) ?? state.channels.find((c) => !c.archived);
  // The phone opens on the list, with the last channel loaded behind it; wide
  // viewports show that channel straight away because nothing covers it.
  // Arriving from a notification is the exception — that tap asked for the
  // message, so reveal it instead of the list.
  if (target) await selectChannel(target.slug, { reveal: Boolean(deepLink) });
  else {
    renderChannelHeader();
    renderTimeline();
  }

  $('#app').classList.remove('is-loading');

  // After the shell is up, so the thread pane opens over a rendered channel.
  if (deepLink?.thread) await openThread(deepLink.thread).catch(() => {});

  api.stream({
    since: () => state.seq,
    onEvent: (event) => {
      handleEvent(event).catch((err) => console.error('event failed', err));
    },
    onStatus: (status) => {
    setConnection(status);
    // A stream that just came back may have been away across a whole reply.
    if (status === 'live') refreshTyping();
  },
  });

  // Keep "last seen 3m ago" honest without a re-render storm. This re-fetches
  // rather than re-rendering because whether a watcher is up is the server's
  // answer, not ours: a `serve` that started or died leaves no event behind.
  setInterval(() => {
    refreshSessions(); // it swallows its own errors — the rail is decoration
  }, 60_000);
}

boot();

// A bare inline <script> would be blocked by the page's CSP, so registration
// lives here instead — this module is already an allowed same-origin source.
if ('serviceWorker' in navigator) {
  // A notification tapped while a window is already open cannot be delivered
  // by URL without discarding that window's state, so the worker posts the
  // target here instead.
  navigator.serviceWorker.addEventListener('message', (event) => {
    const { type, channel, thread } = event.data ?? {};
    if (type !== 'navigate') return;
    goTo(channel, thread).catch((err) => console.error('notification navigation failed', err));
  });

  // Whether this page is under a worker decides what a handover below means,
  // and the first install claims it mid-flight — so this is read now and kept
  // in step, not re-read from a `controller` that has already moved on by the
  // time the event lands.
  let controlled = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  let lastUpdateCheck = 0;

  /**
   * An installed app is resumed far more often than it is launched, and being
   * resumed re-runs nothing — no navigation, no module fetch, and so no update
   * check. Network-first does not save it either: nothing asks the network in
   * the first place. Asking here is what makes a new build land on a phone
   * that is never actually closed; the worker that comes back claims the page
   * and the handover below reloads it.
   */
  const checkForUpdate = () => {
    const now = Date.now();
    if (now - lastUpdateCheck < 60_000) return;
    lastUpdateCheck = now;
    navigator.serviceWorker
      .getRegistration()
      .then((registration) => registration?.update())
      .catch(() => {
        /* offline, or the daemon is down — the worker we have still serves */
      });
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });

  // Registration is a promise, and the document it belongs to can stop being a
  // valid one while it is still in flight: the handover below reloads the page,
  // and under Electron `register` then rejects with an InvalidStateError rather
  // than never settling. Nothing was catching it, so a reload that arrived at
  // the wrong moment surfaced as an unhandled rejection. Skip the call once a
  // reload is on the way, and treat a rejection the same as any other — there
  // is no page left to serve.
  const registerWorker = async () => {
    if (reloading) return;
    try {
      const registration = await navigator.serviceWorker.register('./sw.js');
      // An installed app is launched, not reloaded, and can sit open for days;
      // asking on the way in is what makes a new worker land the same day.
      await registration.update();
    } catch {
      /* offline, the daemon is down, or this document is on its way out */
    }
  };

  window.addEventListener('load', registerWorker);

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // A worker that skipped waiting now owns a page built against the last one.
    // One reload lines the HTML, CSS, and JS back up. Not on a first install,
    // where the handover is to a page that has been served from the network all
    // along and is already current — but every handover after that one counts,
    // including the ones a long-lived app collects without ever reloading.
    const first = !controlled;
    controlled = Boolean(navigator.serviceWorker.controller);
    if (first || reloading) return;
    reloading = true;
    location.reload();
  });
}

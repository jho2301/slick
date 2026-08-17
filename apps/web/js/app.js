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
} from './format.js';
import {
  $,
  autosize,
  clear,
  confirmModal,
  copyToClipboard,
  el,
  initModal,
  openModal,
  toast,
} from './ui.js';
import { createMentionMenu } from './mentions.js';
import { initPaneResizer } from './panes.js';
import { currentSubscription, disablePush, enablePush, pushSupported } from './push.js';

const api = new Api();
const LAST_CHANNEL_KEY = 'slick.channel';
const GROUP_WINDOW_MS = 5 * 60 * 1000;
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
  current: null,
  messages: [],
  hasMore: false,
  oldestSeq: null,
  thread: null,
  unread: new Map(),
  editing: null,
  atBottom: true,
  /** threadId -> Map<agentId, timeout handle> */
  typing: new Map(),
  seq: 0,
};

/** message id -> rendered row, so live updates can patch in place. */
const nodes = new Map();

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

function isGrouped(message, previous) {
  return Boolean(
    previous &&
      !previous.deleted &&
      previous.author.id === message.author.id &&
      previous.author.kind === message.author.kind &&
      message.createdAt - previous.createdAt < GROUP_WINDOW_MS &&
      dayKey(previous.createdAt) === dayKey(message.createdAt)
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
 * One message row. `previous` decides whether it is visually grouped under
 * the message above it.
 */
function messageRow(message, previous, opts = {}) {
  const grouped = !opts.standalone && isGrouped(message, previous);
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
        message.author.kind === 'agent' ? el('span', { class: 'msg__badge' }, 'agent') : null,
        message.author.kind === 'system' ? el('span', { class: 'msg__badge msg__badge--system' }, 'system') : null,
        el('span', { class: 'msg__time', title: fullStamp(message.createdAt) }, clock(message.createdAt))
      )
    );
  }

  if (message.deleted) {
    main.append(el('div', { class: 'msg__body msg__deleted' }, 'This message was deleted'));
  } else {
    main.append(el('div', { class: 'msg__body', html: renderText(message.text) }));
    if (message.editedAt) main.append(el('span', { class: 'msg__edited' }, '(edited)'));
    if (message.metadata) {
      main.append(el('div', { class: 'msg__meta' }, JSON.stringify(message.metadata)));
    }
  }

  if (!opts.inThread) {
    const typers = typingAgents(message.threadId);
    if (typers.length > 0) main.append(typingChip(typers, message.threadId));
    else if (message.replyCount > 0) main.append(threadSummary(message));
  }

  row.append(main);
  if (!message.deleted) row.append(messageActions(message, { inThread: opts.inThread }));
  return row;
}

function emptyState(title, ...lines) {
  return el('div', { class: 'empty' }, el('h2', {}, title), lines.map((text) => el('p', { html: text })));
}

function renderTimeline() {
  const host = clear($('#messages'));
  nodes.clear();

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

  renderAgents();
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

function renderAgents() {
  const list = clear($('#agent-list'));
  if (state.sessions.length === 0) {
    list.append(
      el(
        'li',
        { class: 'rail__empty' },
        'No agents yet. Give one a history key:',
        el('br'),
        el('code', {}, 'slick agent start --agent claude')
      )
    );
    return;
  }
  for (const session of state.sessions) {
    const live = session.lastSeenAt && Date.now() - session.lastSeenAt < 5 * 60 * 1000;
    list.append(
      el(
        'li',
        { class: 'agent' },
        el('span', { class: `agent__dot${live ? '' : ' is-idle'}`, title: `last seen ${ago(session.lastSeenAt)}` }),
        el(
          'div',
          { class: 'agent__body', onclick: () => session.channelSlug && selectChannel(session.channelSlug) },
          el('div', { class: 'agent__name' }, session.name ? `${session.agentId} · ${session.name}` : session.agentId),
          el('div', { class: 'agent__key', title: session.key }, session.key)
        ),
        el(
          'button',
          {
            class: 'agent__copy',
            title: 'Copy history key',
            onclick: async () => {
              await copyToClipboard(session.key);
              toast('History key copied');
            },
          },
          'copy'
        )
      )
    );
  }
}

/** Known agents for the `@mention` picker: one entry per agent id, most recently active first. */
function agentSuggestions() {
  const byId = new Map();
  for (const session of state.sessions) {
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
  renderTimeline();
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
  renderThread();
}

function renderThread() {
  if (!state.thread) return;
  const { root, replies } = state.thread;
  $('#thread-sub').textContent = `#${state.thread.channel.slug}`;
  const host = clear($('#thread-body'));
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
  if (typers.length > 0) host.append(typingBubble(typers));
  host.scrollTop = host.scrollHeight;
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
    state.sessions = await api.agentSessions();
    renderAgents();
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
  const message = state.editing === threadId ? null : state.messages.find((m) => m.id === threadId);
  if (message) patchMessage(message);
  if (state.thread?.root.id === threadId) renderThread();
}

async function handleEvent(event) {
  if (event.type === 'stream.ready') {
    state.seq = event.seq;
    return;
  }
  state.seq = Math.max(state.seq, event.seq ?? 0);

  switch (event.type) {
    case 'message.created': {
      const message = event.message;
      if (!message) return;
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
      setTyping(event.threadId, event.actor?.id ?? 'agent', Boolean(event.payload?.on));
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

function wireComposer(inputId, formId, buttonId, submit, menuId) {
  const input = $(inputId);
  const button = $(buttonId);
  const resize = autosize(input);
  const mentions = menuId ? createMentionMenu(input, $(menuId), agentSuggestions) : null;
  const sync = () => {
    button.disabled = input.value.trim().length === 0 || input.disabled;
  };
  input.addEventListener('input', sync);
  input.addEventListener('keydown', (event) => {
    if (mentions?.handleKeydown(event)) return;
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
    input.value = '';
    resize();
    sync();
    await submit(text);
  });
  return sync;
}

function wire() {
  initModal();
  initPaneResizer();

  const syncMain = wireComposer('#composer-input', '#composer', '#btn-send', send, '#mention-menu-main');
  wireComposer('#thread-input', '#thread-composer', '#btn-thread-send', sendThreadReply, '#mention-menu-thread');

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
    ['#toggle-agents', '#agent-list'],
    ['#toggle-archived', '#archived-list'],
  ]) {
    $(button).addEventListener('click', () => {
      const target = $(list);
      target.hidden = !target.hidden;
      $(button).setAttribute('aria-expanded', String(!target.hidden));
      $(button).querySelector('.rail__chev').textContent = target.hidden ? '▸' : '▾';
    });
  }

  const timeline = $('#timeline');
  timeline.addEventListener('scroll', () => {
    const distance = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
    state.atBottom = distance < 60;
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
      settingRow(workspace?.name ?? 'Slick', workspace ? `Signed in as ${workspace.user.name}` : 'Not connected yet')
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
    onStatus: setConnection,
  });

  // Keep "last seen 3m ago" honest without a re-render storm.
  setInterval(() => {
    if (state.sessions.length) renderAgents();
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

  // Whether this page booted under a worker decides what a handover below
  // means, and claiming one during startup would blur that — so read it now.
  const wasControlled = Boolean(navigator.serviceWorker.controller);
  let reloading = false;

  window.addEventListener('load', async () => {
    const registration = await navigator.serviceWorker.register('./sw.js');
    // An installed app is launched, not reloaded, and can sit open for days;
    // asking on the way in is what makes a new worker land the same day.
    registration.update().catch(() => {
      /* offline, or the daemon is down — the worker we have still serves */
    });
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // A worker that skipped waiting now owns a page built against the last one.
    // One reload lines the HTML, CSS, and JS back up. Not on a first install,
    // where the handover is to a page that has been served from the network all
    // along and is already current.
    if (!wasControlled || reloading) return;
    reloading = true;
    location.reload();
  });
}

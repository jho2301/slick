/**
 * Everything the app does that is not a redraw: fetching, choosing a channel,
 * posting, editing, and the dialogs that create and change things.
 *
 * Plain functions over the store. A component calls one; the function awaits
 * the daemon and writes atoms; the components that read those atoms redraw.
 */

import type { Category, Channel, Message } from '@slick/core';

import { ApiError } from '../shared/api/api.ts';
import {
  atBottomAtom,
  bootErrorAtom,
  categoriesAtom,
  channelsAtom,
  commandsAtom,
  connectionAtom,
  currentChannelAtom,
  flashAtom,
  hasMoreAtom,
  insetTitlebarAtom,
  jumpVisibleAtom,
  loadingAtom,
  messagesAtom,
  oldestSeqAtom,
  paletteOpenAtom,
  railHiddenAtom,
  scrollRequestAtom,
  seqAtom,
  sessionsAtom,
  settingsOpenAtom,
  threadAtom,
  unreadAtom,
  workspaceAtom,
  type ModalField,
} from './atoms.ts';
import { dispatch } from './events.ts';
import { copyToClipboard } from '../shared/lib/clipboard.ts';
import {
  findModelChoice,
  groupModelChoices,
  modelCommandPreview,
  modelPickerDefaults,
  modelsForProvider,
  parseModelCommandArgs,
  type PickerProvider,
} from '../features/hermes/model-picker.ts';
import { commandSession, modelChoices, serveModel } from '../features/messages/sessions.ts';
import { refreshTyping } from './live.ts';
import { confirmModal, openModal } from '../shared/ui/modal.ts';
import { closeThread, openChannel, openThread } from './navigation.ts';
import { reflowPanes } from './panes.ts';
import { api, hermes, store } from './store.ts';
import { resetThinkState } from '../features/thinking/think-state.ts';
import { fail, toast } from '../shared/ui/toast.ts';
import type { EphemeralOutput } from './types.ts';

const LAST_CHANNEL_KEY = 'slick.channel';
const RAIL_HIDDEN_KEY = 'slick.rail-hidden';

// ------------------------------------------------------------- refreshers ---

export async function refreshChannels(): Promise<void> {
  store.set(channelsAtom, await api.listChannels(true));
}

export async function refreshCategories(): Promise<void> {
  store.set(categoriesAtom, await api.listCategories());
}

export async function refreshSessions(): Promise<void> {
  try {
    store.set(sessionsAtom, await api.agentSessions());
  } catch {
    /* the agent list is decoration; never block the app on it */
  }
}

export function bumpUnread(channelId: string | null | undefined): void {
  if (!channelId || channelId === store.get(currentChannelAtom)?.id) return;
  const unread = new Map(store.get(unreadAtom));
  unread.set(channelId, (unread.get(channelId) ?? 0) + 1);
  store.set(unreadAtom, unread);
}

export function clearUnread(channelId: string): void {
  const unread = store.get(unreadAtom);
  if (!unread.has(channelId)) return;
  const next = new Map(unread);
  next.delete(channelId);
  store.set(unreadAtom, next);
}

// --------------------------------------------------------------- channel ---

/**
 * @param opts `reveal: false` loads the channel without bringing it to the
 *   front — how the phone restores the last channel behind the list on boot.
 */
export async function selectChannel(
  ref: string,
  { flash, reveal = true }: { flash?: string; reveal?: boolean } = {}
): Promise<void> {
  const channel = store.get(channelsAtom).find((c) => c.slug === ref || c.id === ref);
  if (!channel) return;
  const previous = store.get(currentChannelAtom);
  store.set(currentChannelAtom, channel);
  clearUnread(channel.id);
  localStorage.setItem(LAST_CHANNEL_KEY, channel.slug);
  closeThread();
  if (reveal) openChannel();
  // Those ids have left the screen for good; keeping their state would only leak.
  if (previous?.id !== channel.id) resetThinkState();
  await loadMessages();
  scrollToBottom(true);
  if (flash) flashMessage(flash);
}

export async function loadMessages(): Promise<void> {
  const channel = store.get(currentChannelAtom);
  if (!channel) {
    store.set(messagesAtom, []);
    store.set(hasMoreAtom, false);
    store.set(oldestSeqAtom, null);
    return;
  }
  const result = await api.listMessages(channel.slug, { limit: 60 });
  // The channel may have changed under the request; the answer is for the one asked about.
  if (store.get(currentChannelAtom)?.id !== channel.id) return;
  store.set(messagesAtom, result.messages);
  store.set(hasMoreAtom, result.hasMore);
  store.set(oldestSeqAtom, result.oldestSeq ?? null);
}

/** The sixty messages before what is on screen. Returns whether anything was added. */
export async function loadOlder(): Promise<boolean> {
  const channel = store.get(currentChannelAtom);
  const oldest = store.get(oldestSeqAtom);
  if (!channel || !store.get(hasMoreAtom) || oldest == null) return false;
  const result = await api.listMessages(channel.slug, { limit: 60, before: oldest });
  if (store.get(currentChannelAtom)?.id !== channel.id) return false;
  store.set(messagesAtom, [...result.messages, ...store.get(messagesAtom)]);
  store.set(hasMoreAtom, result.hasMore);
  store.set(oldestSeqAtom, result.oldestSeq ?? oldest);
  return result.messages.length > 0;
}

export function scrollToBottom(force = false): void {
  if (!force && !store.get(atBottomAtom)) return;
  store.set(atBottomAtom, true);
  store.set(jumpVisibleAtom, false);
  store.set(scrollRequestAtom, store.get(scrollRequestAtom) + 1);
}

export function flashMessage(id: string): void {
  store.set(flashAtom, { id, at: Date.now() });
}

// ------------------------------------------------------------- composing ---

export async function send(text: string): Promise<void> {
  const channel = store.get(currentChannelAtom);
  if (!channel || !text.trim()) return;
  try {
    await api.postMessage(channel.slug, { text });
    scrollToBottom(true);
  } catch (err) {
    fail(err, 'Could not send that');
  }
}

export async function sendThreadReply(text: string): Promise<void> {
  const thread = store.get(threadAtom);
  if (!thread || !text.trim()) return;
  try {
    await api.replyTo(thread.root.id, { text });
  } catch (err) {
    fail(err, 'Could not post that reply');
  }
}

export async function saveEdit(id: string, text: string): Promise<boolean> {
  try {
    await api.editMessage(id, { text });
    return true;
  } catch (err) {
    fail(err, 'Could not save that edit');
    return false;
  }
}

export async function removeMessage(message: Message): Promise<void> {
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

export async function copyId(id: string): Promise<void> {
  await copyToClipboard(id);
  toast(`Copied ${id}`);
}

// ------------------------------------------------------------ deep links ---

/**
 * Jump to a channel, and optionally a thread inside it. The one place that
 * knows how a push notification's target becomes screen state.
 */
export async function goTo(
  channel: string | null | undefined,
  thread: string | null | undefined
): Promise<void> {
  if (channel) {
    const target = store.get(channelsAtom).find((c) => c.slug === channel && !c.archived);
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
export function takeDeepLink(): { channel: string | null; thread: string | null } | null {
  const url = new URL(location.href);
  const channel = url.searchParams.get('channel');
  const thread = url.searchParams.get('thread');
  if (!channel && !thread) return null;
  url.searchParams.delete('channel');
  url.searchParams.delete('thread');
  history.replaceState(history.state, '', url);
  return { channel, thread };
}

// -------------------------------------------------------------- channels ---

/** The category picker shared by the create and edit dialogs. */
const NEW_CATEGORY = '__new__';

function categoryField(value = ''): ModalField {
  return {
    name: 'category',
    label: 'Category',
    type: 'select',
    value,
    options: [
      { value: '', label: 'No category' },
      ...store.get(categoriesAtom).map((c) => ({ value: c.id, label: c.name })),
      { value: NEW_CATEGORY, label: '＋ New category…' },
    ],
  };
}

/**
 * Turn what the picker returned into something the API takes. `null` clears
 * the category; picking "New category…" asks for a name first.
 * @returns undefined if the prompt was cancelled
 */
async function resolveCategoryChoice(choice: string | undefined): Promise<string | null | undefined> {
  if (choice !== NEW_CATEGORY) return choice || null;
  const created = await createCategory({ select: false });
  return created ? created.id : undefined;
}

export async function createChannel(): Promise<void> {
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
      categoryField(store.get(currentChannelAtom)?.categoryId ?? ''),
    ],
  });
  if (!values) return;
  try {
    const category = await resolveCategoryChoice(values.category);
    if (category === undefined) return;
    const channel = await api.createChannel({ slug: values.slug ?? '', topic: values.topic, category });
    await refreshChannels();
    await selectChannel(channel.slug);
    toast(`Created #${channel.slug}`);
  } catch (err) {
    fail(err, 'Could not create that channel');
  }
}

export async function editChannel(): Promise<void> {
  const channel = store.get(currentChannelAtom);
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
    store.set(currentChannelAtom, store.get(channelsAtom).find((c) => c.id === updated.id) ?? updated);
    toast('Channel updated');
  } catch (err) {
    fail(err, 'Could not update that channel');
  }
}

export async function toggleArchive(): Promise<void> {
  const channel = store.get(currentChannelAtom);
  if (!channel) return;
  try {
    await api.archiveChannel(channel.id, !channel.archived);
    await refreshChannels();
    store.set(currentChannelAtom, store.get(channelsAtom).find((c) => c.id === channel.id) ?? null);
    toast(channel.archived ? `#${channel.slug} restored` : `#${channel.slug} archived`);
  } catch (err) {
    fail(err, 'Could not archive that channel');
  }
}

export async function deleteChannel(): Promise<void> {
  const channel = store.get(currentChannelAtom);
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
    const next = store.get(channelsAtom).find((c) => !c.archived);
    store.set(currentChannelAtom, null);
    if (next) await selectChannel(next.slug);
    else await loadMessages();
    toast(`Deleted #${channel.slug}`);
  } catch (err) {
    fail(err, 'Could not delete that channel');
  }
}

/** A drop on a rail section. No optimistic move: the `channel.updated` frame redraws. */
export async function moveChannel(channelId: string, categoryId: string | null): Promise<void> {
  const channel = store.get(channelsAtom).find((c) => c.id === channelId);
  if (!channel || channel.categoryId === categoryId) return;
  try {
    await api.updateChannel(channel.id, { category: categoryId });
  } catch (err) {
    fail(err, 'Could not move that channel');
  }
}

// ------------------------------------------------------------ categories ---

/**
 * @param opts `select: false` when this is a step inside another dialog
 *   rather than the thing the user asked for.
 */
export async function createCategory({ select = true }: { select?: boolean } = {}): Promise<Category | null> {
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
    const category = await api.createCategory({ name: values.name ?? '' });
    await refreshCategories();
    if (select) toast(`Created ${category.name}`);
    return category;
  } catch (err) {
    fail(err, 'Could not create that category');
    return null;
  }
}

export async function editCategory(category: Category): Promise<void> {
  const categories = store.get(categoriesAtom);
  const others = categories.filter((c) => c.id !== category.id);
  const index = categories.findIndex((c) => c.id === category.id);
  const values = await openModal({
    title: `Edit ${category.name}`,
    fields: [
      { name: 'name', label: 'Name', value: category.name, required: true },
      {
        name: 'after',
        label: 'Place it',
        type: 'select',
        value: index > 0 ? (categories[index - 1]?.id ?? '') : '',
        options: [
          { value: '', label: 'First' },
          ...others.map((c) => ({ value: c.id, label: `After ${c.name}` })),
        ],
      },
    ],
    extra: [{ label: 'Delete', value: 'delete', danger: true }],
  });
  if (!values) return;
  if (values._action === 'delete') return deleteCategory(category);
  try {
    if (values.name !== category.name) await api.updateCategory(category.id, { name: values.name });
    const order = others.map((c) => c.id);
    order.splice(values.after ? order.indexOf(values.after) + 1 : 0, 0, category.id);
    if (order.some((id, i) => categories[i]?.id !== id)) await api.reorderCategories(order);
    await refreshCategories();
    toast('Category updated');
  } catch (err) {
    fail(err, 'Could not update that category');
  }
}

export async function deleteCategory(category: Category): Promise<void> {
  const inside = store.get(channelsAtom).filter((c) => c.categoryId === category.id).length;
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
    toast(`Deleted ${category.name}`);
  } catch (err) {
    fail(err, 'Could not delete that category');
  }
}

export async function toggleCategory(category: Category): Promise<void> {
  // Optimistic: the fold should happen under the cursor, not a round trip later.
  const collapsed = !category.collapsed;
  const flip = (to: boolean) =>
    store.set(
      categoriesAtom,
      store.get(categoriesAtom).map((c) => (c.id === category.id ? { ...c, collapsed: to } : c))
    );
  flip(collapsed);
  try {
    await api.updateCategory(category.id, { collapsed });
  } catch (err) {
    flip(!collapsed);
    fail(err, 'Could not save that');
  }
}

// ------------------------------------------------------------------ rail ---

/**
 * Collapse or restore the rail on wide viewports.
 *
 * Narrow ones stack instead: the rail *is* the first screen down there, so
 * there is nowhere to collapse it to and the control is hidden. The stored
 * preference is still kept — shrinking the window and pulling it wide again
 * gives back the state you left.
 */
export function setRail(hidden: boolean, { remember = true }: { remember?: boolean } = {}): void {
  store.set(railHiddenAtom, hidden);
  if (remember) localStorage.setItem(RAIL_HIDDEN_KEY, hidden ? '1' : '');
  // The thread's clamp measures the rail, so the room that just opened up (or
  // went away) has to be handed to it — a class change fires no resize.
  requestAnimationFrame(() => reflowPanes());
}

export function toggleRail(): void {
  // A collapse down here would hide the only thing on screen.
  if (window.matchMedia('(max-width: 900px)').matches) return;
  setRail(!store.get(railHiddenAtom));
}

// -------------------------------------------------------------- overlays ---

export function openPalette(): void {
  // A <dialog> sits in the top layer and would cover the palette whatever its
  // z-index, so the sheet gets out of the way first.
  store.set(settingsOpenAtom, false);
  store.set(paletteOpenAtom, true);
}

export function closePalette(): void {
  store.set(paletteOpenAtom, false);
}

export function openSettings(): void {
  store.set(settingsOpenAtom, true);
}

export function closeSettings(): void {
  store.set(settingsOpenAtom, false);
}

// -------------------------------------------------------------- commands ---

/**
 * Fetch the agent's command vocabulary, once, the first time a `/` is typed.
 * Slick has no list of its own to fall back on — an agent that offers nothing
 * simply has no menu.
 */
export async function loadCommands(): Promise<void> {
  const session = commandSession(store.get(sessionsAtom), store.get(currentChannelAtom)?.slug);
  const commands = store.get(commandsAtom);
  if (!session || commands.loading || commands.key === session.key) return;
  store.set(commandsAtom, { ...commands, loading: true });
  try {
    const answer = await api.agentCommands(session.key);
    store.set(commandsAtom, { key: session.key, list: answer.commands ?? [], loading: false });
  } catch {
    store.set(commandsAtom, { ...store.get(commandsAtom), loading: false }); // no vocabulary, no menu
  }
}

/** The sentinel option that trades the menu for a text box. */
const CUSTOM_MODEL = ' custom';

/** The fallback for an agent that never advertised a list. */
async function typeModel(current: string | null): Promise<string | null> {
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

type Show = (output: EphemeralOutput) => void;

async function applyCommandModel(
  sessionKey: string,
  sessionModel: string | null,
  wanted: string | null,
  provider: string,
  choice: { label: string; name: string; value: string } | null,
  show: Show
): Promise<void> {
  if (wanted === null || wanted === undefined) return;
  const normalized = String(wanted).trim();
  if (normalized === (sessionModel ?? '')) return;

  show({ title: '/model', body: 'Switching model…', kind: '' });
  try {
    const model = await api.setAgentModel(sessionKey, normalized || null);
    await refreshSessions();
    if (!model) {
      show({ title: '/model', body: 'Hermes is back on its configured default model.', kind: '' });
      return;
    }
    const label = choice?.label ?? model;
    const via = provider ? ` via ${provider}` : '';
    const preview = choice ? `\n\n\`${modelCommandPreview(provider, choice)}\`` : '';
    show({ title: '/model', body: `Hermes will use **${label}**${via}.${preview}`, kind: '' });
  } catch (err) {
    show({ title: '/model', body: err instanceof Error ? err.message : String(err), kind: 'warn' });
  }
}

/**
 * The Slick-side `/model` picker. Hermes' detached command bridge cannot mutate
 * a live session, so the final selection goes through the same authorized model
 * endpoint as the agent-rail model button.
 */
async function runModelPicker(args: string, show: Show): Promise<void> {
  const session = commandSession(store.get(sessionsAtom), store.get(currentChannelAtom)?.slug);
  if (!session) return;
  const parsed = parseModelCommandArgs(args);
  const current = serveModel(session);
  const providers: PickerProvider[] = groupModelChoices(modelChoices(session));

  if (providers.length === 0) {
    const wanted = await typeModel(current);
    await applyCommandModel(session.key, current, wanted, '', null, show);
    return;
  }

  const defaults = modelPickerDefaults(providers, { provider: parsed.provider, name: parsed.name, current });
  const modelOptions = (provider: string) => [
    ...modelsForProvider(providers, provider).map((model) => ({ value: model.value, label: model.label })),
    { value: CUSTOM_MODEL, label: 'Something else…' },
  ];
  const providerOptions = providers.map((entry) => ({
    value: entry.value,
    label: `${entry.label} · ${entry.models.length} model${entry.models.length === 1 ? '' : 's'}`,
  }));

  const values = await openModal({
    title: 'Hermes model',
    body: 'Choose the provider and model. Both selections are sent as --provider and --name.',
    okLabel: 'Switch model',
    fields: [
      {
        name: 'provider',
        label: 'Provider (--provider)',
        type: 'select',
        value: defaults.provider,
        options: providerOptions,
        required: true,
        // A new provider serves different models, so the model select starts
        // over on its first one.
        onChange: (provider) => ({ name: modelsForProvider(providers, provider)[0]?.value ?? CUSTOM_MODEL }),
      },
      {
        name: 'name',
        label: 'Model (--name)',
        type: 'select',
        value: defaults.name || CUSTOM_MODEL,
        options: (current) => modelOptions(current.provider ?? defaults.provider),
        required: true,
        help: 'The model list comes from the running agent. Choose “Something else…” to enter a name manually.',
      },
    ],
  });
  if (!values) return;

  const provider = values.provider ?? '';
  const choice = findModelChoice(providers, provider, values.name);
  let wanted: string | null = choice?.value ?? null;
  if (values.name === CUSTOM_MODEL) wanted = await typeModel(current);
  if (!choice && values.name !== CUSTOM_MODEL) {
    show({ title: '/model', body: 'That model is not in the selected provider catalog.', kind: 'warn' });
    return;
  }
  await applyCommandModel(session.key, current, wanted, provider, choice, show);
}

/**
 * Run one of the agent's own commands and show what it said.
 *
 * The output goes nowhere near the channel: it comes back in the response to
 * this one request and is drawn above the composer for the person who asked.
 */
export async function runSlashCommand(line: string, show: Show): Promise<void> {
  const [word = '', ...rest] = line.slice(1).split(/\s+/);
  void rest;
  const args = line.slice(1 + word.length).trim();
  const session = commandSession(store.get(sessionsAtom), store.get(currentChannelAtom)?.slug);
  if (!session) {
    show({
      title: `/${word}`,
      body: 'No agent is listening in this workspace, so there is nobody to ask.',
      kind: 'warn',
    });
    return;
  }
  if (word.toLowerCase() === 'model') {
    await runModelPicker(args, show);
    return;
  }
  show({ title: `/${word}`, body: '…', kind: '' });
  try {
    const answer = await api.runAgentCommand(session.key, word, args);
    if (answer.error) show({ title: `/${answer.command || word}`, body: answer.error, kind: 'warn' });
    else show({ title: `/${answer.command || word}`, body: answer.output || '(nothing to show)', kind: '' });
  } catch (err) {
    show({ title: `/${word}`, body: err instanceof Error ? err.message : String(err), kind: 'warn' });
  }
}

// ------------------------------------------------------------------ boot ---

/** How the workspace failed to load, as the empty state's second line (HTML). */
function bootErrorLine(err: unknown): string {
  return err instanceof ApiError && err.status === 401
    ? 'This page needs the daemon token. Open it with <code>slick app</code>.'
    : 'Is the daemon running? Try <code>slick daemon start</code>.';
}

export async function boot(): Promise<void> {
  // The desktop build on macOS floats the traffic lights over the top-left
  // corner, which the header inherits the moment the rail collapses out from
  // under them. Nothing in CSS can see that window, so it is flagged here.
  store.set(
    insetTitlebarAtom,
    navigator.userAgent.includes('Electron') && /Mac/i.test(navigator.platform ?? '')
  );
  setRail(Boolean(localStorage.getItem(RAIL_HIDDEN_KEY)), { remember: false });

  // A reload restores whichever entry was current, but none of the overlays it
  // describes are open any more — reset it so the first back press still counts.
  const state: unknown = history.state;
  if (state && typeof state === 'object' && 'layers' in state) history.replaceState(null, '');

  try {
    const [workspace, channels, categories] = await Promise.all([
      api.workspace(),
      api.listChannels(true),
      api.listCategories(),
    ]);
    store.set(workspaceAtom, workspace);
    store.set(channelsAtom, channels);
    store.set(categoriesAtom, categories);
    store.set(seqAtom, workspace.seq);
  } catch (err) {
    store.set(bootErrorAtom, bootErrorLine(err));
    store.set(connectionAtom, 'closed');
    return;
  }

  await refreshSessions();

  // The limits block below the Hermes section is only allowed to appear once
  // the profile has been read — that read is what says which provider, and so
  // whether there are limits at all. Not awaited: it spawns an interpreter and
  // takes seconds, and nothing on the way to the first channel depends on it.
  if (!hermes.state.loaded && !hermes.state.loading) void hermes.load();

  const deepLink = takeDeepLink();
  const preferred = deepLink?.channel ?? localStorage.getItem(LAST_CHANNEL_KEY);
  const channels = store.get(channelsAtom);
  const target =
    channels.find((c) => c.slug === preferred && !c.archived) ?? channels.find((c) => !c.archived);
  // The phone opens on the list, with the last channel loaded behind it; wide
  // viewports show that channel straight away because nothing covers it.
  // Arriving from a notification is the exception — that tap asked for the
  // message, so reveal it instead of the list.
  if (target) await selectChannel(target.slug, { reveal: Boolean(deepLink) });

  store.set(loadingAtom, false);

  // After the shell is up, so the thread pane opens over a rendered channel.
  if (deepLink?.thread) await openThread(deepLink.thread);

  api.stream({
    since: () => store.get(seqAtom),
    onEvent: dispatch,
    onStatus: (status) => {
      store.set(connectionAtom, status);
      // A stream that just came back may have been away across a whole reply.
      if (status === 'live') void refreshTyping();
    },
  });

  // Keep "last seen 3m ago" honest without a re-render storm. This re-fetches
  // rather than re-rendering because whether a watcher is up is the server's
  // answer, not ours: a `serve` that started or died leaves no event behind.
  setInterval(() => void refreshSessions(), 60_000);
}

/** For the rail: every channel, live or archived, as the list it came in. */
export const channelsOf = (channels: readonly Channel[]) => ({
  active: channels.filter((c) => !c.archived),
  archived: channels.filter((c) => c.archived),
});

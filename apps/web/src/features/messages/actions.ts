import type { Message } from '@slick/core';
import { currentChannelAtom, threadAtom } from '../../app/atoms.ts';
import { copyToClipboard } from '../../shared/lib/clipboard.ts';
import { confirmModal } from '../../shared/ui/modal.ts';
import { api, store } from '../../app/store.ts';
import { fail, toast } from '../../shared/ui/toast.ts';
import { scrollToBottom } from './channel-state.ts';

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

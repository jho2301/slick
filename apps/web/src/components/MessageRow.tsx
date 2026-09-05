/**
 * One message, and the small things drawn around it: the avatar, the badges,
 * the thread chip, the typing indicator, and the answer streaming in below.
 */

import type { Author, Message } from '@slick/core';
import { useAtomValue } from 'jotai';
import { memo, useEffect, useMemo, useRef } from 'react';

import { copyId, removeMessage, saveEdit } from '../actions.ts';
import { badgeSessionsAtom, editingAtom, streamingActiveAtom, streamingAtoms, typingAtom } from '../atoms.ts';
import {
  ago,
  avatarColor,
  clock,
  dayLabel,
  fullStamp,
  initials,
  renderText,
  trimModelName,
} from '../lib/format.ts';
import { isGrouped } from '../lib/grouping.ts';
import { readSections, SECTION_CARDS } from '../lib/response-sections.ts';
import { badgeLabel, messageBadge, visibleMetadata, type MessageBadge } from '../lib/sessions.ts';
import { hasThinking, readThinking } from '../lib/thinking.ts';
import { streamingThinkKey } from '../live.ts';
import { openThread } from '../navigation.ts';
import { store } from '../store.ts';
import type { Surface } from '../types.ts';
import { ThinkingBox } from './ThinkingBox.tsx';

export function Avatar({ author, extraClass = '' }: { author: Author; extraClass?: string }) {
  const label = author.label || author.id;
  return (
    <div
      className={`avatar${author.kind === 'agent' ? ' avatar--agent' : ''}${extraClass}`}
      style={{ background: avatarColor(label) }}
      title={label}
    >
      {initials(label)}
    </div>
  );
}

export function DayDivider({ ts }: { ts: number }) {
  return (
    <div className="day">
      <span>{dayLabel(ts)}</span>
    </div>
  );
}

export function EmptyState({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {lines.map((html, i) => (
        <p key={i} dangerouslySetInnerHTML={{ __html: html }} />
      ))}
    </div>
  );
}

const TypingDots = () => (
  <span className="typing-dots">
    <span />
    <span />
    <span />
  </span>
);

const typingLabel = (agentIds: readonly string[]) =>
  `${agentIds.join(', ')} ${agentIds.length === 1 ? 'is' : 'are'} typing`;

const agentAuthor = (id: string): Author => ({ id, label: id, kind: 'agent' });

/** The little pill under a channel-row message, in place of the reply count while an agent works on it. */
function TypingChip({ agentIds, threadId }: { agentIds: readonly string[]; threadId: string }) {
  return (
    <button className="msg__thread msg__thread--typing" onClick={() => void openThread(threadId)}>
      <span className="stack">
        {agentIds.map((id) => (
          <Avatar key={id} author={agentAuthor(id)} />
        ))}
      </span>
      {typingLabel(agentIds)}
      <TypingDots />
    </button>
  );
}

/** A transient row at the bottom of an open thread, styled like a message. */
export function TypingBubble({ agentIds }: { agentIds: readonly string[] }) {
  return (
    <div className="msg is-typing">
      <div className="msg__gutter">
        {agentIds.map((id) => (
          <Avatar key={id} author={agentAuthor(id)} />
        ))}
      </div>
      <div>
        <div className="msg__body msg__body--typing">
          {typingLabel(agentIds)}
          <TypingDots />
        </div>
      </div>
    </div>
  );
}

/**
 * A live answer, in the shape of the message it is about to become.
 *
 * It replaces the typing chip or bubble rather than sitting beside it: they
 * say the same thing, and "claude is typing" under two paragraphs of claude's
 * answer reads like a second agent. The body keeps the typing dots only while
 * there is no text yet, so a reply that is all thinking still looks alive.
 *
 * Deliberately not cut into sections. Its text arrives a chunk at a time, so a
 * label half-typed as `## Assum` would open a box that closes again a
 * keypress later. The cut happens once, when the finished message replaces it.
 */
export function StreamingBubble({ threadId, surface }: { threadId: string; surface: Surface }) {
  const reply = useAtomValue(streamingAtoms(threadId));
  if (!reply) return null;
  const author = agentAuthor(reply.agentId);
  return (
    <div className="msg is-typing msg--draft" data-thread={threadId}>
      <div className="msg__gutter">
        <Avatar author={author} />
      </div>
      <div>
        {hasThinking(reply.think) ? (
          <ThinkingBox think={reply.think} thinkKey={streamingThinkKey(threadId)} surface={surface} />
        ) : null}
        {reply.text ? (
          <div
            className="msg__body msg__body--draft"
            dangerouslySetInnerHTML={{ __html: renderText(reply.text) }}
          />
        ) : (
          <div className="msg__body msg__body--typing msg__body--draft">
            {typingLabel([reply.agentId])}
            <TypingDots />
          </div>
        )}
      </div>
    </div>
  );
}

function ThreadSummary({ message }: { message: Message }) {
  return (
    <button className="msg__thread" onClick={() => void openThread(message.id)}>
      <span className="stack">
        <Avatar author={message.author} />
      </span>
      {`${message.replyCount} ${message.replyCount === 1 ? 'reply' : 'replies'}`}
      <span className="when">{message.lastReplyAt ? ago(message.lastReplyAt) : ''}</span>
    </button>
  );
}

/** The pair, as they sit beside the author. */
function ModelChip({ badge }: { badge: MessageBadge | null }) {
  if (!badge) return null;
  return (
    // `badge.title` keeps the untrimmed name on purpose: the chip is short
    // enough to scan a thread with, and the hover is where you go when you
    // need to know exactly which weights answered.
    <span className="msg__badges" title={badge.title}>
      {badge.model ? <span className="msg__badge msg__model">{trimModelName(badge.model)}</span> : null}
      {badge.effort ? <span className="msg__badge msg__effort">{badge.effort}</span> : null}
    </span>
  );
}

function MessageActions({ message, inThread }: { message: Message; inThread: boolean }) {
  const editable = message.author.kind !== 'system';
  const surface: Surface = inThread ? 'thread' : 'timeline';
  // The bar rides a full-height rail so it can stick to the top of the
  // scrollport while a long message is still on screen.
  return (
    <div className="msg__rail">
      <div className="msg__actions">
        {!inThread && message.isThreadRoot ? (
          <button onClick={() => void openThread(message.id)} title="Reply in thread">
            Reply
          </button>
        ) : null}
        {editable ? (
          <button onClick={() => store.set(editingAtom, { id: message.id, surface })} title="Edit">
            Edit
          </button>
        ) : null}
        <button onClick={() => void copyId(message.id)} title="Copy message id">
          Copy id
        </button>
        {editable ? (
          <button className="is-danger" onClick={() => void removeMessage(message)} title="Delete">
            Delete
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The inline editor, in the body's place. The text lives in the box itself
 * until Save reads it back, so a live event redrawing the row can never
 * overwrite what is being typed.
 */
function InlineEditor({ message }: { message: Message }) {
  const box = useRef<HTMLTextAreaElement>(null);
  const cancel = () => store.set(editingAtom, null);
  const save = async () => {
    const text = box.current?.value.trim() ?? '';
    store.set(editingAtom, null);
    if (!text || text === message.text) return;
    await saveEdit(message.id, text);
  };
  const resize = () => {
    const node = box.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 400)}px`;
  };
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
    resize();
  }, []);
  return (
    <div className="msg__edit">
      <textarea
        ref={box}
        defaultValue={message.text}
        onInput={resize}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
          } else if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void save();
          }
        }}
      />
      <div className="row">
        <span className="hint">Enter to save · Esc to cancel</span>
        <button className="btn btn--ghost" type="button" onClick={cancel}>
          Cancel
        </button>
        <button className="btn btn--primary" type="button" onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  );
}

/**
 * The collapsible boxes under an answer — reasoning, process, assumptions.
 *
 * Real `<details>` rather than a scripted box: closed is the default state of
 * the element itself, the summary is already a button to a screen reader, and
 * find-in-page opens the one it matched. Nothing here carries `.msg__body`,
 * for the editor's reason above.
 */
function SectionCards({ sections }: { sections: Record<string, string> }) {
  return (
    <>
      {SECTION_CARDS.map(({ key, label }) =>
        sections[key] ? (
          <details key={key} className="rsec" data-section={key}>
            <summary className="rsec__head">
              <span className="rsec__title">{label}</span>
            </summary>
            <div className="rsec__body" dangerouslySetInnerHTML={{ __html: renderText(sections[key]) }} />
          </details>
        ) : null
      )}
    </>
  );
}

export interface MessageRowProps {
  message: Message;
  /** The message above it, which decides whether this one is tucked under it. */
  previous: Message | null;
  surface: Surface;
  /** Never grouped: the root at the top of a thread stands on its own. */
  standalone?: boolean;
}

/**
 * One message row. `previous` decides whether it is visually grouped under
 * the message above it.
 */
export const MessageRow = memo(function MessageRow({
  message,
  previous,
  surface,
  standalone = false,
}: MessageRowProps) {
  const inThread = surface === 'thread';
  const sessions = useAtomValue(badgeSessionsAtom);
  const editing = useAtomValue(editingAtom);
  const typing = useAtomValue(typingAtom);
  const streamingActive = useAtomValue(streamingActiveAtom);

  const modelOf = (m: Message) => badgeLabel(m, sessions);
  const grouped = !standalone && isGrouped(message, previous, modelOf);
  const badge = messageBadge(message, sessions);
  const think = useMemo(() => readThinking(message), [message]);
  const sections = useMemo(() => readSections(message), [message]);
  const meta = visibleMetadata(message.metadata);
  const isEditing = editing?.id === message.id && editing.surface === surface;

  const typers = typing.get(message.threadId) ?? [];
  const streaming = streamingActive.has(message.threadId);

  return (
    <div className={`msg${grouped ? ' is-grouped' : ''}`} data-id={message.id}>
      <div className="msg__gutter">
        {grouped ? (
          <span className="msg__stamp">{clock(message.createdAt)}</span>
        ) : (
          <Avatar author={message.author} />
        )}
      </div>
      <div>
        {!grouped ? (
          <div className="msg__head">
            <span className="msg__author">{message.author.label || message.author.id}</span>
            <ModelChip badge={badge} />
            {message.author.kind === 'system' ? (
              <span className="msg__badge msg__badge--system">system</span>
            ) : null}
            <span className="msg__time" title={fullStamp(message.createdAt)}>
              {clock(message.createdAt)}
            </span>
          </div>
        ) : null}

        {message.deleted ? (
          <div className="msg__body msg__deleted">This message was deleted</div>
        ) : (
          <>
            {/* Above the body and inside this column: `.msg` is a two-column
                grid — avatar, then body — and a third in-flow child would wrap
                under the avatar gutter. Nothing inside the box carries
                `.msg__body`: the editor takes the body's place, and the answer
                is the row's one editable body. */}
            {think ? <ThinkingBox think={think} thinkKey={message.id} surface={surface} /> : null}
            {isEditing ? (
              <InlineEditor message={message} />
            ) : (
              <div className="msg__body" dangerouslySetInnerHTML={{ __html: renderText(sections.answer) }} />
            )}
            <SectionCards sections={sections} />
            {message.editedAt ? <span className="msg__edited">(edited)</span> : null}
            {meta ? <div className="msg__meta">{JSON.stringify(meta)}</div> : null}
          </>
        )}

        {/* An answer already arriving says everything the typing pill would, so
            it takes the pill's place rather than stacking on top of it. */}
        {!inThread ? (
          streaming ? (
            <StreamingBubble threadId={message.threadId} surface="timeline" />
          ) : typers.length > 0 ? (
            <TypingChip agentIds={typers} threadId={message.threadId} />
          ) : message.replyCount > 0 ? (
            <ThreadSummary message={message} />
          ) : null
        ) : null}
      </div>
      {!message.deleted ? <MessageActions message={message} inThread={inThread} /> : null}
    </div>
  );
});

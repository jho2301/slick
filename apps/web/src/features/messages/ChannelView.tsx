/**
 * The middle column: the channel's header, its timeline, and the composer.
 */

import type { Message } from '@slick/core';
import { useAtomValue } from 'jotai';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import {
  deleteChannel,
  editChannel,
  loadCommands,
  loadOlder,
  scrollToBottom,
  send,
  toggleArchive,
  toggleRail,
} from '../../app/actions.ts';
import {
  atBottomAtom,
  bootErrorAtom,
  commandsAtom,
  currentChannelAtom,
  flashAtom,
  hasMoreAtom,
  jumpVisibleAtom,
  messagesAtom,
  railHiddenAtom,
  scrollRequestAtom,
  sessionsAtom,
} from '../../app/atoms.ts';
import { dayKey } from '../../shared/lib/format.ts';
import { agentSuggestions } from './sessions.ts';
import { closeChannel } from '../../app/navigation.ts';
import { store } from '../../app/store.ts';
import { Composer } from './Composer.tsx';
import { DayDivider, EmptyState, MessageRow } from './MessageRow.tsx';

/** How close to the bottom still counts as reading live, in both panes. */
export const NEAR_BOTTOM_PX = 60;

function ChannelHeader() {
  const channel = useAtomValue(currentChannelAtom);
  const railHidden = useAtomValue(railHiddenAtom);
  const railLabel = railHidden ? 'Show sidebar' : 'Hide sidebar';
  return (
    <header className="chan-head" id="chan-head">
      <div className="chan-head__left">
        <button
          className="icon-btn icon-btn--ghost only-narrow"
          id="btn-menu"
          aria-label="Back to channels"
          onClick={() => closeChannel()}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M12.5 3.5L6 10l6.5 6.5 1.4-1.4L8.8 10l5.1-5.1z" />
          </svg>
        </button>
        {/* Wide viewports only: down where the rail is the whole screen
            there is nothing to collapse it away from. */}
        <button
          className="icon-btn icon-btn--ghost only-wide"
          id="btn-rail"
          title={`${railLabel} (⌘B)`}
          aria-label={railLabel}
          aria-expanded={!railHidden}
          aria-controls="rail"
          onClick={toggleRail}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3.5 3h13A1.5 1.5 0 0118 4.5v11a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 012 15.5v-11A1.5 1.5 0 013.5 3zm0 1.5v11H8v-11H3.5zm6 0v11h7v-11h-7z" />
          </svg>
        </button>
        <h1 className="chan-head__title" id="chan-title">
          {channel ? `#${channel.slug}` : 'Slick'}
        </h1>
        <button
          className="chan-head__topic"
          id="chan-topic"
          title="Edit topic"
          onClick={() => void editChannel()}
        >
          {channel?.topic ?? ''}
        </button>
      </div>
      <div className="chan-head__actions">
        <button className="chip" id="btn-edit-channel" disabled={!channel} onClick={() => void editChannel()}>
          Edit
        </button>
        <button
          className="chip"
          id="btn-archive-channel"
          disabled={!channel}
          onClick={() => void toggleArchive()}
        >
          {channel?.archived ? 'Unarchive' : 'Archive'}
        </button>
        <button
          className="chip chip--danger"
          id="btn-delete-channel"
          disabled={!channel}
          onClick={() => void deleteChannel()}
        >
          Delete
        </button>
      </div>
    </header>
  );
}

/** The rows, with a divider wherever the day changes. */
function TimelineRows({ messages }: { messages: Message[] }) {
  const rows: React.ReactNode[] = [];
  let previous: Message | null = null;
  let lastDay: string | null = null;
  for (const message of messages) {
    const key = dayKey(message.createdAt);
    if (key !== lastDay) {
      rows.push(<DayDivider key={`day-${key}`} ts={message.createdAt} />);
      lastDay = key;
      previous = null;
    }
    rows.push(<MessageRow key={message.id} message={message} previous={previous} surface="timeline" />);
    previous = message;
  }
  return <>{rows}</>;
}

function Timeline() {
  const channel = useAtomValue(currentChannelAtom);
  const messages = useAtomValue(messagesAtom);
  const hasMore = useAtomValue(hasMoreAtom);
  const bootError = useAtomValue(bootErrorAtom);
  const scrollRequest = useAtomValue(scrollRequestAtom);
  const flash = useAtomValue(flashAtom);

  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  /** Whether the reader was at the bottom as of the last scroll, so growth can follow. */
  const atBottom = useRef(true);
  /** The height before older messages were prepended, to keep the reading position steady. */
  const anchor = useRef<number | null>(null);
  const loading = useRef(false);

  const loadEarlier = useCallback(async () => {
    const host = scroller.current;
    if (loading.current || !host) return;
    loading.current = true;
    anchor.current = host.scrollHeight;
    try {
      if (!(await loadOlder())) anchor.current = null;
    } finally {
      loading.current = false;
    }
  }, []);

  // Keep the reading position steady while content grows above it.
  useLayoutEffect(() => {
    const host = scroller.current;
    if (!host || anchor.current === null) return;
    host.scrollTop = host.scrollHeight - anchor.current;
    anchor.current = null;
  }, [messages]);

  // Asked to jump to the end: a channel opened, a message sent.
  useLayoutEffect(() => {
    const host = scroller.current;
    if (!host) return;
    host.scrollTop = host.scrollHeight;
    atBottom.current = true;
  }, [scrollRequest, channel?.id]);

  // A reader parked at the bottom stays there as the content grows — a
  // message landing, an answer streaming in a few characters at a time.
  useEffect(() => {
    const host = scroller.current;
    const content = inner.current;
    if (!host || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) host.scrollTop = host.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  // Scroll to and highlight one message, once.
  useEffect(() => {
    if (!flash) return;
    const node = scroller.current?.querySelector<HTMLElement>(`.msg[data-id="${CSS.escape(flash.id)}"]`);
    if (!node) return;
    node.scrollIntoView({ block: 'center' });
    node.classList.add('is-flash');
    const timer = setTimeout(() => node.classList.remove('is-flash'), 1500);
    return () => clearTimeout(timer);
  }, [flash]);

  const onScroll = () => {
    const host = scroller.current;
    if (!host) return;
    const distance = host.scrollHeight - host.scrollTop - host.clientHeight;
    const near = distance < NEAR_BOTTOM_PX;
    atBottom.current = near;
    store.set(atBottomAtom, near);
    if (near) store.set(jumpVisibleAtom, false);
    if (host.scrollTop < 80 && hasMore) void loadEarlier();
  };

  let body: React.ReactNode;
  if (bootError) {
    body = <EmptyState title="Cannot reach the workspace" lines={[bootError]} />;
  } else if (!channel) {
    body = (
      <EmptyState
        title="No channel selected"
        lines={['Pick one on the left, or create your first channel.']}
      />
    );
  } else if (messages.length === 0) {
    body = (
      <EmptyState
        title={`This is the start of #${channel.slug}`}
        lines={[
          channel.purpose || 'Say something to get it going.',
          `From a terminal: <code>slick send ${channel.slug} "hello"</code>`,
        ]}
      />
    );
  } else {
    body = (
      <>
        {hasMore ? (
          <div style={{ textAlign: 'center', padding: '4px 0 10px' }}>
            <button className="chip" onClick={() => void loadEarlier()}>
              Load earlier messages
            </button>
          </div>
        ) : null}
        <TimelineRows messages={messages} />
      </>
    );
  }

  return (
    <div className="timeline" id="timeline" ref={scroller} onScroll={onScroll}>
      <div className="timeline__inner" id="messages" ref={inner}>
        {body}
      </div>
    </div>
  );
}

function JumpButton() {
  const visible = useAtomValue(jumpVisibleAtom);
  return (
    <button className="jump" id="btn-jump" hidden={!visible} onClick={() => scrollToBottom(true)}>
      Jump to latest ↓
    </button>
  );
}

export function ChannelView() {
  const channel = useAtomValue(currentChannelAtom);
  const placeholder = !channel
    ? 'Pick a channel'
    : channel.archived
      ? 'This channel is archived'
      : `Message #${channel.slug}`;
  return (
    <main className="main" id="main">
      <ChannelHeader />
      <Timeline />
      <JumpButton />
      <Composer
        where="main"
        disabled={!channel || channel.archived}
        placeholder={placeholder}
        onSubmit={send}
        suggestions={() => agentSuggestions(store.get(sessionsAtom))}
        commands={() => store.get(commandsAtom).list}
        loadCommands={loadCommands}
      />
    </main>
  );
}

/**
 * The thread pane: the root, its replies, and a composer of its own — with
 * the handle that resizes it laid over its left border.
 */

import type { Message } from '@slick/core';
import { useAtomValue } from 'jotai';
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';

import { loadCommands } from './command-actions.ts';
import { sendThreadReply } from './actions.ts';
import { commandsAtom, sessionsAtom, streamingActiveAtom, threadAtom, typingAtom } from '../../app/atoms.ts';
import { agentSuggestions } from './sessions.ts';
import { closeThread } from '../../app/navigation.ts';
import {
  applyThreadWidth,
  currentThreadWidth,
  DEFAULT_THREAD_WIDTH,
  reflowPanes,
  rememberThreadWidth,
  RESIZE_STEP,
  restoreThreadWidth,
} from '../../app/panes.ts';
import { store } from '../../app/store.ts';
import { NEAR_BOTTOM_PX } from './ChannelView.tsx';
import { Composer } from './Composer.tsx';
import { MessageRow, StreamingBubble, TypingBubble } from './MessageRow.tsx';

/**
 * Laid over this pane's left border rather than given a column of its own,
 * so the split costs the layout nothing. Inside the thread and not beside it
 * for the same reason: out here it would be a grid item and would have to be
 * styled to stop being one.
 */
function PaneResizer() {
  const handle = useRef<HTMLDivElement>(null);

  useEffect(() => {
    restoreThreadWidth();
    // Re-clamp, but against the width that was asked for rather than the one
    // on screen — a window pulled wide again should restore it.
    const onResize = () => reflowPanes();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const node = handle.current;
    if (!node) return;
    node.classList.add('is-dragging');
    document.body.classList.add('is-resizing');
    // Stops the press from starting a text selection in the timeline behind it.
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = currentThreadWidth();
    const stop = new AbortController();
    const { signal } = stop;
    let landed = startWidth;

    // On the window rather than the handle: the pointer outruns a 7px column
    // on any quick drag, and every frame after that would otherwise be
    // somebody else's event.
    window.addEventListener(
      'pointermove',
      (move) => {
        // The thread is the right-hand column, so dragging left grows it.
        landed = applyThreadWidth(startWidth + (startX - move.clientX));
      },
      { signal }
    );
    const end = () => {
      stop.abort();
      node.classList.remove('is-dragging');
      document.body.classList.remove('is-resizing');
      rememberThreadWidth(landed);
    };
    window.addEventListener('pointerup', end, { signal });
    window.addEventListener('pointercancel', end, { signal });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Left grows the thread, same as dragging the handle that way.
    const step = event.key === 'ArrowLeft' ? RESIZE_STEP : event.key === 'ArrowRight' ? -RESIZE_STEP : 0;
    if (step === 0) return;
    event.preventDefault();
    rememberThreadWidth(applyThreadWidth(currentThreadWidth() + step));
  };

  return (
    <div
      className="pane-resizer"
      id="thread-resizer"
      ref={handle}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize thread panel"
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={startDrag}
      // A double-click is the usual way back to the shipped width; hunting for
      // it by hand is not something anyone should have to do.
      onDoubleClick={() => rememberThreadWidth(applyThreadWidth(DEFAULT_THREAD_WIDTH))}
      onKeyDown={onKeyDown}
    />
  );
}

function ThreadBody() {
  const thread = useAtomValue(threadAtom);
  const typing = useAtomValue(typingAtom);
  const streamingActive = useAtomValue(streamingActiveAtom);
  const pane = useRef<HTMLDivElement>(null);
  /** Close enough to the bottom, as of the last scroll, to count as following it. */
  const follow = useRef(true);
  const rootId = thread?.root.id ?? null;

  // Opening one has no reading position to preserve, so this is the one place
  // that still jumps to the bottom unconditionally.
  useLayoutEffect(() => {
    const host = pane.current;
    if (!host || !rootId) return;
    host.scrollTop = host.scrollHeight;
    follow.current = true;
  }, [rootId]);

  // A reader near the bottom follows the pane as it grows — a reply landing,
  // an answer streaming in — and one who has scrolled back up is left alone.
  useEffect(() => {
    const host = pane.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (follow.current) host.scrollTop = host.scrollHeight;
    });
    for (const child of host.children) observer.observe(child);
    const watchChildren = new MutationObserver(() => {
      observer.disconnect();
      for (const child of host.children) observer.observe(child);
    });
    watchChildren.observe(host, { childList: true });
    return () => {
      observer.disconnect();
      watchChildren.disconnect();
    };
  }, []);

  const onScroll = () => {
    const host = pane.current;
    if (!host) return;
    follow.current = host.scrollHeight - host.scrollTop - host.clientHeight < NEAR_BOTTOM_PX;
  };

  if (!thread) return <div className="thread__scroll" id="thread-body" ref={pane} />;
  const { root, replies } = thread;
  const typers = typing.get(root.id) ?? [];
  const rows: React.ReactNode[] = [];
  let previous: Message | null = null;
  for (const reply of replies) {
    rows.push(<MessageRow key={reply.id} message={reply} previous={previous} surface="thread" />);
    previous = reply;
  }
  return (
    <div className="thread__scroll" id="thread-body" ref={pane} onScroll={onScroll}>
      <MessageRow message={root} previous={null} surface="thread" standalone />
      <div className="thread__divider">
        {replies.length === 0
          ? 'No replies yet'
          : `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`}
      </div>
      {rows}
      {streamingActive.has(root.id) ? (
        <StreamingBubble threadId={root.id} surface="thread" />
      ) : typers.length > 0 ? (
        <TypingBubble agentIds={typers} />
      ) : null}
    </div>
  );
}

export function ThreadPane() {
  const thread = useAtomValue(threadAtom);
  return (
    <aside className="thread" id="thread" hidden={!thread}>
      <PaneResizer />
      <header className="thread__head">
        <div className="thread__head-left">
          <button
            className="icon-btn icon-btn--ghost only-narrow"
            id="btn-thread-back"
            aria-label="Back to channel"
            onClick={() => closeThread()}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M12.5 3.5L6 10l6.5 6.5 1.4-1.4L8.8 10l5.1-5.1z" />
            </svg>
          </button>
          <div>
            <div className="thread__title">Thread</div>
            <div className="thread__sub" id="thread-sub">
              {thread ? `#${thread.channel.slug}` : ''}
            </div>
          </div>
        </div>
        <button
          className="icon-btn icon-btn--ghost"
          id="btn-close-thread"
          aria-label="Close thread"
          onClick={() => closeThread()}
        >
          ✕
        </button>
      </header>
      <ThreadBody />
      <Composer
        where="thread"
        placeholder="Reply…"
        onSubmit={sendThreadReply}
        suggestions={() => agentSuggestions(store.get(sessionsAtom))}
        commands={() => store.get(commandsAtom).list}
        loadCommands={loadCommands}
      />
    </aside>
  );
}

/**
 * The left column: the workspace, the channels in their categories, the
 * Hermes panel and its limits, and the connection light.
 */

import type { Category, Channel } from '@slick/core';
import { useAtomValue } from 'jotai';
import { useState, type DragEvent } from 'react';

import { editCategory, moveChannel, toggleCategory } from '../features/channels/actions.ts';
import { openPalette, openSettings } from './layout-actions.ts';
import { selectChannel } from '../features/messages/channel-state.ts';
import {
  categoriesAtom,
  channelsAtom,
  connectionAtom,
  currentChannelAtom,
  draggingAtom,
  hermesAtom,
  unreadAtom,
  workspaceAtom,
} from './atoms.ts';
import { hermes, store } from './store.ts';
import { HermesPanel, HermesUsage, HermesUsageHead } from '../features/hermes/Hermes.tsx';

/**
 * Make a rail section accept channels dropped anywhere inside it — heading
 * included, so a collapsed category is still a target. The highlight is
 * flipped on the node itself: `dragover` fires continuously, and a class it
 * has to wait a render for is a class that flickers.
 */
function dropTarget(categoryId: string | null) {
  return {
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!store.get(draggingAtom)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      event.currentTarget.classList.add('is-drop');
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      const section = event.currentTarget;
      if (!section.contains(event.relatedTarget as Node | null)) section.classList.remove('is-drop');
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      event.currentTarget.classList.remove('is-drop');
      // A drop that lands ends the drag; waiting for dragend would leave an
      // empty bucket on screen if the browser never sends one.
      document.getElementById('rail')?.classList.remove('has-drag');
      const id = store.get(draggingAtom) ?? event.dataTransfer.getData('text/plain');
      store.set(draggingAtom, null);
      if (id) void moveChannel(id, categoryId);
    },
  };
}

function ChannelRow({ channel }: { channel: Channel }) {
  const unread = useAtomValue(unreadAtom).get(channel.id) ?? 0;
  const current = useAtomValue(currentChannelAtom);
  const [lifting, setLifting] = useState(false);
  const isActive = current?.id === channel.id;
  return (
    <li>
      <button
        className={`chan${isActive ? ' is-active' : ''}${unread && !isActive ? ' is-unread' : ''}${lifting ? ' is-dragging' : ''}`}
        onClick={() => void selectChannel(channel.slug)}
        title={channel.topic || `#${channel.slug}`}
        draggable
        onDragStart={(event) => {
          store.set(draggingAtom, channel.id);
          event.dataTransfer.setData('text/plain', channel.id);
          event.dataTransfer.effectAllowed = 'move';
          setLifting(true);
          // On the node, not through state: the empty bucket has to be a
          // target the instant the drag starts, before React's next flush.
          document.getElementById('rail')?.classList.add('has-drag');
        }}
        onDragEnd={() => {
          store.set(draggingAtom, null);
          setLifting(false);
          document.getElementById('rail')?.classList.remove('has-drag');
        }}
      >
        <span className="chan__hash">#</span>
        <span className="chan__name">{channel.slug}</span>
        {unread && !isActive ? <span className="chan__count">{String(unread)}</span> : null}
      </button>
    </li>
  );
}

function CategorySection({ category, channels }: { category: Category; channels: Channel[] }) {
  const drop = dropTarget(category.id);
  return (
    <section
      className="rail__section rail__section--category"
      data-category={category.id}
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
    >
      <div className="rail__headrow">
        <button
          className="rail__heading"
          aria-expanded={!category.collapsed}
          onClick={() => void toggleCategory(category)}
          title={category.collapsed ? 'Expand' : 'Collapse'}
        >
          <span className="rail__chev">{category.collapsed ? '▸' : '▾'}</span>
          <span className="rail__label">{category.name}</span>
          {category.collapsed && channels.length ? (
            <span className="rail__tally">{String(channels.length)}</span>
          ) : null}
        </button>
        <button
          className="rail__cog"
          title={`Edit ${category.name}`}
          onClick={() => void editCategory(category)}
        >
          ···
        </button>
      </div>
      <ul className="channel-list" hidden={category.collapsed}>
        {channels.map((channel) => (
          <ChannelRow key={channel.id} channel={channel} />
        ))}
        {channels.length === 0 ? <li className="chan-drop">Empty — drag channels here</li> : null}
      </ul>
    </section>
  );
}

/** A section that folds: the heading flips, the list hides. */
function useFold(initialOpen: boolean) {
  const [open, setOpen] = useState(initialOpen);
  return { open, toggle: () => setOpen((o) => !o), chev: open ? '▾' : '▸' };
}

function ConnectionLight() {
  const status = useAtomValue(connectionAtom);
  return (
    <footer className="rail__foot">
      <span
        className={`dot${status === 'live' ? ' is-live' : status === 'closed' ? ' is-down' : ''}`}
        id="conn-dot"
      />
      <span id="conn-label">
        {status === 'live'
          ? 'connected'
          : status === 'closed'
            ? 'disconnected'
            : status === 'connecting'
              ? 'connecting…'
              : 'reconnecting…'}
      </span>
    </footer>
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
export function HermesLimitsSection() {
  const usage = (useAtomValue(hermesAtom) ?? hermes.state).usage;
  return (
    <section
      className="rail__section rail__pinned rail__pinned--limits"
      id="hermes-limits-section"
      hidden={!usage.applicable}
    >
      <h2 className="rail__heading rail__heading--static rail__heading--row" id="hermes-limits-heading">
        <span className="rail__heading-text">OpenAI limits</span>
        <span className="hermes__usage-head" id="hermes-limits-head">
          <HermesUsageHead usage={usage} />
        </span>
      </h2>
      <div className="hermes" id="hermes-limits">
        <HermesUsage usage={usage} />
      </div>
    </section>
  );
}

export function HermesSection() {
  const fold = useFold(false);
  return (
    <section className="rail__section rail__pinned" id="hermes-section">
      <button
        className="rail__heading"
        id="toggle-hermes"
        aria-expanded={fold.open}
        onClick={() => {
          // Asked for the first time it is actually looked at. Reading a
          // profile spawns an interpreter, and a panel nobody has unfolded
          // has no reason to have done that on every boot.
          if (!fold.open && !hermes.state.loaded) void hermes.load();
          fold.toggle();
        }}
      >
        <span className="rail__chev">{fold.chev}</span> Hermes
      </button>
      <div className="hermes" id="hermes-panel" hidden={!fold.open}>
        <HermesPanel />
      </div>
    </section>
  );
}

export function Rail() {
  const workspace = useAtomValue(workspaceAtom);
  const channels = useAtomValue(channelsAtom);
  const categories = useAtomValue(categoriesAtom);
  const channelsFold = useFold(true);
  const archivedFold = useFold(false);
  const bucket = dropTarget(null);

  const active = channels.filter((c) => !c.archived);
  const archived = channels.filter((c) => c.archived);
  const loose = active.filter((c) => !c.categoryId);

  return (
    <aside className="rail" id="rail">
      <header className="rail__head">
        <div className="rail__workspace">
          <span className="rail__mark">S</span>
          <div>
            <div className="rail__title" id="workspace-name">
              {workspace?.name ?? 'Slick'}
            </div>
            <div className="rail__user" id="workspace-user">
              {workspace?.user.name ?? ''}
            </div>
          </div>
        </div>
        <button
          className="icon-btn icon-btn--ghost"
          id="btn-search"
          title="Search (⌘K)"
          aria-label="Search"
          onClick={openPalette}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M9 3a6 6 0 104.47 10.03l3.25 3.25 1.06-1.06-3.25-3.25A6 6 0 009 3zm0 1.5a4.5 4.5 0 110 9 4.5 4.5 0 010-9z" />
          </svg>
        </button>
        <button
          className="icon-btn icon-btn--ghost"
          id="btn-settings"
          title="Menu"
          aria-label="Menu"
          aria-haspopup="dialog"
          onClick={openSettings}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 5h14v1.7H3zM3 9.15h14v1.7H3zM3 13.3h14V15H3z" />
          </svg>
        </button>
      </header>

      <nav className="rail__scroll" id="rail-scroll">
        {/* One section per category; the bucket below holds every channel
            that is not in one. */}
        <div id="category-sections">
          {categories.map((category) => (
            <CategorySection
              key={category.id}
              category={category}
              channels={active.filter((c) => c.categoryId === category.id)}
            />
          ))}
        </div>

        {/* An empty bucket is a heading over nothing, so it goes away — but it
            is also the only way back out of a category, which is why the CSS
            brings it back for as long as a channel is in the air. */}
        <section
          className={`rail__section${loose.length === 0 ? ' is-empty' : ''}`}
          id="channels-section"
          onDragOver={bucket.onDragOver}
          onDragLeave={bucket.onDragLeave}
          onDrop={bucket.onDrop}
        >
          <button
            className="rail__heading"
            id="toggle-channels"
            aria-expanded={channelsFold.open}
            onClick={channelsFold.toggle}
          >
            <span className="rail__chev">{channelsFold.chev}</span> Channels
          </button>
          <ul className="channel-list" id="channel-list" hidden={!channelsFold.open}>
            {loose.map((channel) => (
              <ChannelRow key={channel.id} channel={channel} />
            ))}
            {loose.length === 0 && categories.length > 0 ? (
              <li className="chan-drop">Drag a channel here to take it out of its category</li>
            ) : null}
          </ul>
        </section>

        <section
          className="rail__section rail__section--archived"
          id="archived-section"
          hidden={archived.length === 0}
        >
          <button
            className="rail__heading"
            id="toggle-archived"
            aria-expanded={archivedFold.open}
            onClick={archivedFold.toggle}
          >
            <span className="rail__chev">{archivedFold.chev}</span> Archived
          </button>
          <ul className="channel-list" id="archived-list" hidden={!archivedFold.open}>
            {archived.map((channel) => (
              <ChannelRow key={channel.id} channel={channel} />
            ))}
          </ul>
        </section>
      </nav>

      {/* Pinned under the scroller so it stays put rather than scrolling away
          with the channels. Folded by default — a default you have already
          set is not something to keep an eye on. This is Hermes' own
          configuration, not Slick's: the provider and model a profile hands
          out when no conversation has said otherwise. */}
      <HermesSection />

      {/* The account's own limits, deliberately *not* inside the folded panel
          above. Those are settings, kept out of the way because they are
          already decided; this is a number that moves on its own and is worth
          seeing without opening anything. */}
      <HermesLimitsSection />

      <ConnectionLight />
    </aside>
  );
}

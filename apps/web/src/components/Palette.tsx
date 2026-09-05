/**
 * The command palette (⌘K): jump to a channel, or search messages.
 */

import type { Message } from '@slick/core';
import { useAtomValue } from 'jotai';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { closePalette, flashMessage, selectChannel } from '../actions.ts';
import { channelsAtom, paletteOpenAtom } from '../atoms.ts';
import { highlight } from '../lib/format.ts';
import { openThread } from '../navigation.ts';
import { api, store } from '../store.ts';

type PaletteItem =
  | { kind: 'channel'; label: string; hint: string; ref: string }
  | { kind: 'message'; label: string; hint: string; snippet: string; terms: string[]; message: Message };

async function itemsFor(query: string): Promise<PaletteItem[]> {
  const term = query.trim();
  const channels = store.get(channelsAtom);
  const asItem = (c: (typeof channels)[number]): PaletteItem => ({
    kind: 'channel',
    label: `#${c.slug}`,
    hint: c.topic,
    ref: c.slug,
  });
  if (!term) return channels.filter((c) => !c.archived).map(asItem);
  const matched = channels.filter((c) => c.slug.includes(term.toLowerCase())).map(asItem);
  let hits: PaletteItem[] = [];
  try {
    const result = await api.search(term, { limit: 12 });
    hits = result.results.map((message) => ({
      kind: 'message',
      label: message.author.label || message.author.id,
      hint: `#${message.channelSlug ?? ''}`,
      snippet: message.text,
      terms: result.terms,
      message,
    }));
  } catch {
    /* searching is best-effort while typing */
  }
  return [...matched, ...hits];
}

export function Palette() {
  const open = useAtomValue(paletteOpenAtom);
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<PaletteItem[]>([]);
  const [index, setIndex] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Which search is the latest, so a slow earlier answer cannot land on top of a newer one. */
  const generation = useRef(0);

  const update = (query: string) => {
    const token = ++generation.current;
    void itemsFor(query).then((found) => {
      if (token !== generation.current) return;
      setItems(found);
      setIndex(0);
    });
  };

  useEffect(() => {
    if (!open) return;
    const node = input.current;
    if (node) {
      node.value = '';
      node.focus();
    }
    update('');
  }, [open]);

  const choose = async (at: number) => {
    const item = items[at];
    if (!item) return;
    closePalette();
    if (item.kind === 'channel') {
      await selectChannel(item.ref);
      return;
    }
    const { message } = item;
    if (message.channelSlug) await selectChannel(message.channelSlug);
    if (message.parentId) await openThread(message.parentId);
    else flashMessage(message.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIndex((i) => Math.min(i + 1, Math.max(items.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void choose(index);
    }
  };

  return (
    <div
      className="palette"
      id="palette"
      hidden={!open}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closePalette();
      }}
    >
      <div className="palette__box">
        <input
          id="palette-input"
          ref={input}
          className="palette__input"
          placeholder="Jump to a channel, or type to search messages…"
          autoComplete="off"
          onInput={(event) => {
            const value = event.currentTarget.value;
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => update(value), 130);
          }}
          onKeyDown={onKeyDown}
        />
        <ul className="palette__results" id="palette-results">
          {items.length === 0 ? (
            <li className="snippet">Nothing matched.</li>
          ) : (
            items.map((item, i) => (
              <li
                key={item.kind === 'channel' ? `c:${item.ref}` : `m:${item.message.id}`}
                className={i === index ? 'is-sel' : ''}
                onClick={() => void choose(i)}
                onMouseMove={() => {
                  if (index !== i) setIndex(i);
                }}
              >
                <span className="what">{item.label}</span>
                {item.kind === 'message' ? (
                  <span
                    className="snippet"
                    dangerouslySetInnerHTML={{ __html: highlight(item.snippet, item.terms) }}
                  />
                ) : (
                  <span className="snippet">{item.hint ?? ''}</span>
                )}
                <span className="where">{item.kind === 'message' ? item.hint : ''}</span>
              </li>
            ))
          )}
        </ul>
        <div className="palette__foot">
          <b>↑↓</b> move · <b>Enter</b> open · <b>Esc</b> close
        </div>
      </div>
    </div>
  );
}

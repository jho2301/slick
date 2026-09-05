/**
 * Layers, and the history entries behind them.
 *
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

import { channelRevealedAtom, layersAtom, threadAtom } from './atoms.ts';
import { api, store } from './store.ts';
import { fail } from '../shared/ui/toast.ts';

export const stacks = (): boolean => window.matchMedia('(max-width: 900px)').matches;

function pushLayer(name: string): void {
  const layers = [...store.get(layersAtom), name];
  store.set(layersAtom, layers);
  history.pushState({ layers }, '');
}

/**
 * Rewind past `name`'s entry — and any layer stacked on top of it, since those
 * sit between us and it. The resulting popstate is what actually tears their
 * UI down.
 */
function dropLayer(name: string): void {
  const layers = store.get(layersAtom);
  const at = layers.indexOf(name);
  if (at === -1) return;
  const depth = layers.length - at;
  store.set(layersAtom, layers.slice(0, at));
  history.go(-depth);
}

/** What a history entry says about the stack, or nothing. */
function readLayers(entry: unknown): string[] {
  if (!entry || typeof entry !== 'object') return [];
  const layers: unknown = (entry as { layers?: unknown }).layers;
  return Array.isArray(layers) ? layers.filter((l): l is string => typeof l === 'string') : [];
}

/** Bring the layers in line with the entry a back/forward landed us on. */
export function syncLayers(entry: unknown): void {
  const layers = readLayers(entry);
  store.set(layersAtom, layers);
  if (!layers.includes('thread')) closeThread({ viaPopstate: true });
  if (!layers.includes('channel')) closeChannel({ viaPopstate: true });
}

/**
 * Reveal the channel over the list. The channel stays loaded underneath when
 * it is dismissed, so coming back to it costs nothing.
 */
export function openChannel(): void {
  if (!stacks() || store.get(channelRevealedAtom)) return;
  store.set(channelRevealedAtom, true);
  pushLayer('channel');
}

export function closeChannel({ viaPopstate = false }: { viaPopstate?: boolean } = {}): void {
  if (!store.get(channelRevealedAtom)) return;
  store.set(channelRevealedAtom, false);
  if (!viaPopstate) dropLayer('channel');
}

/**
 * The layer only goes on once the fetch succeeds — a thread that failed to
 * open is not something to back out of.
 */
export async function openThread(rootId: string): Promise<void> {
  const wasOpen = store.get(threadAtom) !== null;
  try {
    store.set(threadAtom, await api.thread(rootId));
  } catch (err) {
    fail(err, 'Could not open that thread');
    return;
  }
  // Jumping straight from one thread to another stays on the same layer.
  if (!wasOpen && stacks()) pushLayer('thread');
}

export function closeThread({ viaPopstate = false }: { viaPopstate?: boolean } = {}): void {
  if (!store.get(threadAtom)) return;
  store.set(threadAtom, null);
  if (!viaPopstate) dropLayer('thread');
}

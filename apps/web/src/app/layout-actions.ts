import { paletteOpenAtom, railHiddenAtom, settingsOpenAtom } from './atoms.ts';
import { reflowPanes } from './panes.ts';
import { store } from './store.ts';
import { RAIL_HIDDEN_KEY } from './preferences.ts';

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

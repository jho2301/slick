/**
 * What every thinking box remembers between redraws: whether it is open, and
 * what its live region last said.
 *
 * Both sit outside the row on purpose. A row is redrawn on every
 * `message.updated`, every reply-count bump, every typing flip three rows
 * down, so a box that kept its own state would slam shut every time an agent
 * so much as started typing. Out here, a redraw reconstructs the right state
 * for free.
 */

import type { ThinkingPhase } from '@slick/core';

import { thinkUiAtoms, type ThinkUiState } from '../../app/atoms.ts';
import { store } from '../../app/store.ts';

/** key → what this box's live region last said, and when. */
const said = new Map<string, { text: string; phase: ThinkingPhase; at: number }>();

export const thinkSaid = (key: string) => said.get(key);
export const setThinkSaid = (key: string, entry: { text: string; phase: ThinkingPhase; at: number }) => {
  said.set(key, entry);
};

/**
 * Open or shut, decided here rather than in the click handler.
 *
 * The handler only ever sees the presses; the interesting transitions arrive
 * as redraws, so this is the one place that can see both. `sawPhase` is what
 * makes a redraw different from a phase change: the row is reconstructed
 * dozens of times per answer and only the handful of those that actually move
 * the phase are allowed to overrule the reader.
 */
export function resolveThinkOpen(seen: ThinkUiState | null, phase: ThinkingPhase): ThinkUiState {
  // Born collapsed — unless it is already broken. "Born collapsed" is the
  // default, and the error rule overrules it here for exactly the reason it
  // overrules a manual collapse below: the step that failed is the one thing
  // in the box worth showing unasked, and a reload or a switch away and back
  // arrives here rather than at the transition underneath.
  if (!seen) return { open: phase === 'error', sawPhase: phase };
  // Nothing moved, so whatever the reader last chose stands. That one line is
  // both the latch during the stream and the permanence after it.
  if (seen.sawPhase === phase) return seen;
  // The phase turned over. Finishing hands the space back to the answer that
  // is arriving; failing does the exact opposite, because a failure is
  // precisely when someone needs to see which step broke.
  return { open: phase === 'error', sawPhase: phase };
}

/** A press on the head: the reader's choice, for every copy of the box at once. */
export function toggleThink(key: string, phase: ThinkingPhase): void {
  const seen = store.get(thinkUiAtoms(key));
  store.set(thinkUiAtoms(key), { open: !seen?.open, sawPhase: seen?.sawPhase ?? phase });
}

/** The box is gone for good — its message dropped, its answer landed. */
export function forgetThink(key: string): void {
  thinkUiAtoms.remove(key);
  said.delete(key);
}

/**
 * Switching channels. Those ids have left the screen for good, and keeping
 * their state would only leak. ("Load earlier" is the opposite case and calls
 * nothing: same channel, same conversation, and a box the reader opened
 * should still be open once sixty older messages arrive above it.)
 */
export function resetThinkState(): void {
  for (const key of [...thinkUiAtoms.getParams()]) thinkUiAtoms.remove(key);
  said.clear();
}

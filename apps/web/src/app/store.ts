/**
 * The one store, the one API client, and the Hermes bridge.
 *
 * Actions write to `store` directly and components read from it through the
 * Provider, so a stream frame is applied without a component in the loop and
 * a test can drive the whole state machine without rendering anything.
 */

import { createStore } from 'jotai';

import { Api } from '../shared/api/api.ts';
import { hermesAtom } from './atoms.ts';
import { createHermesStore, type HermesState, type HermesStore } from '../features/hermes/hermes-store.ts';

export const store = createStore();

export const api = new Api();

/** A copy React can tell apart from the last one; the store mutates in place. */
const snapshot = (state: HermesState): HermesState => ({ ...state, usage: { ...state.usage } });

/**
 * The Hermes rail panel. It owns its own state — including the ordering rules
 * that keep one profile's answer off another profile's panel — and every
 * change lands in `hermesAtom` as a fresh snapshot.
 */
export const hermes: HermesStore = createHermesStore({
  api,
  onChange: (state) => store.set(hermesAtom, snapshot(state)),
});
store.set(hermesAtom, snapshot(hermes.state));

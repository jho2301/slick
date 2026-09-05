/**
 * Every piece of state the app draws from, as jotai atoms.
 *
 * Plain atoms, written by the action modules through one external store
 * (`store.ts`) and read by components through the Provider. No async atoms:
 * a request is an action that awaits and then writes, so what is on screen
 * is always something that has already arrived.
 */

import type {
  AgentSession,
  Category,
  Channel,
  Message,
  Thread,
  ThinkingPhase,
  WorkspaceInfo,
} from '@slick/core';
import { atom, type PrimitiveAtom } from 'jotai';
import { selectAtom } from 'jotai/utils';

import type { CommandEntry } from './lib/commands.ts';
import type { HermesState } from './lib/hermes-store.ts';
import { modelFingerprint } from './lib/sessions.ts';
import type { ConnectionStatus, StreamingReply, Surface } from './types.ts';

/**
 * One atom per key, made on first use and kept until removed. What jotai's
 * `atomFamily` did before it left the core package; small enough to own.
 */
export interface AtomFamily<V> {
  (key: string): PrimitiveAtom<V>;
  remove(key: string): void;
  getParams(): Iterable<string>;
}

function atomFamily<V>(make: (key: string) => PrimitiveAtom<V>): AtomFamily<V> {
  const cache = new Map<string, PrimitiveAtom<V>>();
  const get = ((key: string) => {
    let found = cache.get(key);
    if (!found) {
      found = make(key);
      cache.set(key, found);
    }
    return found;
  }) as AtomFamily<V>;
  get.remove = (key) => {
    cache.delete(key);
  };
  get.getParams = () => cache.keys();
  return get;
}

// ------------------------------------------------------------- workspace ---

export const workspaceAtom = atom<WorkspaceInfo | null>(null);
export const channelsAtom = atom<Channel[]>([]);
export const categoriesAtom = atom<Category[]>([]);
export const sessionsAtom = atom<AgentSession[]>([]);

/**
 * The sessions as the badges read them: a fresh value only when a model or a
 * level actually moved. The list is re-fetched every minute to keep "seen 3m
 * ago" honest, and that must not redraw a single message row.
 */
export const badgeSessionsAtom = selectAtom(
  sessionsAtom,
  (sessions) => sessions,
  (a, b) => modelFingerprint(a) === modelFingerprint(b)
);

export const seqAtom = atom(0);
export const connectionAtom = atom<ConnectionStatus>('connecting');
/** Daemon version, fetched the first time Settings is opened. */
export const versionAtom = atom<string | null>(null);
/** `#app.is-loading` until the first channel is on screen. */
export const loadingAtom = atom(true);
/** Why the workspace could not be reached, as the empty state's line, or null. */
export const bootErrorAtom = atom<string | null>(null);

// --------------------------------------------------------------- channel ---

export const currentChannelAtom = atom<Channel | null>(null);
export const messagesAtom = atom<Message[]>([]);
export const hasMoreAtom = atom(false);
export const oldestSeqAtom = atom<number | null>(null);
/** channel id → messages that landed there while it was not on screen. */
export const unreadAtom = atom<ReadonlyMap<string, number>>(new Map<string, number>());
/** Which message is being edited inline, and in which pane. */
export const editingAtom = atom<{ id: string; surface: Surface } | null>(null);
/** Whether the timeline is scrolled to its end, which is what "follow new messages" means. */
export const atBottomAtom = atom(true);
export const jumpVisibleAtom = atom(false);
/** Bumped to ask the timeline to scroll to its end. */
export const scrollRequestAtom = atom(0);
/** A message to scroll to and highlight, once. */
export const flashAtom = atom<{ id: string; at: number } | null>(null);

// ---------------------------------------------------------------- thread ---

export const threadAtom = atom<Thread | null>(null);

// ------------------------------------------------------------------ live ---

/** threadId → the agents typing in it, as the timers in `live.ts` last said. */
export const typingAtom = atom<ReadonlyMap<string, readonly string[]>>(new Map<string, readonly string[]>());
/**
 * The threads with an answer arriving. Changes when a reply starts or ends,
 * never per token, so a message row can ask cheaply whether to draw a bubble.
 */
export const streamingActiveAtom = atom<ReadonlySet<string>>(new Set<string>());
/** One thread's arriving answer, written once per animation frame. */
export const streamingAtoms = atomFamily((_threadId: string) => atom<StreamingReply | null>(null));

/**
 * Whether a thinking box is open, and which phase it was in when that was
 * last decided. Keyed by message id, or by `streaming-<threadId>` for the box
 * on an answer still arriving — and shared by every copy of the box, so
 * opening the one in the channel opens the one in the pane.
 */
export interface ThinkUiState {
  open: boolean;
  sawPhase: ThinkingPhase;
}
export const thinkUiAtoms = atomFamily((_key: string) => atom<ThinkUiState | null>(null));

/** The agent's own slash commands, fetched the first time one is typed. */
export interface CommandsState {
  key: string | null;
  list: CommandEntry[];
  loading: boolean;
}
export const commandsAtom = atom<CommandsState>({ key: null, list: [], loading: false });

// ---------------------------------------------------------------- hermes ---

/** The Hermes panel, as a snapshot of the framework-free store's state. */
export const hermesAtom = atom<HermesState | null>(null);

// -------------------------------------------------------------------- ui ---

export const railHiddenAtom = atom(false);
/** The desktop build on macOS floats the traffic lights over the header. */
export const insetTitlebarAtom = atom(false);
/** The phone's stack of layers, mirrored into `history.state`. */
export const layersAtom = atom<string[]>([]);
/** `#app.with-channel`: on a phone, the channel is in front of the list. */
export const channelRevealedAtom = atom(false);
/** Channel id being dragged between categories, if any. */
export const draggingAtom = atom<string | null>(null);
export const paletteOpenAtom = atom(false);
export const settingsOpenAtom = atom(false);

export interface ModalOption {
  value: string;
  label: string;
  group?: string | null;
}

export type ModalValues = Record<string, string>;

export interface ModalField {
  name: string;
  label?: string;
  value?: string;
  type?: 'text' | 'select' | 'textarea';
  placeholder?: string;
  /** HTML, rendered under the field. */
  help?: string;
  required?: boolean;
  rows?: number;
  /** A select's options, or a function of the other fields for one that depends on them. */
  options?: ModalOption[] | ((values: ModalValues) => ModalOption[]);
  /** Fields to move when this one changes, as the model picker resets the model under a new provider. */
  onChange?: (value: string, values: ModalValues) => ModalValues | undefined;
}

export interface ModalExtra {
  label: string;
  value: string;
  danger?: boolean;
}

export interface ModalConfig {
  title: string;
  fields?: ModalField[];
  note?: string;
  /** Plain text under the title. */
  body?: string;
  okLabel?: string;
  danger?: boolean;
  /** Secondary verbs that resolve with `_action` set to their value. */
  extra?: ModalExtra[];
}

export interface ModalRequest {
  /** Which opening this is, so a new request draws a fresh form. */
  id: number;
  config: ModalConfig;
  resolve: (values: ModalValues | null) => void;
}
export const modalAtom = atom<ModalRequest | null>(null);

export interface Toast {
  id: number;
  text: string;
  kind: '' | 'error';
  fading: boolean;
}
export const toastsAtom = atom<Toast[]>([]);

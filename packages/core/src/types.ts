/**
 * The shapes that cross every boundary: what the database hands back once
 * serialized, what the daemon sends over HTTP, what the CLI prints as JSON,
 * and what the web app renders. One definition, used by all four, is the
 * point of this file — the daemon and the browser cannot disagree about a
 * message when they share its type.
 *
 * Nothing here has behaviour. Runtime rules live beside the code that
 * enforces them (`thinking.ts` clamps a trace; `messages.ts` validates text).
 */

export type JsonObject = Record<string, unknown>;

// ------------------------------------------------------------------ actors ---

export type AuthorKind = 'human' | 'agent' | 'system';

/**
 * Who did something. Messages call this `author` and events call it `actor`;
 * it is the same shape either way, and one name for it is the glossary's
 * decision. An event's actor carries no label.
 */
export interface Author {
  id: string;
  kind: AuthorKind;
  label?: string;
}

/** A message always has a label to show: the author's name, or its id. */
export interface MessageAuthor extends Author {
  label: string;
}

// ---------------------------------------------------------------- channels ---

export interface ChannelCategoryRef {
  id: string;
  slug: string;
  name: string;
  position: number;
}

export interface Channel {
  id: string;
  slug: string;
  name: string;
  topic: string;
  purpose: string;
  kind: string;
  categoryId: string | null;
  category: ChannelCategoryRef | null;
  position: number;
  archived: boolean;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  /** Only present when the listing asked for stats. */
  messageCount?: number;
  lastMessageAt: number | null;
}

export interface Category {
  id: string;
  slug: string;
  name: string;
  position: number;
  collapsed: boolean;
  /** Only present when the listing asked for counts. */
  channelCount?: number;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
}

// ---------------------------------------------------------------- messages ---

/**
 * Metadata is the author's business: whatever JSON was handed in comes back
 * out. Underscore-prefixed keys are bookkeeping the UI knows how to draw
 * (`_model`, `_effort`, `_think`, `_response`) and hides from the raw dump.
 */
export type MessageMetadata = JsonObject;

export interface Message {
  id: string;
  channelId: string;
  /** Joined in on every read; absent only on a row read without the join. */
  channelSlug?: string;
  parentId: string | null;
  /** The root's id — its own id for a root, its parent's for a reply. */
  threadId: string;
  isThreadRoot: boolean;
  author: MessageAuthor;
  text: string;
  mentions: string[];
  metadata: MessageMetadata | null;
  sessionKey: string | null;
  seq: number;
  replyCount: number;
  lastReplyAt: number | null;
  createdAt: number;
  updatedAt: number;
  editedAt: number | null;
  deleted: boolean;
  deletedAt: number | null;
}

// ---------------------------------------------------------------- thinking ---

export type ThinkingPhase = 'streaming' | 'done' | 'error';
export type StepStatus = 'pending' | 'in_progress' | 'complete' | 'error';

export interface ThinkingSource {
  u: string;
  t?: string;
}

/** One step of a trace, as stored: every field settled, status defaulted. */
export interface ThinkingStep {
  id: string;
  t?: string;
  st: StepStatus;
  d?: string[];
  o?: string;
  src?: ThinkingSource[];
}

/**
 * The reasoning trace behind an answer. Short keys on purpose: it rides inside
 * every hydrated copy of its message, forever. `t` title, `p` phase, `s` steps.
 */
export interface ThinkingTrace {
  t?: string;
  p: ThinkingPhase;
  s: ThinkingStep[];
}

// ------------------------------------------------------------------ agents ---

export type SessionState = JsonObject;

export interface ServeStatus {
  live: boolean;
  pid: number | null;
  served: boolean;
  callable: boolean;
}

export interface AgentSession {
  key: string;
  agentId: string;
  name: string | null;
  title: string;
  channelId: string | null;
  channelSlug: string | null;
  cursorSeq: number;
  state: SessionState;
  status: string;
  callable: boolean;
  serve: ServeStatus;
  messageCount: number;
  resumeCount: number;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number | null;
}

export interface ModelChoice {
  id: string;
  label: string;
  group: string | null;
}

// ------------------------------------------------------------------ events ---

export interface EventRecord {
  seq: number;
  type: string;
  actor: Author;
  channelId: string | null;
  messageId: string | null;
  threadId: string | null;
  sessionKey: string | null;
  payload: JsonObject;
  createdAt: number;
}

/** An event with its live message and channel slug attached — what the UI reads. */
export interface HydratedEvent extends EventRecord {
  channelSlug?: string | null;
  message?: Message | null;
}

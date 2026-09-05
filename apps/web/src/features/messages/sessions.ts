/**
 * What the rail and the badges read off an agent session: which model its
 * `serve` watcher is set to, how hard it thinks, and which session a message
 * came through.
 *
 * Pure functions over the session list, so the badge on a message is a value
 * derived from state rather than a chip patched into a row after the fact.
 */

import type { AgentSession, Message, ModelChoice } from '@slick/core';

import { ago } from '../../shared/lib/format.ts';

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/**
 * The model this session's `serve` watcher is set to call, or null for
 * whatever the agent picks by itself. Mirrors `readServeModel` in the core —
 * underscore-prefixed because it is Slick's bookkeeping, not agent memory.
 */
export function serveModel(session: AgentSession): string | null {
  return text(session.state._serveModel);
}

/**
 * How hard this session's watcher is set to think, or null for whatever the
 * agent's own configuration says. Mirrors `readServeEffort` in the core.
 */
export function serveEffort(session: AgentSession): string | null {
  return text(session.state._serveEffort);
}

/**
 * The models this agent told `serve` it can run (`<cmd> --list-models`), in
 * the shape the picker wants. Empty for an agent that never answered — those
 * get a text box instead, because a name typed by hand still works.
 */
export function modelChoices(session: AgentSession): ModelChoice[] {
  const stored: unknown = session.state._serveModelChoices;
  if (!Array.isArray(stored)) return [];
  const choices: ModelChoice[] = [];
  for (const entry of stored) {
    if (typeof entry === 'string') {
      choices.push({ id: entry, label: entry, group: null });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string') continue;
    choices.push({
      id: record.id,
      label: typeof record.label === 'string' && record.label ? record.label : record.id,
      group: typeof record.group === 'string' ? record.group : null,
    });
  }
  return choices;
}

/**
 * What the rail calls the current model: the agent's own name for it.
 *
 * Untrimmed, because `messageModel` reads this too and there it is an
 * identity rather than a label. Its callers shorten it themselves where they
 * paint it.
 */
export function modelLabel(session: AgentSession, model: string | null): string {
  if (!model) return 'default model';
  return modelChoices(session).find((choice) => choice.id === model)?.label ?? model;
}

/**
 * The session a message was posted through. Agents stamp their history key on
 * every message, so that is the exact answer; an agent that posted some other
 * way falls back to its session only when it has exactly one, because guessing
 * between several would put the wrong model next to someone's words.
 */
export function sessionForMessage(message: Message, sessions: readonly AgentSession[]): AgentSession | null {
  if (message.sessionKey) {
    const exact = sessions.find((session) => session.key === message.sessionKey);
    if (exact) return exact;
  }
  const mine = sessions.filter((session) => session.agentId === message.author.id);
  return mine.length === 1 ? (mine[0] ?? null) : null;
}

/**
 * What an agent message says it was answered by — this stands in for the old
 * `agent` badge, so every agent message gets one. Nothing records which model
 * wrote a given message, so it is the session's current setting under the
 * agent's own name for it, same as the rail. A session we cannot pin down, or
 * one on its default, still says something rather than reading like a human.
 */
export function messageModel(message: Message, sessions: readonly AgentSession[]): string | null {
  if (message.author.kind !== 'agent') return null;
  // What actually answered, as `serve` recorded it when the reply was posted.
  // That is history and stays true; everything below is only today's setting.
  // Deliberately the untrimmed name: this is the identity, and `badgeLabel`
  // hands it to the grouping rule. `llama-3-70b.gguf` and
  // `llama-3-70b.safetensors` are one architecture in two builds, and letting
  // them shorten to the same string here would tuck them under one header
  // whose single badge then claims one model answered both. The chip is where
  // the name gets shortened, because that is where it is only a label.
  const answered = text(message.metadata?._model);
  if (answered) return answered;
  const session = sessionForMessage(message, sessions);
  if (!session) return 'agent';
  return modelLabel(session, serveModel(session));
}

/**
 * Metadata worth dumping under a message. Slick's own bookkeeping is
 * underscore-prefixed (`_model`, as on `_serveModel`) and gets rendered
 * properly elsewhere — the raw line is for what the agent chose to attach.
 */
export function visibleMetadata(metadata: unknown): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const entries = Object.entries(metadata as Record<string, unknown>).filter(([key]) => !key.startsWith('_'));
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/**
 * How hard the agent was thinking, if anything says. Recorded on the message
 * by `serve` when the reply was posted — that is history and stays true —
 * and otherwise the session's setting today, same fallback as the model.
 */
export function messageEffort(message: Message, sessions: readonly AgentSession[]): string | null {
  if (message.author.kind !== 'agent') return null;
  const level = text(message.metadata?._effort);
  if (level) return level;
  // A reply `serve` stamped says what it says. It writes `_model` and `_effort`
  // together, so `_model` alone means "answered at no particular level" — not
  // "we do not know" — and today's setting must not be painted over yesterday.
  if (message.metadata && '_model' in message.metadata) return null;
  const session = sessionForMessage(message, sessions);
  return session ? serveEffort(session) : null;
}

/**
 * What the badges say, and what hovering them explains.
 *
 * Two chips rather than one string: the model is a name and the level is a
 * setting, they change independently, and a reader scanning a thread for
 * which answers were thought hard about should find a column rather than read
 * to the end of every id. They sit in one wrapper so the pair travels, and
 * wraps, together.
 */
export interface MessageBadge {
  model: string | null;
  effort: string | null;
  title: string;
}

export function messageBadge(message: Message, sessions: readonly AgentSession[]): MessageBadge | null {
  const model = messageModel(message, sessions);
  const effort = messageEffort(message, sessions);
  if (!model && !effort) return null;
  const answered = model ? `Answered by ${model}` : 'Answered';
  return { model, effort, title: effort ? `${answered}, thinking ${effort}` : answered };
}

/**
 * One string standing for both chips, for the grouping rule. A grouped row has
 * no header and so no chips at all, so two replies differing in either half
 * must not be tucked under one heading: the level counts as much as the name.
 */
export function badgeLabel(message: Message, sessions: readonly AgentSession[]): string | null {
  const badge = messageBadge(message, sessions);
  return badge ? `${badge.model ?? ''} ${badge.effort ?? ''}` : null;
}

/**
 * A fingerprint of "which model, at which level, is each session on". The
 * badges only need redrawing when this changes — a session's `lastSeenAt`
 * ticking over every minute is not a reason to touch a single row.
 *
 * Raw names, not trimmed ones: two settings that only look alike after
 * trimming are still a change worth redrawing for.
 */
export function modelFingerprint(sessions: readonly AgentSession[]): string {
  return sessions
    .map((session) => `${session.key}:${serveModel(session) ?? ''}:${serveEffort(session) ?? ''}`)
    .join('|');
}

/**
 * The sessions worth showing a human.
 *
 * A session only earns a place here if `slick agent serve` answers for it.
 * The rest are automations — the cron job that posts the morning digest owns
 * a history key and a cursor exactly like an agent does, but nothing is
 * watching it, so every affordance the rail offers (open its channel, pick
 * its model, @mention it) does nothing. They speak in their channels instead.
 */
export function callableSessions(sessions: readonly AgentSession[]): AgentSession[] {
  return sessions.filter((session) => session.callable);
}

export interface AgentSuggestion {
  id: string;
  hint?: string;
}

/**
 * Known agents for the `@mention` picker: one entry per agent id, most
 * recently active first. Only the ones that answer — offering an automation
 * here would spell its name correctly and still be ignored.
 */
export function agentSuggestions(sessions: readonly AgentSession[]): AgentSuggestion[] {
  const byId = new Map<string, AgentSession>();
  for (const session of callableSessions(sessions)) {
    const current = byId.get(session.agentId);
    if (!current || (session.lastSeenAt ?? 0) > (current.lastSeenAt ?? 0)) byId.set(session.agentId, session);
  }
  return [...byId.values()]
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
    .map((session) => ({
      id: session.agentId,
      hint: session.channelSlug
        ? `#${session.channelSlug} · ${ago(session.lastSeenAt)}`
        : ago(session.lastSeenAt),
    }));
}

/**
 * The session a slash command is aimed at: an agent that is home in this
 * channel, or failing that any agent that is home at all. A command is asked
 * of an agent, so there has to be one.
 */
export function commandSession(
  sessions: readonly AgentSession[],
  currentSlug: string | null | undefined
): AgentSession | null {
  const callable = sessions.filter((session) => session.serve.callable);
  return callable.find((session) => session.channelSlug === currentSlug) ?? callable[0] ?? null;
}

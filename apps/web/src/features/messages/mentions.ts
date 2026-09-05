/**
 * @-mention autocomplete for a composer textarea, as the rules: where a
 * mention starts, which agents match, and what the box reads once one is
 * picked. The menu itself is a component; this is what it decides with.
 */

import type { AgentSuggestion } from './sessions.ts';

const TOKEN_RE = /^[a-z0-9._-]*$/i;

export interface MentionAnchor {
  /** Where the `@` sits. */
  start: number;
  /** What has been typed after it. */
  query: string;
}

/** Is the caret sitting inside an `@token`? If so, where does it start. */
export function findMention(value: string, caret: number): MentionAnchor | null {
  const at = value.lastIndexOf('@', caret - 1);
  if (at === -1) return null;
  const before = value[at - 1];
  if (before && !/\s/.test(before)) return null;
  const query = value.slice(at + 1, caret);
  if (!TOKEN_RE.test(query)) return null;
  return { start: at, query };
}

/** The agents worth offering for what has been typed so far, at most eight. */
export function mentionMatches(agents: readonly AgentSuggestion[], query: string): AgentSuggestion[] {
  const wanted = query.toLowerCase();
  return agents.filter((a) => a.id.toLowerCase().startsWith(wanted)).slice(0, 8);
}

/** The box with `@id ` in place of the token, and where the caret lands. */
export function insertMention(
  value: string,
  anchor: MentionAnchor,
  id: string
): { value: string; caret: number } {
  const insert = `@${id} `;
  return {
    value: value.slice(0, anchor.start) + insert + value.slice(anchor.start + 1 + anchor.query.length),
    caret: anchor.start + insert.length,
  };
}

/**
 * Whether a message is drawn tucked under the one above it — no avatar, no
 * header, just the text under the previous message's name.
 *
 * This lives apart from the UI because it is the rule that decides whether a
 * message gets a header at all, and a message with no header has nowhere to
 * hang its model badge. Keeping it DOM-free means that rule can be checked
 * directly.
 */

import { dayKey } from './format.js';

/** How close together two messages have to be to share one header. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * `modelOf` is what the badge would say for a message. A grouped row has no
 * header and so no badge, which means grouping two messages together quietly
 * claims the first one's model answered both. An agent can change model
 * between two consecutive replies, so that has to be checked rather than
 * assumed: same name above the messages is not the same thing as same model
 * behind them.
 */
export function isGrouped(message, previous, modelOf) {
  return Boolean(
    previous &&
      !previous.deleted &&
      previous.author.id === message.author.id &&
      previous.author.kind === message.author.kind &&
      message.createdAt - previous.createdAt < GROUP_WINDOW_MS &&
      dayKey(previous.createdAt) === dayKey(message.createdAt) &&
      modelOf(message) === modelOf(previous)
  );
}

/**
 * Message grouping — specifically, that grouping never hides which model
 * actually answered.
 *
 * A grouped message is drawn with no header, and the model badge lives in the
 * header. So grouping two messages together makes the second one's model
 * invisible: the reader sees one badge, the first message's, and takes it for
 * both. That is only honest when both messages really were answered by the
 * same model.
 */

import { strictEqual } from 'node:assert/strict';
import { test } from 'vitest';

import { isGrouped, type Groupable } from '../src/lib/grouping.ts';

/** Taken from a real pair of consecutive `hermes` replies in one thread. */
const AT = 1787457959755;

interface Reply extends Groupable {
  id: string;
  metadata: Record<string, string> | null;
}

function reply(overrides: Partial<Reply> = {}): Reply {
  return {
    id: 'msg_test',
    author: { id: 'hermes', kind: 'agent' },
    createdAt: AT,
    metadata: null,
    ...overrides,
  };
}

/**
 * What the UI puts on the badge, in miniature: the model `serve` recorded when
 * the reply was posted, or — for a message posted before that was stamped —
 * today's setting for the session, which here is its default.
 */
const modelOf = (message: Reply) =>
  message.author.kind === 'agent' ? message.metadata?._model?.trim() || 'default model' : null;

test('a reply whose model differs from the one above it keeps its own header', () => {
  // The live repro: two `hermes` replies 19s apart in the same thread. The
  // first went unstamped, the second recorded gpt-5.6-luna. Grouped, the only
  // badge on screen reads "default model" — and gpt-5.6-luna is never shown.
  const first = reply({ id: 'msg_first', createdAt: AT });
  const second = reply({ id: 'msg_second', createdAt: AT + 19_091, metadata: { _model: 'gpt-5.6-luna' } });

  strictEqual(modelOf(first) === modelOf(second), false, 'guard: this pair must disagree on the model');
  strictEqual(isGrouped(second, first, modelOf), false);
});

test('two replies from the same model still group', () => {
  const first = reply({ id: 'msg_first', metadata: { _model: 'gpt-5.6-luna' } });
  const second = reply({ id: 'msg_second', createdAt: AT + 19_091, metadata: { _model: 'gpt-5.6-luna' } });

  strictEqual(isGrouped(second, first, modelOf), true);
});

test('two unstamped replies still group', () => {
  const first = reply({ id: 'msg_first' });
  const second = reply({ id: 'msg_second', createdAt: AT + 19_091 });

  strictEqual(isGrouped(second, first, modelOf), true);
});

test('a stamp matching the session default still groups', () => {
  // Nothing to tell apart: both rows would show the same badge either way.
  const first = reply({ id: 'msg_first' });
  const second = reply({ id: 'msg_second', createdAt: AT + 19_091, metadata: { _model: 'default model' } });

  strictEqual(isGrouped(second, first, modelOf), true);
});

test('humans group without a model in the picture', () => {
  const first = reply({ id: 'a', author: { id: 'fano', kind: 'human' } });
  const second = reply({ id: 'b', author: { id: 'fano', kind: 'human' }, createdAt: AT + 19_091 });

  strictEqual(isGrouped(second, first, modelOf), true);
});

test('the rules that were already there still hold', () => {
  const first = reply({ id: 'msg_first', metadata: { _model: 'gpt-5.6-luna' } });
  const same = { createdAt: AT + 19_091, metadata: { _model: 'gpt-5.6-luna' } };

  strictEqual(isGrouped(reply({ ...same }), null, modelOf), false, 'nothing above it');
  strictEqual(isGrouped(reply({ ...same }), { ...first, deleted: true }, modelOf), false, 'previous deleted');
  strictEqual(
    isGrouped(reply({ ...same, author: { id: 'claude', kind: 'agent' } }), first, modelOf),
    false,
    'a different author'
  );
  strictEqual(
    isGrouped(reply({ ...same, author: { id: 'hermes', kind: 'human' } }), first, modelOf),
    false,
    'the same name, but a human'
  );
  strictEqual(
    isGrouped(reply({ ...same, createdAt: AT + 5 * 60 * 1000 }), first, modelOf),
    false,
    'past the grouping window'
  );
  // Two minutes apart, so well inside the window, but on either side of local
  // midnight — the day divider goes between them and they cannot share a header.
  const lastMinute = new Date(AT);
  lastMinute.setHours(23, 59, 0, 0);
  strictEqual(
    isGrouped(
      reply({ ...same, createdAt: lastMinute.getTime() + 120_000 }),
      reply({ ...first, createdAt: lastMinute.getTime() }),
      modelOf
    ),
    false,
    'over a day boundary'
  );
});

/**
 * The badge is two chips now — the model and the level it was thought at — and
 * a grouped row shows neither. So the level has to count in this comparison as
 * much as the name does, or a reply thought about at `max` hides under one
 * that was not.
 */
const badgeOf = (message: Reply) => {
  if (message.author.kind !== 'agent') return null;
  const model = message.metadata?._model?.trim() || 'default model';
  const effort = message.metadata?._effort?.trim() || '';
  return `${model} ${effort}`;
};

test('and one thought about harder than the one above it keeps its own header too', () => {
  const first = reply({ id: 'msg_first', createdAt: AT, metadata: { _model: 'gpt-5.6-luna' } });
  const second = reply({
    id: 'msg_second',
    createdAt: AT + 5_000,
    metadata: { _model: 'gpt-5.6-luna', _effort: 'max' },
  });
  strictEqual(isGrouped(second, first, badgeOf), false, 'the level is half the badge');
});

test('but the same model at the same level still groups', () => {
  const stamp = { _model: 'gpt-5.6-luna', _effort: 'high' };
  const first = reply({ id: 'msg_first', createdAt: AT, metadata: stamp });
  const second = reply({ id: 'msg_second', createdAt: AT + 5_000, metadata: { ...stamp } });
  strictEqual(isGrouped(second, first, badgeOf), true);
});

/**
 * Model names on the badge — specifically, which dots are safe to cut.
 *
 * A local model is a file on disk, and its name arrives wearing the file's
 * extension. A hosted model is not a file, and its name is full of dots that
 * happen to look like one. Getting that distinction wrong in either direction
 * is visible: leave the extension on and the same weights badge twice under
 * two names, cut too eagerly and `gpt-4.1` becomes `gpt-4`.
 */

import { strictEqual } from 'node:assert/strict';
import { test } from 'node:test';

import { trimModelName } from '../js/format.js';
import { isGrouped } from '../js/grouping.js';

test('a local weight file badges as its name', () => {
  // The live repro: one model in one workspace, badged 14 times without the
  // extension and 9 times with it.
  strictEqual(trimModelName('Qwen3.8-27B-UD-IQ4_XS.gguf'), 'Qwen3.8-27B-UD-IQ4_XS');
});

test('every suffix the adapters trim is trimmed here too', () => {
  // The same set `reply.model`'s `pattern` uses, so a badge that skipped the
  // adapter reads the same as one that went through it.
  for (const ext of ['gguf', 'ggml', 'safetensors', 'bin', 'pt', 'pth']) {
    strictEqual(trimModelName(`Qwen3.8-27B.${ext}`), 'Qwen3.8-27B', ext);
  }
});

test('a hosted name keeps every dot it came with', () => {
  // The case most likely to regress: these dots are version numbers, and a
  // rule that cut at the last one would silently ship `gpt-4` and `claude-3`.
  strictEqual(trimModelName('gpt-5.6-luna'), 'gpt-5.6-luna');
  strictEqual(trimModelName('gpt-4.1'), 'gpt-4.1');
  strictEqual(trimModelName('claude-3.5-sonnet'), 'claude-3.5-sonnet');
  strictEqual(trimModelName('llama-3.1-70b-instruct'), 'llama-3.1-70b-instruct');
  strictEqual(trimModelName('default model'), 'default model');
});

test('a suffix that is not a weight file is not a suffix', () => {
  strictEqual(trimModelName('some-model.json'), 'some-model.json');
  strictEqual(trimModelName('some-model.ptx'), 'some-model.ptx');
  strictEqual(trimModelName('gguf'), 'gguf', 'no dot, nothing to cut');
});

test('a path stays whole', () => {
  // Nothing in the live workspace stamps a directory, so stripping one would
  // be a guess. The extension still goes.
  strictEqual(trimModelName('/weights/Qwen3.8-27B.gguf'), '/weights/Qwen3.8-27B');
  strictEqual(trimModelName('C:\\weights\\Qwen3.8-27B.gguf'), 'C:\\weights\\Qwen3.8-27B');
});

test('nothing to trim is not an excuse to throw', () => {
  strictEqual(trimModelName(null), '');
  strictEqual(trimModelName(undefined), '');
  strictEqual(trimModelName(''), '');
  strictEqual(trimModelName('.gguf'), '.gguf', 'all suffix and no name still says something');
  strictEqual(trimModelName(' .gguf'), ' .gguf', 'nor does a name that trims to blank');
  strictEqual(trimModelName(42), '42', 'a label the agent sent as a number is still a label');
});

test('the spelling of the extension is not the point', () => {
  // The filesystems these names come off are case-insensitive, so the same
  // weights arrive spelled either way and must land on the same badge.
  strictEqual(trimModelName('Qwen3.8-27B-UD-IQ4_XS.GGUF'), 'Qwen3.8-27B-UD-IQ4_XS');
  strictEqual(trimModelName('model.SafeTensors'), 'model');
  strictEqual(trimModelName('model.Bin'), 'model');
});

// ------------------------------------------------------------- grouping ---

/**
 * `messageModel`, in miniature. Deliberately NOT trimmed: the trim happens in
 * `modelChip`, and this is the string the grouping rule compares.
 */
const modelOf = (message) =>
  message.author.kind === 'agent' ? message.metadata?._model?.trim() || 'default model' : null;

const AT = 1787457959755;
const reply = (overrides) => ({
  id: 'msg_test',
  author: { id: 'hermes', kind: 'agent', label: 'hermes' },
  sessionKey: 'slk_h1_ehec4jjhxayq70pwy2ps',
  createdAt: AT,
  metadata: null,
  ...overrides,
});

test('shortening the badge does not merge two builds into one header', () => {
  // The trap this trim could have walked into. `.gguf` and `.safetensors` are
  // two builds of one architecture — often two different quantisations — and
  // they shorten to the same string. Grouping reads the untrimmed name, so
  // they keep their own headers and their own badges; only the chips are
  // short. A shared header here would put one badge over two models.
  const first = reply({ id: 'msg_first', metadata: { _model: 'llama-3-70b.gguf' } });
  const second = reply({
    id: 'msg_second',
    createdAt: AT + 19_091,
    metadata: { _model: 'llama-3-70b.safetensors' },
  });

  strictEqual(isGrouped(second, first, modelOf), false);
  strictEqual(trimModelName('llama-3-70b.gguf'), trimModelName('llama-3-70b.safetensors'));
});

test('and two plainly different models still do not group', () => {
  const first = reply({ id: 'msg_first', metadata: { _model: 'Qwen3.8-27B-UD-IQ4_XS.gguf' } });
  const second = reply({ id: 'msg_second', createdAt: AT + 19_091, metadata: { _model: 'gpt-5.6-luna' } });

  strictEqual(isGrouped(second, first, modelOf), false);
});

test('while the same model at two efforts keeps its own headers', () => {
  // The other half of the grouping key, unaffected by any of this.
  const first = reply({ id: 'msg_first', metadata: { _model: 'gpt-5.6-luna', _effort: 'max' } });
  const second = reply({
    id: 'msg_second',
    createdAt: AT + 19_091,
    metadata: { _model: 'gpt-5.6-luna', _effort: 'low' },
  });
  const badgeOf = (message) =>
    `${modelOf(message) ?? ''} ${message.metadata?._effort ?? ''}`;

  strictEqual(isGrouped(second, first, badgeOf), false);
});

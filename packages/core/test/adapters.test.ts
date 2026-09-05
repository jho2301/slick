/**
 * Two things that used to be hard-coded inside `slick agent serve`: how an
 * agent binary is called, and what happens when its answer is too long to
 * post. Both are pure functions now, so both can be checked without a child
 * process or a workspace.
 */

import { test, describe } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BUILT_IN_ADAPTERS,
  MAX_TEXT_LENGTH,
  buildAgentArgs,
  buildModelListArgs,
  listAdapters,
  loadAdapter,
  lookupReported,
  normalizeAdapter,
  parseAgentReply,
  slotFires,
  supportsCommands,
  buildCommandListCall,
  buildCommandRunCall,
  splitMessageText,
  supportsResume,
} from '../src/index.ts';

const { claude, plain } = BUILT_IN_ADAPTERS;

describe('calling an agent', () => {
  test('the claude adapter builds exactly the call serve used to make by hand', () => {
    assert.deepEqual(
      buildAgentArgs(claude, {
        prompt: 'hello',
        session: 'sess-1',
        permissionMode: 'plan',
        allowedTools: 'Read',
        skipPermissions: true,
        model: 'opus',
        system: 'be brief',
      }),
      [
        '-p',
        'hello',
        '--output-format',
        'json',
        '--resume',
        'sess-1',
        '--permission-mode',
        'plan',
        '--allowedTools',
        'Read',
        '--dangerously-skip-permissions',
        '--model',
        'opus',
        '--append-system-prompt',
        'be brief',
      ]
    );
  });

  test('a group with nothing to put in it is left out whole', () => {
    assert.deepEqual(buildAgentArgs(claude, { prompt: 'hi' }), ['-p', 'hi', '--output-format', 'json']);
    assert.deepEqual(buildAgentArgs(claude, { prompt: 'hi', skipPermissions: false }), [
      '-p',
      'hi',
      '--output-format',
      'json',
    ]);
  });

  test('an agent with no way to be given a model is never given one', () => {
    const modelless = normalizeAdapter(
      { cmd: 'x', args: { prompt: ['--ask', '{prompt}'] } },
      { name: 'modelless', source: 'built-in' }
    );
    assert.deepEqual(buildAgentArgs(modelless, { prompt: 'hi', model: 'opus' }), ['--ask', 'hi']);
    assert.equal(supportsResume(modelless), false, 'and cannot be handed a conversation either');
  });

  test('an adapter that reads stdin keeps the prompt out of the arguments', () => {
    assert.deepEqual(buildAgentArgs(plain, { prompt: 'a very long prompt' }), []);
    assert.equal(plain.promptVia, 'stdin');
  });

  test('only an agent that can be asked what it runs is asked', () => {
    assert.deepEqual(buildModelListArgs(claude), ['--list-models']);
    assert.equal(buildModelListArgs(plain), null);
  });
});

describe('reading an agent’s reply', () => {
  test('a JSON answer gives back the text, the conversation and the model', () => {
    const reply = parseAgentReply(claude, {
      stdout: JSON.stringify({ result: 'done', session_id: 's-9', modelUsage: { 'claude-opus-4': {} } }),
    });
    assert.deepEqual(reply, {
      text: 'done',
      sessionId: 's-9',
      model: 'claude-opus-4',
      effort: null,
      error: null,
    });
  });

  test('an agent that reports an error is a failure even when it exits 0', () => {
    const reply = parseAgentReply(claude, {
      stdout: JSON.stringify({ is_error: true, result: 'boom', session_id: 's-9' }),
    });
    assert.equal(reply.error, 'boom');
    assert.equal(reply.text, '');
    assert.equal(reply.sessionId, 's-9', 'which conversation failed is still worth knowing');
  });

  test('an empty answer is a failure, not an answer nobody can post', () => {
    const reply = parseAgentReply(claude, {
      stdout: JSON.stringify({ result: '  ', session_id: 's-9' }),
      cmd: 'x',
    });
    assert.match(reply.error!, /empty answer/);
  });

  test('output that is not the JSON we hoped for is still read as an answer', () => {
    const reply = parseAgentReply(claude, { stdout: 'warning: something\nthe actual answer' });
    assert.match(reply.text, /the actual answer$/);
    assert.equal(reply.sessionId, null);
  });

  test('a plain adapter takes stdout as it stands', () => {
    assert.deepEqual(parseAgentReply(plain, { stdout: '  hello  \n' }), {
      text: 'hello',
      sessionId: null,
      model: null,
      effort: null,
      error: null,
    });
  });

  test('a non-zero exit is reported with whatever it said on the way out', () => {
    const reply = parseAgentReply(plain, { stdout: '', stderr: 'no such model', code: 1, cmd: 'agent' });
    assert.equal(reply.error, 'no such model');
    assert.equal(
      parseAgentReply(plain, { stdout: '', code: 3, cmd: 'agent' }).error,
      'agent exited with code 3'
    );
  });

  test('reply field names are the adapter’s to choose, nested ones included', () => {
    const custom = normalizeAdapter(
      {
        cmd: 'x',
        args: { prompt: ['{prompt}'] },
        reply: { format: 'json', text: 'data.answer', sessionId: 'data.thread', model: 'meta.model' },
      },
      { name: 'custom', source: 'built-in' }
    );
    const reply = parseAgentReply(custom, {
      stdout: JSON.stringify({ data: { answer: 'yes', thread: 't-1' }, meta: { model: 'm-1' } }),
    });
    assert.deepEqual(reply, { text: 'yes', sessionId: 't-1', model: 'm-1', effort: null, error: null });
  });
});

describe('values that are not one flag one value', () => {
  const split = normalizeAdapter(
    {
      cmd: 'x',
      args: {
        prompt: ['-q', '{prompt}'],
        model: { match: '^(.+?)::(.+)$', args: ['-m', '{2}', '--provider', '{1}'], else: ['-m', '{value}'] },
      },
    },
    { name: 'split', source: 'built-in' }
  );

  test('a match spreads the captures across several flags', () => {
    assert.deepEqual(buildAgentArgs(split, { prompt: 'hi', model: 'copilot::gpt-5.4' }), [
      '-q',
      'hi',
      '-m',
      'gpt-5.4',
      '--provider',
      'copilot',
    ]);
  });

  test('a value of another shape takes the other branch', () => {
    assert.deepEqual(buildAgentArgs(split, { prompt: 'hi', model: 'gpt-5.4' }), [
      '-q',
      'hi',
      '-m',
      'gpt-5.4',
    ]);
  });

  test('with no other branch, a value that does not match leaves the group out', () => {
    const strict = normalizeAdapter(
      {
        cmd: 'x',
        args: { prompt: ['-q', '{prompt}'], model: { match: '^local:(.+)$', args: ['--weights', '{1}'] } },
      },
      { name: 'strict', source: 'built-in' }
    );
    assert.deepEqual(buildAgentArgs(strict, { prompt: 'hi', model: 'local:qwen.gguf' }), [
      '-q',
      'hi',
      '--weights',
      'qwen.gguf',
    ]);
    assert.deepEqual(buildAgentArgs(strict, { prompt: 'hi', model: 'gpt-5.4' }), ['-q', 'hi']);
  });

  test('a group that is an object without a match is refused', () => {
    assert.throws(
      () =>
        normalizeAdapter(
          { cmd: 'x', args: { prompt: ['{prompt}'], model: { args: ['-m'] } } },
          { name: 'x', source: '/tmp/x.json' }
        ),
      /needs a "match" pattern/
    );
  });
});

describe('reading a reply that is not JSON', () => {
  const hermeslike = normalizeAdapter(
    {
      cmd: 'x',
      args: { prompt: ['-q', '{prompt}'] },
      reply: { format: 'text', sessionId: { pattern: 'session_id:\\s*(\\S+)', from: 'stderr' } },
    },
    { name: 'hermeslike', source: 'built-in' }
  );

  test('the conversation to resume is found in what it printed', () => {
    const reply = parseAgentReply(hermeslike, {
      stdout: 'the answer\n',
      stderr: '↻ Resumed session old-1 (2 messages)\n\nsession_id: 20260824_120000_abc\n',
    });
    assert.deepEqual(reply, {
      text: 'the answer',
      sessionId: '20260824_120000_abc',
      model: null,
      effort: null,
      error: null,
    });
  });

  test('`from` says which stream to believe', () => {
    const reply = parseAgentReply(hermeslike, { stdout: 'session_id: not-this-one\nthe answer', stderr: '' });
    assert.equal(reply.sessionId, null, 'stdout is the answer, not a place to look for fields');
  });

  test('a failed run still reports which conversation it died in', () => {
    const reply = parseAgentReply(hermeslike, {
      stdout: '',
      stderr: 'Error: provider unreachable\n\nsession_id: sess-9\n',
      code: 1,
      cmd: 'hermes',
    });
    assert.equal(reply.sessionId, 'sess-9');
    assert.match(reply.error!, /provider unreachable/);
  });

  test('naming a JSON field on a text reply is refused, with the fix in the hint', () => {
    assert.throws(
      () =>
        normalizeAdapter(
          { cmd: 'x', args: { prompt: ['{prompt}'] }, reply: { format: 'text', sessionId: 'session_id' } },
          { name: 'x', source: '/tmp/x.json' }
        ),
      /names a JSON field, but this reply is text/
    );
  });
});
describe('adapter manifests', () => {
  const bad = (raw: unknown, pattern: RegExp) => {
    assert.throws(() => normalizeAdapter(raw, { name: 'x', source: '/tmp/x.json' }), pattern);
  };

  test('a manifest that cannot work is refused where it can be fixed', () => {
    bad({ args: { nope: ['--x'] } }, /unknown argument group "nope"/);
    bad({ args: { model: '--model' } }, /must be a list of strings/);
    bad({ args: {} }, /nothing carries the prompt/);
    bad({ args: { prompt: ['-p', '{prompt}'] }, reply: { format: 'yaml' } }, /reply\.format/);
    bad({ args: { prompt: ['-p', '{prompt}'] }, maxMessageLength: 0 }, /maxMessageLength/);
    bad([], /not a JSON object/);
  });

  test('an adapter that reads stdin needs no prompt argument', () => {
    const adapter = normalizeAdapter({ cmd: 'x', promptVia: 'stdin' }, { name: 'x', source: 'built-in' });
    assert.equal(adapter.promptVia, 'stdin');
  });
});

describe('finding adapters', () => {
  let home: string;
  const write = (name: string, body: string) => writeFileSync(join(home, 'adapters', `${name}.json`), body);

  test('a file wins over a built-in of the same name', () => {
    home = mkdtempSync(join(tmpdir(), 'slick-adapters-'));
    mkdirSync(join(home, 'adapters'), { recursive: true });
    write('claude', JSON.stringify({ cmd: '/opt/claude', args: { prompt: ['-p', '{prompt}'] } }));
    assert.equal(loadAdapter('claude', home).cmd, '/opt/claude');
    assert.equal(loadAdapter('plain', home).cmd, null, 'the other built-ins are untouched');
  });

  test('a name nobody has heard of says where to put one', () => {
    assert.throws(() => loadAdapter('hermes', home), /No agent adapter called "hermes"/);
    assert.throws(() => loadAdapter('../etc/passwd', home), /not a valid adapter name/);
  });

  test('a manifest that does not parse costs you that adapter, not the list', () => {
    write('broken', '{ this is not json');
    const found = listAdapters(home);
    assert.match(found.find((a) => a.name === 'broken')!.error!, /not valid JSON/);
    assert.ok(
      found.find((a) => a.name === 'plain'),
      'the others are still listed'
    );
    rmSync(home, { recursive: true, force: true });
  });
});

describe('splitting an answer too long to post', () => {
  const fits = (pieces: string[], cap: number) =>
    pieces.every((piece) => piece.length <= cap && piece.trim().length > 0);

  test('anything that already fits comes back untouched', () => {
    assert.deepEqual(splitMessageText('hello'), ['hello']);
    assert.deepEqual(splitMessageText('', 500), ['']);
  });

  test('prose is broken between lines, and nothing is lost', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i} ${'x'.repeat(40)}`);
    const pieces = splitMessageText(lines.join('\n'), 500);
    assert.ok(pieces.length > 1);
    assert.ok(fits(pieces, 500));
    assert.equal(pieces.join('\n'), lines.join('\n'), 'the answer survives the split exactly');
  });

  test('a code fence the split lands inside is closed and reopened', () => {
    const code = Array.from({ length: 40 }, (_, i) => `const a${i} = ${i};`);
    const pieces = splitMessageText(`Here:\n\n\`\`\`js\n${code.join('\n')}\n\`\`\`\n\nDone.`, 300);
    assert.ok(pieces.length > 2);
    assert.ok(fits(pieces, 300));
    for (const piece of pieces) {
      const fences = piece.match(/^ {0,3}`{3,}/gm) ?? [];
      assert.equal(fences.length % 2, 0, `a piece renders as half a fence:\n${piece}`);
    }
    assert.equal(
      pieces.join('\n').match(/const a\d+ = /g)!.length,
      code.length,
      'every line of code is still there'
    );
  });

  test('a single line too long for any piece is cut, not dropped', () => {
    const pieces = splitMessageText('u'.repeat(2000), 300);
    assert.ok(fits(pieces, 300));
    assert.equal(pieces.join('').length, 2000);
  });

  test('no adapter can raise the cap past what a message will hold', () => {
    const pieces = splitMessageText('z'.repeat(MAX_TEXT_LENGTH * 2), MAX_TEXT_LENGTH * 10);
    assert.ok(fits(pieces, MAX_TEXT_LENGTH));
    assert.equal(pieces.length, 2);
  });
});

describe('asking the agent’s own store which model ran', () => {
  let home: string;
  let store: string;

  const adapter = (model: Record<string, unknown>) =>
    normalizeAdapter(
      { cmd: 'x', args: { prompt: ['{prompt}'] }, reply: { format: 'text', model } },
      { name: 'x', source: '/tmp/x.json' }
    );

  test('a lookup answers with the row the agent wrote', () => {
    home = mkdtempSync(join(tmpdir(), 'slick-store-'));
    store = join(home, 'state.db');
    const db = new DatabaseSync(store);
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT)');
    db.prepare('INSERT INTO sessions VALUES (?, ?)').run('sess-1', 'gpt-5.6-luna');
    db.prepare('INSERT INTO sessions VALUES (?, ?)').run('sess-2', 'C:\\LLM\\models\\Qwen3.8-27B.gguf');
    db.close();

    const plainLookup = adapter({ sqlite: store, query: 'SELECT model FROM sessions WHERE id = ?' });
    assert.equal(lookupReported(plainLookup, { sessionId: 'sess-1' }), 'gpt-5.6-luna');
  });

  test('a pattern beside it trims a path down to the model’s name', () => {
    const trimmed = adapter({
      sqlite: store,
      query: 'SELECT model FROM sessions WHERE id = ?',
      pattern: '([^/\\\\]+?)(?:\\.(?:gguf|safetensors))?$',
    });
    assert.equal(lookupReported(trimmed, { sessionId: 'sess-2' }), 'Qwen3.8-27B');
    assert.equal(
      lookupReported(trimmed, { sessionId: 'sess-1' }),
      'gpt-5.6-luna',
      'and leaves a plain name alone'
    );
  });

  test('nothing to find is no badge, never a failed answer', () => {
    const found = adapter({ sqlite: store, query: 'SELECT model FROM sessions WHERE id = ?' });
    assert.equal(lookupReported(found, { sessionId: 'never-existed' }), null);
    assert.equal(lookupReported(found, { sessionId: null }), null, 'no id, nothing to bind');

    const gone = adapter({
      sqlite: join(home, 'not-here.db'),
      query: 'SELECT model FROM sessions WHERE id = ?',
    });
    assert.equal(lookupReported(gone, { sessionId: 'sess-1' }), null);

    const wrongTable = adapter({ sqlite: store, query: 'SELECT model FROM runs WHERE id = ?' });
    assert.equal(lookupReported(wrongTable, { sessionId: 'sess-1' }), null);

    assert.equal(
      lookupReported(BUILT_IN_ADAPTERS.claude, { sessionId: 'sess-1' }),
      null,
      'no lookup, no query'
    );
    rmSync(home, { recursive: true, force: true });
  });

  test('it stays a lookup: one SELECT, one bind, and never the session id', () => {
    const bad = (model: Record<string, unknown>, pattern: RegExp) =>
      assert.throws(() => adapter(model), pattern);
    bad({ sqlite: '/tmp/x.db', query: 'DELETE FROM sessions' }, /must be a single SELECT/);
    bad({ sqlite: '/tmp/x.db', query: 'SELECT 1; DROP TABLE sessions' }, /must be a single SELECT/);
    bad({ sqlite: '/tmp/x.db', query: 'SELECT model FROM s WHERE a = ? AND b = ?' }, /at most one "\?"/);
    bad({ sqlite: 'state.db', query: 'SELECT model FROM s' }, /absolute path/);
    // The id is the key everything else binds to, so it cannot come from a
    // lookup that needs it.
    assert.throws(
      () =>
        normalizeAdapter(
          {
            cmd: 'x',
            args: { prompt: ['{prompt}'] },
            reply: { format: 'text', sessionId: { sqlite: '/tmp/x.db', query: 'SELECT id FROM s' } },
          },
          { name: 'x', source: '/tmp/x.json' }
        ),
      /cannot be read from a database/
    );
  });

  test('the answer can come out of the store too, and is not clipped like a name is', () => {
    const home = mkdtempSync(join(tmpdir(), 'slick-answer-'));
    const store = join(home, 'state.db');
    const long = 'x'.repeat(5000);
    const db = new DatabaseSync(store);
    db.exec('CREATE TABLE messages (session_id TEXT, content TEXT)');
    db.prepare('INSERT INTO messages VALUES (?, ?)').run('sess-1', long);
    db.close();

    const withStore = normalizeAdapter(
      {
        cmd: 'x',
        args: { prompt: ['{prompt}'] },
        reply: {
          format: 'text',
          text: { sqlite: store, query: 'SELECT content FROM messages WHERE session_id = ?' },
        },
      },
      { name: 'x', source: '/tmp/x.json' }
    );
    assert.equal(lookupReported(withStore, { sessionId: 'sess-1' }, 'text')!.length, 5000);
    assert.equal(
      lookupReported(withStore, { sessionId: 'nobody' }, 'text'),
      null,
      'and stays quiet with no row'
    );
    rmSync(home, { recursive: true, force: true });
  });
});

describe('a trimming pattern is not a search pattern', () => {
  test('a field with a store behind it is never scraped off the streams', () => {
    // The trim below matches anything, which is fine against one looked-up
    // value and catastrophic against a whole answer.
    const adapter = normalizeAdapter(
      {
        cmd: 'x',
        args: { prompt: ['{prompt}'] },
        reply: {
          format: 'text',
          model: {
            sqlite: '/nope/state.db',
            query: 'SELECT model FROM sessions WHERE id = ?',
            pattern: '(.*)$',
          },
          sessionId: { pattern: 'session_id:\\s*(\\S+)', from: 'stderr' },
        },
      },
      { name: 'x', source: '/tmp/x.json' }
    );
    const reply = parseAgentReply(adapter, {
      stdout: 'the whole answer\n',
      stderr: '\nsession_id: sess-1\n',
    });
    assert.equal(reply.text, 'the whole answer');
    assert.equal(reply.model, null, 'the badge waits for the lookup rather than eating the answer');
    assert.equal(reply.sessionId, 'sess-1');
  });
});

describe('how hard to think', () => {
  test('the claude adapter carries an effort level, and leaves it out when there is none', () => {
    assert.deepEqual(buildAgentArgs(claude, { prompt: 'hi', effort: 'xhigh' }), [
      '-p',
      'hi',
      '--output-format',
      'json',
      '--effort',
      'xhigh',
    ]);
    assert.deepEqual(buildAgentArgs(claude, { prompt: 'hi' }), ['-p', 'hi', '--output-format', 'json']);
  });

  test('an agent with no effort group is never asked to think harder', () => {
    assert.deepEqual(buildAgentArgs(plain, { prompt: 'hi', effort: 'max' }), []);
  });

  test('a reported level comes back beside the model', () => {
    const reporting = normalizeAdapter(
      {
        cmd: 'x',
        args: { prompt: ['-p', '{prompt}'], effort: ['--reasoning', '{effort}'] },
        reply: { format: 'json', text: 'result', model: 'model', effort: 'reasoning.effort' },
      },
      { name: 'reporting', source: 'built-in' }
    );
    const reply = parseAgentReply(reporting, {
      stdout: JSON.stringify({ result: 'done', model: 'm-1', reasoning: { effort: 'max' } }),
    });
    assert.equal(reply.effort, 'max');
    assert.equal(reply.model, 'm-1');
  });

  test('the level can also be read out of the agent’s own store', () => {
    const home = mkdtempSync(join(tmpdir(), 'slick-effort-'));
    const store = join(home, 'state.db');
    const db = new DatabaseSync(store);
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, model_config TEXT)');
    db.prepare('INSERT INTO sessions VALUES (?, ?)').run('sess-1', '{"reasoning_config": {"effort": "max"}}');
    db.close();

    const adapter = normalizeAdapter(
      {
        cmd: 'x',
        args: { prompt: ['{prompt}'] },
        reply: {
          format: 'text',
          effort: {
            sqlite: store,
            query:
              "SELECT json_extract(model_config, '$.reasoning_config.effort') FROM sessions WHERE id = ?",
          },
        },
      },
      { name: 'x', source: '/tmp/x.json' }
    );
    assert.equal(lookupReported(adapter, { sessionId: 'sess-1' }, 'effort'), 'max');
    assert.equal(
      lookupReported(adapter, { sessionId: 'sess-1' }, 'model'),
      null,
      'a field with no lookup stays quiet'
    );
    rmSync(home, { recursive: true, force: true });
  });
});

describe('splitting stays inside the cap, whatever the text', () => {
  const FENCES = ['```', '```js', '~~~', '````', '   ```py'];
  /** Everything but whitespace and fence lines — what a split must not lose. */
  const body = (s: string) =>
    s
      .split('\n')
      .filter((line: string) => !/^ {0,3}(`{3,}|~{3,})/.test(line))
      .join('')
      .replace(/\s/g, '');

  test('a fence opener landing on the boundary neither loops nor overflows', () => {
    // The shape that hung `serve`: the opener sits within a closer's width of
    // the cap, so every piece was re-seeded with a fence it had no room for.
    for (let cap = 200; cap <= 210; cap++) {
      const opener = '```js';
      const text = `${'y'.repeat(cap - opener.length - 1)}\n${opener}\n${'z'.repeat(cap * 3)}`;
      const pieces = splitMessageText(text, cap);
      assert.ok(pieces.length > 1 && pieces.length < 50, `cap ${cap}: ${pieces.length} pieces`);
      assert.ok(
        pieces.every((piece) => piece.length <= cap),
        `cap ${cap}: longest piece is ${Math.max(...pieces.map((p) => p.length))}`
      );
    }
  });

  test('and no document does, over a few thousand of them', () => {
    let seed = 12345;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
    for (let round = 0; round < 2000; round++) {
      const cap = 200 + rnd(400);
      const lines = [];
      for (let i = 0; i < rnd(30) + 1; i++) {
        const roll = rnd(10);
        if (roll < 2) lines.push(FENCES[rnd(FENCES.length)]);
        else if (roll < 3) lines.push('');
        // Lengths clustered on the boundary, where the arithmetic goes wrong.
        else lines.push('x'.repeat(Math.max(0, cap - 8 + rnd(20))));
      }
      const text = lines.join('\n');
      const pieces = splitMessageText(text, cap);
      for (const piece of pieces) {
        assert.ok(piece.length <= cap, `piece of ${piece.length} over cap ${cap}`);
        if (text.trim()) assert.ok(piece.trim().length > 0, 'a piece with nothing in it cannot be posted');
      }
      if (text.trim()) assert.equal(body(pieces.join('\n')), body(text), 'the answer survives the split');
    }
  });
});

describe('an answer that lives in a store', () => {
  const withLookup = (extra = {}, format = 'text') =>
    normalizeAdapter(
      {
        cmd: 'x',
        args: { prompt: ['-p', '{prompt}'] },
        reply: {
          format,
          sessionId: format === 'json' ? 'session_id' : { pattern: 'id: (\\S+)', from: 'stderr' },
          text: { sqlite: '/nowhere/state.db', query: 'SELECT content FROM m WHERE id = ?', ...extra },
        },
      },
      { name: 'x', source: '/tmp/x.json' }
    );

  test('is not guessed at from the printed output, and is not an empty-answer failure', () => {
    const reply = parseAgentReply(withLookup(), {
      stdout: 'reasoning noise\nand more',
      stderr: '\nid: s-1\n',
    });
    assert.equal(reply.error, null, 'the caller has a store to ask; this is not a failure yet');
    assert.equal(reply.text, '', 'and the printed noise is not the answer');
    assert.equal(reply.sessionId, 's-1');
  });

  test('a trimming pattern beside it does not turn every run into a failure', () => {
    const reply = parseAgentReply(withLookup({ pattern: '(.*)$' }), {
      stdout: 'noise',
      stderr: '\nid: s-1\n',
    });
    assert.equal(reply.error, null);
    assert.equal(reply.text, '');
  });

  test('and a JSON envelope is never posted as the answer', () => {
    const reply = parseAgentReply(withLookup({}, 'json'), {
      stdout: JSON.stringify({ session_id: 's-1', reasoning: 'blah', answer: 'hi' }),
    });
    assert.equal(reply.error, null);
    assert.equal(reply.text, '');
    assert.equal(reply.sessionId, 's-1');
    assert.doesNotMatch(String(reply.text), /reasoning/);
  });

  test('a bind with no placeholder to bind to is refused where it is written', () => {
    assert.throws(
      () =>
        normalizeAdapter(
          {
            cmd: 'x',
            args: { prompt: ['{prompt}'] },
            reply: {
              format: 'text',
              model: { sqlite: '/x/state.db', query: 'SELECT model FROM s', bind: 'sessionId' },
            },
          },
          { name: 'x', source: '/tmp/x.json' }
        ),
      /no "\?" in the query to bind to/
    );
  });
});

describe('saying only what was actually asked', () => {
  const picky = normalizeAdapter(
    {
      cmd: 'x',
      args: {
        prompt: ['-p', '{prompt}'],
        effort: { match: '^(low|high)$', args: ['--effort', '{value}'] },
        model: ['--model', '{model}'],
      },
    },
    { name: 'picky', source: '/tmp/x.json' }
  );

  test('a match-form group that drops the value did not ask for it', () => {
    assert.equal(slotFires(picky, 'effort', 'high'), true);
    assert.equal(slotFires(picky, 'effort', 'ultra'), false, 'no else, so nothing reached the binary');
    assert.deepEqual(buildAgentArgs(picky, { prompt: 'p', effort: 'ultra' }), ['-p', 'p']);
    assert.equal(slotFires(picky, 'effort', null), false);
    assert.equal(slotFires(picky, 'model', 'anything'), true, 'a plain group always fires');
    assert.equal(slotFires(BUILT_IN_ADAPTERS.plain, 'effort', 'high'), false, 'no group at all');
  });
});

describe('an agent that fails in its own words', () => {
  test('a text adapter can say where the failure is, and it is believed', () => {
    const adapter = normalizeAdapter(
      {
        cmd: 'x',
        args: { prompt: ['-p', '{prompt}'] },
        reply: { format: 'text', error: { pattern: '^ERROR: (.*)$', from: 'stderr' } },
      },
      { name: 'x', source: '/tmp/x.json' }
    );
    const failed = parseAgentReply(adapter, {
      stdout: 'half an answer',
      stderr: 'ERROR: quota exhausted',
      code: 0,
    });
    assert.equal(failed.error, 'quota exhausted');
    assert.equal(failed.text, '');

    const fine = parseAgentReply(adapter, { stdout: 'a real answer', stderr: 'note: warming up', code: 0 });
    assert.equal(fine.error, null);
    assert.equal(fine.text, 'a real answer');
  });
});

describe('an agent’s own commands', () => {
  const spec = (extra: unknown) =>
    normalizeAdapter(
      { cmd: 'x', args: { prompt: ['{prompt}'] }, commands: extra },
      { name: 'x', source: '/tmp/x.json' }
    );

  test('the two calls are built from the adapter, and the binary can be its own', () => {
    const adapter = spec({
      list: { cmd: '/usr/bin/python3', args: ['/helper.py', '--list'], cwd: '/tmp' },
      run: { args: ['/helper.py', '{command}', '{args}'] },
    });
    assert.equal(supportsCommands(adapter), true);
    assert.deepEqual(buildCommandListCall(adapter, 'x'), {
      cmd: '/usr/bin/python3',
      args: ['/helper.py', '--list'],
      cwd: '/tmp',
    });
    assert.deepEqual(buildCommandRunCall(adapter, 'x', { command: 'status', args: '--json' }), {
      cmd: 'x',
      args: ['/helper.py', 'status', '--json'],
      cwd: null,
    });
  });

  test('an agent with nothing to offer offers nothing', () => {
    assert.equal(supportsCommands(BUILT_IN_ADAPTERS.claude), false);
    assert.equal(buildCommandListCall(BUILT_IN_ADAPTERS.claude, 'claude'), null);
    assert.equal(buildCommandRunCall(BUILT_IN_ADAPTERS.claude, 'claude', { command: 'help' }), null);
  });

  test('a manifest that cannot say which command to run is refused', () => {
    assert.throws(() => spec({ run: { args: ['/helper.py'] } }), /no "\{command\}" placeholder/);
    assert.throws(() => spec({}), /needs a "list", a "run", or both/);
    assert.throws(() => spec({ list: { args: [] } }), /cannot be empty/);
  });
});

describe('what the agent says while it is still answering', () => {
  const withStream = (stream: unknown, args: Record<string, unknown> = { prompt: ['-p', '{prompt}'] }) =>
    normalizeAdapter({ cmd: 'x', args, stream }, { name: 'x', source: '/tmp/x.json' });

  test('the flag that asks for the narration rides in with the paths that read it', () => {
    const adapter = withStream({ text: 'delta.text', step: 'tool.name', args: ['--stream-json'] });
    assert.deepEqual(buildAgentArgs(adapter, { prompt: 'p' }), ['-p', 'p', '--stream-json']);
    assert.deepEqual(adapter.stream!.read({ delta: { text: 'hal' }, tool: { name: 'grep' } }), {
      text: 'hal',
      reasoning: null,
      step: 'grep',
      stepStatus: null,
    });
    assert.equal(
      adapter.stream!.read({ usage: { tokens: 12 } }),
      null,
      'a frame it cannot read is not a flicker'
    );
  });

  test('asking for the narration without saying how to read it is refused', () => {
    // It used to be an unknown group and said so. Now the group exists, so a
    // manifest that names it alone would validate and silently never fire.
    assert.throws(
      () => withStream(undefined, { prompt: ['{prompt}'], stream: ['--stream-json'] }),
      /no "stream" block to go with it/
    );
    assert.throws(() => withStream({ args: ['--stream-json'] }), /names no field to read/);
  });

  test('an adapter with nothing to say is read exactly as it was before', () => {
    assert.equal(BUILT_IN_ADAPTERS.claude.stream, null);
    assert.equal(withStream(undefined).stream, null);
  });
});

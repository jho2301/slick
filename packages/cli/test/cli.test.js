import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse, withGlobals } from '../src/args.js';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/slick.js');
const FAKE_AGENT = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-agent.js');
let home;

before(() => {
  home = mkdtempSync(join(tmpdir(), 'slick-cli-'));
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * Run the real binary in a real subprocess. Every call is a cold start, which
 * is exactly the situation `slick agent resume` exists for.
 */
function slick(args, opts = {}) {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      {
        env: { ...process.env, SLICK_HOME: home, NO_COLOR: '1', FORCE_COLOR: '0', ...(opts.env ?? {}) },
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        let json = null;
        try {
          json = JSON.parse(stdout);
        } catch {
          /* human output */
        }
        done({ code: err?.code ?? 0, stdout: stdout.trim(), stderr: stderr.trim(), json });
      }
    );
  });
}

describe('argument parsing', () => {
  const spec = withGlobals({ booleans: ['peek'], strings: ['channel', 'limit'] });

  test('separates flags from free text', () => {
    const { _, flags } = parse(['general', 'deploy', 'is', '--broken', '--json'], spec);
    assert.deepEqual(_, ['general', 'deploy', 'is']);
    assert.equal(flags.json, true);
    assert.equal(flags.broken, true);
  });

  test('value flags consume their value, boolean flags do not', () => {
    const { _, flags } = parse(['--channel', 'general', '--peek', 'text', '--limit=5'], spec);
    assert.equal(flags.channel, 'general');
    assert.equal(flags.peek, true);
    assert.equal(flags.limit, '5');
    assert.deepEqual(_, ['text']);
  });

  test('supports --no-x, short flags and --', () => {
    assert.equal(parse(['--no-json'], spec).flags.json, false);
    assert.equal(parse(['-j'], spec).flags.json, true);
    assert.deepEqual(parse(['--', '--not-a-flag'], spec)._, ['--not-a-flag']);
  });
});

describe('the basics', () => {
  test('init creates a workspace', async () => {
    const result = await slick(['init', '--user', 'Tester', '--json']);
    assert.equal(result.code, 0);
    assert.equal(result.json.user.name, 'Tester');
    assert.equal(result.json.counts.channels, 2);
  });

  test('send and read a message', async () => {
    const sent = await slick(['send', 'general', 'hello from a subprocess', '--json']);
    assert.equal(sent.code, 0);
    assert.equal(sent.json.message.text, 'hello from a subprocess');
    assert.equal(sent.json.message.author.label, 'Tester');

    const read = await slick(['read', 'general', '--json']);
    assert.equal(read.json.messages.at(-1).id, sent.json.message.id);
  });

  test('reads message text from a pipe', async () => {
    const result = await new Promise((done) => {
      const child = execFile(
        process.execPath,
        [BIN, 'send', 'general', '-', '--json'],
        { env: { ...process.env, SLICK_HOME: home, NO_COLOR: '1' }, encoding: 'utf8' },
        (err, stdout) => done(JSON.parse(stdout))
      );
      child.stdin.end('piped in\n');
    });
    assert.equal(result.message.text, 'piped in');
  });

  test('channel lifecycle', async () => {
    assert.equal((await slick(['channel', 'create', 'cli-room', '--topic', 'made by a test', '--json'])).code, 0);
    const shown = await slick(['channel', 'show', 'cli-room', '--json']);
    assert.equal(shown.json.channel.topic, 'made by a test');
    await slick(['channel', 'update', 'cli-room', '--rename', 'cli-den', '--json']);
    assert.equal((await slick(['channel', 'show', 'cli-room'])).code, 4, 'old name is gone');
    await slick(['channel', 'archive', 'cli-den']);
    assert.ok(!(await slick(['channel', 'list', '--json'])).json.channels.some((c) => c.slug === 'cli-den'));
    await slick(['channel', 'unarchive', 'cli-den']);
    assert.equal((await slick(['channel', 'delete', 'cli-den', '--json'])).json.channel.deleted, true);
  });

  test('channel categories', async () => {
    const created = (await slick(['category', 'create', 'Ops & Deploys', '--json'])).json.category;
    assert.equal(created.slug, 'ops-deploys');

    const inside = (await slick(['channel', 'create', 'cli-deploys', '--category', 'ops-deploys', '--json'])).json
      .channel;
    assert.equal(inside.category.name, 'Ops & Deploys');

    // `channel list` reports the grouping, `category list` reports the groups.
    const listed = (await slick(['channel', 'list', '--json'])).json.channels;
    assert.equal(listed.find((c) => c.slug === 'cli-deploys').categoryId, created.id);
    const grouped = (await slick(['category', 'list', '--json'])).json;
    assert.equal(grouped.categories.find((c) => c.id === created.id).channelCount, 1);

    await slick(['category', 'create', 'Design', '--json']);
    assert.deepEqual(
      (await slick(['category', 'reorder', 'design', '--json'])).json.categories.map((c) => c.slug),
      ['design', 'ops-deploys']
    );

    assert.equal((await slick(['category', 'collapse', 'design', '--json'])).json.category.collapsed, true);
    assert.equal((await slick(['category', 'expand', 'design', '--json'])).json.category.collapsed, false);

    // Taking a channel out, then deleting the category, both leave it standing.
    assert.equal((await slick(['category', 'move', 'cli-deploys', 'design', '--json'])).json.channel.category.slug, 'design');
    assert.equal((await slick(['category', 'move', 'cli-deploys', 'none', '--json'])).json.channel.categoryId, null);
    await slick(['category', 'move', 'cli-deploys', 'design', '--json']);
    assert.equal((await slick(['category', 'delete', 'design', '--json'])).json.category.uncategorisedChannels, 1);
    assert.equal((await slick(['channel', 'show', 'cli-deploys', '--json'])).json.channel.categoryId, null);

    assert.equal((await slick(['category', 'move', 'cli-deploys', 'nope', '--json'])).code, 4);
    assert.equal((await slick(['category', 'create', 'ops-deploys', '--json'])).code, 5);
    await slick(['channel', 'delete', 'cli-deploys', '--json']);
    await slick(['category', 'delete', 'ops-deploys', '--json']);
  });

  test('threads', async () => {
    const root = (await slick(['send', 'general', 'thread root', '--json'])).json.message;
    await slick(['thread', 'reply', root.id, 'first reply', '--json']);
    const thread = (await slick(['thread', 'show', root.id, '--json'])).json;
    assert.equal(thread.replies.length, 1);
    assert.equal(thread.root.replyCount, 1);
  });

  test('edit and delete', async () => {
    const msg = (await slick(['send', 'general', 'typo mesage', '--json'])).json.message;
    const edited = (await slick(['message', 'edit', msg.id, 'typo message', '--json'])).json.message;
    assert.equal(edited.text, 'typo message');
    assert.ok(edited.editedAt);
    assert.equal((await slick(['message', 'delete', msg.id, '--json'])).json.message.deleted, true);
  });

  test('search', async () => {
    await slick(['send', 'general', 'the quick brown fox']);
    assert.equal((await slick(['search', 'quick', 'fox', '--json'])).json.count, 1);
    assert.equal((await slick(['search', 'quick', 'zebra', '--json'])).json.count, 0);
  });
});

describe('agent history keys across processes', () => {
  let key;

  test('start prints a key on its own with -q', async () => {
    const result = await slick(['agent', 'start', '--agent', 'claude', '--name', 'cli', '--channel', 'general', '-q']);
    key = result.stdout;
    assert.match(key, /^slk_h1_[0-9a-z]{20}$/);
  });

  test('a later process resumes with only the key', async () => {
    await slick(['send', 'general', '@claude please look at the build']);
    const resumed = (await slick(['agent', 'resume', key, '--json'])).json;
    assert.equal(resumed.session.agentId, 'claude');
    assert.equal(resumed.pending, 1);
    assert.equal(resumed.missed[0].message.text, '@claude please look at the build');
    assert.deepEqual(resumed.missed[0].message.mentions, ['claude']);
  });

  test('resume does not consume; pull does', async () => {
    assert.equal((await slick(['agent', 'resume', key, '--json'])).json.pending, 1);
    const pulled = (await slick(['agent', 'pull', key, '--json'])).json;
    assert.equal(pulled.events.length, 1);
    assert.equal((await slick(['agent', 'pull', key, '--json'])).json.events.length, 0);
  });

  test('SLICK_AGENT_KEY stands in for --key', async () => {
    await slick(['send', 'general', 'another one']);
    const pulled = (await slick(['agent', 'pull', '--json'], { env: { SLICK_AGENT_KEY: key } })).json;
    assert.equal(pulled.events.length, 1);
  });

  test('the agent posts as itself and does not re-read its own words', async () => {
    const posted = (await slick(['agent', 'post', key, 'on it', '--json'])).json;
    assert.equal(posted.message.author.kind, 'agent');
    assert.equal(posted.message.author.id, 'claude');
    assert.equal((await slick(['agent', 'pull', key, '--json'])).json.events.length, 0);
    assert.equal((await slick(['agent', 'pull', key, '--json', '--include-own', '--peek'])).json.events.length, 1);
  });

  test('state survives between processes', async () => {
    await slick(['agent', 'state', 'set', key, 'step=verifying', 'attempt=2']);
    await slick(['agent', 'state', 'set', key, 'step=done']);
    const state = (await slick(['agent', 'state', 'get', key, '--json'])).json.state;
    assert.deepEqual(state, { step: 'done', attempt: 2 });
  });

  test('sessions can be found again by name when the key is lost', async () => {
    const listed = (await slick(['agent', 'sessions', '--json'])).json.sessions;
    assert.ok(listed.some((s) => s.key === key && s.name === 'cli'));
    const byName = (await slick(['agent', 'resume', 'cli', '--agent', 'claude', '--json'])).json;
    assert.equal(byName.session.key, key);
  });

  test('replies into a thread as the agent', async () => {
    const root = (await slick(['send', 'general', 'question for the bot', '--json'])).json.message;
    const replied = (await slick(['agent', 'reply', key, root.id, 'answer', '--json'])).json;
    assert.equal(replied.message.parentId, root.id);
    assert.equal(replied.message.author.kind, 'agent');
  });

  test('resume --create makes the session on first run', async () => {
    const first = (await slick(['agent', 'resume', 'nightly', '--create', '--agent', 'ops', '--json'])).json;
    const second = (await slick(['agent', 'resume', 'nightly', '--create', '--agent', 'ops', '--json'])).json;
    assert.equal(first.session.key, second.session.key);
  });
});

describe('agent serve', () => {
  let key;

  test('sets up a session and a mention to answer', async () => {
    key = (
      await slick(['agent', 'start', '--agent', 'claude', '--name', 'server', '--channel', 'general', '-q'])
    ).stdout;
    await slick(['send', 'general', '@claude what is the plan']);
    await slick(['send', 'general', 'not addressed to anyone']);
  });

  test('--once calls the fake agent only for the @mention and posts its reply', async () => {
    const result = await slick(['agent', 'serve', key, '--once', '--cmd', FAKE_AGENT, '--json']);
    assert.equal(result.code, 0);
    const lines = result.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].message.text, 'echo(resumed=false): @claude what is the plan');
    assert.equal(lines[0].message.author.id, 'claude');

    const pulled = (await slick(['agent', 'pull', key, '--json', '--peek'])).json;
    assert.equal(pulled.events.length, 0, 'both messages were consumed even though only one was answered');
  });

  test('the next run resumes the same fake-agent session', async () => {
    await slick(['send', 'general', '@claude and now']);
    const result = await slick(['agent', 'serve', key, '--once', '--cmd', FAKE_AGENT, '--json']);
    const line = JSON.parse(result.stdout.trim());
    assert.equal(line.message.text, 'echo(resumed=true): @claude and now');
  });

  test('a failing call is reported and does not consume the message', async () => {
    await slick(['send', 'general', '@claude trigger a failure']);
    const result = await slick(['agent', 'serve', key, '--once', '--cmd', FAKE_AGENT, '--json'], {
      env: { FAKE_AGENT_FAIL: '1' },
    });
    assert.match(result.stderr, /boom/);
    assert.equal(result.stdout.trim(), '');
  });

  test('--dry-run prints the prompt and calls nothing', async () => {
    const result = await slick(['agent', 'serve', key, '--once', '--dry-run', '--cmd', FAKE_AGENT]);
    assert.match(result.stdout, /would call/);
    assert.match(result.stdout, /trigger a failure/);
  });

  test('--all answers every message, not just mentions', async () => {
    await slick(['agent', 'pull', key]); // catch up past the earlier failed/dry-run rounds
    await slick(['send', 'general', 'no mention here']);
    const result = await slick(['agent', 'serve', key, '--once', '--all', '--cmd', FAKE_AGENT, '--json']);
    const line = JSON.parse(result.stdout.trim());
    assert.match(line.message.text, /no mention here$/);
  });

  test('a transcript too big to send retires the session instead of retrying into it', async () => {
    const before = (await slick(['agent', 'state', 'get', key, '--json'])).json;
    assert.equal(before.state._serveSessionId, 'fake-session-1', 'a session is saved to resume');

    await slick(['send', 'general', '@claude answer despite the oversized history']);
    const result = await slick(['agent', 'serve', key, '--once', '--cmd', FAKE_AGENT, '--json'], {
      env: { FAKE_AGENT_OVERSIZED_RESUME: '1' },
    });

    assert.match(result.stderr, /Retiring the resumed/);
    const line = JSON.parse(result.stdout.trim());
    assert.match(line.message.text, /^echo\(resumed=false\)/, 'answered from a fresh session');
    assert.match(line.message.text, /oversized history$/, 'and it answered the real message');

    const pulled = (await slick(['agent', 'pull', key, '--json', '--peek'])).json;
    assert.equal(pulled.events.length, 0, 'the message was consumed, not left to retry forever');
  });

  test('the id of a failed call is never saved as the session to resume', async () => {
    await slick(['agent', 'state', 'set', key, '--replace', '{}']);
    await slick(['send', 'general', '@claude this one fails']);
    await slick(['agent', 'serve', key, '--once', '--cmd', FAKE_AGENT, '--json'], {
      env: { FAKE_AGENT_FAIL: '1' },
    });
    const state = (await slick(['agent', 'state', 'get', key, '--json'])).json;
    assert.equal(state.state._serveSessionId, undefined, 'a broken session is not carried into the next run');
  });

  test('after --max-attempts it says so in the thread and stops blocking the queue', async () => {
    const result = await slick(
      ['agent', 'serve', key, '--once', '--cmd', FAKE_AGENT, '--max-attempts', '1', '--json'],
      { env: { FAKE_AGENT_FAIL: '1' } }
    );
    assert.match(result.stderr, /\(1\/1\)/);

    const thread = (await slick(['read', 'general', '--limit', '20', '--replies', '--json'])).json;
    const note = thread.messages.find((m) => m.text.includes('could not answer this'));
    assert.ok(note, 'the failure is visible to the human, not just in stderr');
    assert.match(note.text, /boom/);

    const pulled = (await slick(['agent', 'pull', key, '--json', '--peek'])).json;
    assert.ok(
      !pulled.events.some((e) => e.message?.text?.includes('this one fails')),
      'the unanswerable message no longer wedges everything behind it'
    );
  });

  test('a second watcher on the same session key is refused', async () => {
    const lock = join(home, `serve-${key}.lock`);
    writeFileSync(lock, String(process.pid)); // a live pid: the test runner itself
    try {
      const result = await slick(['agent', 'serve', key, '--once', '--cmd', FAKE_AGENT]);
      assert.equal(result.code, 5, 'conflict');
      assert.match(result.stderr, /already watching/);
      assert.match(result.stderr, new RegExp(String(process.pid)));
    } finally {
      rmSync(lock, { force: true });
    }
  });

  /** Serve one round and return exactly what the child process was handed. */
  async function serveDump(extra = [], env = {}) {
    const dump = join(home, 'fake-agent-call.json');
    const result = await slick(['agent', 'serve', key, '--once', '--cmd', FAKE_AGENT, '--json', ...extra], {
      env: { FAKE_AGENT_DUMP: dump, ...env },
    });
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(readFileSync(dump, 'utf8'));
  }

  test('the prompt carries the conversation and the message, and no role preamble', async () => {
    await slick(['send', 'general', '@claude who are you']);
    const call = await serveDump();
    assert.equal(call.system, null, 'nothing is appended to the system prompt by default');
    assert.doesNotMatch(call.prompt, /You are "claude"/, 'not re-sent on every turn');
    assert.match(call.prompt, /Recent conversation in #general/);
    assert.match(call.prompt, /who are you$/);
  });

  test('--append-system-prompt is passed through when asked for', async () => {
    await slick(['send', 'general', '@claude with a house rule']);
    const call = await serveDump(['--append-system-prompt', 'Answer in French.']);
    assert.equal(call.system, 'Answer in French.');
  });

  test('saved state is sent when it changes, and not again until it does', async () => {
    await slick(['agent', 'state', 'set', key, 'step=verifying']);
    await slick(['send', 'general', '@claude first look']);
    const first = await serveDump();
    assert.match(first.prompt, /Your saved state from earlier runs/);
    assert.match(first.prompt, /"step":"verifying"/);
    assert.doesNotMatch(first.prompt, /_serveSessionId/, 'our bookkeeping is not the agent’s memory');

    await slick(['send', 'general', '@claude nothing changed']);
    const second = await serveDump();
    assert.doesNotMatch(second.prompt, /Your saved state/, 'the resumed transcript is still holding it');

    await slick(['agent', 'state', 'set', key, 'step=done']);
    await slick(['send', 'general', '@claude changed now']);
    const third = await serveDump();
    assert.match(third.prompt, /"step":"done"/);
  });

  test('a retired session is told the state again, having never seen it', async () => {
    await slick(['send', 'general', '@claude after the retirement']);
    const call = await serveDump([], { FAKE_AGENT_OVERSIZED_RESUME: '1' });
    assert.equal(call.resumed, false, 'the oversized resume was retired for a fresh session');
    assert.match(call.prompt, /"step":"done"/, 'which starts out knowing nothing');
  });

  test('but a lock left behind by a dead process does not', async () => {
    const lock = join(home, `serve-${key}.lock`);
    writeFileSync(lock, '2147483646'); // a pid that cannot be running
    await slick(['send', 'general', '@claude after the crash']);
    const result = await slick(['agent', 'serve', key, '--once', '--cmd', FAKE_AGENT, '--json']);
    assert.equal(result.code, 0);
    assert.match(JSON.parse(result.stdout.trim()).message.text, /after the crash$/);
    assert.equal(existsSync(lock), false, 'and the lock is released on the way out');
  });
});

describe('errors are actionable', () => {
  test('unknown channel exits 4 with a hint', async () => {
    const result = await slick(['read', 'nope']);
    assert.equal(result.code, 4);
    assert.match(result.stderr, /No channel named "nope"/);
    assert.match(result.stderr, /slick channel list/);
  });

  test('unknown history key reports a distinct code in --json', async () => {
    const result = await slick(['agent', 'resume', 'slk_h1_00000000000000000000', '--json']);
    assert.equal(result.code, 4);
    assert.equal(result.json.error.code, 'unknown_history_key');
  });

  test('duplicate channel exits 5', async () => {
    assert.equal((await slick(['channel', 'create', 'general'])).code, 5);
  });

  test('empty message exits 2', async () => {
    assert.equal((await slick(['send', 'general', '   '])).code, 2);
  });

  test('unknown command suggests a real one', async () => {
    const result = await slick(['chanel']);
    assert.equal(result.code, 2);
    assert.match(result.stdout, /Did you mean channel/);
  });

  test('--help works without touching the workspace', async () => {
    const result = await slick(['--help'], { env: { SLICK_HOME: '/nonexistent/should-not-be-created' } });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Slack-shaped workspace/);
  });
});

import { test, describe, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventEmitter } from 'node:events';

import { Workspace, serveLockPath } from '@slick/core';
import { createServer, type SlickServer } from '../src/index.ts';
import { createHub } from '../src/hub.ts';
import { createPushService, type PushSubscription } from '../src/push.ts';
import { buildStamp } from '../src/static.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TOKEN = 'test-token-abc';

/**
 * A stand-in for the built UI, copied per run so the tests that touch it
 * never touch the repo. It has what the daemon looks for — an index, a
 * stylesheet, a hashed bundle, a manifest and a worker — and nothing else.
 */
const WEB_FIXTURE = join(import.meta.dirname, 'fixtures', 'web-root');

let home: string;
let webRoot: string;
let app: SlickServer;
let base: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'slick-server-'));
  webRoot = join(home, 'web');
  cpSync(WEB_FIXTURE, webRoot, { recursive: true });
  app = createServer({ home, token: TOKEN, webRoot });
  const bound = await app.listen(0);
  base = bound.url;
});

afterAll(async () => {
  await app.close();
  rmSync(home, { recursive: true, force: true });
});

interface CallOptions {
  anonymous?: boolean;
  headers?: Record<string, string>;
}

/** Authenticated request helper. The body is whatever JSON came back. */
async function call(
  method: string,
  path: string,
  body?: unknown,
  opts: CallOptions = {}
): Promise<{ status: number; headers: Headers; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.anonymous ? {} : { authorization: `Bearer ${TOKEN}` }),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers ?? {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

describe('auth', () => {
  test('rejects requests without a token', async () => {
    const res = await call('GET', '/api/health', null, { anonymous: true });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'unauthorized');
  });

  test('accepts a bearer token', async () => {
    const res = await call('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  test('accepts a query token and trades it for a cookie', async () => {
    const res = await fetch(`${base}/?token=${TOKEN}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie') ?? '', /slick_token=/);
    assert.match(res.headers.get('set-cookie') ?? '', /HttpOnly/);
  });

  test('rejects a wrong token', async () => {
    const res = await call('GET', '/api/health', null, {
      anonymous: true,
      headers: { authorization: 'Bearer nope-nope-nope' },
    });
    assert.equal(res.status, 401);
  });

  test('rejects a non-local Host header (DNS rebinding)', async () => {
    // fetch() refuses to set Host, so go through node:http to forge it.
    const { port } = new URL(base);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/health',
          method: 'GET',
          headers: { host: 'evil.example.com', authorization: `Bearer ${TOKEN}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});

describe('a request the daemon cannot decode', () => {
  test('a malformed escape in a path is a 400, and the daemon is still up afterwards', async () => {
    // These used to throw a URIError past the request handler, which the
    // daemon treats as fatal — one bad URL from a browser tab shut the
    // workspace down. Now they are answered, and nothing else notices.
    assert.equal((await call('GET', '/api/channels/%zz')).status, 400);
    const anonymous = await fetch(`${base}/%zz`);
    assert.equal(anonymous.status, 401, 'auth still runs first');
    await anonymous.text();
    const res = await fetch(`${base}/%zz`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 400);
    await res.text();
    assert.equal((await call('GET', '/api/health')).status, 200, 'the daemon answered the next request');
  });
});

describe('channels over HTTP', () => {
  test('create, read, update, archive, delete', async () => {
    const created = await call('POST', '/api/channels', { slug: 'api-test', topic: 'from a test' });
    assert.equal(created.status, 201);
    assert.equal(created.body.channel.slug, 'api-test');

    const listed = await call('GET', '/api/channels');
    assert.ok(listed.body.channels.some((c: { slug: string }) => c.slug === 'api-test'));

    const updated = await call('PATCH', '/api/channels/api-test', { topic: 'changed' });
    assert.equal(updated.body.channel.topic, 'changed');

    const archived = await call('POST', '/api/channels/api-test/archive');
    assert.equal(archived.body.channel.archived, true);
    const visible = await call('GET', '/api/channels');
    assert.ok(!visible.body.channels.some((c: { slug: string }) => c.slug === 'api-test'));

    await call('POST', '/api/channels/api-test/unarchive');
    const removed = await call('DELETE', '/api/channels/api-test');
    assert.equal(removed.body.channel.deleted, true);
  });

  test('maps domain errors onto status codes', async () => {
    assert.equal((await call('GET', '/api/channels/nope')).status, 404);
    assert.equal((await call('POST', '/api/channels', { slug: 'general' })).status, 409);
    assert.equal((await call('POST', '/api/channels', { slug: '!!' })).status, 422);
    assert.equal((await call('GET', '/api/nothing-here')).status, 404);
  });
});

describe('categories over HTTP', () => {
  test('create, group channels, reorder, delete', async () => {
    const created = await call('POST', '/api/categories', { name: 'Engineering' });
    assert.equal(created.status, 201);
    assert.equal(created.body.category.slug, 'engineering');

    const second = await call('POST', '/api/categories', { name: 'Product' });
    assert.deepEqual(
      (await call('GET', '/api/categories')).body.categories.map((c: { slug: string }) => c.slug),
      ['engineering', 'product']
    );

    await call('POST', '/api/channels', { slug: 'http-deploys', category: 'engineering' });
    const grouped = await call('GET', '/api/categories/engineering/channels');
    assert.deepEqual(
      grouped.body.channels.map((c: { slug: string }) => c.slug),
      ['http-deploys']
    );
    assert.ok(
      !(await call('GET', '/api/channels?category=')).body.channels.some(
        (c: { slug: string }) => c.slug === 'http-deploys'
      ),
      'an empty category filter means "the uncategorised ones"'
    );

    const moved = await call('PATCH', '/api/channels/http-deploys', { category: second.body.category.id });
    assert.equal(moved.body.channel.category.name, 'Product');

    const collapsed = await call('PATCH', '/api/categories/product', { collapsed: true });
    assert.equal(collapsed.body.category.collapsed, true);

    const reordered = await call('POST', '/api/categories/reorder', { order: ['product'] });
    assert.deepEqual(
      reordered.body.categories.map((c: { slug: string }) => c.slug),
      ['product', 'engineering']
    );

    const removed = await call('DELETE', '/api/categories/product');
    assert.equal(removed.body.category.uncategorisedChannels, 1);
    assert.equal((await call('GET', '/api/channels/http-deploys')).body.channel.categoryId, null);
    await call('DELETE', '/api/categories/engineering');
    await call('DELETE', '/api/channels/http-deploys');
  });

  test('maps domain errors onto status codes', async () => {
    await call('POST', '/api/categories', { name: 'Dupe' });
    assert.equal((await call('POST', '/api/categories', { name: 'dupe' })).status, 409);
    assert.equal((await call('POST', '/api/categories', { name: '  ' })).status, 422);
    assert.equal((await call('GET', '/api/categories/nope')).status, 404);
    assert.equal((await call('PATCH', '/api/channels/general', { category: 'nope' })).status, 404);
    await call('DELETE', '/api/categories/dupe');
  });
});

describe('messages and threads over HTTP', () => {
  test('post, reply, edit, delete', async () => {
    const posted = await call('POST', '/api/channels/general/messages', { text: 'over http' });
    assert.equal(posted.status, 201);
    const id = posted.body.message.id;

    const reply = await call('POST', `/api/messages/${id}/replies`, { text: 'a reply' });
    assert.equal(reply.body.message.parentId, id);

    const thread = await call('GET', `/api/messages/${id}/thread`);
    assert.equal(thread.body.replies.length, 1);
    assert.equal(thread.body.root.replyCount, 1);

    const edited = await call('PATCH', `/api/messages/${id}`, { text: 'over http (edited)' });
    assert.equal(edited.body.message.text, 'over http (edited)');

    const deleted = await call('DELETE', `/api/messages/${id}`);
    assert.equal(deleted.body.message.deleted, true);
  });

  test('paginates', async () => {
    for (let i = 0; i < 5; i++) {
      await call('POST', '/api/channels/general/messages', { text: `page ${i}` });
    }
    const page = await call('GET', '/api/channels/general/messages?limit=2');
    assert.equal(page.body.messages.length, 2);
    assert.equal(page.body.hasMore, true);
  });

  test('searches', async () => {
    await call('POST', '/api/channels/general/messages', { text: 'findable needle here' });
    const found = await call('GET', '/api/search?q=needle');
    assert.equal(found.body.count, 1);
  });
});

describe('agent sessions over HTTP', () => {
  test('start, resume, pull, post, state', async () => {
    const started = await call('POST', '/api/agents/sessions', {
      agentId: 'httpbot',
      name: 'main',
      channel: 'general',
    });
    assert.equal(started.status, 201);
    const key = started.body.session.key;

    await call('POST', '/api/channels/general/messages', { text: 'something to catch up on' });

    const resumed = await call('POST', `/api/agents/sessions/${key}/resume`, { contextLimit: 5 });
    assert.equal(resumed.body.pending, 1);
    assert.equal(resumed.body.cursor, started.body.session.cursorSeq, 'resume peeks');

    const pulled = await call('POST', `/api/agents/sessions/${key}/pull`, {});
    assert.equal(pulled.body.events.length, 1);
    assert.equal(pulled.body.pending, 0);

    const said = await call('POST', `/api/agents/sessions/${key}/messages`, { text: 'ack' });
    assert.equal(said.status, 201);
    assert.equal(said.body.message.author.kind, 'agent');
    assert.equal(said.body.message.sessionKey, key);

    await call('PUT', `/api/agents/sessions/${key}/state`, { state: { phase: 'done' } });
    const fetched = await call('GET', `/api/agents/sessions/${key}`);
    assert.deepEqual(fetched.body.session.state, { phase: 'done' });

    const ended = await call('POST', `/api/agents/sessions/${key}/end`);
    assert.equal(ended.body.session.status, 'ended');
  });

  test('the model a served session runs is read and set over HTTP', async () => {
    const key = (await call('POST', '/api/agents/sessions', { agentId: 'modelbot', channel: 'general' })).body
      .session.key;

    assert.equal(
      (await call('GET', `/api/agents/sessions/${key}/model`)).body.model,
      null,
      'none to begin with'
    );

    const set = await call('PUT', `/api/agents/sessions/${key}/model`, {
      model: ' anthropic/claude-opus-4 ',
    });
    assert.equal(set.body.model, 'anthropic/claude-opus-4', 'trimmed on the way in');
    assert.equal(
      (await call('GET', `/api/agents/sessions/${key}/model`)).body.model,
      'anthropic/claude-opus-4'
    );

    // It rides in the session list, which is what the app renders the rail from.
    const listed = (await call('GET', '/api/agents/sessions')).body.sessions.find(
      (s: { key: string }) => s.key === key
    );
    assert.equal(listed.state._serveModel, 'anthropic/claude-opus-4');

    const cleared = await call('PUT', `/api/agents/sessions/${key}/model`, { model: null });
    assert.equal(cleared.body.model, null, 'and back to the default');

    const bad = await call('PUT', `/api/agents/sessions/${key}/model`, { model: 'two\nlines' });
    assert.equal(bad.status, 422, 'a model name is one line');
  });

  test('the models an agent advertised are offered back for choosing', async () => {
    const key = (await call('POST', '/api/agents/sessions', { agentId: 'pickbot', channel: 'general' })).body
      .session.key;
    assert.deepEqual((await call('GET', `/api/agents/sessions/${key}/model`)).body.choices, []);

    // What `serve` writes after asking the binary `--list-models`.
    app.ws.agents.setModelChoices(key, [{ id: 'north::big', label: 'big', group: 'north' }, 'plain-name']);

    const offered = (await call('GET', `/api/agents/sessions/${key}/model`)).body;
    assert.deepEqual(offered.choices, [
      { id: 'north::big', label: 'big', group: 'north' },
      { id: 'plain-name', label: 'plain-name', group: null },
    ]);
    assert.ok(offered.checkedAt > 0, 'and when that answer was last refreshed');

    // A probe that came back empty-handed keeps the list we already had.
    app.ws.agents.setModelChoices(key, null);
    assert.equal((await call('GET', `/api/agents/sessions/${key}/model`)).body.choices.length, 2);
  });

  test('the session list says which agents can actually be called', async () => {
    const automation = (await call('POST', '/api/agents/sessions', { agentId: 'digest', channel: 'general' }))
      .body.session.key;
    const watched = (await call('POST', '/api/agents/sessions', { agentId: 'answers', channel: 'general' }))
      .body.session.key;
    writeFileSync(serveLockPath(watched, home), String(process.pid));

    const sessions = (await call('GET', '/api/agents/sessions')).body.sessions;
    const byKey = new Map<string, { callable: boolean; serve: { live: boolean } }>(
      sessions.map((s: { key: string }) => [s.key, s])
    );
    assert.equal(
      byKey.get(automation)!.callable,
      false,
      'nothing is watching it, so a mention would go nowhere'
    );
    assert.equal(byKey.get(watched)!.callable, true);
    assert.equal(byKey.get(watched)!.serve.live, true);

    // The watcher stops, but the bookkeeping it wrote says it will be back.
    rmSync(serveLockPath(watched, home), { force: true });
    await call('PUT', `/api/agents/sessions/${watched}/state`, { state: { _serveThreads: {} } });
    const after = (await call('GET', '/api/agents/sessions')).body.sessions.find(
      (s: { key: string }) => s.key === watched
    );
    assert.equal(after.serve.live, false);
    assert.equal(after.callable, true, 'an agent between restarts is still an agent');
  });

  test('an unknown history key is a 404 with a usable code', async () => {
    const res = await call('POST', '/api/agents/sessions/slk_h1_00000000000000000000/resume', {});
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'unknown_history_key');
  });

  test('typing is a live signal that never shows up as something to resume', async () => {
    const started = await call('POST', '/api/agents/sessions', { agentId: 'typer', channel: 'general' });
    const key = started.body.session.key;
    const root = await call('POST', '/api/channels/general/messages', { text: '@typer you there?' });
    const rootId = root.body.message.id;

    const on = await call('POST', `/api/agents/sessions/${key}/typing`, {
      on: true,
      threadId: rootId,
      channelId: root.body.message.channelId,
    });
    assert.equal(on.status, 200);
    await call('POST', `/api/agents/sessions/${key}/typing`, { on: false, threadId: rootId });

    const events = await call('GET', '/api/events?since=0');
    const typingEvents = events.body.events.filter((e: { type: string }) => e.type === 'agent.typing');
    assert.equal(typingEvents.length, 2);
    assert.equal(typingEvents[0].payload.on, true);
    assert.equal(typingEvents[0].threadId, rootId);

    const resumed = await call('POST', `/api/agents/sessions/${key}/resume`, {});
    assert.ok(resumed.body.missed.every((e: { type: string }) => e.type !== 'agent.typing'));
  });

  test('and the app can ask who is typing right now, rather than wait for a change it missed', async () => {
    const key = (await call('POST', '/api/agents/sessions', { agentId: 'snap', channel: 'general' })).body
      .session.key;
    const rootId = (await call('POST', '/api/channels/general/messages', { text: '@snap are you working?' }))
      .body.message.id;

    await call('POST', `/api/agents/sessions/${key}/typing`, { on: true, threadId: rootId });
    const quiet = await call('GET', '/api/typing');
    assert.equal(quiet.status, 200);
    assert.deepEqual(quiet.body.typing, [], 'nobody is watching that session, so nobody is typing in it');

    const lock = join(home, `serve-${key}.lock`);
    writeFileSync(lock, String(process.pid));
    try {
      const live = (await call('GET', '/api/typing')).body.typing;
      assert.equal(live.length, 1);
      assert.equal(live[0].threadId, rootId);
      assert.equal(live[0].agentId, 'snap');

      await call('POST', `/api/agents/sessions/${key}/typing`, { on: false, threadId: rootId });
      assert.deepEqual((await call('GET', '/api/typing')).body.typing, []);
    } finally {
      rmSync(lock, { force: true });
    }
  });

  test('a gateway with no session here can still say it is typing', async () => {
    const rootId = (await call('POST', '/api/channels/general/messages', { text: 'hermes, a question' })).body
      .message.id;

    const on = await call('POST', '/api/typing', { agentId: 'hermes', threadId: rootId, on: true });
    assert.equal(on.status, 200);
    assert.deepEqual(on.body, { ok: true });

    // No history key was minted and no lock exists anywhere, yet it shows.
    const live = (await call('GET', '/api/typing')).body.typing;
    assert.equal(live.length, 1);
    assert.equal(live[0].threadId, rootId);
    assert.equal(live[0].agentId, 'hermes');
    assert.equal(live[0].sessionKey, null);
    assert.ok(
      (await call('GET', '/api/agents/sessions')).body.sessions.every(
        (s: { agentId: string }) => s.agentId !== 'hermes'
      ),
      'and nothing invented a session to hang it on'
    );

    await call('POST', '/api/typing', { agentId: 'hermes', threadId: rootId, on: false });
    assert.deepEqual((await call('GET', '/api/typing')).body.typing, []);
  });

  test('and a reply id means the thread it is in', async () => {
    const rootId = (await call('POST', '/api/channels/general/messages', { text: 'the root' })).body.message
      .id;
    const replyId = (await call('POST', `/api/messages/${rootId}/replies`, { text: 'a reply' })).body.message
      .id;

    await call('POST', '/api/typing', { agentId: 'hermes', threadId: replyId, on: true });
    const live = (await call('GET', '/api/typing')).body.typing;
    assert.equal(live.length, 1);
    assert.equal(live[0].threadId, rootId);

    await call('POST', '/api/typing', { agentId: 'hermes', threadId: rootId, on: false });
  });

  test('typing it cannot place is refused where the caller can see it', async () => {
    const missing = await call('POST', '/api/typing', { agentId: 'hermes', threadId: 'msg_nope', on: true });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'not_found');

    const rootId = (await call('POST', '/api/channels/general/messages', { text: 'anything' })).body.message
      .id;
    const named = await call('POST', '/api/typing', { agentId: 'not a name', threadId: rootId, on: true });
    assert.equal(named.status, 422);
    assert.equal(named.body.error.code, 'invalid_request');
    assert.deepEqual((await call('GET', '/api/typing')).body.typing, []);
  });

  test('thinking is the same signal with a shape to it, and just as un-resumable', async () => {
    const key = (await call('POST', '/api/agents/sessions', { agentId: 'thinker', channel: 'general' })).body
      .session.key;
    const rootId = (await call('POST', '/api/channels/general/messages', { text: '@thinker take your time' }))
      .body.message.id;

    const posted = await call('POST', `/api/agents/sessions/${key}/thinking`, {
      threadId: rootId,
      think: {
        t: 'Working…',
        p: 'streaming',
        s: [{ id: 't1', t: 'Reading the thread…', st: 'in_progress' }],
      },
    });
    assert.equal(posted.status, 200);

    const events = await call('GET', '/api/events?since=0');
    const thinking = events.body.events.filter((e: { type: string }) => e.type === 'agent.thinking');
    assert.equal(thinking.length, 1);
    assert.equal(thinking[0].threadId, rootId);
    assert.equal(thinking[0].payload.think.s[0].id, 't1');

    // The scratchpad is one agent's working-out, and it stays out of the
    // conversation every other agent replays.
    const resumed = await call('POST', `/api/agents/sessions/${key}/resume`, {});
    assert.ok(resumed.body.missed.every((e: { type: string }) => e.type !== 'agent.thinking'));

    // Nobody is watching that session, so nothing of it is live.
    assert.deepEqual((await call('GET', '/api/thinking')).body.thinking, []);
  });

  test('and a gateway with no session here gets a snapshot until it says it is done', async () => {
    const rootId = (await call('POST', '/api/channels/general/messages', { text: 'hermes, think out loud' }))
      .body.message.id;

    const on = await call('POST', '/api/thinking', {
      agentId: 'hermes',
      threadId: rootId,
      think: {
        t: 'Searching…',
        p: 'streaming',
        s: [{ id: 't1', t: 'Searching the web…', st: 'in_progress' }],
      },
    });
    assert.equal(on.status, 200);

    const live = (await call('GET', '/api/thinking')).body.thinking;
    assert.equal(live.length, 1);
    assert.equal(live[0].threadId, rootId);
    assert.equal(live[0].agentId, 'hermes');
    assert.equal(live[0].sessionKey, null);
    assert.equal(live[0].think.t, 'Searching…');
    assert.equal(live[0].think.s[0].st, 'in_progress');

    // A finished blob belongs on the message it explains, not in the snapshot
    // of what is happening right now.
    await call('POST', '/api/thinking', {
      agentId: 'hermes',
      threadId: rootId,
      think: { t: 'Searched the web', p: 'done', s: [{ id: 't1', t: 'Searched the web', st: 'complete' }] },
    });
    assert.deepEqual((await call('GET', '/api/thinking')).body.thinking, []);
  });
});

describe('the agent’s own slash commands', () => {
  let key: string;

  // An adapter whose "agent" is a two-line node script: it lists two commands
  // and answers one of them, which is all the daemon side needs to be real.
  const HELPER = `
    // With -e, argv[1] is already the first real argument.
    const [, first, ...rest] = process.argv;
    if (first === 'list') {
      process.stdout.write(JSON.stringify([
        { name: 'ping', description: 'say hello', args_hint: '[times]', aliases: ['p'] },
        { name: 'model', description: 'switch model', args_hint: '[model]', picker: 'model', where: 'session' },
        { name: 'nope', description: 'cannot run here', where: 'session' },
      ]));
    } else if (first === 'ping' || first === 'p') {
      process.stdout.write('pong ' + rest.join(' ').trim());
    } else {
      process.stderr.write('/' + first + ' needs a live session');
      process.exit(3);
    }`;

  test('a session records which adapter serves it, and the adapter is asked', async () => {
    mkdirSync(join(home, 'adapters'), { recursive: true });
    writeFileSync(
      join(home, 'adapters', 'talky.json'),
      JSON.stringify({
        cmd: process.execPath,
        args: { prompt: ['-e', '{prompt}'] },
        commands: {
          list: { args: ['-e', HELPER, 'list'] },
          run: { args: ['-e', HELPER, '{command}', '{args}'] },
        },
      })
    );
    key = (await call('POST', '/api/agents/sessions', { agentId: 'talky', channel: 'general' })).body.session
      .key;
    await call('PUT', `/api/agents/sessions/${key}/state`, { state: { _serveAdapter: 'talky' } });

    const listed = await call('GET', `/api/agents/sessions/${key}/commands`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.error, null);
    assert.deepEqual(
      listed.body.commands.map((c: { name: string }) => c.name),
      ['ping', 'model', 'nope']
    );
    assert.equal(listed.body.commands[0].summary, 'say hello');
    assert.equal(listed.body.commands[0].args, '[times]');
    assert.deepEqual(listed.body.commands[0].aliases, ['p']);
    assert.equal(listed.body.commands[1].picker, 'model');
    assert.equal(listed.body.commands[1].where, 'session');
    assert.equal(listed.body.commands[2].where, 'session', 'listed, but the agent says not from here');
  });

  test('running one answers the caller and leaves nothing behind', async () => {
    const before = (await call('GET', '/api/channels/general/messages')).body.messages.length;

    const ran = await call('POST', `/api/agents/sessions/${key}/command`, { command: 'ping', args: 'twice' });
    assert.equal(ran.status, 200);
    assert.equal(ran.body.output, 'pong twice');
    assert.equal(ran.body.error, null);

    const failed = await call('POST', `/api/agents/sessions/${key}/command`, { command: 'nope' });
    assert.match(failed.body.error, /needs a live session/);
    assert.equal(failed.body.output, '');

    const after = (await call('GET', '/api/channels/general/messages')).body.messages.length;
    assert.equal(after, before, 'a command is not a message');
    const events = await call('GET', '/api/events?since=0');
    assert.ok(
      events.body.events.every((e: { type: string }) => !String(e.type).includes('command')),
      'and it is not in the log either'
    );
  });

  test('an agent with no commands of its own simply has none', async () => {
    const plain = (await call('POST', '/api/agents/sessions', { agentId: 'quiet', channel: 'general' })).body
      .session.key;
    const listed = await call('GET', `/api/agents/sessions/${plain}/commands`);
    assert.deepEqual(listed.body.commands, []);
    const ran = await call('POST', `/api/agents/sessions/${plain}/command`, { command: 'help' });
    assert.match(ran.body.error, /cannot run commands/);
  });
});

describe('push notifications', () => {
  // Its own server + workspace, with a fake `webpush` swapped in — real
  // delivery always speaks TLS regardless of the endpoint's scheme, so a
  // fake HTTP push endpoint can't stand in for it. This still exercises the
  // real subscribe/unsubscribe/prune logic in push.ts and the real
  // agent-vs-human filtering in hub.ts; only the actual network hop is fake.
  let pushHome: string;
  let pushApp: SlickServer;
  let pushBase: string;
  let calls: { endpoint: string; payload: { body: string } }[];
  const PUSH_TOKEN = 'push-test-token';

  beforeAll(async () => {
    pushHome = mkdtempSync(join(tmpdir(), 'slick-server-push-'));
    calls = [];
    const fakeWebpush = {
      generateVAPIDKeys: () => ({ publicKey: 'fake-public-key', privateKey: 'fake-private-key' }),
      setVapidDetails: () => {},
      sendNotification: (sub: PushSubscription, payload: string) => {
        calls.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
        if (sub.endpoint.endsWith('/gone')) {
          return Promise.reject(Object.assign(new Error('subscription expired'), { statusCode: 410 }));
        }
        return Promise.resolve();
      },
    };
    const workspace = Workspace.open({ home: pushHome });
    const push = createPushService(workspace, fakeWebpush);
    pushApp = createServer({ workspace, token: PUSH_TOKEN, push, webRoot: null });
    const bound = await pushApp.listen(0);
    pushBase = bound.url;
  });

  afterAll(async () => {
    await pushApp.close();
    rmSync(pushHome, { recursive: true, force: true });
  });

  async function pushCall(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${pushBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${PUSH_TOKEN}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  test('hands out the VAPID public key from the injected push service', async () => {
    const res = await pushCall('GET', '/api/push/vapid-public-key');
    assert.equal(res.status, 200);
    assert.equal(res.body.publicKey, 'fake-public-key');
  });

  test('a human message does not notify anyone, an agent message does', async () => {
    await pushCall('POST', '/api/push/subscribe', { endpoint: 'https://push.example/one', keys: {} });

    calls.length = 0;
    await pushCall('POST', '/api/channels/general/messages', { text: 'a human, not pushed' });
    await sleep(50);
    assert.equal(calls.length, 0, 'human messages do not page anyone');

    const started = await pushCall('POST', '/api/agents/sessions', {
      agentId: 'pushbot',
      channel: 'general',
    });
    const key = started.body.session.key;
    await pushCall('POST', `/api/agents/sessions/${key}/messages`, { text: 'an agent reply, pushed' });
    await sleep(50);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.endpoint, 'https://push.example/one');
    assert.equal(calls[0]!.payload.body, 'an agent reply, pushed');

    await pushCall('POST', '/api/push/unsubscribe', { endpoint: 'https://push.example/one' });
  });

  test('a subscription the push service reports gone is pruned and not retried', async () => {
    await pushCall('POST', '/api/push/subscribe', { endpoint: 'https://push.example/gone', keys: {} });
    await pushCall('POST', '/api/push/subscribe', { endpoint: 'https://push.example/still-good', keys: {} });

    calls.length = 0;
    const first = await pushCall('POST', '/api/agents/sessions', { agentId: 'pruner', channel: 'general' });
    await pushCall('POST', `/api/agents/sessions/${first.body.session.key}/messages`, { text: 'round one' });
    await sleep(50);
    assert.deepEqual(calls.map((c) => c.endpoint).sort(), [
      'https://push.example/gone',
      'https://push.example/still-good',
    ]);

    calls.length = 0;
    const second = await pushCall('POST', '/api/agents/sessions', { agentId: 'pruner2', channel: 'general' });
    await pushCall('POST', `/api/agents/sessions/${second.body.session.key}/messages`, { text: 'round two' });
    await sleep(50);
    assert.deepEqual(
      calls.map((c) => c.endpoint),
      ['https://push.example/still-good'],
      'the gone subscription was dropped after its first 410'
    );
  });
});

/** Reads SSE frames off a fetch body until a predicate is satisfied. */
function frameReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  /** The raw frame that satisfies `predicate`, or null when patience runs out. */
  async function readRawUntil(
    predicate: (chunk: string) => boolean,
    timeoutMs = 6000
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = buffer.split('\n\n').find((chunk) => chunk.includes('data:') && predicate(chunk));
      if (hit) return hit;
      if (Date.now() >= deadline) return null;
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: false }>((r) =>
          setTimeout(() => r({ value: undefined, done: false }), 400)
        ),
      ]);
      if (done) return null;
      if (value) buffer += decoder.decode(value, { stream: true });
    }
  }

  const parse = (chunk: string): any =>
    JSON.parse(
      chunk
        .split('\n')
        .find((l) => l.startsWith('data:'))!
        .slice(5)
        .trim()
    );

  /** The parsed payload that satisfies `predicate`, or null. */
  async function readUntil(predicate: (event: any) => boolean, timeoutMs = 6000): Promise<any> {
    const raw = await readRawUntil((chunk) => {
      try {
        return Boolean(predicate(parse(chunk)));
      } catch {
        return false;
      }
    }, timeoutMs);
    return raw ? parse(raw) : null;
  }

  const cancel = () => reader.cancel().catch(() => {});
  return { readRawUntil, readUntil, parse, cancel };
}

describe('live stream', () => {
  test('pushes events as they happen, including writes made outside HTTP', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/stream?since=0`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const stream = frameReader(res);

    assert.ok(await stream.readUntil((e) => e.type === 'stream.ready'), 'stream announces itself');

    // Written straight to SQLite, exactly as the CLI would — the daemon must
    // still notice and fan it out.
    app.ws.messages.post({ channel: 'general', text: 'written outside the daemon' });
    const seen = await stream.readUntil((e) => e.message?.text === 'written outside the daemon');
    assert.ok(seen, 'external write reached the stream');
    assert.equal(seen.type, 'message.created');
    assert.equal(seen.channelSlug, 'general');

    controller.abort();
    await stream.cancel();
  });

  test('carries a streamed delta to an open reader without writing anything down', async () => {
    const root = await call('POST', '/api/channels/general/messages', { text: '@hermes, a long question' });
    const rootId = root.body.message.id;

    const controller = new AbortController();
    const res = await fetch(`${base}/api/stream`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    const stream = frameReader(res);

    assert.ok(await stream.readRawUntil((c) => c.includes('"stream.ready"')), 'stream announces itself');

    const before = (await call('GET', '/api/health')).body.seq;
    const posted = await call('POST', '/api/stream/delta', {
      agentId: 'hermes',
      threadId: rootId,
      text: 'the beginning of an ans',
      think: { t: 'Drafting…', p: 'streaming', s: [{ id: 't1', t: 'Reading the thread…', st: 'complete' }] },
    });
    assert.equal(posted.status, 200);
    assert.deepEqual(posted.body, { ok: true });

    // Unlike the parsed reads above this one wants the *raw* frame, because
    // what is being asserted about a delta is as much the lines it does not
    // have as the payload it does.
    const raw = await stream.readRawUntil((c) => c.includes('"agent.delta"'));
    assert.ok(raw, 'the delta reached the open reader');

    const frame = stream.parse(raw);
    assert.equal(frame.threadId, rootId);
    assert.equal(
      frame.channelId,
      root.body.message.channelId,
      'the channel came from the message, not the caller'
    );
    assert.deepEqual(frame.actor, { id: 'hermes', kind: 'agent' });
    assert.equal(frame.text, 'the beginning of an ans');
    assert.equal(frame.think.s[0].id, 't1');
    assert.equal(typeof frame.at, 'number');

    // Matched against the raw frame on purpose: an `id:` line would set the
    // reader's Last-Event-ID to a seq it has never actually been sent.
    assert.ok(!/(^|\n)id:/.test(raw), 'an ephemeral frame carries no id line');

    // And nothing about it survived the request.
    assert.equal((await call('GET', '/api/health')).body.seq, before, 'the log did not move');
    const events = await call('GET', '/api/events?since=0');
    assert.ok(
      events.body.events.every((e: { type: string }) => e.type !== 'agent.delta'),
      'no row was written for a fragment of an answer that does not exist yet'
    );

    controller.abort();
    await stream.cancel();
  });

  test('a reader too far behind is hung up on, never quietly skipped past', async () => {
    // A real stalled socket is not something a test can arrange, so this
    // drives the hub directly: what matters is which of the two paths gives
    // up on a client, and how.
    const hub = createHub(app.ws, { activePollMs: 30 });
    /** A response that claims to be a megabyte behind on demand. */
    const fakeClient = () => {
      const req = Object.assign(new EventEmitter(), { headers: {} });
      const res = Object.assign(new EventEmitter(), {
        writableLength: 0,
        wrote: [] as string[],
        ended: false,
        writeHead: () => {},
        flushHeaders: () => {},
        write: (chunk: string) => res.wrote.push(chunk),
        end: () => {
          res.ended = true;
        },
      });
      return { req: req as unknown as IncomingMessage, res, asResponse: res as unknown as ServerResponse };
    };

    try {
      const stalled = fakeClient();
      const client = hub.subscribe(stalled.req, stalled.asResponse, {});
      const cursor = client.cursor;
      stalled.res.writableLength = 2_000_000;

      // An ephemeral frame is skipped and the client keeps its place: there is
      // no seq on a delta, so there is nothing for it to have missed.
      const rootId = (await call('POST', '/api/channels/general/messages', { text: 'something to point at' }))
        .body.message.id;
      hub.broadcast({ type: 'agent.delta', threadId: rootId, text: 'a fragment' });
      assert.equal(stalled.res.ended, false, 'a dropped delta is not worth a disconnect');
      assert.equal(hub.size, 1);

      // A log row is not. Skipping it would advance the cursor past a hole no
      // reconnect could ever fill, so the connection ends instead and the
      // browser comes back quoting the last id it really received.
      hub.wake();
      assert.equal(stalled.res.ended, true, 'the connection was ended, not the row dropped');
      assert.equal(hub.size, 0, 'and the client is out of the set');
      assert.equal(client.cursor, cursor, 'its cursor never moved over what it did not get');

      // A reader that is keeping up is untouched by any of it.
      const fine = fakeClient();
      hub.subscribe(fine.req, fine.asResponse, {});
      await call('POST', '/api/channels/general/messages', { text: 'and one for the healthy reader' });
      hub.wake();
      assert.equal(fine.res.ended, false);
      assert.ok(
        fine.res.wrote.some((chunk) => chunk.includes('and one for the healthy reader')),
        'the row reached it'
      );
    } finally {
      hub.close();
    }
  });

  test('a delta is normalized and capped on the way in, like every other blob', async () => {
    const rootId = (await call('POST', '/api/channels/general/messages', { text: 'a question with a reply' }))
      .body.message.id;

    // The one body in the app that is copied onto every open socket at once
    // was also the only one arriving unchecked. A fragment has a size.
    const huge = await call('POST', '/api/stream/delta', {
      agentId: 'hermes',
      threadId: rootId,
      text: 'x'.repeat(4097),
    });
    assert.equal(huge.status, 422);
    assert.equal(huge.body.error.code, 'invalid_request');
    assert.match(huge.body.error.message, /fragment/);

    const wrong = await call('POST', '/api/stream/delta', {
      agentId: 'hermes',
      threadId: rootId,
      text: { no: 1 },
    });
    assert.equal(wrong.status, 422);

    const controller = new AbortController();
    const res = await fetch(`${base}/api/stream`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    });
    const stream = frameReader(res);
    assert.ok(await stream.readRawUntil((c) => c.includes('"stream.ready"')));

    // A reply id, because a producer answering in a thread has the reply in
    // hand and not the root — and the draft has to land under the same key
    // `POST /api/thinking` resolves to, or the browser holds two of them.
    const reply = await call('POST', `/api/messages/${rootId}/replies`, { text: 'a reply in that thread' });
    assert.equal(reply.status, 201);

    await call('POST', '/api/stream/delta', {
      agentId: 'hermes',
      threadId: reply.body.message.id,
      text: 'half an answ',
      think: { t: 'T'.repeat(400), p: 'whatever', s: [{ t: 'Reading…', st: 'nonsense' }] },
    });

    const frame = stream.parse((await stream.readRawUntil((c) => c.includes('"agent.delta"')))!);
    assert.equal(frame.threadId, rootId, 'the reply lit up the root it belongs to');
    assert.equal(frame.think.t.length, 200, 'the title was clamped, not taken as given');
    assert.equal(frame.think.p, 'streaming', 'and a phase nobody defined is a live one');
    assert.equal(frame.think.s[0].st, 'pending');
    assert.equal(frame.think.s[0].id, 's0', 'a step with no id got one from its place');

    controller.abort();
    await stream.cancel();
  });

  test('a delta it cannot place is refused, ephemeral or not', async () => {
    const missing = await call('POST', '/api/stream/delta', {
      agentId: 'hermes',
      threadId: 'msg_nope',
      text: 'hi',
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'not_found');

    const rootId = (await call('POST', '/api/channels/general/messages', { text: 'anything at all' })).body
      .message.id;
    const named = await call('POST', '/api/stream/delta', {
      agentId: 'not a name',
      threadId: rootId,
      text: 'hi',
    });
    assert.equal(named.status, 422);
    assert.equal(named.body.error.code, 'invalid_request');
  });

  test('so a reader that drops mid-answer resumes at the seq the delta never moved', async () => {
    const root = await call('POST', '/api/channels/general/messages', {
      text: 'the question before the drop',
    });
    const rootId = root.body.message.id;

    const controller = new AbortController();
    const res = await fetch(`${base}/api/stream`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    });
    const stream = frameReader(res);

    assert.ok(await stream.readRawUntil((c) => c.includes('"stream.ready"')));

    // One real event, whose id is what an EventSource would remember.
    await call('POST', '/api/channels/general/messages', { text: 'a real message before the stream' });
    const durable = await stream.readRawUntil((c) => c.includes('a real message before the stream'));
    assert.ok(durable, 'the real message arrived');
    const lastEventId = Number(
      durable
        .split('\n')
        .find((l) => l.startsWith('id:'))!
        .slice(3)
        .trim()
    );
    assert.ok(Number.isFinite(lastEventId));

    await call('POST', '/api/stream/delta', { agentId: 'hermes', threadId: rootId, text: 'partial…' });
    assert.ok(await stream.readRawUntil((c) => c.includes('"agent.delta"')), 'the delta arrived after it');

    controller.abort();
    await stream.cancel();

    // The delta left no id behind to remember, so the reconnect quotes the
    // last durable one — the same place it would have resumed from if nothing
    // had streamed at all.
    const resumed = new AbortController();
    const again = await fetch(`${base}/api/stream`, {
      headers: { authorization: `Bearer ${TOKEN}`, 'last-event-id': String(lastEventId) },
      signal: resumed.signal,
    });
    const stream2 = frameReader(again);

    const ready = await stream2.readRawUntil((c) => c.includes('"stream.ready"'));
    assert.ok(ready);
    const parsed = stream2.parse(ready);
    assert.equal(parsed.since, lastEventId, 'resumed exactly where the last real event left it');

    await call('POST', '/api/channels/general/messages', { text: 'a real message after the reconnect' });
    assert.ok(
      await stream2.readRawUntil((c) => c.includes('a real message after the reconnect')),
      'and the resumed stream is a working stream'
    );

    resumed.abort();
    await stream2.cancel();
  });
});

describe('web UI hosting', () => {
  test('serves the app shell', async () => {
    const res = await fetch(`${base}/?token=${TOKEN}`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /<div id="app"/);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  });

  test('serves the shell and its bundle with the right types and lifetimes', async () => {
    const css = await fetch(`${base}/styles.css`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /text\/css/);
    assert.equal(css.headers.get('cache-control'), 'no-cache', 'the shell is re-asked for on every load');
    await css.text();

    // A content-hashed bundle changes its name when its bytes change, so a
    // browser may keep it for as long as it likes.
    const bundle = await fetch(`${base}/assets/app-abc123.js`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(bundle.status, 200);
    assert.match(bundle.headers.get('content-type') ?? '', /text\/javascript/);
    assert.match(bundle.headers.get('cache-control') ?? '', /immutable/);
    await bundle.text();

    // Unknown extensionless paths boot the shell; unknown files do not.
    const spa = await fetch(`${base}/some/route`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /<div id="app"/);
    const gone = await fetch(`${base}/assets/nope.js`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(gone.status, 404);
    await gone.text();
  });

  // An installed app launches with what the manifest gave it and nothing else,
  // so a bare start_url strands it on the 401 page the moment its storage has
  // no cookie — a fresh profile, a cleared jar, or iOS, where a home-screen app
  // never had Safari's to begin with.
  test('the manifest hands the installed app a way back in', async () => {
    const res = await fetch(`${base}/manifest.webmanifest`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/manifest\+json/);

    const manifest = (await res.json()) as { start_url: string; name: string; icons: unknown[] };
    assert.equal(manifest.start_url, `/?token=${encodeURIComponent(TOKEN)}`);
    // Origin-relative, so it survives the daemon coming up on another port,
    // and inside `scope` — a start_url outside it is not installable at all.
    assert.ok(manifest.start_url.startsWith('/'));
    assert.equal(manifest.name, 'Slick');
    assert.ok(manifest.icons.length >= 2);
  });

  // The worker is a build artefact like the rest of the shell: the bundler
  // writes the build's file list into it, so it changes whenever the UI does
  // and the daemon serves it exactly as it is on disk.
  test('the service worker is served as built, never cached', async () => {
    const res = await fetch(`${base}/sw.js`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/javascript/);
    assert.match(res.headers.get('cache-control') ?? '', /no-cache/);
    assert.equal(await res.text(), readFileSync(join(webRoot, 'sw.js'), 'utf8'));

    // The build the daemon reports is what tells an installed app it is out
    // of date, so it has to be there whether or not a worker was rewritten.
    const health = (await fetch(`${base}/api/health`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }).then((r) => r.json())) as { build: string | null };
    assert.equal(health.build, buildStamp(webRoot));
  });

  test('and the build changes when the UI does', async () => {
    const file = join(webRoot, 'styles.css');
    const before = buildStamp(webRoot);
    const stat = statSync(file);
    try {
      utimesSync(file, stat.atime, new Date(stat.mtimeMs + 5000));
      assert.notEqual(buildStamp(webRoot), before, 'a touched asset should restamp the build');
    } finally {
      utimesSync(file, stat.atime, stat.mtime);
    }
    assert.equal(buildStamp(webRoot), before, 'and putting it back should restore it');
  });

  test('and the manifest is no more readable than anything else', async () => {
    const res = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(res.status, 401);
    assert.doesNotMatch(await res.text(), new RegExp(TOKEN));
  });
});

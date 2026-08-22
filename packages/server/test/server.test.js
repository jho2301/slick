import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Workspace, serveLockPath } from '@slick/core';
import { createServer } from '../src/index.js';
import { createPushService } from '../src/push.js';
import { buildStamp, resolveWebRoot } from '../src/static.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOKEN = 'test-token-abc';

let home;
let app;
let base;

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'slick-server-'));
  app = createServer({ home, token: TOKEN });
  const bound = await app.listen(0);
  base = bound.url;
});

after(async () => {
  await app.close();
  rmSync(home, { recursive: true, force: true });
});

/** Authenticated request helper. */
async function call(method, path, body, opts = {}) {
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
    const status = await new Promise((resolve, reject) => {
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

describe('channels over HTTP', () => {
  test('create, read, update, archive, delete', async () => {
    const created = await call('POST', '/api/channels', { slug: 'api-test', topic: 'from a test' });
    assert.equal(created.status, 201);
    assert.equal(created.body.channel.slug, 'api-test');

    const listed = await call('GET', '/api/channels');
    assert.ok(listed.body.channels.some((c) => c.slug === 'api-test'));

    const updated = await call('PATCH', '/api/channels/api-test', { topic: 'changed' });
    assert.equal(updated.body.channel.topic, 'changed');

    const archived = await call('POST', '/api/channels/api-test/archive');
    assert.equal(archived.body.channel.archived, true);
    const visible = await call('GET', '/api/channels');
    assert.ok(!visible.body.channels.some((c) => c.slug === 'api-test'));

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
      (await call('GET', '/api/categories')).body.categories.map((c) => c.slug),
      ['engineering', 'product']
    );

    await call('POST', '/api/channels', { slug: 'http-deploys', category: 'engineering' });
    const grouped = await call('GET', '/api/categories/engineering/channels');
    assert.deepEqual(grouped.body.channels.map((c) => c.slug), ['http-deploys']);
    assert.ok(
      !(await call('GET', '/api/channels?category=')).body.channels.some((c) => c.slug === 'http-deploys'),
      'an empty category filter means "the uncategorised ones"'
    );

    const moved = await call('PATCH', '/api/channels/http-deploys', { category: second.body.category.id });
    assert.equal(moved.body.channel.category.name, 'Product');

    const collapsed = await call('PATCH', '/api/categories/product', { collapsed: true });
    assert.equal(collapsed.body.category.collapsed, true);

    const reordered = await call('POST', '/api/categories/reorder', { order: ['product'] });
    assert.deepEqual(reordered.body.categories.map((c) => c.slug), ['product', 'engineering']);

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

    assert.equal((await call('GET', `/api/agents/sessions/${key}/model`)).body.model, null, 'none to begin with');

    const set = await call('PUT', `/api/agents/sessions/${key}/model`, { model: ' anthropic/claude-opus-4 ' });
    assert.equal(set.body.model, 'anthropic/claude-opus-4', 'trimmed on the way in');
    assert.equal((await call('GET', `/api/agents/sessions/${key}/model`)).body.model, 'anthropic/claude-opus-4');

    // It rides in the session list, which is what the app renders the rail from.
    const listed = (await call('GET', '/api/agents/sessions')).body.sessions.find((s) => s.key === key);
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
    app.ws.agents.setModelChoices(key, [
      { id: 'north::big', label: 'big', group: 'north' },
      'plain-name',
    ]);

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
    const automation = (await call('POST', '/api/agents/sessions', { agentId: 'digest', channel: 'general' })).body
      .session.key;
    const watched = (await call('POST', '/api/agents/sessions', { agentId: 'answers', channel: 'general' })).body
      .session.key;
    writeFileSync(serveLockPath(watched, home), String(process.pid));

    const sessions = (await call('GET', '/api/agents/sessions')).body.sessions;
    const byKey = new Map(sessions.map((s) => [s.key, s]));
    assert.equal(byKey.get(automation).callable, false, 'nothing is watching it, so a mention would go nowhere');
    assert.equal(byKey.get(watched).callable, true);
    assert.equal(byKey.get(watched).serve.live, true);

    // The watcher stops, but the bookkeeping it wrote says it will be back.
    rmSync(serveLockPath(watched, home), { force: true });
    await call('PUT', `/api/agents/sessions/${watched}/state`, { state: { _serveThreads: {} } });
    const after = (await call('GET', '/api/agents/sessions')).body.sessions.find((s) => s.key === watched);
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
    const typingEvents = events.body.events.filter((e) => e.type === 'agent.typing');
    assert.equal(typingEvents.length, 2);
    assert.equal(typingEvents[0].payload.on, true);
    assert.equal(typingEvents[0].threadId, rootId);

    const resumed = await call('POST', `/api/agents/sessions/${key}/resume`, {});
    assert.ok(resumed.body.missed.every((e) => e.type !== 'agent.typing'));
  });
});

describe('push notifications', () => {
  // Its own server + workspace, with a fake `webpush` swapped in — real
  // delivery always speaks TLS regardless of the endpoint's scheme, so a
  // fake HTTP push endpoint can't stand in for it. This still exercises the
  // real subscribe/unsubscribe/prune logic in push.js and the real
  // agent-vs-human filtering in hub.js; only the actual network hop is fake.
  let pushHome;
  let pushApp;
  let pushBase;
  let calls;
  const PUSH_TOKEN = 'push-test-token';

  before(async () => {
    pushHome = mkdtempSync(join(tmpdir(), 'slick-server-push-'));
    calls = [];
    const fakeWebpush = {
      generateVAPIDKeys: () => ({ publicKey: 'fake-public-key', privateKey: 'fake-private-key' }),
      setVapidDetails: () => {},
      sendNotification: (sub, payload) => {
        calls.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
        if (sub.endpoint.endsWith('/gone')) {
          const err = new Error('subscription expired');
          err.statusCode = 410;
          return Promise.reject(err);
        }
        return Promise.resolve();
      },
    };
    const workspace = Workspace.open({ home: pushHome });
    const push = createPushService(workspace, fakeWebpush);
    pushApp = createServer({ workspace, token: PUSH_TOKEN, push });
    const bound = await pushApp.listen(0);
    pushBase = bound.url;
  });

  after(async () => {
    await pushApp.close();
    rmSync(pushHome, { recursive: true, force: true });
  });

  async function pushCall(method, path, body) {
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

    const started = await pushCall('POST', '/api/agents/sessions', { agentId: 'pushbot', channel: 'general' });
    const key = started.body.session.key;
    await pushCall('POST', `/api/agents/sessions/${key}/messages`, { text: 'an agent reply, pushed' });
    await sleep(50);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].endpoint, 'https://push.example/one');
    assert.equal(calls[0].payload.body, 'an agent reply, pushed');

    await pushCall('POST', '/api/push/unsubscribe', { endpoint: 'https://push.example/one' });
  });

  test('a subscription the push service reports gone is pruned and not retried', async () => {
    await pushCall('POST', '/api/push/subscribe', { endpoint: 'https://push.example/gone', keys: {} });
    await pushCall('POST', '/api/push/subscribe', { endpoint: 'https://push.example/still-good', keys: {} });

    calls.length = 0;
    const first = await pushCall('POST', '/api/agents/sessions', { agentId: 'pruner', channel: 'general' });
    await pushCall('POST', `/api/agents/sessions/${first.body.session.key}/messages`, { text: 'round one' });
    await sleep(50);
    assert.deepEqual(
      calls.map((c) => c.endpoint).sort(),
      ['https://push.example/gone', 'https://push.example/still-good']
    );

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

describe('live stream', () => {
  test('pushes events as they happen, including writes made outside HTTP', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/stream?since=0`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    /** Read until `predicate` is happy or we run out of patience. */
    async function readUntil(predicate, timeoutMs = 6000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise((r) => setTimeout(() => r({ value: undefined, done: false }), 400)),
        ]);
        if (done) break;
        if (value) buffer += decoder.decode(value, { stream: true });
        const events = buffer
          .split('\n\n')
          .filter((chunk) => chunk.includes('data:'))
          .map((chunk) => {
            const line = chunk.split('\n').find((l) => l.startsWith('data:'));
            try {
              return JSON.parse(line.slice(5).trim());
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        const hit = events.find(predicate);
        if (hit) return hit;
      }
      return null;
    }

    assert.ok(await readUntil((e) => e.type === 'stream.ready'), 'stream announces itself');

    // Written straight to SQLite, exactly as the CLI would — the daemon must
    // still notice and fan it out.
    app.ws.messages.post({ channel: 'general', text: 'written outside the daemon' });
    const seen = await readUntil((e) => e.message?.text === 'written outside the daemon');
    assert.ok(seen, 'external write reached the stream');
    assert.equal(seen.type, 'message.created');
    assert.equal(seen.channelSlug, 'general');

    controller.abort();
    await reader.cancel().catch(() => {});
  });
});

describe('web UI hosting', () => {
  test('serves the app shell', async () => {
    const res = await fetch(`${base}/?token=${TOKEN}`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /<div id="app"/);
    assert.match(res.headers.get('content-type'), /text\/html/);
  });

  test('serves the module graph', async () => {
    for (const path of ['/styles.css', '/js/app.js', '/js/api.js', '/js/format.js', '/js/ui.js']) {
      const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal(res.status, 200, `${path} should be served`);
      await res.text();
    }
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
    assert.match(res.headers.get('content-type'), /application\/manifest\+json/);

    const manifest = await res.json();
    assert.equal(manifest.start_url, `./?token=${encodeURIComponent(TOKEN)}`);
    // Relative, so it survives the daemon coming up on another port, and inside
    // `scope` — a start_url outside it is not installable at all.
    assert.ok(manifest.start_url.startsWith('./'));
    assert.equal(manifest.name, 'Slick');
    assert.ok(manifest.icons.length >= 2);
  });

  // A worker is only replaced when its own bytes change. Without a stamp in
  // it, a shell that ships new JS behind an unchanged sw.js leaves every
  // installed app on the worker — and the cache — it already has.
  test('the service worker carries the build it belongs to', async () => {
    const res = await fetch(`${base}/sw.js`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/javascript/);

    const source = await res.text();
    assert.doesNotMatch(source, /__BUILD__/, 'the placeholder should have been replaced');
    const stamp = source.match(/const BUILD = ["']([0-9a-f]+)["']/)?.[1];
    assert.ok(stamp, 'the worker should name a build');

    // The same build the daemon reports, or the app cannot tell whether the
    // worker it is running is the one being served.
    const health = await fetch(`${base}/api/health`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }).then((r) => r.json());
    assert.equal(health.build, stamp);
  });

  test('and the build changes when the UI does', async () => {
    const webRoot = resolveWebRoot(null);
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

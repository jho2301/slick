import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from '../src/index.js';

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

  test('an unknown history key is a 404 with a usable code', async () => {
    const res = await call('POST', '/api/agents/sessions/slk_h1_00000000000000000000/resume', {});
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'unknown_history_key');
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
});

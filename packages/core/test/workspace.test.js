import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Workspace } from '../src/workspace.js';
import { ConflictError, NotFoundError, ValidationError } from '../src/errors.js';
import { looksLikeHistoryKey } from '../src/ids.js';

/** @type {string} */
let home;
/** @type {Workspace} */
let ws;
let dbCounter = 0;

before(() => {
  home = mkdtempSync(join(tmpdir(), 'slick-core-'));
});

after(() => {
  ws?.close();
  rmSync(home, { recursive: true, force: true });
});

// A real file per test, not :memory:, so tests can reopen the same workspace
// from a second connection the way a restarted agent process does.
beforeEach(() => {
  ws?.close();
  ws = Workspace.open({ file: join(home, `w${dbCounter++}.db`), home });
});

describe('bootstrap', () => {
  test('creates the default channels exactly once', () => {
    assert.deepEqual(
      ws.channels.list().map((c) => c.slug),
      ['general', 'agents']
    );
    const again = ws.bootstrap();
    assert.equal(again.created, false);
    assert.equal(ws.channels.list().length, 2);
  });

  test('reports workspace info', () => {
    const info = ws.info();
    assert.equal(info.counts.channels, 2);
    assert.equal(info.counts.messages, 0);
    assert.equal(info.counts.categories, 0);
    assert.ok(info.seq > 0, 'bootstrap emits events');
  });

  test('a workspace made before categories existed picks them up on open', () => {
    const file = join(home, 'legacy.db');
    const before = Workspace.open({ file, home });
    before.messages.post({ channel: 'general', text: 'written before categories' });
    before.close();

    // Rewind the file to the shape a v1 workspace had on disk.
    const raw = new DatabaseSync(file);
    raw.exec('DROP INDEX ix_channels_category');
    raw.exec('ALTER TABLE channels DROP COLUMN category_id');
    raw.exec('DROP TABLE channel_categories');
    raw.exec('PRAGMA user_version = 1');
    raw.close();

    const after = Workspace.open({ file, home });
    try {
      assert.equal(after.info().counts.categories, 0);
      const eng = after.categories.create({ name: 'Engineering' });
      assert.equal(after.channels.update('general', { category: eng.id }).categoryId, eng.id);
      assert.equal(after.messages.list('general').messages.length, 1, 'the old contents are untouched');
    } finally {
      after.close();
    }
  });
});

describe('channels', () => {
  test('create, read, update, archive, delete', () => {
    const created = ws.channels.create({ slug: 'Design Review!', topic: 'pixels' });
    assert.equal(created.slug, 'design-review');
    assert.equal(created.topic, 'pixels');

    assert.equal(ws.channels.get('#design-review').id, created.id);
    assert.equal(ws.channels.get(created.id).slug, 'design-review');

    const renamed = ws.channels.update('design-review', { slug: 'design', name: 'Design' });
    assert.equal(renamed.slug, 'design');
    assert.equal(renamed.name, 'Design');

    const archived = ws.channels.archive('design');
    assert.equal(archived.archived, true);
    assert.ok(!ws.channels.list().some((c) => c.slug === 'design'));
    assert.ok(ws.channels.list({ includeArchived: true }).some((c) => c.slug === 'design'));

    ws.channels.unarchive('design');
    assert.equal(ws.channels.get('design').archived, false);

    const removed = ws.channels.remove('design');
    assert.equal(removed.deleted, true);
    assert.throws(() => ws.channels.get('design'), NotFoundError);
  });

  test('rejects duplicate slugs and bad names', () => {
    assert.throws(() => ws.channels.create({ slug: 'general' }), ConflictError);
    assert.throws(() => ws.channels.create({ slug: '!!!' }), ValidationError);
  });

  test('refuses to delete a channel that still has messages', () => {
    ws.messages.post({ channel: 'general', text: 'hello' });
    assert.throws(() => ws.channels.remove('general'), ConflictError);
    const forced = ws.channels.remove('general', { force: true });
    assert.equal(forced.deletedMessages, 1);
  });
});

describe('channel categories', () => {
  test('create, rename, collapse, delete', () => {
    const created = ws.categories.create({ name: 'Engineering & Ops' });
    assert.equal(created.slug, 'engineering-ops', 'the handle comes from the name');
    assert.equal(created.name, 'Engineering & Ops');
    assert.equal(created.collapsed, false);
    assert.deepEqual(ws.categories.list().map((c) => c.channelCount), [0], 'counts come with the listing');

    assert.equal(ws.categories.get('engineering-ops').id, created.id);
    assert.equal(ws.categories.get(created.id).name, created.name);

    const renamed = ws.categories.update(created.id, { name: 'Engineering', slug: 'eng' });
    assert.equal(renamed.slug, 'eng');
    assert.equal(renamed.name, 'Engineering');

    assert.equal(ws.categories.setCollapsed('eng', true).collapsed, true);
    assert.equal(ws.categories.get('eng').collapsed, true, 'collapse is stored, not per-session');

    assert.equal(ws.categories.remove('eng').deleted, true);
    assert.throws(() => ws.categories.get('eng'), NotFoundError);
  });

  test('rejects duplicate handles and bad names', () => {
    ws.categories.create({ name: 'Design' });
    assert.throws(() => ws.categories.create({ name: 'design' }), ConflictError);
    assert.throws(() => ws.categories.create({ name: '   ' }), ValidationError);
    assert.throws(() => ws.categories.create({ name: '!!!' }), ValidationError);
  });

  test('a channel belongs to one category and can be taken out again', () => {
    const eng = ws.categories.create({ name: 'Engineering' });
    const product = ws.categories.create({ name: 'Product' });

    const deploys = ws.channels.create({ slug: 'deploys', category: 'engineering' });
    assert.equal(deploys.categoryId, eng.id);
    assert.deepEqual(deploys.category, { id: eng.id, slug: 'engineering', name: 'Engineering', position: eng.position });

    const moved = ws.channels.update('deploys', { category: product.id });
    assert.equal(moved.categoryId, product.id, 'moving replaces rather than adds');
    assert.equal(ws.categories.list().find((c) => c.id === eng.id).channelCount, 0);
    assert.equal(ws.categories.list().find((c) => c.id === product.id).channelCount, 1);

    const loose = ws.channels.update('deploys', { category: null });
    assert.equal(loose.categoryId, null);
    assert.equal(loose.category, null);

    // Not mentioning it at all leaves it where it is.
    ws.channels.update('deploys', { category: 'product' });
    assert.equal(ws.channels.update('deploys', { topic: 'ship logs' }).categoryId, product.id);

    assert.throws(() => ws.channels.update('deploys', { category: 'nope' }), NotFoundError);
  });

  test('listing can be filtered to one category, or to the channels in none', () => {
    ws.categories.create({ name: 'Engineering' });
    ws.channels.create({ slug: 'deploys', category: 'engineering' });

    assert.deepEqual(
      ws.channels.list({ category: 'engineering' }).map((c) => c.slug),
      ['deploys']
    );
    assert.deepEqual(
      ws.channels.list({ category: null }).map((c) => c.slug),
      ['general', 'agents'],
      'the default channels start uncategorised'
    );
  });

  test('deleting a category keeps its channels, uncategorised', () => {
    const eng = ws.categories.create({ name: 'Engineering' });
    ws.channels.create({ slug: 'deploys', category: eng.id });
    ws.messages.post({ channel: 'deploys', text: 'still here' });

    const removed = ws.categories.remove(eng.id);
    assert.equal(removed.uncategorisedChannels, 1);
    assert.equal(ws.channels.get('deploys').categoryId, null);
    assert.equal(ws.messages.list('deploys').messages.length, 1);
  });

  test('reorder puts the named categories first and leaves the rest in order', () => {
    ws.categories.create({ name: 'One' });
    ws.categories.create({ name: 'Two' });
    ws.categories.create({ name: 'Three' });
    assert.deepEqual(ws.categories.list().map((c) => c.slug), ['one', 'two', 'three']);

    assert.deepEqual(
      ws.categories.reorder(['three']).map((c) => c.slug),
      ['three', 'one', 'two']
    );
    assert.deepEqual(
      ws.categories.reorder(['two', 'two', 'one']).map((c) => c.slug),
      ['two', 'one', 'three'],
      'a repeated name is not a second slot'
    );
    assert.throws(() => ws.categories.reorder([]), ValidationError);
    assert.throws(() => ws.categories.reorder(['nope']), NotFoundError);
  });

  test('grouping shows up in the event log without waking agents', () => {
    const start = ws.seq();
    const eng = ws.categories.create({ name: 'Engineering' });
    ws.channels.update('general', { category: eng.id });
    ws.categories.remove(eng.id);

    assert.deepEqual(
      ws.events({ since: start }).map((e) => e.type),
      ['category.created', 'channel.updated', 'category.deleted']
    );

    const session = ws.agents.start({ agentId: 'claude' });
    ws.categories.create({ name: 'Product' });
    assert.deepEqual(ws.agents.pull(session.key).events, [], 'sidebar changes are not an agent inbox item');
  });
});

describe('messages and threads', () => {
  test('post, edit, delete', () => {
    const msg = ws.messages.post({ channel: 'general', text: 'first post' });
    assert.equal(msg.channelSlug, 'general');
    assert.equal(msg.isThreadRoot, true);
    assert.equal(msg.author.kind, 'human');

    const edited = ws.messages.update(msg.id, { text: 'first post (edited)' });
    assert.equal(edited.text, 'first post (edited)');
    assert.ok(edited.editedAt);

    const deleted = ws.messages.remove(msg.id);
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.text, '', 'soft delete removes the content');
    assert.equal(ws.messages.list('general').messages.length, 0);
    assert.equal(ws.messages.list('general', { includeDeleted: true }).messages.length, 1);
  });

  test('threads stay one level deep and keep reply counts', () => {
    const root = ws.messages.post({ channel: 'general', text: 'root' });
    const a = ws.messages.reply(root.id, { text: 'reply one' });
    const b = ws.messages.reply(a.id, { text: 'reply to the reply' });

    assert.equal(b.parentId, root.id, 'replying to a reply joins the same thread');

    const thread = ws.messages.thread(a.id);
    assert.equal(thread.root.id, root.id);
    assert.equal(thread.replies.length, 2);
    assert.equal(ws.messages.get(root.id).replyCount, 2);

    // Replies do not clutter the channel timeline.
    assert.equal(ws.messages.list('general').messages.length, 1);
    assert.equal(ws.messages.list('general', { includeReplies: true }).messages.length, 3);

    ws.messages.remove(b.id);
    assert.equal(ws.messages.get(root.id).replyCount, 1);
  });

  test('hard delete removes the row and its replies', () => {
    const root = ws.messages.post({ channel: 'general', text: 'root' });
    ws.messages.reply(root.id, { text: 'child' });
    ws.messages.remove(root.id, { hard: true });
    assert.equal(ws.messages.find(root.id), null);
    assert.equal(ws.messages.list('general', { includeReplies: true, includeDeleted: true }).messages.length, 0);
  });

  test('pagination walks backwards through history', () => {
    for (let i = 0; i < 10; i++) ws.messages.post({ channel: 'general', text: `m${i}` });
    const page1 = ws.messages.list('general', { limit: 4 });
    assert.deepEqual(page1.messages.map((m) => m.text), ['m6', 'm7', 'm8', 'm9']);
    assert.equal(page1.hasMore, true);

    const page2 = ws.messages.list('general', { limit: 4, before: page1.oldestSeq });
    assert.deepEqual(page2.messages.map((m) => m.text), ['m2', 'm3', 'm4', 'm5']);

    const forward = ws.messages.list('general', { limit: 3, after: page2.newestSeq });
    assert.deepEqual(forward.messages.map((m) => m.text), ['m6', 'm7', 'm8']);
  });

  test('refuses empty text and archived channels', () => {
    assert.throws(() => ws.messages.post({ channel: 'general', text: '   ' }), ValidationError);
    ws.channels.archive('general');
    assert.throws(() => ws.messages.post({ channel: 'general', text: 'hi' }), ConflictError);
  });

  test('extracts mentions', () => {
    const msg = ws.messages.post({ channel: 'general', text: 'hey @claude and @ops-bot, look here' });
    assert.deepEqual(msg.mentions, ['claude', 'ops-bot']);
  });
});

describe('agent sessions', () => {
  test('a history key survives a restart and resumes exactly where it left off', () => {
    const session = ws.agents.start({ agentId: 'claude', name: 'inbox', channel: 'general' });
    assert.ok(looksLikeHistoryKey(session.key));
    assert.equal(session.cursorSeq, ws.seq(), 'a new session starts caught up');

    // The human says something while the agent is away.
    const asked = ws.messages.post({ channel: 'general', text: '@claude what is the status?' });

    // A brand new process only has the key.
    const restarted = Workspace.open({ file: ws.file, home });
    try {
      const resumed = restarted.agents.resume(session.key);
      assert.equal(resumed.session.key, session.key);
      assert.equal(resumed.pending, 1);
      assert.equal(resumed.missed[0].message.id, asked.id);
      assert.equal(resumed.missed[0].channelSlug, 'general');
      assert.equal(resumed.cursor, session.cursorSeq, 'resume peeks, it does not consume');
    } finally {
      restarted.close();
    }
  });

  test('pull advances the cursor and never repeats a message', () => {
    const session = ws.agents.start({ agentId: 'claude', channel: 'general' });
    ws.messages.post({ channel: 'general', text: 'one' });
    ws.messages.post({ channel: 'general', text: 'two' });

    const first = ws.agents.pull(session.key);
    assert.deepEqual(first.events.map((e) => e.message.text), ['one', 'two']);
    assert.equal(first.pending, 0);

    const second = ws.agents.pull(session.key);
    assert.deepEqual(second.events, []);

    ws.messages.post({ channel: 'general', text: 'three' });
    const third = ws.agents.pull(session.key);
    assert.deepEqual(third.events.map((e) => e.message.text), ['three']);
  });

  test('peek leaves the cursor alone', () => {
    const session = ws.agents.start({ agentId: 'claude' });
    ws.messages.post({ channel: 'general', text: 'unread' });
    const peeked = ws.agents.pull(session.key, { peek: true });
    assert.equal(peeked.events.length, 1);
    assert.equal(peeked.cursor, session.cursorSeq);
    assert.equal(ws.agents.pull(session.key).events.length, 1, 'still unread after a peek');
  });

  test('an agent does not read back its own posts', () => {
    const session = ws.agents.start({ agentId: 'claude', channel: 'general' });
    const { message } = ws.agents.post(session.key, { text: 'working on it' });
    assert.equal(message.author.kind, 'agent');
    assert.equal(message.author.id, 'claude');
    assert.equal(message.sessionKey, session.key);

    assert.equal(ws.agents.pull(session.key).events.length, 0);
    assert.equal(ws.agents.pull(session.key, { includeOwn: true, peek: true }).events.length, 1);
    assert.equal(ws.agents.get(session.key).messageCount, 1);
  });

  test('two agents each keep their own place in the log', () => {
    const alice = ws.agents.start({ agentId: 'alice' });
    ws.messages.post({ channel: 'general', text: 'first' });
    const bob = ws.agents.start({ agentId: 'bob' }); // joins later, so starts caught up
    ws.messages.post({ channel: 'general', text: 'second' });

    assert.deepEqual(ws.agents.pull(alice.key).events.map((e) => e.message.text), ['first', 'second']);
    assert.deepEqual(ws.agents.pull(bob.key).events.map((e) => e.message.text), ['second']);
  });

  test('state is private memory that survives resume', () => {
    const session = ws.agents.start({ agentId: 'claude', name: 'triage' });
    ws.agents.setState(session.key, { step: 'reading', todo: ['a', 'b'] });
    ws.agents.setState(session.key, { step: 'writing' });

    const resumed = ws.agents.resume('triage', { agentId: 'claude' });
    assert.deepEqual(resumed.state, { step: 'writing', todo: ['a', 'b'] }, 'merge by default');

    ws.agents.setState(session.key, { only: true }, { merge: false });
    assert.deepEqual(ws.agents.get(session.key).state, { only: true });
  });

  test('scoping a session to a channel filters what it sees', () => {
    ws.channels.create({ slug: 'noise' });
    const session = ws.agents.start({ agentId: 'claude', channel: 'general' });
    ws.messages.post({ channel: 'noise', text: 'ignore me' });
    ws.messages.post({ channel: 'general', text: 'read me' });

    const scoped = ws.agents.pull(session.key, { scope: 'session' });
    assert.deepEqual(scoped.events.map((e) => e.message.text), ['read me']);
  });

  test('resume --create makes a session on first run and finds it after', () => {
    const first = ws.agents.resume('nightly', { create: true, agentId: 'claude', channel: 'general' });
    const second = ws.agents.resume('nightly', { create: true, agentId: 'claude' });
    assert.equal(second.session.key, first.session.key);
    assert.equal(second.session.resumeCount, 2);
  });

  test('reports an unknown key clearly, even with --create', () => {
    for (const opts of [{}, { create: true, agentId: 'claude' }]) {
      assert.throws(
        () => ws.agents.resume('slk_h1_00000000000000000000', opts),
        (err) => err instanceof NotFoundError && err.code === 'unknown_history_key',
        'a specific key that does not exist is an error, not a reason to mint a different one'
      );
    }
  });

  test('duplicate session names are rejected but can be reused deliberately', () => {
    ws.agents.start({ agentId: 'claude', name: 'inbox' });
    assert.throws(() => ws.agents.start({ agentId: 'claude', name: 'inbox' }), ConflictError);
    const reused = ws.agents.start({ agentId: 'claude', name: 'inbox', reuse: true });
    assert.equal(reused.reused, true);
    // Same name under a different agent is fine.
    assert.ok(ws.agents.start({ agentId: 'other', name: 'inbox' }).key);
  });

  test('agents can reply into a thread', () => {
    const session = ws.agents.start({ agentId: 'claude', channel: 'general' });
    const root = ws.messages.post({ channel: 'general', text: 'question?' });
    const { message } = ws.agents.reply(session.key, root.id, { text: 'answer.' });
    assert.equal(message.parentId, root.id);
    assert.equal(ws.messages.thread(root.id).replies.length, 1);
  });

  test('typing is a live signal, not part of the conversation an agent resumes into', () => {
    const session = ws.agents.start({ agentId: 'claude', channel: 'general' });
    const root = ws.messages.post({ channel: 'general', text: '@claude are you there?' });

    ws.agents.typing(session.key, { on: true, threadId: root.id, channelId: root.channelId });
    ws.agents.typing(session.key, { on: false, threadId: root.id, channelId: root.channelId });

    const typingEvents = ws.events().filter((e) => e.type === 'agent.typing');
    assert.equal(typingEvents.length, 2);
    assert.equal(typingEvents[0].payload.on, true);
    assert.equal(typingEvents[0].threadId, root.id);
    assert.equal(typingEvents[0].actor.id, 'claude');
    assert.equal(typingEvents[1].payload.on, false);

    // Another session resuming should never see typing blips as unread work.
    const other = ws.agents.start({ agentId: 'watcher', channel: 'general' });
    const resumed = ws.agents.resume(other.key);
    assert.ok(
      resumed.missed.every((e) => e.type !== 'agent.typing'),
      'typing must not show up as something to handle'
    );
  });
});

describe('search', () => {
  test('ANDs terms and honours filters', () => {
    ws.messages.post({ channel: 'general', text: 'deploy the auth service' });
    ws.messages.post({ channel: 'general', text: 'auth is fine' });
    ws.messages.post({ channel: 'agents', text: 'deploy the worker' });

    assert.equal(ws.search('auth').count, 2);
    assert.equal(ws.search('deploy auth').count, 1);
    assert.equal(ws.search('deploy', { channel: 'agents' }).count, 1);
    assert.equal(ws.search('"the auth"').count, 1);
    assert.equal(ws.search('   ').count, 0);
  });

  test('does not return deleted messages', () => {
    const msg = ws.messages.post({ channel: 'general', text: 'secret' });
    ws.messages.remove(msg.id);
    assert.equal(ws.search('secret').count, 0);
  });
});

describe('event log', () => {
  test('seq is globally monotonic and readable from any point', () => {
    const start = ws.seq();
    ws.messages.post({ channel: 'general', text: 'a' });
    ws.channels.create({ slug: 'later' });
    ws.messages.post({ channel: 'later', text: 'b' });

    const events = ws.events({ since: start });
    assert.deepEqual(events.map((e) => e.type), [
      'message.created',
      'channel.created',
      'message.created',
    ]);
    const seqs = events.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
  });
});

#!/usr/bin/env node
/**
 * Fill a workspace with a believable conversation.
 *
 *   node scripts/seed-demo.mjs [--home <dir>] [--reset]
 *
 * Used by the UI smoke test and handy for showing the app to someone.
 */

import { rmSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Workspace, paths } from '@slick/core';

const { values } = parseArgs({
  options: { home: { type: 'string' }, reset: { type: 'boolean', default: false } },
});

const home = values.home ?? process.env.SLICK_HOME;
if (values.reset && home) rmSync(paths(home).root, { recursive: true, force: true });

const ws = Workspace.open({ home });
ws.setUser({ id: 'fano', name: 'Fano' });

const HOUR = 3600_000;

function ensureChannel(def) {
  const existing = ws.channels.find(def.slug);
  if (!existing) return ws.channels.create(def);
  // Re-running against an older workspace should still land the grouping.
  return def.category && existing.categoryId !== ws.categories.get(def.category).id
    ? ws.channels.update(existing.id, { category: def.category })
    : existing;
}

function ensureCategory(name) {
  return ws.categories.find(name) ?? ws.categories.create({ name });
}

const engineering = ensureCategory('Engineering');
const product = ensureCategory('Product');

ensureChannel({ slug: 'general', topic: 'Everything that does not have a home yet' });
ensureChannel({ slug: 'agents', topic: 'Where your AI agents report in', category: engineering.id });
ensureChannel({
  slug: 'deploys',
  name: 'deploys',
  topic: 'Ship logs and incident chatter',
  category: engineering.id,
});
ensureChannel({
  slug: 'design',
  name: 'design',
  topic: 'Screens, copy, and arguments about spacing',
  category: product.id,
});

const claude = ws.agents.find('inbox', { agentId: 'claude' })
  ?? ws.agents.start({ agentId: 'claude', name: 'inbox', channel: 'deploys', title: 'Release watch' });

const reviewer = ws.agents.find('review', { agentId: 'reviewer' })
  ?? ws.agents.start({ agentId: 'reviewer', name: 'review', channel: 'design', title: 'Design review bot' });

if (ws.messages.list('deploys').messages.length === 0) {
  const incident = ws.messages.post({
    channel: 'deploys',
    text: '@claude staging is failing on the `assets:build` step since about 09:40. Can you look?',
  });
  ws.agents.post(claude.key, {
    channel: 'deploys',
    text: 'Looking now. Pulling the last three runs to compare.',
  });
  ws.agents.reply(claude.key, incident.id, {
    text:
      'Found it. The cache key still includes `NODE_ENV`, so the release build reuses the dev bundle:\n\n' +
      '```yaml\nkey: assets-${{ env.NODE_ENV }}-${{ hashFiles(\'**/package-lock.json\') }}\n```\n\n' +
      'Dropping `NODE_ENV` from the key fixes it. Want me to open the PR?',
    metadata: { run: 4821, confidence: 'high' },
  });
  ws.messages.reply(incident.id, { text: 'Yes please. Small and boring, straight to main.' });
  ws.agents.reply(claude.key, incident.id, {
    text: 'PR #412 is up and green. **Staging is back.**',
  });
  ws.agents.setState(claude.key, {
    watching: 'staging',
    lastIncident: incident.id,
    step: 'awaiting-merge',
  });

  ws.messages.post({ channel: 'deploys', text: 'Merged. Thanks — that was fast.' });
}

if (ws.messages.list('general').messages.length === 0) {
  ws.messages.post({ channel: 'general', text: 'Morning. Light day — mostly cleanup and the release notes.' });
  ws.messages.post({
    channel: 'general',
    text: 'Reminder: everything here is one SQLite file at `~/.slick/slick.db`. Back it up like any other file.',
  });
  const question = ws.messages.post({
    channel: 'general',
    text: 'Does anyone remember why we kept the old `/v1` endpoints around?',
  });
  ws.messages.reply(question.id, { text: 'Two integrations still call them. There is a ticket to migrate.' });
}

if (ws.messages.list('design').messages.length === 0) {
  const spacing = ws.messages.post({
    channel: 'design',
    text: 'New composer spec is in. 14px gutters, 10px radius, and the send button only lights up with text.',
  });
  ws.agents.reply(reviewer.key, spacing.id, {
    text: 'Checked against the tokens. One mismatch: the thread pane still uses 12px gutters.',
  });
}

const info = ws.info();
console.log(
  `seeded ${info.counts.channels} channels in ${info.counts.categories} categories, ` +
    `${info.counts.messages} messages, ${info.counts.agentSessions} agent sessions in ${info.file}`
);
console.log(`claude history key:   ${claude.key}`);
console.log(`reviewer history key: ${reviewer.key}`);
ws.close();

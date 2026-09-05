/**
 * The Hermes panel's asynchrony, without a DOM.
 *
 * Every bug this file is about lives between two awaits: a profile read that
 * lands after the user has moved on, a save whose answer arrives for a profile
 * nobody is looking at any more, a draft from one profile written to another.
 * The store exists so those are ordinary facts to assert rather than something
 * only a human clicking fast can find.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createHermesStore } from '../js/hermes-store.js';

const CATALOG = [
  {
    value: 'openai-codex',
    label: 'OpenAI Codex',
    models: [
      { value: 'gpt-6-astra', label: 'gpt-6-astra' },
      { value: 'gpt-6-vega', label: 'gpt-6-vega' },
    ],
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    models: [
      { value: 'claude-sonnet-5', label: 'claude-sonnet-5' },
      { value: 'claude-opus-5', label: 'claude-opus-5' },
    ],
  },
];

/** Let queued microtasks and resolved promises run before asserting. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const answerFor = (provider, model, extra = {}) => ({
  providers: CATALOG,
  defaults: { provider, model },
  catalogError: null,
  error: null,
  ...extra,
});

/**
 * An api whose every call hangs until the test says otherwise, so "which
 * answer came back second" is something a test decides rather than races.
 */
function fakeApi({ profiles = [{ name: 'work', isDefault: true }, { name: 'lab', isDefault: false }] } = {}) {
  const reads = [];
  const writes = [];
  const profileCalls = [];
  const usageReads = [];
  return {
    reads,
    writes,
    profileCalls,
    usageReads,
    hermesProfiles() {
      const pending = deferred();
      profileCalls.push(pending);
      // Resolved by default; a test that wants to fail this one rejects it
      // before the first tick.
      queueMicrotask(() => pending.resolve(profiles));
      return pending.promise;
    },
    hermesProfileModel(name) {
      const pending = { name, ...deferred() };
      reads.push(pending);
      return pending.promise;
    },
    setHermesProfileModel(name, wanted) {
      const pending = { name, wanted, ...deferred() };
      writes.push(pending);
      return pending.promise;
    },
    hermesProfileUsage(name, opts = {}) {
      // Hangs like the others: whether the account answers before or after the
      // profile moves is the whole question these tests are asking.
      const pending = { name, opts, ...deferred() };
      usageReads.push(pending);
      return pending.promise;
    },
  };
}

let api;
let store;
let renders;

beforeEach(() => {
  api = fakeApi();
  renders = 0;
  store = createHermesStore({ api, onChange: () => (renders += 1) });
});

/** Load `work` and land on gpt-6-astra, which most tests start from. */
async function loaded() {
  store.load();
  await settle();
  api.reads.at(-1).resolve(answerFor('openai-codex', 'gpt-6-astra'));
  await settle();
}

describe('reading a profile', () => {
  test('the first load asks for the first profile and shows what it says', async () => {
    await loaded();
    assert.equal(api.reads.length, 1);
    assert.equal(api.reads[0].name, 'work');
    assert.equal(store.state.profile, 'work');
    assert.deepEqual(store.state.saved, { provider: 'openai-codex', model: 'gpt-6-astra' });
    assert.deepEqual(store.state.draft, { provider: 'openai-codex', model: 'gpt-6-astra' });
    assert.equal(store.state.loaded, true);
    assert.equal(store.isBusy(), false);
  });

  test('a read still in flight leaves the panel busy and its controls out of reach', async () => {
    store.load();
    await settle();
    assert.equal(store.isBusy(), true);
    assert.equal(store.canSave(), false);
  });

  test('an out-of-order answer for a profile nobody is on any more is ignored', async () => {
    await loaded();
    store.selectProfile('lab');
    await settle();
    store.selectProfile('work');
    await settle();

    const [, lab, work] = api.reads;
    assert.equal(lab.name, 'lab');
    assert.equal(work.name, 'work');

    // The slow one lands last, for the profile that was left behind.
    work.resolve(answerFor('anthropic', 'claude-opus-5'));
    await settle();
    lab.resolve(answerFor('openai-codex', 'gpt-6-vega'));
    await settle();

    assert.equal(store.state.profile, 'work');
    assert.deepEqual(store.state.saved, { provider: 'anthropic', model: 'claude-opus-5' });
    assert.deepEqual(store.state.draft, { provider: 'anthropic', model: 'claude-opus-5' });
    assert.equal(store.isBusy(), false, 'the abandoned read does not leave the panel spinning');
  });

  test('switching profiles drops the old draft rather than carrying it across', async () => {
    await loaded();
    store.setDraft({ provider: 'anthropic', model: 'claude-opus-5' });
    assert.equal(store.dirty(), true);

    store.selectProfile('lab');
    await settle();
    assert.deepEqual(store.state.draft, { provider: '', model: '' }, 'nothing from work survives into lab');
    assert.deepEqual(store.state.saved, { provider: '', model: '' });
    assert.equal(store.canSave(), false);

    // And nothing can be written in that window either.
    await store.save();
    assert.equal(api.writes.length, 0, 'the old draft is never offered to the new profile');
  });

  test('selecting the profile already showing changes nothing', async () => {
    await loaded();
    const before = api.reads.length;
    store.selectProfile('work');
    await settle();
    assert.equal(api.reads.length, before);
  });
});

describe('saving', () => {
  test('the save goes to the profile that was on screen, and says so', async () => {
    await loaded();
    store.setDraft({ provider: 'anthropic', model: 'claude-opus-5' });
    assert.equal(store.canSave(), true);

    store.save();
    await settle();
    assert.equal(api.writes.length, 1);
    assert.equal(api.writes[0].name, 'work');
    assert.deepEqual(api.writes[0].wanted, { provider: 'anthropic', model: 'claude-opus-5' });
    assert.equal(store.state.saving, true);
    assert.equal(store.canSave(), false, 'no second write while the first is out');

    api.writes[0].resolve(answerFor('anthropic', 'claude-opus-5'));
    await settle();
    assert.deepEqual(store.state.saved, { provider: 'anthropic', model: 'claude-opus-5' });
    assert.deepEqual(store.state.note, { kind: 'ok', text: 'Saved to the work profile.' });
  });

  test('a save cannot be started while a read is in flight', async () => {
    await loaded();
    store.setDraft({ provider: 'anthropic', model: 'claude-opus-5' });
    store.load();
    await settle();

    await store.save();
    assert.equal(api.writes.length, 0, 'the handler refuses, not just the button');
  });

  test('the draft cannot be moved while the panel is busy', async () => {
    await loaded();
    store.load();
    await settle();
    store.setDraft({ provider: 'anthropic', model: 'claude-opus-5' });
    assert.deepEqual(store.state.draft, { provider: 'openai-codex', model: 'gpt-6-astra' });
  });

  test('switching profile mid-save abandons the answer instead of applying it', async () => {
    await loaded();
    store.setDraft({ provider: 'anthropic', model: 'claude-opus-5' });
    store.save();
    await settle();
    assert.equal(api.writes[0].name, 'work');

    store.selectProfile('lab');
    await settle();
    assert.equal(store.state.saving, false, 'the panel is not stuck on "Saving…"');

    api.reads.at(-1).resolve(answerFor('openai-codex', 'gpt-6-vega'));
    await settle();
    api.writes[0].resolve(answerFor('anthropic', 'claude-opus-5'));
    await settle();

    assert.equal(store.state.profile, 'lab');
    assert.deepEqual(store.state.saved, { provider: 'openai-codex', model: 'gpt-6-vega' }, "work's readback never lands on lab");
    assert.deepEqual(store.state.draft, { provider: 'openai-codex', model: 'gpt-6-vega' });
    assert.equal(store.state.note, null, 'and no "saved" tick for a profile nobody is looking at');
  });

  test('a refused write keeps the draft and says what happened', async () => {
    await loaded();
    store.setDraft({ provider: 'anthropic', model: 'claude-opus-5' });
    store.save();
    await settle();
    api.writes[0].reject(new Error('config.yaml is read-only'));
    await settle();

    assert.deepEqual(store.state.saved, { provider: 'openai-codex', model: 'gpt-6-astra' }, 'the known default is still known');
    assert.deepEqual(store.state.draft, { provider: 'anthropic', model: 'claude-opus-5' }, 'the choice is not thrown away');
    assert.deepEqual(store.state.note, { kind: 'warn', text: 'config.yaml is read-only' });
    assert.equal(store.canSave(), true, 'and it can be tried again');
  });

  test('a readback that does not match what was asked for is called out', async () => {
    await loaded();
    store.setDraft({ provider: 'anthropic', model: 'claude-opus-5' });
    store.save();
    await settle();
    api.writes[0].resolve(answerFor('openai-codex', 'gpt-6-astra'));
    await settle();
    assert.equal(store.state.note.kind, 'warn');
    assert.match(store.state.note.text, /other than what was asked/);
  });

  test('there is nothing to save when the draft is what the profile already says', async () => {
    await loaded();
    assert.equal(store.canSave(), false);
    await store.save();
    assert.equal(api.writes.length, 0);
  });
});

describe('a read that failed', () => {
  test('the error is shown and a retry re-reads without writing anything', async () => {
    store.load();
    await settle();
    api.reads[0].reject(new Error('hermes is not installed'));
    await settle();
    assert.equal(store.state.error, 'hermes is not installed');
    assert.equal(store.state.loaded, true);
    assert.equal(store.isBusy(), false);

    store.retry();
    await settle();
    assert.equal(api.reads.length, 2, 'the retry asks again');
    assert.equal(api.reads[1].name, 'work');
    api.reads[1].resolve(answerFor('anthropic', 'claude-sonnet-5'));
    await settle();

    assert.equal(store.state.error, null);
    assert.deepEqual(store.state.saved, { provider: 'anthropic', model: 'claude-sonnet-5' });
    assert.equal(api.writes.length, 0, 'a retry is a read, never a write');
  });

  test('a failed refresh keeps the default it already knows on screen', async () => {
    await loaded();
    store.retry();
    await settle();
    api.reads[1].reject(new Error('hermes went away'));
    await settle();

    assert.equal(store.state.error, 'hermes went away');
    assert.deepEqual(store.state.saved, { provider: 'openai-codex', model: 'gpt-6-astra' }, 'the last known default is still shown');
    assert.ok(store.state.providers.length > 0, 'and so is the catalog it came with');
    assert.equal(store.canSave(), false, 'but nothing is written on top of an unreadable profile');
  });

  test('an installation with no profiles at all says so', async () => {
    api = fakeApi({ profiles: [] });
    store = createHermesStore({ api, onChange: () => {} });
    store.load();
    await settle();
    assert.match(store.state.error, /no Hermes profile/);
    assert.equal(api.reads.length, 0);
  });

  test('an error the payload carries blocks saving too', async () => {
    store.load();
    await settle();
    api.reads[0].resolve({ providers: [], defaults: {}, error: 'HERMES_HOME is not readable' });
    await settle();
    assert.equal(store.state.error, 'HERMES_HOME is not readable');
    assert.equal(store.canSave(), false);
  });
});

describe('the level the profile thinks at', () => {
  /** What the bridge reports as `agent.reasoning_effort`'s vocabulary. */
  const EFFORTS = [
    { value: 'minimal', label: 'minimal' },
    { value: 'low', label: 'low' },
    { value: 'medium', label: 'medium' },
    { value: 'high', label: 'high' },
    { value: 'xhigh', label: 'xhigh' },
    { value: 'max', label: 'max' },
    { value: 'ultra', label: 'ultra' },
    { value: 'none', label: 'none' },
  ];

  /** The same answer as `answerFor`, with the effort half of it filled in. */
  const withEffort = (provider, model, effort, extra = {}) => ({
    ...answerFor(provider, model, extra),
    effort,
    efforts: EFFORTS,
    effectiveEffort: effort,
    ...extra,
  });

  /** Load `work` on gpt-6-astra at `high`, which these tests start from. */
  async function loadedAt(effort = 'high') {
    store.load();
    await settle();
    api.reads.at(-1).resolve(withEffort('openai-codex', 'gpt-6-astra', effort));
    await settle();
  }

  test('what the profile is set to arrives with everything else', async () => {
    await loadedAt('high');
    assert.equal(store.state.savedEffort, 'high');
    assert.equal(store.state.draftEffort, 'high');
    assert.deepEqual(store.state.efforts, EFFORTS);
    assert.equal(store.dirty(), false, 'reading is not changing');
  });

  test('a profile with no level set reads as the absence, not as a level', async () => {
    store.load();
    await settle();
    api.reads.at(-1).resolve(withEffort('openai-codex', 'gpt-6-astra', null));
    await settle();
    assert.equal(store.state.savedEffort, '');
    assert.equal(store.state.draftEffort, '');
    assert.equal(store.dirty(), false);
  });

  test('changing only the level is something to save, and it is what gets written', async () => {
    await loadedAt('high');
    store.setEffort('max');
    assert.equal(store.state.draftEffort, 'max');
    assert.equal(store.dirty(), true, 'the pair did not move, but the setting did');
    assert.equal(store.canSave(), true);

    store.save();
    await settle();
    assert.equal(api.writes.length, 1);
    assert.equal(api.writes[0].name, 'work');
    assert.deepEqual(api.writes[0].wanted, {
      provider: 'openai-codex',
      model: 'gpt-6-astra',
      effort: 'max',
    });

    api.writes[0].resolve(withEffort('openai-codex', 'gpt-6-astra', 'max'));
    await settle();
    assert.equal(store.state.savedEffort, 'max');
    assert.equal(store.state.draftEffort, 'max');
    assert.deepEqual(store.state.note, { kind: 'ok', text: 'Saved to the work profile.' });
    assert.equal(store.dirty(), false);
  });

  test('a level saved alongside a provider change goes in the same write', async () => {
    await loadedAt('high');
    store.setDraft({ provider: 'anthropic', model: 'claude-opus-5' });
    store.setEffort('low');
    store.save();
    await settle();
    assert.deepEqual(api.writes[0].wanted, {
      provider: 'anthropic',
      model: 'claude-opus-5',
      effort: 'low',
    });
  });

  test('going back to the Hermes default asks for the setting to be cleared', async () => {
    await loadedAt('high');
    store.setEffort('');
    assert.equal(store.dirty(), true);
    store.save();
    await settle();
    assert.equal(api.writes[0].wanted.effort, '', 'an empty level is a request to unset it, not a missing field');
    api.writes[0].resolve(withEffort('openai-codex', 'gpt-6-astra', null));
    await settle();
    assert.equal(store.state.savedEffort, '');
    assert.deepEqual(store.state.note, { kind: 'ok', text: 'Saved to the work profile.' });
  });

  test('a readback at a level nobody asked for is called out', async () => {
    await loadedAt('high');
    store.setEffort('max');
    store.save();
    await settle();
    api.writes[0].resolve(withEffort('openai-codex', 'gpt-6-astra', 'high'));
    await settle();
    assert.equal(store.state.note.kind, 'warn');
    assert.match(store.state.note.text, /other than what was asked/);
  });

  test('the level cannot be moved while the panel is busy', async () => {
    await loadedAt('high');
    store.load();
    await settle();
    store.setEffort('max');
    assert.equal(store.state.draftEffort, 'high', 'a draft moved mid-request could be written to another profile');
  });

  test('cancelling puts the level back with the rest of the draft', async () => {
    await loadedAt('high');
    store.setDraft({ provider: 'anthropic', model: 'claude-opus-5' });
    store.setEffort('ultra');
    store.revert();
    assert.deepEqual(store.state.draft, { provider: 'openai-codex', model: 'gpt-6-astra' });
    assert.equal(store.state.draftEffort, 'high');
    assert.equal(store.dirty(), false);
  });

  test('switching profiles drops the level as it drops everything else', async () => {
    await loadedAt('high');
    store.setEffort('ultra');

    store.selectProfile('lab');
    await settle();
    assert.equal(store.state.draftEffort, '', 'nothing from work survives into lab');
    assert.equal(store.state.savedEffort, '');
    assert.deepEqual(store.state.efforts, [], 'not even the catalog it came with');
    assert.equal(store.canSave(), false);

    await store.save();
    assert.equal(api.writes.length, 0, "work's level is never offered to lab");

    api.reads.at(-1).resolve(withEffort('anthropic', 'claude-sonnet-5', 'low'));
    await settle();
    assert.equal(store.state.savedEffort, 'low');
    assert.equal(store.state.draftEffort, 'low');
  });

  test("an answer for a profile nobody is on any more does not set anyone's level", async () => {
    await loadedAt('high');
    store.selectProfile('lab');
    await settle();
    store.selectProfile('work');
    await settle();

    const [, lab, work] = api.reads;
    work.resolve(withEffort('openai-codex', 'gpt-6-astra', 'xhigh'));
    await settle();
    lab.resolve(withEffort('anthropic', 'claude-sonnet-5', 'minimal'));
    await settle();

    assert.equal(store.state.profile, 'work');
    assert.equal(store.state.savedEffort, 'xhigh');
    assert.equal(store.state.draftEffort, 'xhigh');
  });

  test('what is actually in force is kept apart from what this profile sets', async () => {
    // A per-model `agent.reasoning_overrides` entry outranks the global, so
    // the two are not always the same fact and the panel must not merge them.
    store.load();
    await settle();
    api.reads.at(-1).resolve(withEffort('openai-codex', 'gpt-6-astra', 'high', { effectiveEffort: 'max' }));
    await settle();
    assert.equal(store.state.savedEffort, 'high');
    assert.equal(store.state.effectiveEffort, 'max');
  });
});

describe('what the account behind the profile has left', () => {
  /** One window as the daemon sends it. */
  const window = (label, used, resetAt = null) => ({
    label,
    usedPercent: used,
    remainingPercent: 100 - used,
    resetAt,
    detail: null,
  });

  /** A whole usage payload, in the shape `GET …/usage` answers with. */
  const usageAnswer = (extra = {}) => ({
    profile: 'work',
    usage: {
      provider: 'openai-codex',
      supported: true,
      available: true,
      title: 'Account limits',
      plan: 'Pro',
      source: 'usage_api',
      fetchedAt: '2026-09-05T12:00:00Z',
      windows: [window('Session', 40, '2026-09-05T17:00:00Z'), window('Weekly', 88, '2026-09-09T00:00:00Z')],
      details: ['Credits balance: $12.34'],
      bankedResets: 2,
      unavailableReason: null,
    },
    note: null,
    fetchedAt: '2026-09-05T12:00:00Z',
    error: null,
    code: null,
    cached: false,
    throttled: false,
    ...extra,
  });

  /** Load `work`, on the provider that has limits, and settle the usage ask. */
  async function onCodex(answer = usageAnswer()) {
    store.load();
    await settle();
    api.reads.at(-1).resolve(answerFor('openai-codex', 'gpt-6-astra'));
    await settle();
    if (answer !== null) {
      api.usageReads.at(-1)?.resolve(answer);
      await settle();
    }
  }

  test('a profile on Codex is asked about, once, off the back of the read', async () => {
    await onCodex();
    assert.equal(api.usageReads.length, 1, 'one ask, and only after the config said which provider');
    assert.equal(api.usageReads[0].name, 'work');
    assert.equal(api.usageReads[0].opts.refresh, false);
    assert.equal(store.state.usage.applicable, true);
    assert.equal(store.state.usage.loaded, true);
    assert.equal(store.state.usage.loading, false);
    assert.equal(store.state.usage.answer.usage.bankedResets, 2);
    assert.deepEqual(
      store.state.usage.answer.usage.windows.map((w) => w.label),
      ['Session', 'Weekly']
    );
  });

  test('a profile on a provider with no limits API is never asked', async () => {
    store.load();
    await settle();
    api.reads.at(-1).resolve(answerFor('anthropic', 'claude-opus-5'));
    await settle();
    assert.equal(api.usageReads.length, 0, 'no request, because there is nothing to request');
    assert.equal(store.state.usage.applicable, false);
    assert.equal(store.state.usage.answer, null);
  });

  test('the account ask does not hold up the panel that says which model it is on', async () => {
    store.load();
    await settle();
    api.reads.at(-1).resolve(answerFor('openai-codex', 'gpt-6-astra'));
    await settle();
    // The usage request is still out.
    assert.equal(store.state.usage.loading, true);
    assert.equal(store.isBusy(), false, 'a slow provider must not disable the selects');
    assert.equal(store.state.loaded, true);
  });

  test('refreshing asks again, past the cache, and says so while it is out', async () => {
    await onCodex();
    store.refreshUsage();
    await settle();
    assert.equal(api.usageReads.length, 2);
    assert.equal(api.usageReads[1].opts.refresh, true);
    assert.equal(store.state.usage.loading, true);

    api.usageReads[1].resolve(usageAnswer({ cached: true, throttled: true }));
    await settle();
    assert.equal(store.state.usage.answer.throttled, true, 'the panel is told the request did not happen');
    assert.equal(store.state.usage.loading, false);
  });

  test('a second click while one is out is not a second request', async () => {
    await onCodex();
    store.refreshUsage();
    store.refreshUsage();
    store.refreshUsage();
    await settle();
    assert.equal(api.usageReads.length, 2, 'one ask outstanding at a time — the rate limit is the provider’s');
  });

  test('a signed-out account is kept as an answer, not thrown at the renderer', async () => {
    await onCodex(
      usageAnswer({
        usage: null,
        error: 'This profile has no usable ChatGPT credentials.',
        code: 'not_authenticated',
      })
    );
    assert.equal(store.state.usage.answer.code, 'not_authenticated');
    assert.equal(store.state.usage.loaded, true);
    assert.equal(store.state.error, null, 'the model half of the panel is unaffected');
    assert.deepEqual(store.state.saved, { provider: 'openai-codex', model: 'gpt-6-astra' });
  });

  test('a request that never arrived is shaped like an answer too', async () => {
    store.load();
    await settle();
    api.reads.at(-1).resolve(answerFor('openai-codex', 'gpt-6-astra'));
    await settle();
    api.usageReads.at(-1).reject(new Error('the daemon went away'));
    await settle();
    assert.equal(store.state.usage.answer.code, 'unreachable');
    assert.match(store.state.usage.answer.error, /went away/);
    assert.equal(store.state.usage.loading, false, 'a failure still ends the spinner');
  });

  test('switching profiles drops the account numbers with everything else', async () => {
    await onCodex();
    store.selectProfile('lab');
    await settle();
    assert.equal(store.state.usage.answer, null, "work's remaining quota is not lab's");
    assert.equal(store.state.usage.applicable, false);
    assert.equal(store.state.usage.loaded, false);
  });

  test('an account answer for a profile nobody is on is dropped whole', async () => {
    store.load();
    await settle();
    api.reads.at(-1).resolve(answerFor('openai-codex', 'gpt-6-astra'));
    await settle();
    const stray = api.usageReads.at(-1);

    store.selectProfile('lab');
    await settle();
    api.reads.at(-1).resolve(answerFor('anthropic', 'claude-sonnet-5'));
    await settle();

    stray.resolve(usageAnswer());
    await settle();
    assert.equal(store.state.profile, 'lab');
    assert.equal(store.state.usage.answer, null, "work's numbers must never appear under lab");
    assert.equal(store.state.usage.loading, false, 'and nothing is left spinning');
  });

  test('saving a move onto Codex asks about the account it just moved to', async () => {
    store.load();
    await settle();
    api.reads.at(-1).resolve(answerFor('anthropic', 'claude-opus-5'));
    await settle();
    assert.equal(api.usageReads.length, 0);

    store.setDraft({ provider: 'openai-codex', model: 'gpt-6-astra' });
    store.save();
    await settle();
    api.writes[0].resolve(answerFor('openai-codex', 'gpt-6-astra'));
    await settle();

    assert.equal(store.state.usage.applicable, true);
    assert.equal(api.usageReads.length, 1, 'the account changed, so the numbers are asked for');
  });

  test('saving a move off Codex throws the old account’s numbers away', async () => {
    await onCodex();
    store.setDraft({ provider: 'anthropic', model: 'claude-opus-5' });
    store.save();
    await settle();
    api.writes[0].resolve(answerFor('anthropic', 'claude-opus-5'));
    await settle();

    assert.equal(store.state.usage.applicable, false);
    assert.equal(store.state.usage.answer, null, 'those numbers were about a different account');
    assert.equal(api.usageReads.length, 1, 'and no new ask, because there is nothing to ask');
  });

  test('saving a model on the same provider leaves the numbers alone', async () => {
    await onCodex();
    store.setDraft({ provider: 'openai-codex', model: 'gpt-6-vega' });
    store.save();
    await settle();
    api.writes[0].resolve(answerFor('openai-codex', 'gpt-6-vega'));
    await settle();

    assert.equal(api.usageReads.length, 1, 'the same account — nothing to re-ask');
    assert.equal(store.state.usage.answer.usage.plan, 'Pro', 'and what it said is still on screen');
  });
});

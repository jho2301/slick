import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  hasAccountLimits,
  hermesEfforts,
  hermesSelection,
  resetPhrase,
  resetStamp,
  resetWithin,
  sameEffort,
  sameSelection,
  shouldRefreshUsageAfter,
  usageAge,
  usageLimitRows,
  usageLimitText,
  usageStatus,
  usageWindows,
  withConfigured,
} from '../js/hermes-panel.js';

/** The shape `GET /api/hermes/profiles/:name/model` hands back. */
const CATALOG = [
  {
    value: 'openai-codex',
    label: 'OpenAI Codex',
    custom: false,
    authenticated: true,
    models: [
      { value: 'gpt-6-astra', label: 'gpt-6-astra' },
      { value: 'shared-model', label: 'shared-model' },
    ],
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    custom: false,
    authenticated: true,
    models: [
      { value: 'claude-sonnet-5', label: 'claude-sonnet-5' },
      { value: 'shared-model', label: 'shared-model' },
    ],
  },
  { value: 'custom:fano', label: 'fano', custom: true, authenticated: true, models: [{ value: 'local-qwen', label: 'local-qwen' }] },
];

describe('what the panel starts on', () => {
  test('the configured pair, when the catalog has it', () => {
    assert.deepEqual(hermesSelection(CATALOG, { provider: 'anthropic', model: 'claude-sonnet-5' }), {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
  });

  test('a profile with nothing configured falls to the first provider’s first model', () => {
    assert.deepEqual(hermesSelection(CATALOG, { provider: null, model: null }), {
      provider: 'openai-codex',
      model: 'gpt-6-astra',
    });
  });

  test('an empty catalog offers the configured pair and invents nothing', () => {
    assert.deepEqual(hermesSelection([], { provider: 'anthropic', model: 'claude-sonnet-5' }), {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
    assert.deepEqual(hermesSelection([], { provider: null, model: null }), { provider: '', model: '' });
  });
});

describe('changing the provider', () => {
  test('the model follows the provider rather than staying behind on a stale one', () => {
    // The failure this exists to stop: pick anthropic, leave `gpt-6-astra`
    // showing, and save a pair no provider serves.
    assert.deepEqual(
      hermesSelection(CATALOG, { provider: 'anthropic', model: 'gpt-6-astra' }),
      { provider: 'anthropic', model: 'claude-sonnet-5' },
      'a model the new provider does not have is replaced by one it does'
    );
  });

  test('a model both providers serve survives the switch', () => {
    assert.deepEqual(hermesSelection(CATALOG, { provider: 'anthropic', model: 'shared-model' }), {
      provider: 'anthropic',
      model: 'shared-model',
    });
  });

  test('a provider with no models at all leaves the model empty rather than borrowed', () => {
    const barren = [...CATALOG, { value: 'empty-one', label: 'Empty One', custom: false, authenticated: true, models: [] }];
    assert.deepEqual(hermesSelection(barren, { provider: 'empty-one', model: 'gpt-6-astra' }), {
      provider: 'empty-one',
      model: '',
    });
  });
});

describe('a configured value the catalog has never heard of', () => {
  // Credentials pulled, a provider plugin removed, a model retired upstream, a
  // config edited by hand. The panel has to keep saying what the profile is
  // actually set to — showing something else as "current" is how someone
  // overwrites a working setting believing they changed nothing.
  test('an unlisted provider is still offered, and marked as not in the catalog', () => {
    const providers = withConfigured(CATALOG, { provider: 'retired-co', model: 'old-model' });
    const retired = providers.find((p) => p.value === 'retired-co');
    assert.ok(retired, 'the configured provider is in the list');
    assert.equal(retired.unlisted, true);
    assert.deepEqual(retired.models, [{ value: 'old-model', label: 'old-model', unlisted: true }]);
    assert.deepEqual(hermesSelection(providers, { provider: 'retired-co', model: 'old-model' }), {
      provider: 'retired-co',
      model: 'old-model',
    });
  });

  test('an unlisted model under a known provider joins that provider’s list', () => {
    const providers = withConfigured(CATALOG, { provider: 'anthropic', model: 'claude-4-legacy' });
    const anthropic = providers.find((p) => p.value === 'anthropic');
    assert.equal(anthropic.unlisted, undefined, 'the provider itself is listed');
    assert.deepEqual(anthropic.models.at(-1), { value: 'claude-4-legacy', label: 'claude-4-legacy', unlisted: true });
    assert.deepEqual(hermesSelection(providers, { provider: 'anthropic', model: 'claude-4-legacy' }), {
      provider: 'anthropic',
      model: 'claude-4-legacy',
    });
  });

  test('a configured pair already in the catalog adds nothing', () => {
    assert.deepEqual(withConfigured(CATALOG, { provider: 'anthropic', model: 'claude-sonnet-5' }), CATALOG);
    assert.deepEqual(withConfigured(CATALOG, { provider: null, model: null }), CATALOG);
  });
});

describe('knowing when there is nothing to save', () => {
  test('the same pair is the same pair', () => {
    assert.equal(sameSelection({ provider: 'a', model: 'b' }, { provider: 'a', model: 'b' }), true);
    assert.equal(sameSelection({ provider: 'a', model: 'b' }, { provider: 'a', model: 'c' }), false);
    assert.equal(sameSelection({ provider: 'a', model: 'b' }, { provider: 'z', model: 'b' }), false);
  });

  test('an unset default is not the same as a chosen one', () => {
    assert.equal(sameSelection({ provider: null, model: null }, { provider: '', model: '' }), true);
    assert.equal(sameSelection({ provider: null, model: null }, { provider: 'a', model: 'b' }), false);
  });
});

describe('the sequence the panel actually runs', () => {
  // Load, change provider, change model, save. Composed here because the bugs
  // live between the steps, not inside them.
  test('a provider change refreshes the models and only then is there something to save', () => {
    const saved = { provider: 'openai-codex', model: 'gpt-6-astra' };
    const providers = withConfigured(CATALOG, saved);

    let draft = hermesSelection(providers, saved);
    assert.equal(sameSelection(saved, draft), true, 'nothing to save on arrival');

    draft = hermesSelection(providers, { provider: 'custom:fano', model: draft.model });
    assert.deepEqual(draft, { provider: 'custom:fano', model: 'local-qwen' }, 'the stale model did not follow');
    assert.equal(sameSelection(saved, draft), false, 'now there is something to save');

    // Cancel puts it back exactly, and there is nothing to save again.
    assert.equal(sameSelection(saved, hermesSelection(providers, saved)), true);
  });

  test('after a save the readback becomes the new baseline', () => {
    const readback = { provider: 'anthropic', model: 'claude-sonnet-5' };
    const providers = withConfigured(CATALOG, readback);
    assert.equal(sameSelection(readback, hermesSelection(providers, readback)), true);
  });

  test('a provider whose models never loaded cannot be saved as a half-pair', () => {
    const barren = [{ value: 'quiet', label: 'Quiet', custom: false, authenticated: true, models: [] }];
    const draft = hermesSelection(barren, { provider: 'quiet', model: null });
    assert.equal(draft.model, '', 'and the panel disables Save on an empty model');
  });
});

describe('how hard the profile is told to think', () => {
  /** `agent.reasoning_effort`'s own vocabulary, as the bridge reports it. */
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

  test('the levels Hermes accepts, behind the option of having no opinion at all', () => {
    const options = hermesEfforts(EFFORTS, null);
    assert.deepEqual(options[0], { value: '', label: 'Hermes default' }, 'a set level can always be unset again');
    assert.deepEqual(
      options.slice(1).map((o) => o.value),
      ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'none'],
      'exactly what Hermes offers, in Hermes’ order'
    );
  });

  test('a configured level the catalog has never heard of is still offered, and marked', () => {
    const options = hermesEfforts(EFFORTS, 'turbo');
    assert.deepEqual(options.at(-1), { value: 'turbo', label: 'turbo', unlisted: true });
  });

  test('a level already in the catalog is not offered twice', () => {
    assert.deepEqual(hermesEfforts(EFFORTS, 'high'), hermesEfforts(EFFORTS, null));
  });

  test('a catalog that could not be read still offers the default and whatever is configured', () => {
    assert.deepEqual(hermesEfforts([], 'high'), [
      { value: '', label: 'Hermes default' },
      { value: 'high', label: 'high', unlisted: true },
    ]);
    assert.deepEqual(hermesEfforts([], null), [{ value: '', label: 'Hermes default' }]);
  });

  test('an unset level and an empty one are the same absence', () => {
    // The wire says `null` for a key that is not in the config; a `<select>`
    // says `''` for the same thing. Neither is "something to save".
    assert.equal(sameEffort(null, ''), true);
    assert.equal(sameEffort('high', 'high'), true);
    assert.equal(sameEffort('high', 'max'), false);
    assert.equal(sameEffort(null, 'high'), false);
  });
});

describe('what the account has left', () => {
  const codex = (windows, extra = {}) => ({
    provider: 'openai-codex',
    supported: true,
    available: true,
    title: 'Account limits',
    plan: 'Pro',
    windows,
    details: [],
    bankedResets: null,
    unavailableReason: null,
    ...extra,
  });

  test('only a provider with a limits API is worth asking about', () => {
    assert.equal(hasAccountLimits('openai-codex'), true);
    assert.equal(hasAccountLimits('anthropic'), false);
    assert.equal(hasAccountLimits('custom:fano'), false);
    assert.equal(hasAccountLimits(''), false);
    assert.equal(hasAccountLimits(null), false);
  });

  test('a window is reported as what is left, and as what was spent', () => {
    const [session, weekly] = usageWindows(
      codex([
        { label: 'Session', usedPercent: 42.4, remainingPercent: 57.6, resetAt: '2026-09-05T17:00:00Z' },
        { label: 'Weekly', usedPercent: 88, remainingPercent: 12, resetAt: '2026-09-09T00:00:00Z' },
      ])
    );
    assert.deepEqual(
      { label: session.label, used: session.used, remaining: session.remaining, known: session.known },
      { label: 'Session', used: 42, remaining: 58, known: true }
    );
    assert.equal(weekly.remaining, 12);
    assert.equal(weekly.resetAt, '2026-09-09T00:00:00Z');
  });

  test('a window with only the used half still draws a meter', () => {
    const [only] = usageWindows(codex([{ label: 'Session', usedPercent: 30 }]));
    assert.equal(only.remaining, 70, 'the other half is arithmetic, not a second field');
    assert.equal(only.fill, 30);
  });

  test('a window with no figure at all is empty, never full', () => {
    const [blank] = usageWindows(codex([{ label: 'Session', usedPercent: null, remainingPercent: null }]));
    assert.equal(blank.known, false);
    assert.equal(blank.remaining, null);
    assert.equal(blank.fill, 0, '"no answer" must never be drawn as "nothing left"');
  });

  test('a provider that reports past 100% is spent, not negative', () => {
    const [over] = usageWindows(codex([{ label: 'Session', usedPercent: 118 }]));
    assert.equal(over.used, 100);
    assert.equal(over.remaining, 0);
  });

  test('windows keep the order and the labels Hermes gave them', () => {
    const labels = usageWindows(
      codex([{ label: 'Session', usedPercent: 1 }, { label: 'Weekly', usedPercent: 2 }, { label: 'Monthly', usedPercent: 3 }])
    ).map((w) => w.label);
    assert.deepEqual(labels, ['Session', 'Weekly', 'Monthly'], 'a window Hermes adds needs no change here');
  });

  test('a reset is phrased as the wait, and as nothing when there is none', () => {
    const now = Date.parse('2026-09-05T12:00:00Z');
    assert.equal(resetPhrase('2026-09-05T12:40:00Z', now), 'in 40m');
    assert.equal(resetPhrase('2026-09-05T15:30:00Z', now), 'in 3h 30m');
    assert.equal(resetPhrase('2026-09-09T00:00:00Z', now), 'in 3d 12h');
    assert.equal(resetPhrase('2026-09-05T11:00:00Z', now), 'now', 'a window already past is not "in -1h"');
    assert.equal(resetPhrase(null, now), null);
    assert.equal(resetPhrase('not a date', now), null);
  });
});

describe('the two rows the rail always draws', () => {
  const codexRows = (windows) =>
    usageLimitRows({ provider: 'openai-codex', supported: true, windows, details: [] });

  test('"Session" is relabelled to the thing it actually measures', () => {
    // Codex calls its five-hour window "Session", which reads as "this
    // conversation" to anyone who has not read Codex' docs. The rail says the
    // duration instead; the value underneath is untouched.
    const [session] = codexRows([{ label: 'Session', usedPercent: 42, resetAt: '2026-09-05T17:00:00Z' }]);
    assert.equal(session.key, 'session');
    assert.equal(session.label, '5hour');
    assert.equal(session.used, 42, 'the relabel does not disturb the number');
    assert.equal(session.resetAt, '2026-09-05T17:00:00Z');
    assert.equal(session.known, true);
  });

  test('"Weekly" is reported under the duration word the rail uses', () => {
    const [, weekly] = codexRows([{ label: 'Weekly', usedPercent: 88, resetAt: '2026-09-09T00:00:00Z' }]);
    assert.equal(weekly.key, 'weekly');
    assert.equal(weekly.label, 'weekly');
    assert.equal(weekly.used, 88);
    assert.equal(weekly.resetAt, '2026-09-09T00:00:00Z');
  });

  test('both rows are always there, in order, whatever Hermes sent', () => {
    // A rail whose row count changes with the answer jumps under the cursor,
    // and a missing row reads as "no limit" rather than "not reported".
    for (const windows of [
      [],
      [{ label: 'Session', usedPercent: 5 }],
      [{ label: 'Weekly', usedPercent: 5 }],
      [{ label: 'Monthly', usedPercent: 5 }],
    ]) {
      const rows = codexRows(windows);
      assert.equal(rows.length, 2, `two rows for ${JSON.stringify(windows)}`);
      assert.deepEqual(rows.map((r) => r.key), ['session', 'weekly']);
      assert.deepEqual(rows.map((r) => r.label), ['5hour', 'weekly']);
    }
  });

  test('a row Hermes said nothing about is unknown, not zero', () => {
    const [session, weekly] = codexRows([{ label: 'Weekly', usedPercent: 60 }]);
    assert.deepEqual(
      { used: session.used, known: session.known, resetAt: session.resetAt },
      { used: null, known: false, resetAt: null },
      '"not reported" must never be drawn as "none used"'
    );
    assert.equal(weekly.known, true);
  });

  test('a window Hermes names differently still lands in its row', () => {
    const [session, weekly] = codexRows([
      { label: '5h limit', usedPercent: 11 },
      { label: 'This week', usedPercent: 22 },
    ]);
    assert.equal(session.used, 11);
    assert.equal(weekly.used, 22);
  });

  test('a window with no figure at all comes through as unknown', () => {
    const [session] = codexRows([{ label: 'Session', usedPercent: null, remainingPercent: null }]);
    assert.equal(session.known, false);
    assert.equal(session.used, null);
  });

  test('nothing to read at all is still two rows', () => {
    for (const nothing of [null, undefined, { supported: false, windows: [] }]) {
      assert.deepEqual(usageLimitRows(nothing).map((r) => r.label), ['5hour', 'weekly']);
    }
  });
});

describe('how long a window has left, as the row prints it', () => {
  const now = Date.parse('2026-09-05T12:00:00Z');

  test('under an hour is minutes alone', () => {
    assert.equal(resetWithin('2026-09-05T12:12:00Z', now), '12m');
    assert.ok(!resetWithin('2026-09-05T12:12:00Z', now).includes('0h'), '"0h 12m" reads as a rounding artefact');
  });

  test('a day or more is days alone', () => {
    assert.equal(resetWithin('2026-09-08T14:00:00Z', now), '3d');
    assert.equal(resetWithin('2026-09-11T06:00:00Z', now), '5d');
  });

  test('a whole number of days reads the same way', () => {
    assert.equal(resetWithin('2026-09-10T12:00:00Z', now), '5d');
  });

  test('under a day is hours alone', () => {
    assert.equal(resetWithin('2026-09-05T15:23:00Z', now), '3h');
  });
});

describe('the single line a limits row draws', () => {
  const now = Date.parse('2026-09-05T12:00:00Z');
  const row = (extra) => ({ label: '5hour', known: true, remaining: 100, resetAt: null, ...extra });

  test('what is left, and how long it lasts', () => {
    assert.equal(
      usageLimitText(row({ remaining: 97, resetAt: '2026-09-08T14:00:00Z' }), now),
      '97% (~3d)'
    );
    assert.equal(
      usageLimitText(row({ remaining: 92, resetAt: '2026-09-10T12:00:00Z' }), now),
      '92% (~5d)'
    );
  });

  test('a reset under an hour never says "0h"', () => {
    const said = usageLimitText(row({ remaining: 40, resetAt: '2026-09-05T12:12:00Z' }), now);
    assert.equal(said, '40% (~12m)');
    assert.ok(!said.includes('0h'));
  });

  test('no reset to show drops the clause rather than printing "unknown"', () => {
    assert.equal(usageLimitText(row({ remaining: 55, resetAt: null }), now), '55%');
    assert.equal(usageLimitText(row({ remaining: 55, resetAt: 'not a date' }), now), '55%');
  });

  test('the line is bare percent and reset: no "left", no "for"', () => {
    for (const said of [
      usageLimitText(row({ remaining: 97, resetAt: '2026-09-08T14:00:00Z' }), now),
      usageLimitText(row({ remaining: 55, resetAt: null }), now),
      usageLimitText(row({ remaining: 40, resetAt: '2026-09-05T12:12:00Z' }), now)
    ]) {
      assert.ok(!said.includes('left'), `"${said}" must not say "left"`);
      assert.ok(!said.includes('for'), `"${said}" must not say "for"`);
    }
  });

  test('a reset is approximate, and says so', () => {
    for (const said of [
      usageLimitText(row({ remaining: 97, resetAt: '2026-09-08T14:00:00Z' }), now),
      usageLimitText(row({ remaining: 40, resetAt: '2026-09-05T12:12:00Z' }), now)
    ]) {
      assert.ok(said.includes('~'), `"${said}" must mark the reset as approximate`);
    }
  });

  test('a row the provider said nothing about says so', () => {
    assert.equal(usageLimitText(row({ known: false, remaining: null }), now), 'unknown');
    assert.equal(usageLimitText(null, now), 'unknown');
  });
});

describe('the clock time a window comes back', () => {
  // `resetStamp` formats in the reader's own locale and zone, so the test
  // pins the parts that do not move: the local day, hour and minute of the
  // instant, and the fact that an unreadable value formats to nothing at all.
  const iso = '2026-09-05T17:05:00Z';
  const local = new Date(iso);

  test('the stamp carries the local day and minute of the instant', () => {
    const stamp = resetStamp(iso);
    assert.ok(stamp, 'a readable date formats to something');
    assert.match(stamp, new RegExp(`\\b${local.getDate()}\\b`), 'the local day of the month');
    assert.match(stamp, new RegExp(`${String(local.getMinutes()).padStart(2, '0')}\\b`), 'minutes, zero-padded');
    const hour = local.getHours();
    assert.match(
      stamp,
      new RegExp(`\\b(${hour}|${hour % 12 === 0 ? 12 : hour % 12})\\b`),
      'the local hour, on whichever clock the locale uses'
    );
  });

  test('it is a stamp, not a countdown', () => {
    assert.ok(!/\bin\b|ago/.test(resetStamp(iso)), 'no relative phrasing — resetPhrase does that');
  });

  test('two instants an hour apart do not format the same', () => {
    assert.notEqual(resetStamp('2026-09-05T17:05:00Z'), resetStamp('2026-09-05T18:05:00Z'));
  });

  test('nothing to format is nothing, rather than "Invalid Date"', () => {
    assert.equal(resetStamp(null), null);
    assert.equal(resetStamp(undefined), null);
    assert.equal(resetStamp(''), null);
    assert.equal(resetStamp('not a date'), null);
  });
});

describe('why there are no numbers, which is several different facts', () => {
  const answerOf = (extra) => ({ usage: null, error: null, code: null, ...extra });

  test('windows to draw is the only "ok"', () => {
    const status = usageStatus({
      usage: { supported: true, windows: [{ label: 'Session', usedPercent: 10 }], details: [] },
      error: null,
      code: null,
    });
    assert.equal(status.kind, 'ok');
  });

  test('a provider with no limits API is not a failure and offers no retry', () => {
    const status = usageStatus(answerOf({ usage: { provider: 'anthropic', supported: false, windows: [] } }));
    assert.equal(status.kind, 'unsupported');
    assert.equal(status.retryable, false, 'there is nothing to ask again for');
    assert.match(status.text, /anthropic/);
  });

  test('a signed-out account says so, and does not offer a retry that cannot help', () => {
    const status = usageStatus(
      answerOf({ code: 'not_authenticated', error: 'This profile has no usable ChatGPT credentials.' })
    );
    assert.equal(status.kind, 'signed-out');
    assert.equal(status.retryable, false, 'the fix is a login, not another request');
    assert.match(status.text, /credentials/);
  });

  test('an endpoint that would not answer is an error, and that one is worth retrying', () => {
    const status = usageStatus(answerOf({ code: 'usage_unreachable', error: 'The usage endpoint could not be reached.' }));
    assert.equal(status.kind, 'error');
    assert.equal(status.retryable, true);
  });

  test('asked, answered, and had nothing to say is neither of the above', () => {
    assert.equal(usageStatus(answerOf({ usage: { supported: true, windows: [], details: [] } })).kind, 'empty');
    assert.equal(usageStatus(null).kind, 'empty', 'nothing read yet is not an error either');
  });

  test('a reason the account itself gave is repeated rather than replaced', () => {
    const status = usageStatus(
      answerOf({ usage: { supported: true, windows: [], unavailableReason: 'Limits are only available for OAuth accounts.' } })
    );
    assert.equal(status.kind, 'empty');
    assert.match(status.text, /OAuth/);
  });

  test('an error with no sentence still gets one', () => {
    const status = usageStatus({ usage: null, error: null, code: 'usage_failed' });
    assert.equal(status.kind, 'error');
    assert.ok(status.text.length > 0, 'a blank warning is not a warning');
  });
});

describe('how old the number on screen is', () => {
  const now = Date.parse('2026-09-05T12:00:00Z');

  test('a fresh answer reads as just now, an old one as its age', () => {
    assert.equal(usageAge({ fetchedAt: '2026-09-05T11:59:50Z' }, now), 'just now');
    assert.equal(usageAge({ fetchedAt: '2026-09-05T11:50:00Z' }, now), '10m ago');
    assert.equal(usageAge({ fetchedAt: '2026-09-05T09:00:00Z' }, now), '3h ago');
  });

  test('a refresh the daemon would not pass on says so rather than claiming a request', () => {
    const said = usageAge({ fetchedAt: '2026-09-05T11:59:55Z', throttled: true }, now);
    assert.match(said, /already up to date/, 'saying "just now" over a request that never happened is a lie');
  });

  test('an answer with no timestamp has no age to give', () => {
    assert.equal(usageAge({ fetchedAt: null }, now), null);
    assert.equal(usageAge(null, now), null);
  });
});

describe('when a finished message is worth re-asking the account', () => {
  test("an agent's answer on the Codex path costs the account something", () => {
    assert.equal(shouldRefreshUsageAfter({ author: { kind: 'agent' } }, 'openai-codex'), true);
  });

  test('an agent answer on another provider has no account to ask', () => {
    assert.equal(shouldRefreshUsageAfter({ author: { kind: 'agent' } }, 'anthropic'), false);
  });

  test('a human line costs the account nothing', () => {
    assert.equal(shouldRefreshUsageAfter({ author: { kind: 'human' } }, 'openai-codex'), false);
  });
});

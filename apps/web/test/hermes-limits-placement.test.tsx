/**
 * Where the account limits are drawn.
 *
 * They used to be the last thing inside `#hermes-panel`, which is folded by
 * default — so the one part of that section that changes on its own was the
 * only part nobody saw. These tests pin the fix: the limits are a rail section
 * of their own, directly under the Hermes one, shown whenever the profile's
 * provider has limits at all and hidden when it does not.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render } from '@testing-library/react';
import { Provider } from 'jotai';
import { beforeEach, describe, test } from 'vitest';

import { hermesAtom } from '../src/app/atoms.ts';
import { HermesLimitsSection, HermesSection } from '../src/app/Rail.tsx';
import type { HermesState } from '../src/features/hermes/hermes-store.ts';
import { hermes, store } from '../src/app/store.ts';

// By path from the repo root: under jsdom `import.meta.url` is an http URL.
const css = readFileSync(resolve(process.cwd(), 'apps/web/src/styles.css'), 'utf8');

/** A store write, flushed through React before the next assertion. */
const setHermes = (state: HermesState) =>
  act(async () => {
    store.set(hermesAtom, state);
    await Promise.resolve();
  });

const withUsage = (usage: Partial<HermesState['usage']>): HermesState => ({
  ...hermes.state,
  saved: { provider: 'openai-codex', model: 'gpt-6-astra' },
  usage: { applicable: false, loading: false, loaded: false, answer: null, ...usage },
});

function rail() {
  return render(
    <Provider store={store}>
      <aside id="rail">
        <HermesSection />
        <HermesLimitsSection />
      </aside>
    </Provider>
  );
}

beforeEach(async () => {
  await setHermes(withUsage({ applicable: false }));
});

describe('the limits block has a rail section of its own', () => {
  test('the section sits after the Hermes section, not inside its panel', async () => {
    await setHermes(withUsage({ applicable: true }));
    const { container } = rail();
    const panel = container.querySelector('#hermes-panel')!;
    const limits = container.querySelector('#hermes-limits-section')!;
    assert.ok(panel && limits, 'both sections exist');
    assert.ok(!panel.contains(limits), 'the limits section is outside the collapsible Hermes panel');
    assert.ok(panel.compareDocumentPosition(limits) & Node.DOCUMENT_POSITION_FOLLOWING, 'and comes after it');
  });

  test('it says what it is, rather than "Account limits"', async () => {
    await setHermes(withUsage({ applicable: true }));
    const { container } = rail();
    assert.equal(
      container.querySelector('#hermes-limits-heading .rail__heading-text')?.textContent,
      'OpenAI limits'
    );
  });

  test('the plan and the refresh control share the heading row', async () => {
    store.set(
      hermesAtom,
      withUsage({
        applicable: true,
        loaded: true,
        answer: {
          usage: {
            provider: 'openai-codex',
            supported: true,
            plan: 'Pro',
            windows: [],
            details: [],
            bankedResets: null,
            unavailableReason: null,
          },
          fetchedAt: null,
          error: null,
          code: null,
        },
      })
    );
    const { container } = rail();
    const heading = container.querySelector('#hermes-limits-heading')!;
    assert.ok(heading.classList.contains('rail__heading--row'), 'the heading is laid out as a row');
    const head = heading.querySelector('#hermes-limits-head')!;
    assert.ok(head, 'the head mounts inside the heading');
    assert.equal(head.querySelector('.hermes__usage-plan')?.textContent, 'Pro');
    const refresh = head.querySelector<HTMLButtonElement>('.hermes__usage-refresh')!;
    assert.equal(refresh.getAttribute('aria-label'), 'Refresh usage', 'an icon button with a name');
    assert.match(refresh.title, /Refreshes are limited/, 'and a title that explains the throttle');
    assert.ok(refresh.querySelector('svg[aria-hidden="true"]'), 'the glyph itself is hidden from the reader');
    assert.ok(
      heading.querySelector('.rail__heading-text')!.compareDocumentPosition(head) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      'the words come first, the control after'
    );
  });

  test('nothing folds it — it has a heading, not a toggle button', async () => {
    await setHermes(withUsage({ applicable: true }));
    const { container } = rail();
    const section = container.querySelector('#hermes-limits-section')!;
    assert.equal(section.querySelector('button.rail__heading'), null, 'no collapse control');
    assert.ok(section.querySelector('h2.rail__heading'), 'a heading');
    assert.ok(section.querySelector('#hermes-limits'), 'it holds the block the renderer fills');
  });

  test('the settings that do fold are still in the Hermes panel', async () => {
    await setHermes({
      ...hermes.state,
      loaded: true,
      profiles: [{ name: 'work', isDefault: true, configured: true }],
    });
    const { container } = rail();
    assert.ok(container.querySelector('#toggle-hermes'), 'the Hermes section still collapses');
    for (const id of ['hermes-profile', 'hermes-provider', 'hermes-model', 'hermes-effort']) {
      assert.ok(container.querySelector(`#hermes-panel #${id}`), `${id} is rendered into the panel`);
    }
  });
});

describe('what the section does with it', () => {
  test('visibility follows applicability alone, so loading and errors still show', async () => {
    await setHermes(withUsage({ applicable: false }));
    const { container, rerender } = rail();
    assert.equal(container.querySelector<HTMLElement>('#hermes-limits-section')!.hidden, true);

    await setHermes(withUsage({ applicable: true, loading: true }));
    rerender(
      <Provider store={store}>
        <aside id="rail">
          <HermesSection />
          <HermesLimitsSection />
        </aside>
      </Provider>
    );
    const section = container.querySelector<HTMLElement>('#hermes-limits-section')!;
    assert.equal(section.hidden, false);
    assert.match(section.textContent ?? '', /Asking the provider/);

    await setHermes(
      withUsage({
        applicable: true,
        loaded: true,
        answer: {
          usage: null,
          error: 'The usage endpoint could not be reached.',
          code: 'usage_unreachable',
          fetchedAt: null,
        },
      })
    );
    assert.match(container.querySelector('#hermes-limits')!.textContent ?? '', /could not be reached/);
    assert.ok(container.querySelector('#hermes-limits .hermes__retry'), 'an error is worth a retry');
  });

  test('the rows say what is left and for how long, on one line, and that is all', async () => {
    store.set(
      hermesAtom,
      withUsage({
        applicable: true,
        loaded: true,
        answer: {
          usage: {
            provider: 'openai-codex',
            supported: true,
            plan: 'Pro',
            windows: [
              { label: 'Session', usedPercent: 3, remainingPercent: 97, resetAt: null, detail: null },
              { label: 'Weekly', usedPercent: 45, remainingPercent: 55, resetAt: null, detail: null },
            ],
            details: [],
            bankedResets: null,
            unavailableReason: null,
          },
          fetchedAt: '2026-09-05T12:00:00Z',
          error: null,
          code: null,
        },
      })
    );
    const { container } = rail();
    const line = container.querySelector('#hermes-limits .hermes__limits-line')!;
    assert.ok(line, 'both windows share one line');
    assert.equal(line.querySelectorAll('.hermes__limit-sep').length, 1, 'split by a slash');
    assert.deepEqual(
      [...line.querySelectorAll('.hermes__limit-value')].map((n) => n.textContent),
      ['97%', '55%']
    );
    assert.match(css, /\.hermes__limits-line\s*\{[^}]*white-space:\s*nowrap/s);
    assert.equal(container.querySelector('progress, .hermes__meter, .hermes__limit-bar'), null, 'no meters');
    assert.doesNotMatch(
      container.textContent ?? '',
      /Checked|% used|Reset /,
      'no age, no spent half, no absolute date'
    );
  });
});

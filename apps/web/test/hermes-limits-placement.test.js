/**
 * Where the account limits are drawn.
 *
 * They used to be the last thing inside `#hermes-panel`, which is folded by
 * default — so the one part of that section that changes on its own was the
 * only part nobody saw. These tests pin the fix: the limits are a rail section
 * of their own, directly under the Hermes one, shown whenever the profile's
 * provider has limits at all and hidden when it does not.
 *
 * Read off the source rather than a rendered page because `app.js` boots on
 * import; the placement is a fact about the markup and the one mount call, and
 * both are checkable as text.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

describe('the limits block has a rail section of its own', () => {
  test('the section sits after the Hermes section, not inside its panel', () => {
    const panel = html.indexOf('id="hermes-panel"');
    const hermesEnd = html.indexOf('</section>', panel);
    const limits = html.indexOf('id="hermes-limits-section"');

    assert.ok(panel > -1 && limits > -1, 'both sections exist');
    assert.ok(limits > hermesEnd, 'the limits section is outside the collapsible Hermes panel');
  });

  test('it says what it is, rather than "Account limits"', () => {
    const heading = html.slice(
      html.indexOf('id="hermes-limits-heading"'),
      html.indexOf('</h2>', html.indexOf('id="hermes-limits-heading"'))
    );
    assert.match(heading, /<span class="rail__heading-text">OpenAI limits<\/span>/);
  });

  test('the plan and the refresh control share the heading row', () => {
    // The head is a mount point inside the <h2>, not a second block under it:
    // one row, so the control sits beside the words it belongs to.
    const at = html.indexOf('id="hermes-limits-heading"');
    const heading = html.slice(html.lastIndexOf('<h2', at), html.indexOf('</h2>', at));
    assert.ok(heading.includes('id="hermes-limits-head"'), 'the head mounts inside the heading');
    assert.match(heading, /class="[^"]*rail__heading--row/, 'the heading is laid out as a row');
    assert.ok(
      heading.indexOf('rail__heading-text') < heading.indexOf('id="hermes-limits-head"'),
      'the words come first, the control after'
    );
  });

  test('nothing folds it — it has a heading, not a toggle button', () => {
    const section = html.slice(
      html.indexOf('id="hermes-limits-section"'),
      html.indexOf('</section>', html.indexOf('id="hermes-limits-section"'))
    );
    assert.ok(!section.includes('<button'), 'no collapse control');
    assert.ok(section.includes('id="hermes-limits"'), 'it holds the block the renderer fills');
  });

  test('the settings that do fold are still in the Hermes panel', () => {
    for (const id of ['hermes-provider', 'hermes-model', 'hermes-effort']) {
      assert.ok(app.includes(`'${id}'`), `${id} is still rendered into the panel`);
    }
    assert.ok(html.includes('id="toggle-hermes"'), 'the Hermes section still collapses');
  });
});

describe('what the renderer does with it', () => {
  test('the usage renderer is mounted into the limits section, and nowhere else', () => {
    const calls = app.match(/hermesUsage\(/g) ?? [];
    // One definition, one call.
    assert.equal(calls.length, 2, 'hermesUsage is called exactly once');
    assert.match(app, /clear\(\$\('#hermes-limits'\)\)/);
    assert.match(app, /mount\(panel, hermesUsage\(usage\)\)/);
  });

  test('the head renderer is mounted into the heading row, and nowhere else', () => {
    const calls = app.match(/hermesUsageHead\(/g) ?? [];
    assert.equal(calls.length, 2, 'one definition, one call');
    assert.match(app, /clear\(\$\('#hermes-limits-head'\)\)/);
    assert.match(app, /mount\(head, hermesUsageHead\(usage\)\)/);
  });

  test('visibility follows applicability alone, so loading and errors still show', () => {
    assert.match(app, /section\.hidden = !usage\?\.applicable/);
  });

  test('the profile is read at boot, so applicability is known without unfolding', () => {
    assert.match(app, /if \(!state\.hermes\.loaded && !state\.hermes\.loading\) void hermes\.load\(\)/);
  });
});

/**
 * The block is rows of text now, not a dashboard.
 *
 * The meters and the "Checked 3m ago" line were the previous shape: they took
 * a rail's whole width to say a number twice, and the age was noise on a value
 * the user did not ask to be told the provenance of. Asserted off the source
 * because these are absences, and an absence has no node to query.
 */
describe('what the limits renderer does not draw any more', () => {
  const renderer = app.slice(
    app.indexOf('function renderHermesLimits'),
    app.indexOf('const hermesLabel')
  );

  test('the slice under test is the real one', () => {
    assert.ok(renderer.includes('function hermesUsage(usage)'), 'the renderer is in the slice');
    assert.ok(renderer.includes('function hermesUsageHead(usage)'), 'the head is in the slice');
  });

  test('no meters, no progress elements', () => {
    assert.ok(!/hermes__meter/.test(renderer), 'the meter class is gone');
    assert.ok(!/<progress|'progress'|"progress"/.test(renderer), 'no progress element is built');
    assert.ok(!/row\.fill|\.fill\b/.test(renderer), 'nothing reads the fill percentage a meter needed');
    assert.ok(!/hermes__limit-bar|--pct/.test(renderer), 'no bar, and no percentage handed to CSS');
  });

  test('both windows share one non-wrapping line with a slash', () => {
    assert.match(renderer, /hermes__limits-line/);
    assert.match(renderer, /hermes__limit-sep/);
    assert.match(
      readFileSync(new URL('../styles.css', import.meta.url), 'utf8'),
      /\.hermes__limits-line\s*\{[^}]*white-space:\s*nowrap/si
    );
  });

  test('nothing tells the reader how old the number is', () => {
    assert.ok(!/usageAge/.test(renderer), 'the age helper is not called');
    assert.ok(!/Checked/.test(renderer), 'no "Checked …" line');
  });

  test('the rows say what is left and for how long, and that is all', () => {
    assert.ok(renderer.includes('usageLimitRows('), 'the rows come from the shared helper');
    assert.ok(renderer.includes('usageLimitText(row)'), 'the sentence comes from the shared helper');
    assert.ok(!/% used/.test(renderer), 'the spent half is not what the row says any more');
  });

  test('no absolute date anywhere in the row', () => {
    assert.ok(!/resetStamp/.test(renderer), 'the calendar stamp is not called');
    assert.ok(!/hermes__limit-reset/.test(renderer), 'and its span is gone with it');
    assert.ok(!/Reset'/.test(renderer), 'no "Reset <date>" clause');
  });
});

describe('the one control in the heading row', () => {
  const head = app.slice(app.indexOf('function hermesUsageHead'), app.indexOf('function hermesUsage(usage)'));

  test('it is an icon, not a word', () => {
    assert.ok(head.includes('html: REFRESH_ICON'), 'the button is filled with the icon');
    assert.ok(!/'Refresh usage'\s*\)/.test(head), 'the label is not the button text');
    assert.match(app, /const REFRESH_ICON =\s*\n?\s*'<svg/, 'the icon is inline SVG');
    assert.match(app, /aria-hidden="true"/, 'the glyph itself is hidden from the reader');
  });

  test('so it has to say what it is some other way', () => {
    assert.ok(head.includes("'aria-label': label"), 'an accessible name');
    assert.ok(head.includes('title: `${label}.'), 'and a hover title built from the same words');
    assert.match(head, /Refreshes are limited/, 'the title also explains the throttle');
  });

  test('the label follows the request rather than staying on one word', () => {
    assert.match(head, /usage\.loading \? 'Checking usage…' : 'Refresh usage'/);
    assert.ok(head.includes('disabled: usage.loading'), 'and a request in flight cannot be asked twice');
  });

  test('the plan is the only other thing in the row', () => {
    assert.ok(head.includes("class: 'hermes__usage-plan'"));
    assert.ok(!/hermes__usage-title/.test(head), 'the heading already says what the block is');
  });
});

/**
 * The Hermes panel in the rail, and the account limits under it.
 *
 * Three selects and a save button, for one setting: the provider and model a
 * Hermes profile hands out by default. That is a *global* — `model.provider`
 * and `model.default` in the profile's own `config.yaml` — and the panel says
 * so, because the rail used to hold the other kind of model setting entirely
 * and the two are easy to confuse.
 *
 * Draft and saved are kept apart: nothing is written until the button is
 * pressed, so backing out is closing the panel, and a provider change that
 * leaves no valid model to pair with disables the save rather than guessing.
 */

import { useAtomValue } from 'jotai';
import type { ChangeEvent, ReactNode } from 'react';

import { hermesAtom } from '../atoms.ts';
import { trimModelName } from '../lib/format.ts';
import {
  bankedResetLine,
  hermesEfforts,
  hermesModels,
  usageDetailLines,
  usageLimitRows,
  usageLimitText,
  usageStatus,
  withConfigured,
} from '../lib/hermes-panel.ts';
import type { HermesUsageState } from '../lib/hermes-store.ts';
import { hermes } from '../store.ts';

/** A label that admits when a value is only here because the config names it. */
const label = (entry: { label: string; unlisted?: boolean }) =>
  entry.unlisted ? `${entry.label} (not in catalog)` : entry.label;

function Row({
  title,
  id,
  options,
  value,
  onChange,
  help = null,
  disabled = false,
}: {
  title: string;
  id: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  help?: string | null;
  disabled?: boolean;
}) {
  // Left blank rather than snapped to the first entry when the value is not
  // among them — a select that silently reads as something else is how the
  // wrong thing gets saved.
  const known = options.some((option) => option.value === value);
  return (
    <label className="hermes__field">
      <span className="hermes__label">{title}</span>
      <select
        id={id}
        className="hermes__select"
        value={known ? value : ''}
        onChange={onChange}
        disabled={options.length === 0 || disabled}
      >
        {!known ? <option value="" hidden /> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {help ? <span className="hermes__help">{help}</span> : null}
    </label>
  );
}

/**
 * A read that failed, and the one thing worth offering: ask again.
 *
 * Reading is the only thing it does — nothing about a profile is written by a
 * retry — so a Hermes that was busy, restarting, or briefly unreadable stops
 * being a panel someone has to close and reopen to get out of.
 */
function Problem({ text, busy }: { text: string; busy: boolean }) {
  return (
    <div className="hermes__note is-warn">
      <span>{text}</span>
      <button
        className="hermes__retry"
        disabled={busy}
        title="Read this profile again"
        onClick={() => void hermes.retry()}
      >
        {busy ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  );
}

/** The folded half: the settings, and only the settings. */
export function HermesPanel() {
  const h = useAtomValue(hermesAtom) ?? hermes.state;
  // A read or a write is out: the selects are answers about a profile that is
  // still being settled, so they are not something to move meanwhile.
  const busy = h.loading || h.saving;

  if (h.loading && !h.loaded) return <div className="hermes__note">Asking Hermes…</div>;

  const providers = withConfigured(h.providers, h.saved);
  const models = hermesModels(providers, h.draft.provider);

  return (
    <>
      {/* Which profile is being edited, and — said plainly, because it is the
          one thing about this panel that surprises people — what that does
          and does not reach. */}
      <Row
        title="Profile"
        id="hermes-profile"
        options={h.profiles.map((p) => ({
          value: p.name,
          label: p.isDefault ? `${p.name} (HERMES_HOME)` : p.name,
        }))}
        value={h.profile ?? ''}
        onChange={(event) => void hermes.selectProfile(event.target.value)}
        disabled={busy}
      />
      {h.error ? (
        <Problem text={h.error} busy={busy} />
      ) : (
        <>
          <Row
            title="Provider"
            id="hermes-provider"
            options={providers.map((p) => ({ value: p.value, label: label(p) }))}
            value={h.draft.provider}
            onChange={(event) => hermes.setDraft({ provider: event.target.value, model: h.draft.model })}
            disabled={busy}
          />
          <Row
            title="Model"
            id="hermes-model"
            options={models.map((m) => ({ value: m.value, label: label(m) }))}
            value={h.draft.model}
            onChange={(event) => hermes.setDraft({ provider: h.draft.provider, model: event.target.value })}
            help={models.length === 0 ? 'This provider reports no models.' : null}
            disabled={busy}
          />
          <Row
            title="Reasoning effort"
            id="hermes-effort"
            options={hermesEfforts(h.efforts, h.draftEffort).map((e) => ({
              value: e.value,
              label: label(e),
            }))}
            value={h.draftEffort}
            onChange={(event) => hermes.setEffort(event.target.value)}
            help="How hard this profile thinks by default. Leave it on “Hermes default” for no opinion."
            disabled={busy}
          />
          {h.catalogError ? (
            <div className="hermes__note is-warn">
              Catalog unavailable — only what is configured is listed.
            </div>
          ) : null}
        </>
      )}

      {/* What the profile is on right now, straight from its config, so the
          rail answers the question without anyone opening a menu. It stays
          put through a failed re-read: the last thing Hermes said is still
          the last thing it said. */}
      <div className="hermes__current" title="The profile default, as its config.yaml reads now">
        {h.saved.model ? (
          <>
            <span className="hermes__model">{trimModelName(h.saved.model)}</span>
            {h.saved.provider ? <span className="hermes__prov">{h.saved.provider}</span> : null}
          </>
        ) : (
          // "Could not be read" and "is not set" look identical from here and
          // are not the same fact, so the panel says which one it is.
          <span className="hermes__prov">
            {h.error ? 'default unknown — Hermes could not be read' : 'no default set'}
          </span>
        )}
      </div>
      <div className="hermes__acts">
        <button className="hermes__save" disabled={!hermes.canSave()} onClick={() => void hermes.save()}>
          {h.saving ? 'Saving…' : 'Save default'}
        </button>
        {hermes.dirty() && !busy ? (
          <button className="hermes__undo" onClick={() => hermes.revert()}>
            Cancel
          </button>
        ) : null}
      </div>
      <div className="hermes__scope">
        Profile-wide default for new Hermes conversations. It does not change a chat that already has its own
        model (<code>/model</code>), and a running gateway keeps its model until it is restarted.
      </div>
      {h.note ? <div className={`hermes__note is-${h.note.kind}`}>{h.note.text}</div> : null}
    </>
  );
}

/** An icon rather than a word, because the heading row has no room for one. */
const RefreshIcon = () => (
  <svg
    viewBox="0 0 16 16"
    width="12"
    height="12"
    aria-hidden="true"
    focusable="false"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
    <path d="M13.5 2v3.2h-3.2" />
  </svg>
);

/**
 * The plan and the one control, drawn into the section's own heading row.
 *
 * The heading already says what the block is, so the head carries no title of
 * its own: just which plan the account is on and the button that costs a
 * request.
 */
export function HermesUsageHead({ usage }: { usage: HermesUsageState }) {
  if (!usage.applicable) return null;
  const plan = usage.answer?.usage?.plan ?? null;
  const text = usage.loading ? 'Checking usage…' : 'Refresh usage';
  return (
    <>
      {plan ? <span className="hermes__usage-plan">{plan}</span> : null}
      <button
        className="hermes__usage-refresh"
        disabled={usage.loading}
        aria-label={text}
        // Said out loud, because a button that looks like it did nothing is
        // worse than one that says why: the daemon floors how often a refresh
        // reaches the provider.
        title={`${text}. Refreshes are limited to one every few seconds.`}
        onClick={() => void hermes.refreshUsage()}
      >
        <RefreshIcon />
      </button>
    </>
  );
}

/**
 * What this profile's account has left, when its provider reports such a thing.
 *
 * One row per window and nothing else: how much is left and how long it lasts.
 * Absent entirely for a provider with no limits API — an empty block would
 * read as a failure to fetch something that was never there.
 */
export function HermesUsage({ usage }: { usage: HermesUsageState }) {
  if (!usage.applicable) return null;
  const answer = usage.answer;
  const status = usageStatus(answer);
  const rows = usageLimitRows(answer?.usage);
  const banked = bankedResetLine(answer?.usage?.bankedResets ?? null);

  if (usage.loading && !usage.loaded) {
    return (
      <div className="hermes__usage">
        <div className="hermes__note">Asking the provider…</div>
      </div>
    );
  }

  let line: ReactNode;
  if (status.kind === 'ok') {
    // Both windows on one line, split by a visible slash: they are read as a
    // pair — "how much is left now" against "how much is left this week" —
    // and stacking them made the rail scroll for two short sentences.
    line = (
      <div className="hermes__limits-line">
        {rows.map((row, i) => (
          <span key={row.key} style={{ display: 'contents' }}>
            {i ? (
              <span className="hermes__limit-sep" aria-hidden="true">
                /
              </span>
            ) : null}
            <div className="hermes__limit">
              <span className="hermes__limit-label">{`${row.label}:`}</span>
              <span className="hermes__limit-value">{usageLimitText(row)}</span>
            </div>
          </span>
        ))}
      </div>
    );
  } else {
    // Not a meter, and not silence: "not signed in", "this provider has no
    // limits API" and "it did not answer" are three different situations
    // and only one of them is worth a retry.
    line = (
      <div className={`hermes__note ${status.kind === 'unsupported' ? '' : 'is-warn'}`.trim()}>
        <span>{status.text}</span>
        {status.retryable ? (
          <button
            className="hermes__retry"
            disabled={usage.loading}
            onClick={() => void hermes.refreshUsage()}
          >
            {usage.loading ? 'Checking…' : 'Try again'}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="hermes__usage">
      {line}
      {banked ? <div className="hermes__usage-banked">{banked}</div> : null}
      {/* Whatever else Hermes had to say — a credits balance, say. Passed
          through rather than parsed: it is the provider's sentence and the
          panel is not the place to second-guess it. Its own two phrasings of
          the banked resets are the one exception, because the line above
          already says that. */}
      {usageDetailLines(answer?.usage?.details).map((detail, i) => (
        <div key={i} className="hermes__usage-detail">
          {detail}
        </div>
      ))}
      {answer?.note ? <div className="hermes__note is-warn">{answer.note}</div> : null}
    </div>
  );
}

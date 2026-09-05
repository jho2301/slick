/**
 * Choosing a provider and a model for a Hermes profile.
 *
 * Two fields that are really one decision. A provider serves the models it
 * serves, so the model list is a function of the provider, and the two are
 * saved together — `model.provider` and `model.default` in the profile's
 * `config.yaml`. Everything here is that rule written down: given a catalog
 * and a pair, what pair should actually be showing.
 *
 * No DOM, no fetch. The panel in `app.js` draws what these functions decide,
 * which is what lets the awkward cases — a provider whose credentials were
 * revoked, a model retired upstream, a provider with no models at all — be
 * tested as the small facts they are.
 *
 * Nothing here is about a *session*. `_serveModel` on an agent session is one
 * conversation's override and lives in `model-picker.js`, where a model id is
 * a single `provider::model` string. Here the two halves are separate fields
 * all the way down, because that is how Hermes stores them.
 */

const asText = (value) => (typeof value === 'string' ? value.trim() : '');

const listOf = (value) => (Array.isArray(value) ? value : []);

/** The models a provider serves, or nothing at all. */
function modelsOf(providers, provider) {
  return listOf(listOf(providers).find((entry) => entry.value === provider)?.models);
}

/**
 * The catalog, with whatever the profile is actually set to guaranteed to be
 * in it.
 *
 * A configured value missing from the catalog is not a bad value — it is a
 * value the catalog cannot currently see. Credentials get pulled, a provider
 * plugin gets uninstalled, a model is retired upstream, someone edits the file
 * by hand. Dropping it would leave the panel showing some other provider as
 * "current", and the next save would overwrite a working setting on behalf of
 * somebody who believed they had changed nothing.
 *
 * So it is added instead, flagged `unlisted` so the panel can say where it
 * came from, and appended rather than inserted so the catalog's own order —
 * Hermes' order — is untouched.
 */
export function withConfigured(providers, { provider, model } = {}) {
  const wantedProvider = asText(provider);
  const wantedModel = asText(model);
  if (!wantedProvider) return listOf(providers);

  const entries = listOf(providers);
  const found = entries.find((entry) => entry.value === wantedProvider);
  if (!found) {
    return [
      ...entries,
      {
        value: wantedProvider,
        label: wantedProvider,
        custom: wantedProvider === 'custom' || wantedProvider.startsWith('custom:'),
        unlisted: true,
        models: wantedModel ? [{ value: wantedModel, label: wantedModel, unlisted: true }] : [],
      },
    ];
  }
  if (!wantedModel || listOf(found.models).some((entry) => entry.value === wantedModel)) return entries;
  return entries.map((entry) =>
    entry === found
      ? { ...entry, models: [...listOf(entry.models), { value: wantedModel, label: wantedModel, unlisted: true }] }
      : entry
  );
}

/**
 * The pair that should be showing, given the pair someone has asked for.
 *
 * Called for the first paint and again on every provider change, which is the
 * point: the same rule decides both, so a provider change can never leave a
 * model behind that its new provider does not serve. That pairing — a provider
 * chosen, a model left over from the last one — is a configuration Hermes will
 * accept and then fail on, at the next message rather than at the save.
 *
 * A provider that serves nothing gets an empty model rather than a borrowed
 * one, so the panel has something honest to disable its save button on.
 *
 * @param {Array} providers  the catalog, ideally through `withConfigured`
 * @param {{provider: string|null, model: string|null}} wanted
 * @returns {{provider: string, model: string}}
 */
export function hermesSelection(providers, { provider, model } = {}) {
  const entries = listOf(providers);
  const wantedProvider = asText(provider);
  const wantedModel = asText(model);

  // Nothing to choose from: repeat what the profile says. An empty catalog is
  // a Hermes that could not be asked, not a Hermes with no models.
  if (entries.length === 0) return { provider: wantedProvider, model: wantedModel };

  const chosen = entries.find((entry) => entry.value === wantedProvider) ?? entries[0];
  const models = listOf(chosen.models);
  const keep = models.some((entry) => entry.value === wantedModel);
  return {
    provider: chosen.value,
    model: keep ? wantedModel : (models[0]?.value ?? ''),
  };
}

/** The models to draw under a provider, once `hermesSelection` has settled it. */
export function hermesModels(providers, provider) {
  return modelsOf(providers, asText(provider));
}

/**
 * Is this the pair the profile is already on?
 *
 * `null` and `''` are the same absence: the wire says `null` for a key that is
 * not in the config, and a `<select>` says `''` for the same thing.
 */
export function sameSelection(a, b) {
  return asText(a?.provider) === asText(b?.provider) && asText(a?.model) === asText(b?.model);
}

/**
 * The options for the profile-global reasoning effort select.
 *
 * `agent.reasoning_effort` is a third field on the same setting as provider and
 * model, but it is optional in a way they are not: a provider always serves
 * *some* model, but a profile can perfectly well have no opinion on how hard it
 * thinks, so the first option is always "leave it to Hermes" rather than a
 * level.
 *
 * The catalog is Hermes' own `VALID_REASONING_EFFORTS` (plus "none", the word
 * `agent.reasoning_effort: false` round-trips as) and is trusted as-is, the
 * same way `withConfigured` trusts the provider catalog: a level the file
 * already holds that the catalog does not know about is still offered, flagged
 * `unlisted`, so a save never silently overwrites it.
 *
 * @param {Array<{value: string, label: string}>} efforts  Hermes' own vocabulary
 * @param {string|null} configured  what the profile's config actually says
 */
export function hermesEfforts(efforts, configured) {
  const options = [{ value: '', label: 'Hermes default' }, ...listOf(efforts).map((e) => ({ value: e.value, label: e.label }))];
  const wanted = asText(configured);
  if (wanted && !listOf(efforts).some((e) => e.value === wanted)) {
    options.push({ value: wanted, label: wanted, unlisted: true });
  }
  return options;
}

/**
 * Is this the level the profile is already set to?
 *
 * The same absence rule as `sameSelection`: an unset level is `null` on the
 * wire and `''` in a `<select>`, and neither is "something to save".
 */
export function sameEffort(a, b) {
  return asText(a) === asText(b);
}

// ----------------------------------------------------------- account limits ---

/**
 * The providers that have account limits worth asking about.
 *
 * The daemon is the one that decides — its answer carries `supported` — but the
 * panel needs to know *before* it asks whether asking is worth a request at
 * all, because the ask spawns an interpreter and reaches the network. Kept to
 * exactly the providers `agent.account_usage` answers for on the Codex path.
 */
const USAGE_PROVIDERS = new Set(['openai-codex']);

/** Would this profile's provider have limits to show? */
export function hasAccountLimits(provider) {
  return USAGE_PROVIDERS.has(asText(provider));
}

/**
 * Is a finished agent answer worth re-asking the account for?
 *
 * Only an agent's completed message moves the numbers: a human line costs the
 * account nothing, and a stream delta is not a message at all — it is the same
 * answer arriving in pieces, and asking once per piece would be a request per
 * token. Gated on the provider too, because for anything but the Codex path
 * there is no account to ask.
 */
export function shouldRefreshUsageAfter(message, provider) {
  return message?.author?.kind === 'agent' && hasAccountLimits(provider);
}

/** A number rounded for display, or null — never `NaN` reaching a template. */
const pct = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;

/**
 * One rate-limit window as the row the rail draws.
 *
 * `remaining` is preferred over `used` for the headline because that is the
 * question being asked — "how much have I got left" — and it is computed from
 * `usedPercent` when the daemon did not send it, so a payload missing one half
 * still draws a meter rather than a blank.
 */
function usageRow(window) {
  const used = pct(window?.usedPercent);
  const remaining = pct(window?.remainingPercent) ?? (used === null ? null : 100 - used);
  return {
    label: asText(window?.label) || 'Limit',
    used,
    remaining,
    // What the meter fills. An unknown window is an empty bar, not a full one:
    // "no answer" must never read as "nothing left".
    fill: used ?? 0,
    known: used !== null || remaining !== null,
    resetAt: asText(window?.resetAt) || null,
    detail: asText(window?.detail) || null,
  };
}

/**
 * The windows to draw, in the order Hermes reported them.
 *
 * Codex sends `primary_window` as "Session" and `secondary_window` as
 * "Weekly"; the labels are Hermes' and are not translated here, so a window it
 * starts reporting tomorrow shows up without this file being touched.
 */
export function usageWindows(usage) {
  return listOf(usage?.windows).map(usageRow);
}

/**
 * The two rows the rail draws, always both, in this order.
 *
 * The rail shows a fixed pair — the rolling five-hour window and the weekly
 * one — rather than whatever list arrived, because these two are the ones the
 * account is actually spent against and a row that appears and disappears is a
 * layout that moves under a glance. Matched on Hermes' own labels ("Session",
 * "Weekly"); a window it stops sending leaves its row unknown rather than
 * missing.
 */
const LIMIT_ROWS = [
  { key: 'session', label: '5hour', matches: (name) => /session|5[\s-]?h|primary/.test(name) },
  { key: 'weekly', label: 'weekly', matches: (name) => /week|secondary/.test(name) },
];

export function usageLimitRows(usage) {
  const windows = usageWindows(usage);
  return LIMIT_ROWS.map(({ key, label, matches }) => {
    const found = windows.find((window) => matches(window.label.toLowerCase()));
    return {
      key,
      // The rail's own wording. "Session" is what Codex calls the five-hour
      // window, and it reads like "this conversation" to everyone else.
      label,
      used: found?.used ?? null,
      // What is left, which is what the row says. Derived from `used` when the
      // provider only reported the spent half; null stays null, because "not
      // reported" must not arrive at the row as "100% left".
      remaining: found?.remaining ?? null,
      known: found?.known ?? false,
      resetAt: found?.resetAt ?? null,
    };
  });
}

/**
 * When a window comes back, as a date and a time.
 *
 * The rail says the clock rather than the countdown: a row that reads "in 3h
 * 40m" is only true at the instant it was drawn, and this block sits on screen
 * between refreshes. `null` when there is no reset to show.
 *
 * @param {string|null} iso
 */
const RESET_STAMP = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function resetStamp(iso) {
  const at = Date.parse(asText(iso));
  return Number.isFinite(at) ? RESET_STAMP.format(new Date(at)) : null;
}

/**
 * When a window comes back, phrased for a rail.
 *
 * Relative, because "in 3h 40m" is the thing being asked and an absolute
 * timestamp is what the tooltip is for. `null` when there is no reset to show,
 * so the caller omits the clause rather than printing "unknown".
 *
 * @param {string|null} iso
 * @param {number} now  epoch ms, passed in so this is testable without a clock
 */
export function resetPhrase(iso, now = Date.now()) {
  const at = Date.parse(asText(iso));
  if (!Number.isFinite(at)) return null;
  const seconds = Math.round((at - now) / 1000);
  if (seconds <= 0) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * How long a window has left, as the clause the row prints inside "(…)".
 *
 * The same shape as {@link resetPhrase} without its "in", plus two things the
 * row needs: under an hour it says minutes alone, because "0h 12m" reads as a
 * rounding artefact rather than twelve minutes; and a whole number of days
 * drops the trailing "0h" for the same reason. `null` when there is no reset
 * to show, so the caller omits the clause rather than printing "unknown".
 *
 * @param {string|null} iso
 * @param {number} now  epoch ms, passed in so this is testable without a clock
 */
export function resetWithin(iso, now = Date.now()) {
  const at = Date.parse(asText(iso));
  if (!Number.isFinite(at)) return null;
  const seconds = Math.round((at - now) / 1000);
  if (seconds <= 0) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * One limits row, as the single line the rail draws.
 *
 * "97%" rather than "3% used": the question the rail answers is how much
 * room is left before the next reset, and the reset is right there in the same
 * sentence. A row the provider said nothing about says so.
 *
 * @param {{label: string, remaining: number|null, known: boolean, resetAt: string|null}} row
 * @param {number} now  epoch ms
 */
export function usageLimitText(row, now = Date.now()) {
  if (!row?.known || typeof row.remaining !== 'number') return 'unknown';
  const within = resetWithin(row.resetAt, now);
  return within ? `${row.remaining}% (~${within})` : `${row.remaining}%`;
}

/**
 * What the usage block should actually say, given one answer from the daemon.
 *
 * The whole point of this function is that "no numbers" has several different
 * causes and they are not interchangeable:
 *
 *   - `unsupported` — this profile is on a provider with no limits API. Not a
 *     failure; there is nothing to fetch and no retry to offer.
 *   - `signed-out` — the account exists but this profile cannot prove it. The
 *     fix is a login, not a retry, so the panel says so.
 *   - `error` — it was asked and it did not answer. A retry is the right offer.
 *   - `empty` — asked, answered, and had nothing to report.
 *   - `ok` — there are windows to draw.
 *
 * @param {{usage: object|null, error: string|null, code: string|null}|null} answer
 */
export function usageStatus(answer) {
  if (!answer) return { kind: 'empty', text: 'No account limits have been read yet.', retryable: true };
  const usage = answer.usage ?? null;
  const code = asText(answer.code);

  if (code === 'not_authenticated') {
    return {
      kind: 'signed-out',
      text: asText(answer.error) || 'This profile is not signed in to a ChatGPT account.',
      retryable: false,
    };
  }
  if (code) {
    return {
      kind: 'error',
      text: asText(answer.error) || 'Hermes could not read this account’s limits.',
      retryable: true,
    };
  }
  if (usage && usage.supported === false) {
    const provider = asText(usage.provider);
    return {
      kind: 'unsupported',
      text: provider
        ? `${provider} does not report account limits.`
        : 'This provider does not report account limits.',
      retryable: false,
    };
  }
  if (usage?.unavailableReason) {
    return { kind: 'empty', text: usage.unavailableReason, retryable: true };
  }
  if (!usage || usageWindows(usage).length === 0) {
    return { kind: 'empty', text: 'Hermes reported no limits for this account.', retryable: true };
  }
  return { kind: 'ok', text: null, retryable: true };
}

/**
 * How old the number on screen is, and whether a refresh actually asked.
 *
 * `throttled` is the daemon saying "you clicked refresh and I gave you what I
 * already had". Saying "just now" over that would be claiming a request that
 * never happened, so it gets its own phrasing.
 *
 * @param {{fetchedAt?: string, cached?: boolean, throttled?: boolean}|null} answer
 * @param {number} now  epoch ms
 */
export function usageAge(answer, now = Date.now()) {
  const at = Date.parse(asText(answer?.fetchedAt));
  if (!Number.isFinite(at)) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  const ago = seconds < 45 ? 'just now' : seconds < 3600 ? `${Math.round(seconds / 60)}m ago` : `${Math.round(seconds / 3600)}h ago`;
  return answer?.throttled ? `${ago} — already up to date` : ago;
}

/**
 * The banked resets, as the one line the card draws.
 *
 * "Reset tickets" rather than a sentence, because the card is a rail block of
 * three short rows and the count is the whole fact: how many spare resets this
 * account is holding. `null` when there is none to say, so the caller omits
 * the row instead of printing a zero nobody asked about.
 *
 * @param {number|null} count
 */
export function bankedResetLine(count) {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return null;
  const whole = Math.floor(count);
  return `${whole} reset ticket${whole === 1 ? '' : 's'}`;
}

/**
 * Hermes' free-text detail lines, minus the ones the banked line already says.
 *
 * Hermes phrases the same fact twice — "2 banked resets on this account" and
 * "you have 2 resets banked - use ... reset to active" — and the card renders
 * the count itself, so passing those through is the same sentence three times.
 * Only banked-reset sentences are dropped: a credit balance is a different
 * fact and stays, because this panel does not otherwise second-guess what the
 * provider chose to say.
 */
const BANKED_DETAIL = /\b(?:banked\s+resets?|resets?\s+banked|reset\s+tickets?)\b/i;

export function usageDetailLines(details) {
  return listOf(details)
    .filter((line) => asText(line) && !BANKED_DETAIL.test(line));
}

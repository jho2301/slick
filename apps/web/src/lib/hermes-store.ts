/**
 * The Hermes panel's state, and the order its requests are allowed to matter
 * in.
 *
 * `hermes-panel.ts` decides what pair should be showing. This decides *when* —
 * which is where the panel's real hazards are, because a profile can be
 * changed while a read or a write for the previous one is still out:
 *
 *   - a read that lands after someone has moved on would overwrite the profile
 *     they are now looking at with another profile's default;
 *   - a write carries a draft, and a draft belongs to the profile it was made
 *     against, so it must never be offered to a profile that was chosen after;
 *   - a "Saved to X" tick has to name the profile that was actually written,
 *     not whatever the select happens to read by the time the answer comes.
 *
 * So every request captures its profile in a local — never re-read from state
 * after an await — and takes a generation token. Choosing a profile, reading,
 * and writing all bump that token; an answer whose token is stale is dropped
 * whole, flags included, so nothing abandoned leaves the panel spinning.
 *
 * No DOM, no fetch and no framework: `onChange` is the only thing this reaches
 * out to, and the app bridges it into an atom.
 */

import {
  hasAccountLimits,
  hermesSelection,
  sameEffort,
  sameSelection,
  withConfigured,
  type Selection,
} from './hermes-panel.ts';
import type {
  EffortChoice,
  HermesProfileSummary,
  HermesProviderEntry,
  ProfileModelAnswer,
  ProfileModelWrite,
  UsageAnswer,
} from './hermes-types.ts';

/** The four calls the store makes; `Api` satisfies it, and a test fakes it. */
export interface HermesApi {
  hermesProfiles(): Promise<HermesProfileSummary[]>;
  hermesProfileModel(name: string): Promise<ProfileModelAnswer>;
  setHermesProfileModel(name: string, wanted: ProfileModelWrite): Promise<ProfileModelAnswer>;
  hermesProfileUsage(name: string, opts?: { refresh?: boolean }): Promise<UsageAnswer>;
}

export interface HermesNote {
  kind: 'ok' | 'warn';
  text: string;
}

/**
 * The account limits behind the configured provider, kept apart from
 * everything else in the state.
 *
 * A separate request with a separate lifetime: the model half comes from a
 * config file and is instant, and this one goes over the network to a
 * provider. Folding the two together would hold the provider select behind
 * an HTTP call to OpenAI, and leave the panel showing "Asking Hermes…"
 * because an account was rate-limited.
 */
export interface HermesUsageState {
  /** Whether this profile's provider has limits worth asking about. */
  applicable: boolean;
  loading: boolean;
  loaded: boolean;
  /**
   * The whole payload from the daemon — `usage`, `error`, `code`, `cached`,
   * `throttled`, `fetchedAt` — because `usageStatus` reads all of them to
   * decide what it is looking at.
   */
  answer: UsageAnswer | null;
}

export interface HermesState {
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  profiles: HermesProfileSummary[];
  profile: string | null;
  providers: HermesProviderEntry[];
  /** What the profile's config.yaml said the last time it was read. */
  saved: Selection;
  /** What the two selects are showing. */
  draft: Selection;
  /** `agent.reasoning_effort`'s own vocabulary, as the bridge reports it. */
  efforts: EffortChoice[];
  /** What the profile's config.yaml said the last time it was read. '' is unset. */
  savedEffort: string;
  /** What the effort select is showing. */
  draftEffort: string;
  /**
   * What the configured model would actually think at — a per-model override
   * can outrank `savedEffort`, so the two are kept apart.
   */
  effectiveEffort: string | null;
  error: string | null;
  catalogError: string | null;
  note: HermesNote | null;
  usage: HermesUsageState;
}

const blank = (): Selection => ({ provider: '', model: '' });

const defaultsOf = (answer: ProfileModelAnswer | null | undefined): Selection => ({
  provider: answer?.defaults?.provider ?? '',
  model: answer?.defaults?.model ?? '',
});

const effortOf = (answer: ProfileModelAnswer | null | undefined): string =>
  typeof answer?.effort === 'string' ? answer.effort : '';

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const freshUsage = (applicable: boolean): HermesUsageState => ({
  applicable,
  loading: false,
  loaded: false,
  answer: null,
});

export interface HermesStore {
  readonly state: HermesState;
  load(requested?: string | null): Promise<void>;
  retry(): Promise<void>;
  selectProfile(name: string): Promise<void> | undefined;
  setDraft(wanted: { provider?: string | null; model?: string | null }): void;
  setEffort(level: unknown): void;
  revert(): void;
  save(): Promise<void>;
  loadUsage(opts?: { refresh?: boolean }): Promise<void>;
  refreshUsage(): Promise<void>;
  isBusy(): boolean;
  canSave(): boolean;
  dirty(): boolean;
}

export function createHermesStore({
  api,
  onChange = () => {},
}: {
  api: HermesApi;
  onChange?: (state: HermesState) => void;
}): HermesStore {
  const state: HermesState = {
    loaded: false,
    loading: false,
    saving: false,
    profiles: [],
    profile: null,
    providers: [],
    saved: blank(),
    draft: blank(),
    efforts: [],
    savedEffort: '',
    draftEffort: '',
    effectiveEffort: null,
    error: null,
    catalogError: null,
    note: null,
    usage: freshUsage(false),
  };

  /** Bumped by anything that makes an outstanding request irrelevant. */
  let generation = 0;

  /**
   * The same idea as `generation`, for usage alone.
   *
   * Separate because the two requests do not invalidate each other: a save
   * bumps `generation` and must not throw away account limits that are still
   * perfectly true, and a refresh must not cancel a profile read.
   */
  let usageGeneration = 0;

  const emit = () => onChange(state);

  const isBusy = () => state.loading || state.saving;

  const dirty = () =>
    !sameSelection(state.saved, state.draft) || !sameEffort(state.savedEffort, state.draftEffort);

  const canSave = () =>
    !isBusy() &&
    !state.error &&
    Boolean(state.profile) &&
    Boolean(state.draft.provider && state.draft.model) &&
    dirty();

  /**
   * Start a read. A read of a *different* profile also throws away everything
   * on screen: a draft made against the old profile is not a proposal about
   * the new one, and leaving it there is how it gets saved to the wrong file.
   */
  function begin(profile: string | null): number {
    const token = ++generation;
    // Whatever was in flight now answers a question nobody is asking.
    state.saving = false;
    state.loading = true;
    state.note = null;
    if (profile && profile !== state.profile) {
      state.profile = profile;
      state.providers = [];
      state.saved = blank();
      state.draft = blank();
      state.efforts = [];
      state.savedEffort = '';
      state.draftEffort = '';
      state.effectiveEffort = null;
      state.error = null;
      state.catalogError = null;
      // Another account entirely. Leaving the old numbers up while the new
      // profile loads would put one account's remaining quota under another
      // account's name, which is the one mistake this panel must not make.
      usageGeneration += 1;
      state.usage = freshUsage(false);
    }
    emit();
    return token;
  }

  /**
   * Read one profile. Reading is not activating: nothing is switched by
   * looking, and nothing here writes.
   *
   * @param requested  a profile to move to, or null to re-read whichever one
   *                   is showing
   */
  async function load(requested: string | null = null): Promise<void> {
    const token = begin(requested);
    // The profile this request is about, fixed for its whole lifetime.
    let target = requested ?? state.profile;
    try {
      if (state.profiles.length === 0) {
        const profiles = await api.hermesProfiles();
        if (token !== generation) return;
        state.profiles = profiles;
      }
      target = target ?? state.profiles[0]?.name ?? null;
      if (!target) throw new Error('This installation has no Hermes profile to edit.');
      state.profile = target;
      // The profile list comes back in milliseconds; reading one spawns an
      // interpreter and takes seconds. Say which profile is being read while
      // it is being read, rather than holding the whole panel back for it.
      emit();

      const answer = await api.hermesProfileModel(target);
      if (token !== generation) return;
      state.providers = answer.providers ?? [];
      state.catalogError = answer.catalogError ?? null;
      state.error = answer.error ?? null;
      state.saved = defaultsOf(answer);
      state.draft = hermesSelection(withConfigured(state.providers, state.saved), state.saved);
      state.efforts = Array.isArray(answer.efforts) ? answer.efforts : [];
      state.savedEffort = effortOf(answer);
      state.draftEffort = state.savedEffort;
      state.effectiveEffort = typeof answer.effectiveEffort === 'string' ? answer.effectiveEffort : null;
    } catch (err) {
      if (token !== generation) return;
      // A failed re-read still knows what it read last time, and says so
      // rather than blanking the one line that answers "what is it on?".
      // A failed *switch* has nothing true left to show, and `begin` has
      // already cleared it.
      state.error = reason(err);
    } finally {
      if (token === generation) {
        state.loading = false;
        state.loaded = true;
        // Which account the limits would be about is only known once the
        // config has been read, so the ask is chained off the read rather than
        // fired alongside it — and only for a provider that has any.
        state.usage.applicable = hasAccountLimits(state.saved.provider);
        emit();
        if (state.usage.applicable && !state.usage.loaded && !state.error) void loadUsage();
      }
    }
  }

  /**
   * Ask what this account has left.
   *
   * Not part of `load`, and never awaited by it: a provider that is slow, rate
   * limited or signed out must not hold up the panel that says which model the
   * profile is on. The daemon caches for a minute and collapses concurrent
   * asks, so a redraw that calls this is not a request.
   *
   * `refresh` is the human saying they do not believe the cached number.
   */
  async function loadUsage({ refresh = false }: { refresh?: boolean } = {}): Promise<void> {
    const target = state.profile;
    if (!target || !state.usage.applicable) return;
    // One outstanding ask at a time. A second click while the first is out is
    // the same question, and the daemon would only give it the same answer.
    if (state.usage.loading) return;
    const token = ++usageGeneration;
    state.usage.loading = true;
    emit();
    try {
      const answer = await api.hermesProfileUsage(target, { refresh });
      // Two guards, not one. The token catches a profile switched and switched
      // back; `state.profile` catches an answer for an account nobody is
      // looking at any more.
      if (token !== usageGeneration || target !== state.profile) return;
      state.usage.answer = answer;
    } catch (err) {
      if (token !== usageGeneration || target !== state.profile) return;
      // A transport failure is the panel's own, not the account's, so it is
      // shaped like the daemon's answers rather than thrown at the renderer.
      state.usage.answer = { usage: null, error: reason(err), code: 'unreachable', fetchedAt: null };
    } finally {
      if (token === usageGeneration && target === state.profile) {
        state.usage.loading = false;
        state.usage.loaded = true;
        emit();
      }
    }
  }

  /** The Refresh button: ask again, past the daemon's cache. */
  const refreshUsage = () => loadUsage({ refresh: true });

  /** Read the current profile again — the retry behind an error. */
  const retry = () => load(null);

  function selectProfile(name: string): Promise<void> | undefined {
    if (!name || name === state.profile) return undefined;
    return load(name);
  }

  /** Move the draft, keeping the model from going stale under a new provider. */
  function setDraft(wanted: { provider?: string | null; model?: string | null }): void {
    // Not only the disabled select: a draft moved mid-request is a draft that
    // could be written to a profile it was never made against.
    if (isBusy()) return;
    state.draft = hermesSelection(withConfigured(state.providers, state.saved), wanted);
    state.note = null;
    emit();
  }

  /** Move the effort select. Same busy guard as `setDraft`, same reason. */
  function setEffort(level: unknown): void {
    if (isBusy()) return;
    state.draftEffort = typeof level === 'string' ? level : '';
    state.note = null;
    emit();
  }

  /** Put both halves of the draft back to what the profile is actually on. */
  function revert(): void {
    if (isBusy()) return;
    state.draft = { ...state.saved };
    state.draftEffort = state.savedEffort;
    state.note = null;
    emit();
  }

  /** Whether this profile's answer has ever said anything about effort at all. */
  const hasEffort = () =>
    state.efforts.length > 0 || Boolean(state.savedEffort) || Boolean(state.draftEffort);

  /**
   * Write it, then believe only the readback.
   *
   * The response carries the config as it reads *after* the save, so a write
   * refused downstream — a managed key, a read-only file — shows up as the
   * panel refusing to move rather than a green tick over a setting that never
   * landed.
   */
  async function save(): Promise<void> {
    if (!canSave()) return;
    const target = state.profile;
    if (!target) return;
    const wanted: ProfileModelWrite = { ...state.draft };
    // Only a profile that has ever said something about effort gets the field
    // at all — one that hasn't is not being asked to adopt the concept.
    if (hasEffort()) wanted.effort = state.draftEffort;
    const token = ++generation;
    state.saving = true;
    state.note = null;
    emit();
    try {
      const answer = await api.setHermesProfileModel(target, wanted);
      if (token !== generation) return;
      const wasProvider = state.saved.provider;
      state.saved = defaultsOf(answer);
      // A provider change is a change of account. Whatever is on screen was
      // about the old one, so it goes, and the new one is asked about fresh.
      if (state.saved.provider !== wasProvider) {
        usageGeneration += 1;
        state.usage = freshUsage(hasAccountLimits(state.saved.provider));
      }
      state.draft = { ...state.saved };
      state.savedEffort = effortOf(answer);
      state.draftEffort = state.savedEffort;
      state.effectiveEffort = typeof answer.effectiveEffort === 'string' ? answer.effectiveEffort : null;
      const wantedEffort = wanted.effort ?? '';
      if (answer.error) state.note = { kind: 'warn', text: answer.error };
      else if (!sameSelection(state.saved, wanted) || !sameEffort(state.savedEffort, wantedEffort)) {
        state.note = { kind: 'warn', text: 'Hermes saved something other than what was asked for.' };
      } else state.note = { kind: 'ok', text: `Saved to the ${target} profile.` };
    } catch (err) {
      // The draft survives a refusal: it is still what someone asked for.
      if (token !== generation) return;
      state.note = { kind: 'warn', text: reason(err) };
    } finally {
      if (token === generation) {
        state.saving = false;
        emit();
        if (state.usage.applicable && !state.usage.loaded) void loadUsage();
      }
    }
  }

  return {
    state,
    load,
    retry,
    selectProfile,
    setDraft,
    setEffort,
    revert,
    save,
    loadUsage,
    refreshUsage,
    isBusy,
    canSave,
    dirty,
  };
}

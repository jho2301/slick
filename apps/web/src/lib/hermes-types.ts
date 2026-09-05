/**
 * What the daemon's Hermes routes answer with, as the panel reads it.
 *
 * These mirror `packages/server/src/hermes.ts`. They are written down here
 * rather than imported because the server package is a Node program and the
 * browser has no business depending on it, even for types; the two are kept
 * in step by hand, and `hermes-store.test` reads answers in exactly this shape.
 */

export interface HermesProfileSummary {
  name: string;
  isDefault: boolean;
  configured: boolean;
}

export interface HermesModelEntry {
  value: string;
  label: string;
  /** Only here because the profile's config names it; not in the catalog. */
  unlisted?: boolean;
}

export interface HermesProviderEntry {
  value: string;
  label: string;
  custom?: boolean;
  authenticated?: boolean;
  unlisted?: boolean;
  models: HermesModelEntry[];
}

export interface EffortChoice {
  value: string;
  label: string;
}

export interface ProfileDefaults {
  provider: string | null;
  model: string | null;
}

/** `GET /api/hermes/profiles/:name/model`, and what a write reads back. */
export interface ProfileModelAnswer {
  profile?: string;
  defaults?: Partial<ProfileDefaults> | null;
  providers?: HermesProviderEntry[] | null;
  catalogError?: string | null;
  active?: string | null;
  error?: string | null;
  code?: string | null;
  /** What this profile sets; `null` when its config says nothing. */
  effort?: string | null;
  efforts?: EffortChoice[] | null;
  /** What its configured model actually gets, overrides included. */
  effectiveEffort?: string | null;
}

/** `PUT /api/hermes/profiles/:name/model`. `effort` absent says nothing about the level. */
export interface ProfileModelWrite {
  provider: string;
  model: string;
  effort?: string;
}

export interface UsageWindow {
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAt: string | null;
  detail: string | null;
}

export interface AccountUsage {
  provider: string | null;
  supported: boolean;
  available?: boolean;
  title?: string;
  plan: string | null;
  source?: string | null;
  fetchedAt?: string | null;
  windows: UsageWindow[];
  details: string[];
  bankedResets: number | null;
  unavailableReason: string | null;
}

/** `GET /api/hermes/profiles/:name/usage`: the account's answer, or why there is none. */
export interface UsageAnswer {
  usage: AccountUsage | null;
  note?: string | null;
  fetchedAt: string | null;
  error: string | null;
  code: string | null;
  cached?: boolean;
  throttled?: boolean;
  profile?: string;
}

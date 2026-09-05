/**
 * Narrowing helpers for values that arrive untyped: parsed JSON, adapter
 * manifests someone hand-wrote, whatever an agent binary printed.
 */

import type { JsonObject } from './types.ts';

/** A plain object — not null, not an array. */
export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `code` an error carries, if it carries a string one. */
export function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  const { code } = err as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

/** The message of anything that was thrown. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const { message } = err as { message?: unknown };
    if (typeof message === 'string') return message;
  }
  return String(err);
}

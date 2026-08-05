/**
 * Typed errors shared by every layer.
 *
 * `code` is a stable machine-readable string: the CLI prints it, the HTTP
 * server maps it to a status, and agents can branch on it from `--json` output.
 */

export class SlickError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{status?: number, details?: Record<string, unknown>, hint?: string}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'SlickError';
    this.code = opts.code ?? code;
    this.status = opts.status ?? 400;
    this.details = opts.details;
    this.hint = opts.hint;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint ? { hint: this.hint } : {}),
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export class NotFoundError extends SlickError {
  constructor(message, opts = {}) {
    super('not_found', message, { status: 404, ...opts });
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends SlickError {
  constructor(message, opts = {}) {
    super('invalid_request', message, { status: 422, ...opts });
    this.name = 'ValidationError';
  }
}

export class ConflictError extends SlickError {
  constructor(message, opts = {}) {
    super('conflict', message, { status: 409, ...opts });
    this.name = 'ConflictError';
  }
}

/** Wrap unknown throwables so callers always get a `code`. */
export function toSlickError(err) {
  if (err instanceof SlickError) return err;
  const wrapped = new SlickError('internal_error', err?.message ?? String(err), { status: 500 });
  wrapped.cause = err;
  return wrapped;
}

// Operational application error.
// Carries an HTTP status and a machine-readable code that the central
// errorHandler renders as { error: { code, message } }. Use this for all
// expected, client-facing failures (validation, auth, business rules).

/** Optional structured details, e.g. field-level validation issues. */
export type AppErrorDetails = unknown;

/**
 * Error type understood by the central errorHandler.
 * `status` maps to the HTTP status code; `code` is a stable string the
 * frontend can switch on; `message` is safe to surface to clients.
 */
export class AppError extends Error {
  /** HTTP status code to send (e.g. 401, 403, 404, 409, 422). */
  public readonly status: number;
  /** Stable machine-readable error code (e.g. 'EMAIL_TAKEN'). */
  public readonly code: string;
  /** Optional extra context (never contains secrets). */
  public readonly details?: AppErrorDetails;

  constructor(status: number, code: string, message: string, details?: AppErrorDetails) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    // Restore prototype chain for instanceof checks after transpilation.
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

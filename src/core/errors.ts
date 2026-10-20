/**
 * The single error type used across Terminia. Every error carries a stable
 * code (for tests and branching), a user-facing message, and optionally an
 * actionable hint that the terminal and UI show underneath the message.
 */
export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_PATH'
  | 'NOT_FOUND'
  | 'EXISTS'
  | 'NOT_A_DIRECTORY'
  | 'IS_A_DIRECTORY'
  | 'PERMISSION_DENIED'
  | 'UNSUPPORTED'
  | 'UNAVAILABLE'
  | 'AUTH_REQUIRED'
  | 'AUTH_FAILED'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'CONFLICT'
  | 'PROVIDER'
  | 'VALIDATION'
  | 'CONFIG_REQUIRED'
  | 'SECRET_DETECTED'
  | 'TOO_LARGE'
  | 'EXPIRED'
  | 'IO_ERROR'
  | 'INTERNAL';

export interface ErrorOptions {
  hint?: string;
  retryable?: boolean;
  status?: number;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class TerminiaError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly retryable: boolean;
  readonly status?: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: ErrorOptions = {}) {
    super(message);
    this.name = 'TerminiaError';
    this.code = code;
    this.hint = options.hint;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.details = options.details;
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

export function isTerminiaError(value: unknown, code?: ErrorCode): value is TerminiaError {
  return value instanceof TerminiaError && (code === undefined || value.code === code);
}

/** Converts anything thrown into a TerminiaError without losing the original message. */
export function toTerminiaError(error: unknown, fallback: ErrorCode = 'INTERNAL'): TerminiaError {
  if (error instanceof TerminiaError) return error;
  if (isAbortError(error)) return new TerminiaError('CANCELLED', 'Cancelled.');
  if (error instanceof Error) return new TerminiaError(fallback, error.message, { cause: error });
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message: unknown }).message);
    const code = (error as { code?: unknown }).code;
    return new TerminiaError(isErrorCode(code) ? code : fallback, message, { cause: error });
  }
  return new TerminiaError(fallback, String(error));
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError') ||
    (error instanceof TerminiaError && error.code === 'CANCELLED')
  );
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new TerminiaError('CANCELLED', 'Cancelled.');
}

const CODES = new Set<string>([
  'INVALID_ARGUMENT', 'INVALID_PATH', 'NOT_FOUND', 'EXISTS', 'NOT_A_DIRECTORY', 'IS_A_DIRECTORY',
  'PERMISSION_DENIED', 'UNSUPPORTED', 'UNAVAILABLE', 'AUTH_REQUIRED', 'AUTH_FAILED', 'RATE_LIMITED',
  'NETWORK', 'TIMEOUT', 'CANCELLED', 'CONFLICT', 'PROVIDER', 'VALIDATION', 'CONFIG_REQUIRED',
  'SECRET_DETECTED', 'TOO_LARGE', 'EXPIRED', 'IO_ERROR', 'INTERNAL',
]);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && CODES.has(value);
}

/** Resolves after `ms`, or rejects with CANCELLED when the signal aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TerminiaError('CANCELLED', 'Cancelled.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new TerminiaError('CANCELLED', 'Cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

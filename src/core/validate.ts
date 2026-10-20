import { TerminiaError } from './errors';

/**
 * Small runtime validators for data that crosses a trust boundary: provider
 * API responses, remote-host replies, persisted settings and JSON files from
 * projects. Unknown object keys are dropped, so only declared fields reach
 * the rest of the app.
 */

export type Validator<T> = (value: unknown, path: string) => T;

export type Infer<V> = V extends Validator<infer T> ? T : never;

function fail(path: string, expected: string, value: unknown): never {
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  throw new TerminiaError('VALIDATION', `Unexpected data at ${path || 'root'}: expected ${expected}, got ${actual}.`);
}

export const v = {
  string(): Validator<string> {
    return (value, path) => (typeof value === 'string' ? value : fail(path, 'string', value));
  },
  number(): Validator<number> {
    return (value, path) => (typeof value === 'number' && Number.isFinite(value) ? value : fail(path, 'number', value));
  },
  integer(): Validator<number> {
    return (value, path) => (typeof value === 'number' && Number.isInteger(value) ? value : fail(path, 'integer', value));
  },
  boolean(): Validator<boolean> {
    return (value, path) => (typeof value === 'boolean' ? value : fail(path, 'boolean', value));
  },
  literal<T extends string | number | boolean>(...options: T[]): Validator<T> {
    return (value, path) => (options.includes(value as T) ? (value as T) : fail(path, options.map(String).join(' | '), value));
  },
  /** A string that must be one of `options`. A missing value becomes `fallback`; a wrong value is an error. */
  oneOf<T extends string>(options: readonly T[], fallback?: T): Validator<T> {
    return (value, path) => {
      if (typeof value === 'string' && (options as readonly string[]).includes(value)) return value as T;
      if (fallback !== undefined && (value === null || value === undefined)) return fallback;
      return fail(path, options.join(' | '), value);
    };
  },
  /** Like oneOf, but unknown strings also become `fallback` (for protocol fields that may gain new values). */
  oneOfOr<T extends string>(options: readonly T[], fallback: T): Validator<T> {
    return (value, path) => {
      if (typeof value === 'string') return (options as readonly string[]).includes(value) ? (value as T) : fallback;
      if (value === null || value === undefined) return fallback;
      return fail(path, options.join(' | '), value);
    };
  },
  optional<T>(inner: Validator<T>): Validator<T | undefined> {
    return (value, path) => (value === undefined ? undefined : inner(value, path));
  },
  nullable<T>(inner: Validator<T>): Validator<T | null> {
    return (value, path) => (value === null || value === undefined ? null : inner(value, path));
  },
  withDefault<T>(inner: Validator<T>, fallback: NoInfer<T>): Validator<T> {
    return (value, path) => (value === undefined || value === null ? fallback : inner(value, path));
  },
  array<T>(inner: Validator<T>, { max = 100_000 } = {}): Validator<T[]> {
    return (value, path) => {
      if (!Array.isArray(value)) return fail(path, 'array', value);
      if (value.length > max) throw new TerminiaError('VALIDATION', `Too many items at ${path} (${value.length} > ${max}).`);
      return value.map((item, index) => inner(item, `${path}[${index}]`));
    };
  },
  record<T>(inner: Validator<T>): Validator<Record<string, T>> {
    return (value, path) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(path, 'object', value);
      const out: Record<string, T> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = inner(item, `${path}.${key}`);
      return out;
    };
  },
  object<S extends Record<string, Validator<unknown>>>(shape: S): Validator<{ [K in keyof S]: Infer<S[K]> }> {
    return (value, path) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(path, 'object', value);
      const out: Record<string, unknown> = {};
      for (const [key, validator] of Object.entries(shape)) {
        const result = validator((value as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
        if (result !== undefined) out[key] = result;
      }
      return out as { [K in keyof S]: Infer<S[K]> };
    };
  },
  unknown(): Validator<unknown> {
    return (value) => value;
  },
};

/** Validates `value`; the error message names `what` (for example "GitHub response"). */
export function parse<T>(validator: Validator<T>, value: unknown, what = 'data'): T {
  try {
    return validator(value, '');
  } catch (error) {
    if (error instanceof TerminiaError) {
      throw new TerminiaError('VALIDATION', `Invalid ${what}: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

export function parseJson<T>(validator: Validator<T>, text: string, what = 'data'): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TerminiaError('VALIDATION', `Invalid ${what}: not valid JSON.`);
  }
  return parse(validator, value, what);
}

import { TerminiaError, sleep as defaultSleep } from '../core/errors';
import { redact } from '../core/redact';
import { parse, type Validator } from '../core/validate';
import type { HttpClient, HttpResponse } from '../net/http';

/**
 * GitHub REST API client. All requests carry the credential id only; the
 * token is attached natively. Handles rate limits (primary and secondary),
 * retries idempotent requests with backoff, validates response shapes, and
 * turns GitHub errors into actionable messages.
 */

export const GITHUB_API = 'https://api.github.com';
export const API_VERSION = '2022-11-28';

export interface GitHubRequestOptions<T> {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  validator?: Validator<T>;
  accept?: string;
  /** Statuses treated as success (default: any 2xx). */
  expect?: number[];
  signal?: AbortSignal;
  /** Retries for retryable failures. Defaults to 3 for GET and 0 otherwise. */
  retries?: number;
  responseType?: 'text' | 'bytes';
  maxBytes?: number;
  timeoutMs?: number;
}

export interface GitHubResponse<T> {
  data: T;
  status: number;
  headers: Record<string, string>;
  text: string;
  bytes?: Uint8Array;
}

export interface RateLimit {
  limit: number;
  remaining: number;
  resetAt: number;
}

export interface GitHubClientOptions {
  http: HttpClient;
  credentialId: string;
  baseUrl?: string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Longest wait (ms) the client will sleep through for a rate limit before failing. */
  maxRateLimitWait?: number;
}

interface GitHubErrorBody {
  message?: string;
  documentation_url?: string;
  errors?: { message?: string; code?: string; field?: string; resource?: string }[];
}

function readErrorBody(text: string): GitHubErrorBody {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' ? (value as GitHubErrorBody) : {};
  } catch {
    return {};
  }
}

export class GitHubClient {
  readonly baseUrl: string;
  lastRateLimit: RateLimit | null = null;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly maxRateLimitWait: number;

  constructor(private readonly options: GitHubClientOptions) {
    this.baseUrl = (options.baseUrl ?? GITHUB_API).replace(/\/$/, '');
    this.sleepFn = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.maxRateLimitWait = options.maxRateLimitWait ?? 60_000;
  }

  url(path: string, query?: GitHubRequestOptions<unknown>['query']): string {
    const url = new URL(path.startsWith('http') ? path : `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    return url.toString();
  }

  async request<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, options: GitHubRequestOptions<T> = {}): Promise<GitHubResponse<T>> {
    const retries = options.retries ?? (method === 'GET' ? 3 : 0);
    let attempt = 0;
    for (;;) {
      try {
        return await this.once(method, path, options);
      } catch (error) {
        if (!(error instanceof TerminiaError) || !error.retryable || attempt >= retries || options.signal?.aborted) throw error;
        const wait = typeof error.details?.retryAfterMs === 'number' ? error.details.retryAfterMs : Math.min(8000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);
        if (wait > this.maxRateLimitWait) throw error;
        attempt++;
        await this.sleepFn(wait, options.signal);
      }
    }
  }

  private async once<T>(method: string, path: string, options: GitHubRequestOptions<T>): Promise<GitHubResponse<T>> {
    const headers: Record<string, string> = {
      Accept: options.accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const response = await this.options.http.request({
      url: this.url(path, options.query),
      method: method as 'GET',
      headers,
      body,
      credentialId: this.options.credentialId,
      signal: options.signal,
      responseType: options.responseType,
      maxBytes: options.maxBytes,
      timeoutMs: options.timeoutMs,
    });
    this.trackRateLimit(response);
    const ok = options.expect ? options.expect.includes(response.status) : response.status >= 200 && response.status < 300;
    if (!ok) throw this.errorFor(method, path, response);
    let data: unknown = undefined;
    if (options.validator) {
      let json: unknown;
      try {
        json = response.text ? JSON.parse(response.text) : null;
      } catch {
        throw new TerminiaError('PROVIDER', `GitHub returned a response that is not JSON for ${method} ${path}.`);
      }
      data = parse(options.validator, json, `GitHub response (${method} ${path.split('?')[0]})`);
    }
    return { data: data as T, status: response.status, headers: response.headers, text: response.text, bytes: response.bytes };
  }

  async get<T>(path: string, validator: Validator<T>, options: Omit<GitHubRequestOptions<T>, 'validator'> = {}): Promise<T> {
    return (await this.request('GET', path, { ...options, validator })).data;
  }

  async post<T>(path: string, body: unknown, validator?: Validator<T>, options: Omit<GitHubRequestOptions<T>, 'validator' | 'body'> = {}): Promise<T> {
    return (await this.request('POST', path, { ...options, body, validator })).data;
  }

  async patch<T>(path: string, body: unknown, validator?: Validator<T>, options: Omit<GitHubRequestOptions<T>, 'validator' | 'body'> = {}): Promise<T> {
    return (await this.request('PATCH', path, { ...options, body, validator })).data;
  }

  async put<T>(path: string, body: unknown, validator?: Validator<T>, options: Omit<GitHubRequestOptions<T>, 'validator' | 'body'> = {}): Promise<T> {
    return (await this.request('PUT', path, { ...options, body, validator })).data;
  }

  /** Follows Link: rel="next" headers. `pick` extracts the items of one page. */
  async paginate<P, I>(path: string, validator: Validator<P>, pick: (page: P) => I[], options: { query?: GitHubRequestOptions<P>['query']; maxPages?: number; signal?: AbortSignal } = {}): Promise<I[]> {
    const items: I[] = [];
    let url: string | null = this.url(path, { per_page: 100, ...options.query });
    for (let page = 0; url && page < (options.maxPages ?? 10); page++) {
      const response: GitHubResponse<P> = await this.request('GET', url, { validator, signal: options.signal });
      items.push(...pick(response.data));
      url = nextLink(response.headers.link);
    }
    return items;
  }

  private trackRateLimit(response: HttpResponse): void {
    const limit = Number(response.headers['x-ratelimit-limit']);
    const remaining = Number(response.headers['x-ratelimit-remaining']);
    const reset = Number(response.headers['x-ratelimit-reset']);
    if (Number.isFinite(limit) && Number.isFinite(remaining) && Number.isFinite(reset)) {
      this.lastRateLimit = { limit, remaining, resetAt: reset * 1000 };
    }
  }

  private errorFor(method: string, path: string, response: HttpResponse): TerminiaError {
    const body = readErrorBody(response.text);
    const message = redact(body.message ?? `HTTP ${response.status}`);
    const where = `${method} ${path.replace(this.baseUrl, '').split('?')[0]}`;
    const status = response.status;
    const retryAfter = Number(response.headers['retry-after']);
    const remaining = response.headers['x-ratelimit-remaining'];
    const reset = Number(response.headers['x-ratelimit-reset']);

    if (status === 429 || (status === 403 && (remaining === '0' || /rate limit/i.test(message) || Number.isFinite(retryAfter)))) {
      const retryAfterMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : remaining === '0' && Number.isFinite(reset)
          ? Math.max(1000, reset * 1000 - this.now())
          : 60_000;
      return new TerminiaError('RATE_LIMITED', `GitHub rate limit reached (${message}).`, {
        status,
        retryable: true,
        details: { retryAfterMs },
        hint: `Try again ${retryAfterMs > 60_000 ? `after ${new Date(this.now() + retryAfterMs).toLocaleTimeString()}` : 'in a minute'}.`,
      });
    }
    if (status === 401) {
      return new TerminiaError('AUTH_FAILED', 'GitHub rejected the credential: it is invalid, expired or revoked.', {
        status,
        hint: 'Reconnect in Settings › Build Providers › GitHub, or run `terminia github login`.',
      });
    }
    if (status === 403) {
      const accepted = response.headers['x-accepted-oauth-scopes'];
      const granted = response.headers['x-oauth-scopes'];
      let hint = 'Check that your token can access this repository.';
      if (accepted !== undefined && granted !== undefined && accepted) hint = `This needs the OAuth scope(s) '${accepted}'; your token has '${granted || 'none'}'.`;
      else if (/personal access token/i.test(message)) hint = 'Your fine-grained token lacks a permission for this repository. Terminia needs Actions (read/write), Contents (read/write), Metadata (read) and Workflows (read/write) - see docs/GITHUB-SETUP.md.';
      return new TerminiaError('PERMISSION_DENIED', `GitHub refused ${where}: ${message}`, { status, hint });
    }
    if (status === 404) {
      return new TerminiaError('NOT_FOUND', `GitHub returned 404 for ${where}.`, {
        status,
        hint: 'The resource does not exist, or your token cannot see it (GitHub answers 404 for private repositories without access).',
      });
    }
    if (status === 409) return new TerminiaError('CONFLICT', `GitHub reported a conflict for ${where}: ${message}`, { status });
    if (status === 422) {
      const details = (body.errors ?? []).map((e) => e.message ?? [e.resource, e.field, e.code].filter(Boolean).join(' ')).filter(Boolean);
      return new TerminiaError('VALIDATION', `GitHub rejected ${where}: ${message}${details.length ? ` (${details.join('; ')})` : ''}`, { status });
    }
    if (status >= 500) return new TerminiaError('PROVIDER', `GitHub is having problems (${status}) for ${where}. Retrying usually helps.`, { status, retryable: true });
    return new TerminiaError('PROVIDER', `Unexpected GitHub response ${status} for ${where}: ${message}`, { status });
  }
}

export function nextLink(link: string | undefined): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (match) return match[1]!;
  }
  return null;
}

export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

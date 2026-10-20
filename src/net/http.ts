import { TerminiaError, isAbortError } from '../core/errors';
import { base64ToBytes, bytesToBase64, sha256Hex } from '../core/hash';
import { newId } from '../core/util';
import type { FsBackend } from '../fs/backend';
import { TerminiaHttp, nativeErrorCode, type RootId, type TerminiaHttpPlugin } from '../platform/plugins';
import type { MemoryVault } from '../platform/vault';

/**
 * HTTP for every network call Terminia makes. Requests name a credential by
 * id; the token is attached by native code (iPad) or by the in-memory vault
 * (browser preview, tests) - never by the caller - and only when the request
 * origin is one the credential was bound to.
 */

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  credentialId?: string;
  timeoutMs?: number;
  responseType?: 'text' | 'bytes';
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string>;
  url: string;
  text: string;
  bytes?: Uint8Array;
}

export interface DownloadRequest {
  url: string;
  headers?: Record<string, string>;
  credentialId?: string;
  root: RootId;
  path: string;
  maxBytes?: number;
  signal?: AbortSignal;
  onProgress?: (received: number, total: number) => void;
}

export interface DownloadResult {
  status: number;
  size: number;
  sha256: string;
  contentType?: string;
}

export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
  download(request: DownloadRequest): Promise<DownloadResult>;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}

function mapNativeError(error: unknown, signal?: AbortSignal): TerminiaError {
  if (error instanceof TerminiaError) return error;
  if (signal?.aborted) return new TerminiaError('CANCELLED', 'Cancelled.');
  const code = nativeErrorCode(error);
  const message = (error as { message?: string })?.message ?? String(error);
  switch (code) {
    case 'TIMEOUT':
      return new TerminiaError('TIMEOUT', message, { retryable: true });
    case 'NETWORK':
      return new TerminiaError('NETWORK', message, { retryable: true });
    case 'CANCELLED':
      return new TerminiaError('CANCELLED', 'Cancelled.');
    case 'TOO_LARGE':
      return new TerminiaError('TOO_LARGE', message);
    case 'CREDENTIAL_MISSING':
      return new TerminiaError('AUTH_REQUIRED', message);
    case 'CREDENTIAL_ORIGIN':
      return new TerminiaError('PERMISSION_DENIED', message);
    case 'PIN_MISMATCH':
      return new TerminiaError('AUTH_FAILED', message, {
        hint: "The server's certificate does not match the pinned fingerprint. Check the host, or update the fingerprint in the connection profile.",
      });
    default:
      return new TerminiaError('NETWORK', message, { retryable: true, cause: error });
  }
}

/** Requests through the TerminiaHttp Swift plugin (URLSession). */
export class NativeHttpClient implements HttpClient {
  constructor(private readonly plugin: TerminiaHttpPlugin = TerminiaHttp) {}

  async request(request: HttpRequest): Promise<HttpResponse> {
    const requestId = newId();
    const onAbort = () => void this.plugin.cancel({ requestId }).catch(() => undefined);
    request.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (request.signal?.aborted) throw new TerminiaError('CANCELLED', 'Cancelled.');
      const response = await this.plugin.request({
        requestId,
        url: request.url,
        method: request.method ?? 'GET',
        headers: request.headers,
        bodyText: typeof request.body === 'string' ? request.body : undefined,
        bodyBase64: request.body instanceof Uint8Array ? bytesToBase64(request.body) : undefined,
        credentialId: request.credentialId,
        timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        responseType: request.responseType === 'bytes' ? 'base64' : 'text',
        maxBytes: request.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      });
      const bytes = response.bodyBase64 !== undefined ? base64ToBytes(response.bodyBase64) : undefined;
      return { status: response.status, headers: lowerHeaders(response.headers), url: response.url, text: response.bodyText ?? '', bytes };
    } catch (error) {
      throw mapNativeError(error, request.signal);
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
    }
  }

  async download(request: DownloadRequest): Promise<DownloadResult> {
    const requestId = newId();
    const onAbort = () => void this.plugin.cancel({ requestId }).catch(() => undefined);
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const listener = request.onProgress
      ? await this.plugin.addListener('downloadProgress', (event) => {
          if (event.requestId === requestId) request.onProgress?.(event.received, event.total);
        })
      : null;
    try {
      if (request.signal?.aborted) throw new TerminiaError('CANCELLED', 'Cancelled.');
      return await this.plugin.download({
        requestId,
        url: request.url,
        headers: request.headers,
        credentialId: request.credentialId,
        root: request.root,
        path: request.path,
        maxBytes: request.maxBytes,
      });
    } catch (error) {
      throw mapNativeError(error, request.signal);
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
      await listener?.remove();
    }
  }
}

export interface FetchHttpOptions {
  fetch?: typeof fetch;
  vault?: Pick<MemoryVault, 'resolveForOrigin' | 'has'>;
  /** Storage roots downloads may be written to. */
  roots?: Partial<Record<string, FsBackend>>;
}

/**
 * fetch()-based client for the browser preview and tests. Note that in a
 * browser, CORS applies: api.github.com allows it, but GitHub's artifact and
 * log storage redirects do not, so those downloads only work in the iPad app.
 */
export class FetchHttpClient implements HttpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: FetchHttpOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  private headersFor(request: { url: string; headers?: Record<string, string>; credentialId?: string }): Record<string, string> {
    const headers: Record<string, string> = { ...(request.headers ?? {}) };
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'authorization') delete headers[key];
    }
    if (request.credentialId) {
      const origin = new URL(request.url).origin;
      if (!this.options.vault?.has(request.credentialId)) {
        throw new TerminiaError('AUTH_REQUIRED', 'No credential is stored for this connection.');
      }
      const token = this.options.vault.resolveForOrigin(request.credentialId, origin);
      if (!token) throw new TerminiaError('PERMISSION_DENIED', `The credential is not allowed for ${origin}.`);
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private async send(request: HttpRequest | DownloadRequest, method: string, body?: BodyInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    request.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.fetchImpl(request.url, { method, headers: this.headersFor(request), body, redirect: 'follow', signal: controller.signal });
    } catch (error) {
      if (error instanceof TerminiaError) throw error;
      if (request.signal?.aborted) throw new TerminiaError('CANCELLED', 'Cancelled.');
      if (timedOut) throw new TerminiaError('TIMEOUT', `Request timed out: ${new URL(request.url).host}`, { retryable: true });
      if (isAbortError(error)) throw new TerminiaError('CANCELLED', 'Cancelled.');
      throw new TerminiaError('NETWORK', `Network request failed: ${new URL(request.url).host} (${(error as Error)?.message ?? error})`, {
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    const body = request.body === undefined ? undefined : typeof request.body === 'string' ? request.body : new Blob([request.body as BlobPart]);
    const response = await this.send(request, request.method ?? 'GET', body, request.timeoutMs);
    const max = request.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > max) throw new TerminiaError('TOO_LARGE', `Response is larger than ${Math.round(max / 1048576)} MB.`);
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > max) throw new TerminiaError('TOO_LARGE', `Response is larger than ${Math.round(max / 1048576)} MB.`);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    return {
      status: response.status,
      headers,
      url: response.url || request.url,
      text: request.responseType === 'bytes' ? '' : new TextDecoder().decode(buffer),
      bytes: request.responseType === 'bytes' ? buffer : undefined,
    };
  }

  async download(request: DownloadRequest): Promise<DownloadResult> {
    const backend = this.options.roots?.[request.root];
    if (!backend) throw new TerminiaError('UNAVAILABLE', `Downloads to '${request.root}' are not available here.`);
    const response = await this.send(request, 'GET', undefined, 10 * 60_000);
    if (response.status >= 400) {
      return { status: response.status, size: 0, sha256: '' };
    }
    const total = Number(response.headers.get('content-length') ?? 0);
    const max = request.maxBytes ?? Number.MAX_SAFE_INTEGER;
    if (total > max) throw new TerminiaError('TOO_LARGE', 'The download is larger than the allowed size.');
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = response.body?.getReader();
    if (reader) {
      for (;;) {
        if (request.signal?.aborted) {
          await reader.cancel();
          throw new TerminiaError('CANCELLED', 'Cancelled.');
        }
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        if (received > max) {
          await reader.cancel();
          throw new TerminiaError('TOO_LARGE', 'The download is larger than the allowed size.');
        }
        request.onProgress?.(received, total);
      }
    }
    const data = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    await backend.writeBytes(request.path, data);
    return { status: response.status, size: received, sha256: await sha256Hex(data), contentType: response.headers.get('content-type') ?? undefined };
  }
}

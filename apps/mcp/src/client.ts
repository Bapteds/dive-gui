// HTTP client for the DIVE API, mirroring the web client's auth model
// (apps/web/src/lib/api/client.ts) but for a long-lived Node process:
//   - Log in with a service account -> obtain a Bearer access token.
//   - Attach `Authorization: Bearer <token>` to every request.
//   - On a 401, log in again ONCE (single-flight) and retry the request.
// The browser client refreshes via an httpOnly cookie; a headless server has no
// cookie jar, so re-login (which returns a fresh access token directly) is the
// simpler, equivalent recovery path.
//
// Transient failures (a dropped connection, a timeout, a 502/503/504 from a
// restarting proxy) are retried with backoff — but ONLY for GET, which is safe
// to repeat. A non-idempotent POST/PUT/DELETE is never auto-retried on a
// transient error, so a merge or a solver start can never fire twice.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Config } from './config.js';

/** Error carrying the API's status + parsed `{ error: { code, message } }`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** The request that failed, for context in messages/logs (e.g. "POST /projects"). */
  readonly endpoint?: string;

  constructor(status: number, code: string, message: string, endpoint?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.endpoint = endpoint;
  }
}

interface LoginResponse {
  accessToken: string;
  user: { id: string; email: string; role: string; displayName?: string };
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type Query = Record<string, string | number | boolean | undefined>;

/** Per-call overrides a tool can pass (e.g. a longer timeout for a slow op). */
export interface CallOpts {
  /** Override the request timeout (ms). Defaults to the config's `timeoutMs`. */
  timeoutMs?: number;
}

interface RequestOptions extends CallOpts {
  method?: HttpMethod;
  /** JSON-serialisable body (ignored when `form` or `text` is set). */
  json?: unknown;
  /** Multipart form body (file uploads). Takes precedence over `json`. */
  form?: FormData;
  /** Raw text body (file-content saves). Takes precedence over `json`. */
  text?: string;
  /** Query-string params (undefined values are dropped). */
  query?: Query;
}

/** A single logical file part read from disk, for multipart uploads. */
export interface FilePart {
  field: string;
  path: string;
  /** Override the sent filename (defaults to the path's basename). */
  filename?: string;
}

/**
 * The API surface the MCP tools/resources/prompts depend on. `DiveClient` is the
 * production implementation; tests inject a fake that satisfies this interface,
 * so tool handlers can be exercised without a live backend.
 */
export interface Api {
  /** Base URL with the `/api/v1` prefix, no trailing slash. */
  readonly baseUrl: string;
  /** The longer timeout budget (ms) slow tools should pass via `CallOpts`. */
  readonly slowTimeoutMs: number;
  get<T>(path: string, query?: Query, opts?: CallOpts): Promise<T>;
  post<T>(path: string, json?: unknown, query?: Query, opts?: CallOpts): Promise<T>;
  put<T>(path: string, json?: unknown, query?: Query, opts?: CallOpts): Promise<T>;
  patch<T>(path: string, json?: unknown, query?: Query, opts?: CallOpts): Promise<T>;
  delete<T>(path: string, query?: Query, opts?: CallOpts): Promise<T>;
  putText<T>(path: string, text: string, query?: Query, opts?: CallOpts): Promise<T>;
  postForm<T>(
    path: string,
    fields?: Record<string, string>,
    files?: FilePart[],
    query?: Query,
    opts?: CallOpts,
  ): Promise<T>;
  /** Fetch a binary payload (a rendered artifact, a download). */
  getBytes(
    path: string,
    query?: Query,
    opts?: CallOpts,
  ): Promise<{ bytes: Buffer; contentType: string | null }>;
}

/** Statuses worth retrying on an idempotent call (a proxy hiccup, not a real error). */
const RETRIABLE_STATUS = new Set([502, 503, 504]);
/** Error codes (from `rawFetch`) worth retrying on an idempotent call. */
const RETRIABLE_CODES = new Set(['NETWORK_ERROR', 'TIMEOUT']);

/**
 * Stateful DIVE API client. One instance is shared by every tool; it owns the
 * access token and the single-flight re-login.
 */
export class DiveClient implements Api {
  private token: string | null = null;
  private loginPromise: Promise<string> | null = null;

  constructor(private readonly config: Config) {}

  get baseUrl(): string {
    return this.config.apiUrl;
  }

  get slowTimeoutMs(): number {
    return this.config.slowTimeoutMs;
  }

  /** Log in with the service account and cache the access token (single-flight). */
  private async login(): Promise<string> {
    if (!this.loginPromise) {
      this.loginPromise = (async () => {
        try {
          // Login is safe to retry (it has no side effect beyond issuing a token),
          // so it goes through the retrying `attempt`, making startup resilient to
          // a backend that is still coming up.
          const res = await this.attempt(
            '/auth/login',
            { method: 'POST', json: { email: this.config.email, password: this.config.password } },
            true,
          );
          if (!res.ok) {
            const detail = await this.readError(res);
            throw new ApiError(res.status, detail.code, `Login failed: ${detail.message}`, 'POST /auth/login');
          }
          const data = (await res.json()) as LoginResponse;
          this.token = data.accessToken;
          return data.accessToken;
        } finally {
          this.loginPromise = null;
        }
      })();
    }
    return this.loginPromise;
  }

  /** Ensure a token exists (log in on first use), returning it. */
  private async ensureToken(): Promise<string> {
    return this.token ?? this.login();
  }

  /** Build the full URL for a path + query params. */
  private url(path: string, query?: Query): string {
    const url = new URL(this.config.apiUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /** Low-level fetch with a per-call timeout; attaches the bearer token when present. */
  private async rawFetch(path: string, options: RequestOptions): Promise<Response> {
    const headers = new Headers({ Accept: 'application/json' });
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);

    let body: BodyInit | undefined;
    if (options.form) {
      body = options.form; // browser/undici sets the multipart Content-Type.
    } else if (options.text !== undefined) {
      headers.set('Content-Type', 'text/plain;charset=utf-8');
      body = options.text;
    } else if (options.json !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(options.json);
    }

    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(this.url(path, options.query), {
        method: options.method ?? 'GET',
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ApiError(0, 'TIMEOUT', `Request to ${path} timed out after ${timeoutMs}ms.`);
      }
      throw new ApiError(0, 'NETWORK_ERROR', `Unable to reach the DIVE API at ${this.baseUrl}. Is it running?`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Sleep for a backoff interval that grows with the attempt number. */
  private backoff(attempt: number): Promise<void> {
    const ms = 250 * 2 ** attempt;
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Send a request, retrying transient failures up to `config.retries` times when
   * `allowRetry` is set (only for idempotent GETs and the login POST). A real HTTP
   * error status (4xx, or a 5xx that is not a transient gateway code) is returned
   * as-is for the caller to interpret — retrying it would not help.
   */
  private async attempt(path: string, options: RequestOptions, allowRetry: boolean): Promise<Response> {
    for (let i = 0; ; i++) {
      try {
        const res = await this.rawFetch(path, options);
        if (allowRetry && RETRIABLE_STATUS.has(res.status) && i < this.config.retries) {
          await this.backoff(i);
          continue;
        }
        return res;
      } catch (err) {
        if (
          allowRetry &&
          err instanceof ApiError &&
          RETRIABLE_CODES.has(err.code) &&
          i < this.config.retries
        ) {
          await this.backoff(i);
          continue;
        }
        throw err;
      }
    }
  }

  /** Parse an error body into a { code, message } pair, tolerating non-JSON. */
  private async readError(res: Response): Promise<{ code: string; message: string }> {
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      return {
        code: body.error?.code ?? 'UNKNOWN',
        message: body.error?.message ?? `HTTP ${res.status}`,
      };
    } catch {
      return { code: 'UNKNOWN', message: `HTTP ${res.status}` };
    }
  }

  /**
   * Perform an authenticated request. On a 401 (expired/absent token) it logs in
   * once and retries. Transient failures are retried for GET only. Non-OK
   * responses throw an ApiError carrying the failing endpoint for context.
   */
  private async request(path: string, options: RequestOptions): Promise<Response> {
    const method = options.method ?? 'GET';
    const allowRetry = method === 'GET';
    await this.ensureToken();
    let res = await this.attempt(path, options, allowRetry);

    if (res.status === 401) {
      this.token = null;
      await this.login();
      res = await this.attempt(path, options, allowRetry);
    }

    if (!res.ok) {
      const detail = await this.readError(res);
      throw new ApiError(res.status, detail.code, detail.message, `${method} ${path}`);
    }
    return res;
  }

  /** Decode a JSON response, tolerating 204 / empty bodies. */
  private async decode<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  // ---- Public verbs used by the tools ----

  async get<T>(path: string, query?: Query, opts?: CallOpts): Promise<T> {
    return this.decode<T>(await this.request(path, { method: 'GET', query, ...opts }));
  }

  async post<T>(path: string, json?: unknown, query?: Query, opts?: CallOpts): Promise<T> {
    return this.decode<T>(await this.request(path, { method: 'POST', json, query, ...opts }));
  }

  async put<T>(path: string, json?: unknown, query?: Query, opts?: CallOpts): Promise<T> {
    return this.decode<T>(await this.request(path, { method: 'PUT', json, query, ...opts }));
  }

  async patch<T>(path: string, json?: unknown, query?: Query, opts?: CallOpts): Promise<T> {
    return this.decode<T>(await this.request(path, { method: 'PATCH', json, query, ...opts }));
  }

  async delete<T>(path: string, query?: Query, opts?: CallOpts): Promise<T> {
    return this.decode<T>(await this.request(path, { method: 'DELETE', query, ...opts }));
  }

  /** PUT a raw text body (used for saving case-file content). */
  async putText<T>(path: string, text: string, query?: Query, opts?: CallOpts): Promise<T> {
    return this.decode<T>(await this.request(path, { method: 'PUT', text, query, ...opts }));
  }

  /**
   * POST a multipart form. `fields` are plain string parts; `files` are read
   * from disk and attached as Blobs under their `field` name.
   */
  async postForm<T>(
    path: string,
    fields: Record<string, string> = {},
    files: FilePart[] = [],
    query?: Query,
    opts?: CallOpts,
  ): Promise<T> {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      form.append(key, value);
    }
    for (const file of files) {
      const buf = await readFile(file.path);
      form.append(file.field, new Blob([buf]), file.filename ?? basename(file.path));
    }
    return this.decode<T>(await this.request(path, { method: 'POST', form, query, ...opts }));
  }

  /**
   * Fetch a binary payload (a rendered GLB, a produced export artifact, a case
   * .zip). Returns the raw bytes plus the response Content-Type so a tool can
   * write it to disk with a sensible extension.
   */
  async getBytes(
    path: string,
    query?: Query,
    opts?: CallOpts,
  ): Promise<{ bytes: Buffer; contentType: string | null }> {
    const res = await this.request(path, { method: 'GET', query, ...opts });
    const bytes = Buffer.from(await res.arrayBuffer());
    return { bytes, contentType: res.headers.get('content-type') };
  }
}

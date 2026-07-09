// HTTP client for the DIVE API, mirroring the web client's auth model
// (apps/web/src/lib/api/client.ts) but for a long-lived Node process:
//   - Log in with a service account -> obtain a Bearer access token.
//   - Attach `Authorization: Bearer <token>` to every request.
//   - On a 401, log in again ONCE (single-flight) and retry the request.
// The browser client refreshes via an httpOnly cookie; a headless server has no
// cookie jar, so re-login (which returns a fresh access token directly) is the
// simpler, equivalent recovery path.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Config } from './config.js';

/** Error carrying the API's status + parsed `{ error: { code, message } }`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

interface LoginResponse {
  accessToken: string;
  user: { id: string; email: string; role: string; displayName?: string };
}

type Query = Record<string, string | number | boolean | undefined>;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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
 * Stateful DIVE API client. One instance is shared by every tool; it owns the
 * access token and the single-flight re-login.
 */
export class DiveClient {
  private token: string | null = null;
  private loginPromise: Promise<string> | null = null;

  constructor(private readonly config: Config) {}

  /** Base URL with the `/api/v1` prefix, no trailing slash. */
  get baseUrl(): string {
    return this.config.apiUrl;
  }

  /** Log in with the service account and cache the access token (single-flight). */
  private async login(): Promise<string> {
    if (!this.loginPromise) {
      this.loginPromise = (async () => {
        try {
          const res = await this.rawFetch('/auth/login', {
            method: 'POST',
            json: { email: this.config.email, password: this.config.password },
          });
          if (!res.ok) {
            const detail = await this.readError(res);
            throw new ApiError(res.status, detail.code, `Login failed: ${detail.message}`);
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

  /** Low-level fetch with a timeout; attaches the bearer token when present. */
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      return await fetch(this.url(path, options.query), {
        method: options.method ?? 'GET',
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ApiError(0, 'TIMEOUT', `Request to ${path} timed out after ${this.config.timeoutMs}ms.`);
      }
      throw new ApiError(0, 'NETWORK_ERROR', `Unable to reach the DIVE API at ${this.baseUrl}. Is it running?`);
    } finally {
      clearTimeout(timer);
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
   * once and retries. Non-OK responses throw an ApiError.
   */
  private async request(path: string, options: RequestOptions): Promise<Response> {
    await this.ensureToken();
    let res = await this.rawFetch(path, options);

    if (res.status === 401) {
      this.token = null;
      await this.login();
      res = await this.rawFetch(path, options);
    }

    if (!res.ok) {
      const detail = await this.readError(res);
      throw new ApiError(res.status, detail.code, detail.message);
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

  async get<T>(path: string, query?: Query): Promise<T> {
    return this.decode<T>(await this.request(path, { method: 'GET', query }));
  }

  async post<T>(path: string, json?: unknown, query?: Query): Promise<T> {
    return this.decode<T>(await this.request(path, { method: 'POST', json, query }));
  }

  async put<T>(path: string, json?: unknown, query?: Query): Promise<T> {
    return this.decode<T>(await this.request(path, { method: 'PUT', json, query }));
  }

  async delete<T>(path: string, query?: Query): Promise<T> {
    return this.decode<T>(await this.request(path, { method: 'DELETE', query }));
  }

  /** PUT a raw text body (used for saving case-file content). */
  async putText<T>(path: string, text: string, query?: Query): Promise<T> {
    return this.decode<T>(await this.request(path, { method: 'PUT', text, query }));
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
  ): Promise<T> {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      form.append(key, value);
    }
    for (const file of files) {
      const buf = await readFile(file.path);
      form.append(file.field, new Blob([buf]), file.filename ?? basename(file.path));
    }
    return this.decode<T>(await this.request(path, { method: 'POST', form, query }));
  }
}

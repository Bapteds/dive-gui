import type { ApiErrorBody, ApiErrorCode, AuthResponse } from './types';

/**
 * client.ts - fetch wrapper for the DIVE backend.
 *
 * Responsibilities:
 *  - Attach `Authorization: Bearer <accessToken>` from an in-memory holder
 *    (the access token is NEVER persisted to localStorage).
 *  - Parse `{ error: { code, message } }` bodies into a thrown `ApiError`.
 *  - On a 401 for a non-auth request, call `POST /auth/refresh` ONCE (shared
 *    across concurrent callers), update the token, and retry the original
 *    request. If refresh fails, clear the token and signal logout.
 *  - Send auth requests with `credentials: 'include'` so the httpOnly refresh
 *    cookie is read/written by the browser.
 */

/**
 * Resolve the API base URL from the build-time env, failing loudly if it is
 * missing. Resolved lazily (on the first request) rather than at module load so
 * importing the client in unit tests never throws; a real request surfaces a
 * clear, actionable message instead of silently fetching `undefined/...`.
 */
function getBaseUrl(): string {
  const baseUrl = import.meta.env.VITE_API_URL;
  if (!baseUrl) {
    throw new Error(
      'VITE_API_URL is not set. Copy apps/web/.env.example to apps/web/.env and set ' +
        'VITE_API_URL (e.g. http://localhost:4000/api/v1), then restart the dev server.',
    );
  }
  return baseUrl;
}

/** Endpoints that perform their own credential handling and must not trigger
 * the refresh-and-retry loop (refreshing while refreshing would recurse). */
const AUTH_PATHS = ['/auth/login', '/auth/refresh', '/auth/logout'] as const;

// ---- In-memory access-token holder ----

let accessToken: string | null = null;

/** Replace the in-memory access token (null clears it). */
export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/** Read the current in-memory access token. */
export function getAccessToken(): string | null {
  return accessToken;
}

// ---- Logout signal ----

type LogoutListener = () => void;
let onLogout: LogoutListener | null = null;

/**
 * Register the single handler invoked when a refresh attempt fails (the
 * session can no longer be recovered). The AuthProvider wires this so it can
 * transition to the unauthenticated state and redirect to login.
 */
export function setLogoutHandler(handler: LogoutListener | null): void {
  onLogout = handler;
}

// ---- Error type ----

/** Error thrown for any non-OK response or transport failure. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

function isAuthPath(path: string): boolean {
  return AUTH_PATHS.some((authPath) => path.startsWith(authPath));
}

/** Parse an error response body into a typed ApiError. */
async function toApiError(response: Response): Promise<ApiError> {
  let code: ApiErrorCode = 'UNKNOWN';
  let message = 'Something went wrong. Please try again.';

  try {
    const body = (await response.json()) as Partial<ApiErrorBody>;
    if (body?.error?.code) {
      code = body.error.code as ApiErrorCode;
    }
    if (body?.error?.message) {
      message = body.error.message;
    }
  } catch {
    // Body was not JSON; fall back to a status-derived code.
    if (response.status === 401) {
      code = 'UNAUTHORIZED';
    } else if (response.status === 403) {
      code = 'FORBIDDEN';
    } else if (response.status === 404) {
      code = 'NOT_FOUND';
    }
  }

  return new ApiError(code, message, response.status);
}

// ---- Single-flight refresh ----

/** Shared in-flight refresh promise so concurrent 401s refresh only once. */
let refreshPromise: Promise<boolean> | null = null;

/**
 * Attempt to refresh the access token using the httpOnly refresh cookie.
 * Returns true on success (token updated). Concurrent callers await the same
 * promise. On failure the token is cleared and the logout handler fires.
 */
async function refreshAccessToken(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const response = await fetch(`${getBaseUrl()}/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          return false;
        }
        const data = (await response.json()) as AuthResponse;
        setAccessToken(data.accessToken);
        return true;
      } catch {
        return false;
      } finally {
        // Release the shared promise once settled so future 401s can retry.
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

// ---- Request core ----

interface RequestOptions extends Omit<RequestInit, 'body'> {
  /** JSON-serialisable request body (objects are stringified automatically). */
  body?: unknown;
  /** Skip the automatic 401 refresh-and-retry (used internally for auth). */
  skipRefresh?: boolean;
}

/** Build headers, attaching JSON content-type and the bearer token. */
function buildHeaders(hasBody: boolean, extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set('Accept', 'application/json');
  if (hasBody && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }
  return headers;
}

/** Decode a successful response body, tolerating 204 / empty payloads. */
async function decodeBody<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

async function performFetch(path: string, options: RequestOptions): Promise<Response> {
  const { body, skipRefresh: _skipRefresh, headers, ...rest } = options;
  const hasBody = body !== undefined;
  const init: RequestInit = {
    ...rest,
    headers: buildHeaders(hasBody, headers),
    // Auth endpoints rely on the refresh cookie; send credentials for them.
    credentials: isAuthPath(path) ? 'include' : rest.credentials,
  };
  if (hasBody) {
    init.body = JSON.stringify(body);
  }
  return fetch(`${getBaseUrl()}${path}`, init);
}

/**
 * Core request. Performs the fetch; on a 401 for a non-auth request, refreshes
 * the token once and retries. Throws `ApiError` on any non-OK final response.
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await performFetch(path, options);
  } catch {
    throw new ApiError('NETWORK_ERROR', 'Unable to reach the server. Check your connection.', 0);
  }

  const canRetry = !options.skipRefresh && !isAuthPath(path);
  if (response.status === 401 && canRetry) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      try {
        response = await performFetch(path, options);
      } catch {
        throw new ApiError('NETWORK_ERROR', 'Unable to reach the server. Check your connection.', 0);
      }
    } else {
      // Session is unrecoverable: clear state and signal logout.
      setAccessToken(null);
      onLogout?.();
      throw new ApiError('UNAUTHORIZED', 'Your session has expired. Please sign in again.', 401);
    }
  }

  if (!response.ok) {
    throw await toApiError(response);
  }

  return decodeBody<T>(response);
}

/** Typed HTTP helpers used by the feature-specific API modules. */
export const apiClient = {
  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return request<T>(path, { ...options, method: 'GET' });
  },
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return request<T>(path, { ...options, method: 'POST', body });
  },
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return request<T>(path, { ...options, method: 'PATCH', body });
  },
  delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return request<T>(path, { ...options, method: 'DELETE' });
  },
};

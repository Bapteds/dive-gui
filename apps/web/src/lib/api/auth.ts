import { apiClient, setAccessToken } from './client';
import type { AuthResponse, MeResponse } from './types';

/**
 * auth.ts - authentication endpoints.
 *
 * `login` and `refresh` update the in-memory access token on success.
 * `logout` clears it after the server invalidates the refresh cookie. All of
 * these hit `/auth/*` which the client sends with `credentials: 'include'`,
 * and they skip the automatic 401 refresh-and-retry to avoid recursion.
 */

/** Sign in with email + password. Sets the httpOnly refresh cookie server-side. */
export async function login(email: string, password: string): Promise<AuthResponse> {
  const data = await apiClient.post<AuthResponse>(
    '/auth/login',
    { email, password },
    { skipRefresh: true },
  );
  setAccessToken(data.accessToken);
  return data;
}

/** Exchange the refresh cookie for a fresh access token + current user. */
export async function refresh(): Promise<AuthResponse> {
  const data = await apiClient.post<AuthResponse>('/auth/refresh', undefined, {
    skipRefresh: true,
  });
  setAccessToken(data.accessToken);
  return data;
}

/** Invalidate the refresh cookie and clear the in-memory access token. */
export async function logout(): Promise<void> {
  try {
    await apiClient.post<void>('/auth/logout', undefined, { skipRefresh: true });
  } finally {
    // Always clear locally, even if the network call failed.
    setAccessToken(null);
  }
}

/** Fetch the currently authenticated user. */
export async function me(): Promise<MeResponse> {
  return apiClient.get<MeResponse>('/auth/me');
}

/** Update the current user's own profile (display name only). */
export async function updateMe(fullName: string): Promise<MeResponse> {
  return apiClient.patch<MeResponse>('/auth/me', { fullName });
}

/**
 * Change the current user's own password.
 *
 * The server rotates the refresh cookie for THIS session (and revokes the
 * others), so the request must send credentials so the browser stores the new
 * cookie. The freshly issued access token replaces the in-memory one to keep
 * the current session signed in.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<AuthResponse> {
  const data = await apiClient.post<AuthResponse>(
    '/auth/change-password',
    { currentPassword, newPassword },
    { credentials: 'include' },
  );
  setAccessToken(data.accessToken);
  return data;
}

// Helpers for managing the refresh-token cookie.
// The cookie is httpOnly (not readable by JS), SameSite=Lax, Secure in
// production, and scoped to the auth path so it is only ever sent to the auth
// endpoints. Setting and clearing must use the SAME path/options.
import type { CookieOptions, Response } from 'express';
import { env } from '../../config/env';

/** Cookie name holding the signed refresh token. */
export const REFRESH_COOKIE_NAME = 'refresh_token';

/** Path the refresh cookie is scoped to (auth routes only). */
const REFRESH_COOKIE_PATH = '/api/v1/auth';

/** Base options shared by set and clear so the browser matches the cookie. */
function baseCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: REFRESH_COOKIE_PATH,
  };
}

/**
 * Set (or replace) the refresh-token cookie on the response.
 * @param res The Express response.
 * @param token The signed refresh token to store.
 */
export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    ...baseCookieOptions(),
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

/**
 * Clear the refresh-token cookie. Uses the same path/options as when set.
 * @param res The Express response.
 */
export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, baseCookieOptions());
}

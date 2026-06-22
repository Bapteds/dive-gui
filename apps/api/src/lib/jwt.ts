// JSON Web Token helpers for access and refresh tokens.
// Access tokens are short-lived and carry the user's id + role; refresh tokens
// are long-lived, stored in an httpOnly cookie, and carry a tokenVersion so a
// logout (which bumps the version) can revoke all outstanding refresh tokens.
import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';
import { AppError } from './AppError';
import { isRole, type Role } from './role';

/** Roles as they appear on the wire / in tokens (alias of the shared Role union). */
export type TokenRole = Role;

/** Decoded access-token payload (after our own validation). */
export interface AccessTokenPayload {
  sub: string;
  role: TokenRole;
  type: 'access';
}

/** Decoded refresh-token payload (after our own validation). */
export interface RefreshTokenPayload {
  sub: string;
  tokenVersion: number;
  type: 'refresh';
}

// jsonwebtoken's expiresIn accepts a number (seconds) or a vercel/ms string
// like "15m" / "7d". The env values are validated strings/numbers already.
const accessExpiresIn = env.ACCESS_TOKEN_TTL as SignOptions['expiresIn'];
const refreshExpiresIn = `${env.REFRESH_TOKEN_TTL_DAYS}d` as SignOptions['expiresIn'];

/**
 * Sign a short-lived access token.
 * @param input The subject (user id) and role to embed.
 * @returns A signed JWT string.
 */
export function signAccessToken(input: { sub: string; role: TokenRole }): string {
  const payload: AccessTokenPayload = { sub: input.sub, role: input.role, type: 'access' };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: accessExpiresIn });
}

/**
 * Sign a long-lived refresh token.
 * @param input The subject (user id) and the user's current tokenVersion.
 * @returns A signed JWT string.
 */
export function signRefreshToken(input: { sub: string; tokenVersion: number }): string {
  const payload: RefreshTokenPayload = {
    sub: input.sub,
    tokenVersion: input.tokenVersion,
    type: 'refresh',
  };
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: refreshExpiresIn });
}

/**
 * Verify and decode an access token, asserting its shape and type.
 * @param token The raw JWT string.
 * @returns The validated access-token payload.
 * @throws AppError(401) if the token is missing, invalid, expired, or of the wrong type.
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
  } catch {
    throw new AppError(401, 'UNAUTHENTICATED', 'Invalid or expired access token');
  }
  if (!isAccessPayload(decoded)) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Invalid access token');
  }
  return decoded;
}

/**
 * Verify and decode a refresh token, asserting its shape and type.
 * @param token The raw JWT string.
 * @returns The validated refresh-token payload.
 * @throws AppError(401) if the token is missing, invalid, expired, or of the wrong type.
 */
export function verifyRefreshToken(token: string): RefreshTokenPayload {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, env.JWT_REFRESH_SECRET);
  } catch {
    throw new AppError(401, 'UNAUTHENTICATED', 'Invalid or expired refresh token');
  }
  if (!isRefreshPayload(decoded)) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Invalid refresh token');
  }
  return decoded;
}

/** Runtime guard for an access-token payload. */
function isAccessPayload(value: unknown): value is AccessTokenPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === 'access' &&
    typeof v.sub === 'string' &&
    typeof v.role === 'string' &&
    isRole(v.role)
  );
}

/** Runtime guard for a refresh-token payload. */
function isRefreshPayload(value: unknown): value is RefreshTokenPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.type === 'refresh' && typeof v.sub === 'string' && typeof v.tokenVersion === 'number';
}

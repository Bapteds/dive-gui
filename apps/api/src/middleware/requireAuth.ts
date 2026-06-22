// Authentication middleware.
// Reads a Bearer access token from the Authorization header, verifies it, and
// loads the corresponding user from the database. The DB lookup guarantees the
// account still exists (e.g. not deleted after the token was issued). On any
// failure it throws AppError(401, 'UNAUTHENTICATED', ...).
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/AppError';
import { verifyAccessToken } from '../lib/jwt';
import { prisma } from '../lib/prisma';
import { toPublicUser } from '../lib/serializeUser';

/** Extract a Bearer token from the Authorization header, or null if absent/malformed. */
function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token.trim() || null;
}

/**
 * Require a valid access token. Populates `req.user` on success.
 * @throws AppError(401) when the header is missing/invalid, the token is bad,
 *         or the referenced user no longer exists.
 */
export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = extractBearer(req.headers.authorization);
    if (!token) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
    }

    const payload = verifyAccessToken(token);

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
    }

    // A disabled account loses access immediately, even while its short-lived
    // access token is still otherwise valid (the DB lookup runs every request).
    if (!user.isActive) {
      throw new AppError(401, 'UNAUTHENTICATED', 'This account has been disabled');
    }

    // toPublicUser already narrows role to the Role union; reuse it so the
    // spread carries the strict type expected by req.user.
    const publicUser = toPublicUser(user);
    req.user = { ...publicUser, role: publicUser.role };
    next();
  } catch (err) {
    next(err);
  }
}

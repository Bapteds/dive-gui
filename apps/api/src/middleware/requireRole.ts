// Authorization middleware.
// Guards a route so only a specific role may proceed. Must run AFTER
// requireAuth, which populates req.user. Throws AppError(403, 'FORBIDDEN', ...)
// when the role does not match, or AppError(401, ...) if no user is present.
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '../lib/AppError';
import type { TokenRole } from '../lib/jwt';

/**
 * Create a middleware that requires the authenticated user to have `role`.
 * @param role The role allowed to access the route.
 * @returns An Express RequestHandler enforcing the role.
 */
export function requireRole(role: TokenRole): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      // Defensive: requireRole should always follow requireAuth.
      next(new AppError(401, 'UNAUTHENTICATED', 'Authentication required'));
      return;
    }
    if (req.user.role !== role) {
      next(new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action'));
      return;
    }
    next();
  };
}

// Auth router, mounted at /api/v1/auth.
// Wires validation, rate limiting, and auth guards to the controllers.
import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { loginRateLimiter } from '../../middleware/rateLimit';
import { requireAuth } from '../../middleware/requireAuth';
import { validate } from '../../middleware/validate';
import {
  changePasswordController,
  loginController,
  logoutController,
  meController,
  refreshController,
  updateMeController,
} from './auth.controller';
import { changePasswordSchema, loginSchema, updateMeSchema } from './auth.schemas';

/** Build the auth router with all routes registered. */
export function createAuthRouter(): Router {
  const router = Router();

  // Public: rate-limited login.
  router.post(
    '/login',
    loginRateLimiter,
    validate({ body: loginSchema }),
    asyncHandler(loginController),
  );

  // Public (cookie-based): refresh the access token.
  router.post('/refresh', asyncHandler(refreshController));

  // Authenticated: logout (revokes refresh tokens) and current profile.
  router.post('/logout', asyncHandler(requireAuth), asyncHandler(logoutController));
  router.get('/me', asyncHandler(requireAuth), asyncHandler(meController));

  // Authenticated self-service: update own display name, change own password.
  router.patch(
    '/me',
    asyncHandler(requireAuth),
    validate({ body: updateMeSchema }),
    asyncHandler(updateMeController),
  );
  router.post(
    '/change-password',
    asyncHandler(requireAuth),
    validate({ body: changePasswordSchema }),
    asyncHandler(changePasswordController),
  );

  return router;
}

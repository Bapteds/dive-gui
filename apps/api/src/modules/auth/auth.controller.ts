// Auth HTTP controllers. Thin layer that adapts requests/responses to the
// auth service and manages the refresh cookie. All handlers are async and are
// wrapped with asyncHandler at the router level.
import type { Request, Response } from 'express';
import { AppError } from '../../lib/AppError';
import { AuditAction, recordAudit, toAuditPrincipal } from '../../lib/audit';
import { clearRefreshCookie, REFRESH_COOKIE_NAME, setRefreshCookie } from './auth.cookies';
import {
  changePassword,
  login,
  refresh,
  revokeRefreshTokens,
  updateOwnProfile,
} from './auth.service';
import type { ChangePasswordInput, LoginInput, UpdateMeInput } from './auth.schemas';

/** POST /auth/login — verify credentials, set refresh cookie, return access token. */
export async function loginController(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as LoginInput;
  const result = await login(email, password);

  setRefreshCookie(res, result.refreshToken);
  await recordAudit({ action: AuditAction.LOGIN, actor: toAuditPrincipal(result.user) });
  res.status(200).json({ accessToken: result.accessToken, user: result.user });
}

/** POST /auth/refresh — exchange a valid refresh cookie for a new access token. */
export async function refreshController(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
  const result = await refresh(token);

  // Rotate the refresh cookie to extend the session and keep it consistent.
  setRefreshCookie(res, result.refreshToken);
  res.status(200).json({ accessToken: result.accessToken, user: result.user });
}

/** POST /auth/logout — revoke refresh tokens and clear the cookie. Requires auth. */
export async function logoutController(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    // Should never happen: route is behind requireAuth.
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  await revokeRefreshTokens(req.user.id);
  clearRefreshCookie(res);
  await recordAudit({ action: AuditAction.LOGOUT, actor: toAuditPrincipal(req.user) });
  res.status(204).send();
}

/** GET /auth/me — return the currently authenticated user. Requires auth. */
export async function meController(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  // req.user already is the public user shape (role included); send it as-is.
  res.status(200).json({ user: req.user });
}

/** PATCH /auth/me — update the current user's own profile (display name). Requires auth. */
export async function updateMeController(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  const user = await updateOwnProfile(req.user.id, req.body as UpdateMeInput);
  await recordAudit({
    action: AuditAction.PROFILE_UPDATED,
    actor: toAuditPrincipal(user),
    target: toAuditPrincipal(user),
  });
  res.status(200).json({ user });
}

/**
 * POST /auth/change-password — verify the current password, set a new one,
 * revoke the user's other sessions, and rotate this session's refresh cookie so
 * the current device stays signed in. Requires auth.
 */
export async function changePasswordController(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  const { currentPassword, newPassword } = req.body as ChangePasswordInput;
  const result = await changePassword(req.user.id, currentPassword, newPassword);

  // All other sessions were just revoked via the tokenVersion bump; re-issue
  // this device's refresh cookie at the new version so it is not logged out.
  setRefreshCookie(res, result.refreshToken);
  await recordAudit({
    action: AuditAction.PASSWORD_CHANGED,
    actor: toAuditPrincipal(result.user),
    target: toAuditPrincipal(result.user),
  });
  res.status(200).json({ accessToken: result.accessToken, user: result.user });
}

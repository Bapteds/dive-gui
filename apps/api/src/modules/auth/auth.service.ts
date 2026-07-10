// Auth business logic, independent of Express.
// Handles credential verification, token issuance, refresh validation against
// the user's tokenVersion, and logout-driven revocation.
import { AppError } from '../../lib/AppError';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../../lib/jwt';
import { dummyVerify, hashPassword, verifyPassword } from '../../lib/password';
import { prisma } from '../../lib/prisma';
import { toRole } from '../../lib/role';
import { toPublicUser, type PublicUser } from '../../lib/serializeUser';

/** Result of a successful authentication: tokens + the public user. */
export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

/**
 * Authenticate with email + password.
 * The same error is returned whether the email is unknown or the password is
 * wrong, to avoid leaking which emails exist.
 * @throws AppError(401, 'INVALID_CREDENTIALS') on any mismatch.
 */
export async function login(email: string, password: string): Promise<AuthResult> {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

  if (!user) {
    // Still run a verify (against a dummy hash) so an unknown email costs the same
    // time as a wrong password — no timing oracle for email enumeration (L2).
    await dummyVerify(password);
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  // Only block disabled accounts AFTER verifying the password, so the response
  // never reveals whether a given email exists to someone guessing passwords.
  if (!user.isActive) {
    throw new AppError(
      403,
      'ACCOUNT_DISABLED',
      'This account has been disabled. Contact your administrator.',
    );
  }

  // Stamp the successful sign-in. Use the updated record so the returned
  // profile (and any audit metadata) reflects the fresh timestamp.
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  return {
    accessToken: signAccessToken({ sub: updated.id, role: toRole(updated.role) }),
    refreshToken: signRefreshToken({ sub: updated.id, tokenVersion: updated.tokenVersion }),
    user: toPublicUser(updated),
  };
}

/**
 * Issue a fresh pair of tokens from a valid refresh token.
 * Verifies the token signature/shape, loads the user, and checks that the
 * token's version still matches the user's current tokenVersion (a logout
 * bumps the version, invalidating older refresh tokens).
 * @throws AppError(401, 'UNAUTHENTICATED') if the token or user is invalid/revoked.
 */
export async function refresh(refreshToken: string | undefined): Promise<AuthResult> {
  if (!refreshToken) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Refresh token missing');
  }

  const payload = verifyRefreshToken(refreshToken);

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Refresh token is no longer valid');
  }

  if (payload.tokenVersion !== user.tokenVersion) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Refresh token has been revoked');
  }

  // A disabled account cannot keep an active session alive via refresh.
  if (!user.isActive) {
    throw new AppError(401, 'UNAUTHENTICATED', 'This account has been disabled');
  }

  return {
    accessToken: signAccessToken({ sub: user.id, role: toRole(user.role) }),
    refreshToken: signRefreshToken({ sub: user.id, tokenVersion: user.tokenVersion }),
    user: toPublicUser(user),
  };
}

/**
 * Revoke a user's outstanding refresh tokens by bumping their tokenVersion.
 * Called on logout. Safe even if the user was already deleted.
 * @param userId The id of the user logging out.
 */
export async function revokeRefreshTokens(userId: string): Promise<void> {
  // updateMany (not update) so a logout AFTER the user was deleted is a no-op
  // instead of a P2025 500 — honouring this function's "safe if deleted" contract (L4).
  await prisma.user.updateMany({
    where: { id: userId },
    data: { tokenVersion: { increment: 1 } },
  });
}

/**
 * Update the current user's own editable profile fields (display name only).
 * Email and role remain administered through the back office.
 * @param userId The authenticated user's id.
 * @param input The validated profile fields.
 * @returns The updated public user.
 */
export async function updateOwnProfile(
  userId: string,
  input: { fullName: string },
): Promise<PublicUser> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { fullName: input.fullName.trim() },
  });
  return toPublicUser(user);
}

/**
 * Change the current user's own password.
 * Verifies the supplied current password, stores the new argon2 hash, and bumps
 * tokenVersion so every OTHER outstanding session is revoked. A fresh token
 * pair is returned so the calling device stays signed in.
 * @param userId The authenticated user's id.
 * @param currentPassword The user's current clear-text password (re-verified).
 * @param newPassword The new clear-text password (already length-validated).
 * @throws AppError(401, 'UNAUTHENTICATED') if the account no longer exists.
 * @throws AppError(400, 'INVALID_PASSWORD') if the current password is wrong.
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<AuthResult> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    // The requester was authenticated a moment ago; if the row is gone, treat
    // it as an authentication failure rather than an unexpected 500.
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  }

  const ok = await verifyPassword(user.passwordHash, currentPassword);
  if (!ok) {
    throw new AppError(400, 'INVALID_PASSWORD', 'Your current password is incorrect');
  }

  const passwordHash = await hashPassword(newPassword);
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { passwordHash, tokenVersion: { increment: 1 } },
  });

  return {
    accessToken: signAccessToken({ sub: updated.id, role: toRole(updated.role) }),
    refreshToken: signRefreshToken({ sub: updated.id, tokenVersion: updated.tokenVersion }),
    user: toPublicUser(updated),
  };
}

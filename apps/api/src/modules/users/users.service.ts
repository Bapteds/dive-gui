// Users business logic (back-office account management), independent of Express.
// Enforces the hard business rules:
//   - emails are unique (case-insensitive, stored lowercased);
//   - the protected super-admin cannot be downgraded, disabled, or deleted;
//   - a user cannot delete or disable their own account.
// Every mutating action records an audit entry (best-effort, never throws).
import { Prisma, type User } from '@prisma/client';
import { AppError } from '../../lib/AppError';
import { AuditAction, recordAudit, type AuditActionCode } from '../../lib/audit';
import { hashPassword } from '../../lib/password';
import { prisma } from '../../lib/prisma';
import { toPublicUser, type PublicUser } from '../../lib/serializeUser';
import type { CreateUserInput, UpdateUserInput } from './users.schemas';

/** Identity of the super-admin performing an action, used for guards + audit. */
export interface Actor {
  id: string;
  email: string;
}

/** Normalize an email for storage and comparison. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Detect Prisma's unique-constraint violation (P2002). */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * List all users, protected/super-admin accounts first, then by creation date.
 * @returns The public users in display order.
 */
export async function listUsers(): Promise<PublicUser[]> {
  const users = await prisma.user.findMany({
    orderBy: [
      { isProtected: 'desc' },
      { role: 'asc' }, // 'SUPER_ADMIN' sorts before 'USER' alphabetically
      { createdAt: 'asc' },
    ],
  });
  return users.map(toPublicUser);
}

/**
 * Fetch a single user by id.
 * @throws AppError(404, 'NOT_FOUND') if no such user exists.
 */
export async function getUser(id: string): Promise<PublicUser> {
  const user = await findOrThrow(id);
  return toPublicUser(user);
}

/**
 * Create a new user account with a hashed password.
 * @throws AppError(409, 'EMAIL_TAKEN') if the email is already in use.
 */
export async function createUser(input: CreateUserInput, actor: Actor): Promise<PublicUser> {
  const email = normalizeEmail(input.email);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new AppError(409, 'EMAIL_TAKEN', 'This email address is already in use');
  }

  const passwordHash = await hashPassword(input.password);

  try {
    const user = await prisma.user.create({
      data: {
        email,
        fullName: input.fullName.trim(),
        passwordHash,
        role: input.role,
        // New accounts are never protected; protection is reserved for the seed admin.
        isProtected: false,
      },
    });
    await recordAudit({
      action: AuditAction.USER_CREATED,
      actor,
      target: { id: user.id, email: user.email },
      metadata: { role: user.role },
    });
    return toPublicUser(user);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(409, 'EMAIL_TAKEN', 'This email address is already in use');
    }
    throw err;
  }
}

/**
 * Update an existing user. Applies business rules around protected accounts and
 * account status, then records the most significant change as an audit entry.
 * @throws AppError(404) if not found, (409, 'PROTECTED_ROLE') downgrading a
 *         protected super-admin, (409, 'PROTECTED_ACCOUNT') disabling it,
 *         (409, 'SELF_DISABLE_FORBIDDEN') disabling your own account,
 *         (409, 'EMAIL_TAKEN') on collision.
 */
export async function updateUser(
  id: string,
  input: UpdateUserInput,
  actor: Actor,
): Promise<PublicUser> {
  const target = await findOrThrow(id);

  // The protected super-admin's role is immutable; it may only stay SUPER_ADMIN.
  if (target.isProtected && input.role !== undefined && input.role !== 'SUPER_ADMIN') {
    throw new AppError(409, 'PROTECTED_ROLE', 'The super-admin role cannot be changed');
  }

  // The protected super-admin can never be disabled (no accidental lockout).
  if (target.isProtected && input.isActive === false) {
    throw new AppError(
      409,
      'PROTECTED_ACCOUNT',
      'The super-admin account is permanent and cannot be disabled',
    );
  }

  // An operator cannot disable their own account (would lock themselves out).
  if (target.id === actor.id && input.isActive === false) {
    throw new AppError(409, 'SELF_DISABLE_FORBIDDEN', 'You cannot disable your own account');
  }

  const data: Prisma.UserUpdateInput = {};

  if (input.fullName !== undefined) {
    data.fullName = input.fullName.trim();
  }

  if (input.email !== undefined) {
    const email = normalizeEmail(input.email);
    if (email !== target.email) {
      const collision = await prisma.user.findUnique({ where: { email } });
      if (collision && collision.id !== target.id) {
        throw new AppError(409, 'EMAIL_TAKEN', 'This email address is already in use');
      }
    }
    data.email = email;
  }

  if (input.role !== undefined) {
    data.role = input.role;
  }

  if (input.password !== undefined) {
    data.passwordHash = await hashPassword(input.password);
  }

  if (input.isActive !== undefined) {
    data.isActive = input.isActive;
  }

  // Compute what actually changed (used for revocation and audit metadata).
  const roleChanged = input.role !== undefined && input.role !== target.role;
  const passwordChanged = input.password !== undefined;
  const deactivated = input.isActive === false && target.isActive;
  const activated = input.isActive === true && !target.isActive;

  // A password reset, an effective role change, or a deactivation must take
  // effect immediately. Bump tokenVersion to revoke the target's outstanding
  // refresh tokens: once their short-lived access token expires (or, when
  // disabled, on the very next request) they are forced out. A no-op write
  // (same value) does not bump.
  if (roleChanged || passwordChanged || deactivated) {
    data.tokenVersion = { increment: 1 };
  }

  let user: User;
  try {
    user = await prisma.user.update({ where: { id }, data });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(409, 'EMAIL_TAKEN', 'This email address is already in use');
    }
    throw err;
  }

  // Record the most significant action. A status transition is logged as its
  // own event (more searchable); otherwise a generic update with changed fields.
  const changed: string[] = [];
  if (input.fullName !== undefined && target.fullName !== user.fullName) changed.push('fullName');
  if (input.email !== undefined && target.email !== user.email) changed.push('email');
  if (roleChanged) changed.push('role');
  if (passwordChanged) changed.push('password');

  let action: AuditActionCode = AuditAction.USER_UPDATED;
  if (deactivated) action = AuditAction.USER_DISABLED;
  else if (activated) action = AuditAction.USER_ENABLED;

  await recordAudit({
    action,
    actor,
    target: { id: user.id, email: user.email },
    metadata: {
      ...(changed.length > 0 ? { changed } : {}),
      ...(roleChanged ? { roleFrom: target.role, roleTo: user.role } : {}),
    },
  });

  return toPublicUser(user);
}

/**
 * Delete a user. Guards the protected account and self-deletion.
 * @param id The id of the user to delete.
 * @param actor The requester (blocks self-deletion, attributes the audit entry).
 * @throws AppError(404) if not found, (409, 'PROTECTED_ACCOUNT') for the
 *         super-admin, (409, 'SELF_DELETE_FORBIDDEN') for self-deletion.
 */
export async function deleteUser(id: string, actor: Actor): Promise<void> {
  const target = await findOrThrow(id);

  if (target.isProtected) {
    throw new AppError(
      409,
      'PROTECTED_ACCOUNT',
      'The super-admin account is permanent and cannot be deleted',
    );
  }

  if (target.id === actor.id) {
    throw new AppError(409, 'SELF_DELETE_FORBIDDEN', 'You cannot delete your own account');
  }

  await prisma.user.delete({ where: { id } });

  await recordAudit({
    action: AuditAction.USER_DELETED,
    actor,
    target: { id: target.id, email: target.email },
    metadata: { role: target.role },
  });
}

/** Load a user by id or throw a 404. */
async function findOrThrow(id: string): Promise<User> {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    throw new AppError(404, 'NOT_FOUND', 'User not found');
  }
  return user;
}

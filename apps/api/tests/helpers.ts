// Shared test helpers: app instance, DB reset, and fixtures.
// Keeping these in one place keeps the test files focused on behavior.
import type { User } from '@prisma/client';
import { createApp } from '../src/app';
import { hashPassword } from '../src/lib/password';
import { prisma } from '../src/lib/prisma';
import { signAccessToken, signRefreshToken } from '../src/lib/jwt';
import { toRole } from '../src/lib/role';

/** A single Express app instance shared across tests. */
export const app = createApp();

/** Remove all rows so each test starts from a clean slate. */
export async function resetDatabase(): Promise<void> {
  await prisma.auditLog.deleteMany();
  await prisma.run.deleteMany();
  await prisma.template.deleteMany();
  await prisma.project.deleteMany();
  await prisma.user.deleteMany();
}

/** Options for creating a test user fixture. */
interface CreateTestUserOptions {
  email?: string;
  fullName?: string;
  password?: string;
  role?: 'SUPER_ADMIN' | 'USER';
  isProtected?: boolean;
}

/** Default clear-text password used by fixtures (meets the 8-char minimum). */
export const DEFAULT_PASSWORD = 'Sup3rSecret!';

/**
 * Create a user directly in the database (bypassing the API), hashing the
 * password with the real argon2 helper so login works against the fixture.
 */
export async function createTestUser(options: CreateTestUserOptions = {}): Promise<User> {
  const {
    email = 'user@dive-turbinen.test',
    fullName = 'Regular User',
    password = DEFAULT_PASSWORD,
    role = 'USER',
    isProtected = false,
  } = options;

  return prisma.user.create({
    data: {
      email: email.toLowerCase(),
      fullName,
      passwordHash: await hashPassword(password),
      role,
      isProtected,
    },
  });
}

/** Create the protected super-admin fixture used by most tests. */
export async function createProtectedAdmin(
  options: Omit<CreateTestUserOptions, 'role' | 'isProtected'> = {},
): Promise<User> {
  return createTestUser({
    email: options.email ?? 'admin@dive-turbinen.test',
    fullName: options.fullName ?? 'Protected Admin',
    password: options.password ?? DEFAULT_PASSWORD,
    role: 'SUPER_ADMIN',
    isProtected: true,
  });
}

/** Sign a valid access token for a given user (used to authenticate requests). */
export function accessTokenFor(user: User): string {
  return signAccessToken({ sub: user.id, role: toRole(user.role) });
}

/** Sign a valid refresh token for a given user at its current tokenVersion. */
export function refreshTokenFor(user: User): string {
  return signRefreshToken({ sub: user.id, tokenVersion: user.tokenVersion });
}

/** Build the Authorization header value for a user. */
export function authHeader(user: User): string {
  return `Bearer ${accessTokenFor(user)}`;
}

/**
 * Extract the value of the refresh_token cookie from a supertest response's
 * Set-Cookie header. Returns the raw token (without attributes), or null.
 */
export function extractRefreshCookie(setCookie: string[] | string | undefined): string | null {
  if (!setCookie) return null;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const target = cookies.find((c) => c.startsWith('refresh_token='));
  if (!target) return null;
  const value = target.split(';')[0].split('=')[1];
  return value || null;
}

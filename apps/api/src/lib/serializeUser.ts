// User serialization: convert a Prisma User record into the public shape that
// is safe to send over the wire. Strips secrets (passwordHash) and internal
// fields (tokenVersion). Dates are emitted as ISO 8601 strings.
import type { User } from '@prisma/client';
import { toRole, type Role } from './role';

/** Public, wire-safe representation of a user. The frontend depends on this shape. */
export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  isProtected: boolean;
  /** false = disabled account: cannot log in or refresh until re-enabled. */
  isActive: boolean;
  /** ISO 8601 timestamp of the last successful login, or null if never. */
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Convert a full Prisma user into its public representation.
 * @param user The database user record.
 * @returns The public user (no passwordHash, no tokenVersion).
 */
export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: toRole(user.role),
    isProtected: user.isProtected,
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

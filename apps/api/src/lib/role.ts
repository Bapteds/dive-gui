// Role helpers around the shared account-role union.
// The database stores `role` as a String (SQLite has no native enums), so this
// helper narrows the raw DB value back into the strict union the rest of the
// codebase relies on. Any unexpected value defaults safely to 'USER'. The union
// and its values come from @dive/shared so the API and web client never drift.
import { ROLES, type Role } from '@dive/shared';

export { ROLES, type Role };

/** Type guard for a valid role string. */
export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * Narrow an arbitrary DB string into the Role union.
 * Falls back to 'USER' for any unexpected value (defensive; should not occur
 * because writes are validated by zod).
 * @param value The raw role value from the database.
 * @returns A strict Role.
 */
export function toRole(value: string): Role {
  return isRole(value) ? value : 'USER';
}

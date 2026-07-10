// Password hashing helpers built on argon2 (argon2id variant by default).
// We never store or log clear-text passwords — only the resulting hash.
import argon2 from 'argon2';

/**
 * Hash a clear-text password using argon2id with library defaults.
 * @param plain The clear-text password.
 * @returns The encoded argon2 hash string (includes salt and parameters).
 */
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

/**
 * Verify a clear-text password against a stored argon2 hash.
 * Returns false instead of throwing on malformed hashes.
 * @param hash The stored argon2 hash.
 * @param plain The clear-text password to check.
 * @returns True if the password matches the hash.
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // A malformed/unsupported hash must read as "does not match", not crash.
    return false;
  }
}

/**
 * A fixed, valid argon2id hash (default params) used ONLY to equalize login
 * timing. Its plaintext is a throwaway — nothing authenticates against it.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$yKuzpxwjuqPUjjz4gGeL7g$QpmIM8WDo1B2ycFlhcL4dV9dLBxyE1nmAg4G+cAvzo8';

/**
 * Run a verify against a dummy hash so an UNKNOWN-email login costs the same time
 * as a wrong-password login, closing the timing oracle that would otherwise let an
 * attacker enumerate which emails exist (L2).
 */
export async function dummyVerify(plain: string): Promise<void> {
  await verifyPassword(DUMMY_HASH, plain);
}

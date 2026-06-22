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

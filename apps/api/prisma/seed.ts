// Database seed: idempotently provision the permanent super-admin account.
// Reads SEED_ADMIN_* from the validated env, hashes the password with argon2,
// and upserts the account so running this multiple times never duplicates it.
import { env } from '../src/config/env';
import { hashPassword } from '../src/lib/password';
import { prisma } from '../src/lib/prisma';
import { logger } from '../src/lib/logger';

/** Create or update the protected super-admin from environment variables. */
async function main(): Promise<void> {
  const email = env.SEED_ADMIN_EMAIL.trim().toLowerCase();
  const passwordHash = await hashPassword(env.SEED_ADMIN_PASSWORD);

  const admin = await prisma.user.upsert({
    where: { email },
    // On update, keep the account in sync but DO NOT touch the password: re-seeding
    // (every deploy) previously reset it to SEED_ADMIN_PASSWORD, silently reverting
    // a password the admin had changed in the app (L12). The password is only set on
    // first CREATE; a lost password is recovered out-of-band, not by re-seeding.
    update: {
      fullName: env.SEED_ADMIN_NAME,
      role: 'SUPER_ADMIN',
      isProtected: true,
    },
    create: {
      email,
      fullName: env.SEED_ADMIN_NAME,
      role: 'SUPER_ADMIN',
      isProtected: true,
      passwordHash,
    },
  });

  logger.info(`Seed complete: super-admin ready (${admin.email}, id=${admin.id}).`);
}

main()
  .catch((err) => {
    logger.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });

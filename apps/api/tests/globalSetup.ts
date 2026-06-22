// Vitest global setup.
// Provisions a fresh, isolated SQLite test database before the suite runs by
// pushing the Prisma schema with --force-reset. This drops and recreates the
// schema so every run starts from a clean, known state. The dev database is
// never touched because DATABASE_URL is overridden to the test file.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Absolute path to the api package root (this file lives in <api>/tests). */
const API_ROOT = path.resolve(__dirname, '..');

/** The dedicated test database URL (relative to the Prisma schema dir => prisma/test.db). */
const TEST_DATABASE_URL = 'file:./test.db';

/** Global setup entrypoint: reset the test schema once for the whole run. */
export default function setup(): void {
  // `prisma db push --force-reset` recreates the schema from scratch. We skip
  // client generation (already generated) for speed. Run with the test DB URL
  // so the dev database is untouched.
  execFileSync(
    'npx',
    ['prisma', 'db', 'push', '--force-reset', '--skip-generate', '--accept-data-loss'],
    {
      cwd: API_ROOT,
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      // npx is a .cmd shim on Windows; a shell is required to resolve it.
      shell: true,
    },
  );
}

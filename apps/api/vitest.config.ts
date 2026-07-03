// Vitest configuration for the API.
// Runs against an isolated SQLite test database (prisma/test.db) so the dev
// database is never touched. Environment variables are injected here via
// `test.env`; because config/env.ts uses `dotenv/config` (which does NOT
// override variables already present in process.env), these values win over
// anything in .env during the test run.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A Node environment for backend/supertest tests.
    environment: 'node',
    // Inject a fully-valid, test-only environment.
    env: {
      NODE_ENV: 'test',
      // Relative to the Prisma schema directory (prisma/), i.e. prisma/test.db.
      DATABASE_URL: 'file:./test.db',
      JWT_ACCESS_SECRET: 'test-access-secret',
      JWT_REFRESH_SECRET: 'test-refresh-secret',
      ACCESS_TOKEN_TTL: '15m',
      REFRESH_TOKEN_TTL_DAYS: '7',
      CORS_ORIGIN: 'http://localhost:5173',
      // Isolated, git-ignored storage root so tests never touch dev uploads.
      STORAGE_DIR: './test-storage',
      // Point the conversion's script-existence check at a committed stub (the
      // real python/CgnsToVtk.py lives outside the repo); the command runner is
      // faked in the tests, so the stub is never executed.
      CGNS_TO_VTK_SCRIPT: './tests/fixtures/CgnsToVtk.py',
      // Same idea for the mesh extractor: point at a committed stub (the real
      // script needs PyVista) — the command runner is faked, so it never runs.
      EXTRACT_PATCHES_SCRIPT: './tests/fixtures/extractPatches.py',
      // Short stop grace so the solver-run stop test does not wait 30 s for the
      // SIGTERM escalation (the stream runner is faked, so this only paces tests).
      RUN_STOP_GRACE_MS: '50',
      // Deterministic core budget for the parallel-run tests (not the CI machine's).
      SOLVER_TOTAL_CORES: '8',
      SEED_ADMIN_EMAIL: 'admin@dive-turbinen.test',
      SEED_ADMIN_PASSWORD: 'TestAdminPassw0rd!',
      SEED_ADMIN_NAME: 'Test Super Admin',
    },
    // Create the schema once before the whole suite.
    globalSetup: ['./tests/globalSetup.ts'],
    // Run test files sequentially against the single shared SQLite file to
    // avoid cross-file write contention on the same database.
    fileParallelism: false,
    include: ['tests/**/*.test.ts'],
    // Generous timeout: argon2 hashing is intentionally slow.
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});

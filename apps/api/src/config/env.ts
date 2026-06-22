// Centralized, validated environment configuration.
// Loads variables from .env, validates them with zod, and exposes a typed,
// frozen `env` object. Importing this module fails fast with a clear error
// if any required variable is missing or malformed.
import 'dotenv/config';
import { z } from 'zod';

/**
 * Schema for all environment variables consumed by the API.
 * Keep this in sync with `.env.example`.
 */
/**
 * Minimum secret length accepted in production. Short secrets are brute-forceable
 * and must never reach a deployed environment.
 */
const PROD_SECRET_MIN_LENGTH = 32;

/** Known development placeholders that must not be reused in production. */
const DEV_PLACEHOLDER_SECRETS = new Set([
  'dev-access-secret-change-me',
  'dev-refresh-secret-change-me',
  'ChangeMe!2026',
]);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    JWT_ACCESS_SECRET: z.string().min(1, 'JWT_ACCESS_SECRET is required'),
    JWT_REFRESH_SECRET: z.string().min(1, 'JWT_REFRESH_SECRET is required'),
    ACCESS_TOKEN_TTL: z.string().min(1).default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
    CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
    // Root directory under which uploaded OpenFOAM case files are stored, one
    // subtree per project. Resolved relative to the API process working
    // directory. Defaults to ./storage (i.e. apps/api/storage in local dev).
    STORAGE_DIR: z.string().min(1).default('./storage'),
    // Maximum size (in MB) accepted for a single uploaded case file. CFD meshes
    // can be large (the points/owner files especially), so this is generous.
    // Note: uploads are currently buffered in memory, so very large values cost
    // RAM per concurrent upload; raise deliberately on a server with headroom.
    MAX_UPLOAD_MB: z.coerce.number().int().positive().default(1024),
    // Number of trusted reverse-proxy hops in front of the API. 0 = trust none
    // (default, correct for direct exposure / local dev). Set to 1 behind a
    // single proxy/load balancer so the login rate-limiter keys on the real
    // client IP (X-Forwarded-For) instead of the proxy address.
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    SEED_ADMIN_EMAIL: z.string().email(),
    SEED_ADMIN_PASSWORD: z.string().min(1, 'SEED_ADMIN_PASSWORD is required'),
    SEED_ADMIN_NAME: z.string().min(1, 'SEED_ADMIN_NAME is required'),
  })
  // Production must not run on weak or placeholder secrets. These checks are
  // inert in development/test so local onboarding stays frictionless.
  .superRefine((data, ctx) => {
    if (data.NODE_ENV !== 'production') return;

    const secretFields = [
      { key: 'JWT_ACCESS_SECRET', value: data.JWT_ACCESS_SECRET },
      { key: 'JWT_REFRESH_SECRET', value: data.JWT_REFRESH_SECRET },
    ] as const;

    for (const { key, value } of secretFields) {
      if (value.length < PROD_SECRET_MIN_LENGTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} must be at least ${PROD_SECRET_MIN_LENGTH} characters in production`,
        });
      }
      if (DEV_PLACEHOLDER_SECRETS.has(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is a development placeholder and must be replaced in production`,
        });
      }
    }

    if (data.JWT_ACCESS_SECRET === data.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message: 'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET in production',
      });
    }

    if (DEV_PLACEHOLDER_SECRETS.has(data.SEED_ADMIN_PASSWORD)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SEED_ADMIN_PASSWORD'],
        message: 'SEED_ADMIN_PASSWORD is a development placeholder and must be replaced in production',
      });
    }
  });

/** Inferred, fully-typed shape of the validated environment. */
export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Surface a readable summary of every invalid/missing variable, then abort.
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

/** Validated, immutable environment configuration for the whole API. */
export const env: Readonly<Env> = Object.freeze(parsed.data);

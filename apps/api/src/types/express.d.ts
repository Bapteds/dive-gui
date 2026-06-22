// Ambient type augmentation for Express.
// Adds the authenticated user (set by requireAuth) and the validated request
// payload (set by the validate middleware) to the Request object so route
// handlers can access them in a type-safe way.
import type { Role } from '../lib/role';
import type { PublicUser } from '../lib/serializeUser';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * The authenticated user, populated by `requireAuth`. The public user
       * fields are exposed plus the raw role for guard checks.
       */
      user?: PublicUser & { role: Role };
      /**
       * The request payload after zod validation, populated by `validate`.
       * Shape depends on the route's schema; handlers cast it as needed.
       */
      validated?: {
        body?: unknown;
        params?: unknown;
        query?: unknown;
      };
    }
  }
}

// Ensure this file is treated as a module so the global augmentation applies.
export {};

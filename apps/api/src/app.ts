// Express application factory.
// Assembles middleware and routes into a configured app. Kept free of any
// listening logic so it can be imported directly by tests (supertest).
import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { createAuthRouter } from './modules/auth/auth.routes';
import { createUsersRouter } from './modules/users/users.routes';
import { createAuditRouter } from './modules/audit/audit.routes';
import { createProjectsRouter } from './modules/projects/projects.routes';
import { createTemplatesRouter } from './modules/templates/templates.routes';
import { createMeshingRouter } from './modules/meshing/meshing.routes';
import { createDashboardRouter } from './modules/dashboard/dashboard.routes';

/** Routes whose JSON body is parsed with a larger limit by their own router (M9). */
const APPLY_TEMPLATE_PATH = /^\/api\/v1\/projects\/[^/]+\/apply-template\/[^/]+(\/files)?$/;
function isLargeJsonRoute(method: string, path: string): boolean {
  if (method !== 'POST') return false;
  // Template create (optional inline file up to EDITABLE_FILE_MAX_BYTES).
  if (path === '/api/v1/templates') return true;
  // Apply a template to a case: decisions map / selected paths (up to 1000 files).
  return APPLY_TEMPLATE_PATH.test(path);
}

/**
 * Create and configure the Express application.
 * @returns A ready-to-listen Express instance.
 */
export function createApp(): Express {
  const app = express();

  // Trust exactly the configured number of reverse-proxy hops so the real
  // client IP (used by the login rate-limiter) is read from X-Forwarded-For.
  // Defaults to 0 (trust none) which is correct for direct exposure / local dev.
  app.set('trust proxy', env.TRUST_PROXY);

  // Security headers.
  app.use(helmet());

  // Cross-origin requests from the web client, with credentials so the
  // httpOnly refresh cookie can be sent/received.
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      credentials: true,
    }),
  );

  // Body and cookie parsing. Most routes cap JSON bodies at 16kb (rejecting
  // oversized bodies that could exhaust memory). A few legitimately carry larger
  // JSON — a template's inline file (up to EDITABLE_FILE_MAX_BYTES) and apply
  // decisions / selected paths for up to 1000 files — so the small global parser is
  // skipped for them and their router parses with its own larger limit (M9). Without
  // this, pasting any real OpenFOAM dict into "create template" hit a raw 413.
  const smallJson = express.json({ limit: '16kb' });
  app.use((req, res, next) => {
    if (isLargeJsonRoute(req.method, req.path)) return next();
    return smallJson(req, res, next);
  });
  app.use(cookieParser());

  // Liveness/health probe.
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // Public feature flags the web client reads at load (no auth: only booleans). Lets
  // the client hide the Terminal button when the shell endpoint is disabled server-side.
  app.get('/api/v1/config', (_req: Request, res: Response) => {
    res.json({ terminalEnabled: env.TERMINAL_ENABLED === 'true' });
  });

  // API routers mounted under /api/v1 (auth, users, audit, projects).
  app.use('/api/v1/auth', createAuthRouter());
  app.use('/api/v1/users', createUsersRouter());
  app.use('/api/v1/audit-logs', createAuditRouter());
  app.use('/api/v1/projects', createProjectsRouter());
  app.use('/api/v1/templates', createTemplatesRouter());
  app.use('/api/v1/meshing', createMeshingRouter());
  app.use('/api/v1/dashboard', createDashboardRouter());

  // 404 + error handling must be registered last.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

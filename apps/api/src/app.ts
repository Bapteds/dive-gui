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
import { createChamberRouter } from './modules/chamber/chamber.routes';
import { createDashboardRouter } from './modules/dashboard/dashboard.routes';

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

  // Body and cookie parsing. The JSON limit caps request bodies well above any
  // legitimate payload (the largest is a user form) while rejecting oversized
  // bodies that could be used to exhaust memory.
  app.use(express.json({ limit: '16kb' }));
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
  app.use('/api/v1/chamber', createChamberRouter());
  app.use('/api/v1/dashboard', createDashboardRouter());

  // 404 + error handling must be registered last.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

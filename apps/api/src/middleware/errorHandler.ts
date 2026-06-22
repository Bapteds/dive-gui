// Express error-handling and not-found middleware.
// Produces a normalized JSON error envelope: { error: { code, message } }.
// The Backend Engineer will extend this (e.g. mapping zod/Prisma errors and
// custom AppError types); the current implementation is fully functional.
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../lib/logger';

/** Normalized error payload returned by the API. */
interface ErrorBody {
  error: {
    code: string;
    message: string;
  };
}

/**
 * Optional shape for errors that already carry an HTTP status / machine code.
 * Plain `Error` instances are treated as 500s.
 */
interface HttpLikeError extends Error {
  status?: number;
  statusCode?: number;
  code?: string;
}

/**
 * 404 handler for unmatched routes. Mounted after all routers so any request
 * that reaches it has no matching handler.
 */
export function notFoundHandler(req: Request, res: Response): void {
  const body: ErrorBody = {
    error: {
      code: 'NOT_FOUND',
      message: `Route not found: ${req.method} ${req.originalUrl}`,
    },
  };
  res.status(404).json(body);
}

/**
 * Centralized error handler. Must keep the 4-argument signature so Express
 * recognizes it as an error-handling middleware.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // `next` is required for Express to treat this as an error handler, even
  // though we do not forward the error further.
  _next: NextFunction,
): void {
  const error = err as HttpLikeError;
  const status = error?.status ?? error?.statusCode ?? 500;
  const code = error?.code ?? (status === 500 ? 'INTERNAL_SERVER_ERROR' : 'ERROR');
  const message =
    status === 500 ? 'Internal server error' : (error?.message ?? 'Unexpected error');

  // Always log the underlying error server-side; never leak internals to clients.
  logger.error('Request failed:', error);

  const body: ErrorBody = { error: { code, message } };
  res.status(status).json(body);
}

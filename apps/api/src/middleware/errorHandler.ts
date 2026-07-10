// Express error-handling and not-found middleware.
// Produces a normalized JSON error envelope: { error: { code, message } }.
// The Backend Engineer will extend this (e.g. mapping zod/Prisma errors and
// custom AppError types); the current implementation is fully functional.
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../lib/logger';
import { AppError } from '../lib/AppError';

/** Normalized error payload returned by the API. */
interface ErrorBody {
  error: {
    code: string;
    message: string;
    /** Optional structured context (e.g. field-level validation issues). */
    details?: unknown;
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
  // A trusted, client-facing AppError: surface its exact status / code / message
  // (and optional details, e.g. field-level validation issues — L3). This is the
  // ONLY path that echoes a code/message from the error to the client.
  if (err instanceof AppError) {
    logger.error('Request failed:', err.message);
    const body: ErrorBody = { error: { code: err.code, message: err.message } };
    if (err.details !== undefined) body.error.details = err.details;
    res.status(err.status).json(body);
    return;
  }

  // Any other error: a framework 4xx (e.g. body-parser 413/400) keeps its status but
  // NOT its internal code/message; anything else is an unexpected server fault. Never
  // put a Prisma code (P2025), an fs code (ENOENT) or a raw message on the wire (L3);
  // the full error is only logged server-side.
  const error = err as HttpLikeError;
  const rawStatus = error?.status ?? error?.statusCode ?? 500;
  const status = rawStatus >= 400 && rawStatus < 600 ? rawStatus : 500;
  const isServerError = status >= 500;
  logger.error('Unhandled error:', error);

  const body: ErrorBody = {
    error: {
      code: isServerError ? 'INTERNAL_SERVER_ERROR' : 'ERROR',
      message: isServerError ? 'Internal server error' : (error?.message ?? 'Request error'),
    },
  };
  res.status(status).json(body);
}

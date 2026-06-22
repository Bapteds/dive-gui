// Wrapper that forwards errors thrown by async route handlers to Express's
// error-handling middleware. Without this, a rejected promise inside an async
// handler would not be caught and the central errorHandler would never run.
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** An async (or sync) Express handler that may return a promise. */
type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void | Promise<void>;

/**
 * Wrap an async handler so any thrown/rejected error is passed to `next`.
 * @param handler The async route handler to wrap.
 * @returns A standard Express RequestHandler.
 */
export function asyncHandler(handler: AsyncRequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

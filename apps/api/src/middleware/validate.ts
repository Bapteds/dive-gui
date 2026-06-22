// Request validation middleware backed by zod.
// Validates any combination of body / params / query against the provided
// schemas. On failure it throws AppError(422, 'VALIDATION_ERROR', ...) with a
// readable message and field-level details. On success the parsed (and thus
// coerced/defaulted) values are written back onto the request.
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny } from 'zod';
import { AppError } from '../lib/AppError';

/** Schemas to apply to the request, all optional. */
export interface ValidationSchemas {
  body?: ZodTypeAny;
  params?: ZodTypeAny;
  query?: ZodTypeAny;
}

/** Flatten a ZodError into a compact, client-safe list of issues. */
function formatIssues(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

/** Build a single human-readable message from a ZodError. */
function summarize(error: ZodError): string {
  const first = error.issues[0];
  if (!first) return 'Validation failed';
  const path = first.path.join('.');
  return path ? `${path}: ${first.message}` : first.message;
}

/**
 * Create a validation middleware for the given schemas.
 * Parsed results are stored both on `req.validated.*` and written back onto
 * the native `req.body` / `req.params` / `req.query` for convenience.
 * @param schemas The body/params/query zod schemas to enforce.
 * @returns An Express RequestHandler.
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      req.validated = req.validated ?? {};

      if (schemas.body) {
        const parsed = schemas.body.parse(req.body);
        req.body = parsed;
        req.validated.body = parsed;
      }
      if (schemas.params) {
        const parsed = schemas.params.parse(req.params);
        // req.params is read-only in some setups; assign field by field.
        Object.assign(req.params, parsed);
        req.validated.params = parsed;
      }
      if (schemas.query) {
        const parsed = schemas.query.parse(req.query);
        Object.assign(req.query, parsed);
        req.validated.query = parsed;
      }

      next();
    } catch (err) {
      if (err instanceof ZodError) {
        next(new AppError(422, 'VALIDATION_ERROR', summarize(err), formatIssues(err)));
        return;
      }
      next(err);
    }
  };
}

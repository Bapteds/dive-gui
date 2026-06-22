// Rate limiting for sensitive endpoints.
// The login limiter throttles brute-force attempts against POST /auth/login.
// It uses standard RateLimit-* headers and returns the normalized error
// envelope { error: { code, message } } on limit, matching the rest of the API.
import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';

/**
 * Limiter for the login route: 10 attempts per 15 minutes per IP.
 * In the test environment the limit is relaxed so the suite is not throttled.
 */
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: process.env.NODE_ENV === 'test' ? 1000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response): void => {
    res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many login attempts. Please try again later.',
      },
    });
  },
});

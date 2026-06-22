// Zod schemas for the audit-log module (read-only listing).
import { z } from 'zod';

/** Default and maximum number of audit entries returned in one page. */
export const AUDIT_DEFAULT_LIMIT = 50;
export const AUDIT_MAX_LIMIT = 200;

/** Query for GET /audit-logs: an optional page size (coerced, clamped by schema). */
export const listAuditLogsQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(AUDIT_MAX_LIMIT)
    .default(AUDIT_DEFAULT_LIMIT),
});

/** Inferred, coerced query type. */
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;

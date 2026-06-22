// Zod schemas for the case-file content endpoints.
import { z } from 'zod';

/** Query carrying a case-relative file path (e.g. ?path=system/controlDict). */
export const filePathQuerySchema = z.object({
  path: z.string().trim().min(1, 'A file path is required'),
});

export type FilePathQuery = z.infer<typeof filePathQuerySchema>;

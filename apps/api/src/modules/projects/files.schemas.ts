// Zod schemas for the case-file content endpoints.
import { z } from 'zod';

/** Query carrying a case-relative file path (e.g. ?path=system/controlDict). */
export const filePathQuerySchema = z.object({
  path: z.string().trim().min(1, 'A file path is required'),
});

export type FilePathQuery = z.infer<typeof filePathQuerySchema>;

/** Body for creating a new (empty) case file from the editor. */
export const createFileSchema = z.object({
  path: z.string().trim().min(1, 'A file path is required'),
});

export type CreateFileInput = z.infer<typeof createFileSchema>;

/** Body for moving/renaming a file or directory: source and destination paths. */
export const movePathSchema = z.object({
  from: z.string().trim().min(1, 'A source path is required'),
  to: z.string().trim().min(1, 'A destination path is required'),
});

export type MovePathInput = z.infer<typeof movePathSchema>;

import { z } from 'zod';
import { TEMPLATE_DESCRIPTION_MAX_LENGTH, TEMPLATE_NAME_MAX_LENGTH } from '@dive/shared';

/**
 * schemas.ts - zod schema for the template create / edit form.
 *
 * Name is required; description + tags are optional. Tags are entered as a free
 * comma/space list and normalized server-side. On create the operator can start a
 * single-file template inline (path + content); a single-file template requires a
 * path (validated below). Lengths come from the shared contract.
 */

const name = z
  .string()
  .trim()
  .min(1, 'Enter a name.')
  .max(TEMPLATE_NAME_MAX_LENGTH, `Use ${TEMPLATE_NAME_MAX_LENGTH} characters or fewer.`);

const description = z
  .string()
  .trim()
  .max(TEMPLATE_DESCRIPTION_MAX_LENGTH, `Use ${TEMPLATE_DESCRIPTION_MAX_LENGTH} characters or fewer.`);

export const templateFormSchema = z
  .object({
    name,
    /** Free-form comma/space separated tags; normalized on submit + server-side. */
    tags: z.string().max(400, 'That is a lot of tags.').optional(),
    description: description.optional(),
    /** Create-only: how the template starts. */
    kind: z.enum(['set', 'file']).default('set'),
    /** Single-file path, e.g. `system/fvSolution` (required when kind === 'file'). */
    path: z.string().trim().max(300, 'That path is too long.').optional(),
    /** Single-file content. */
    content: z.string().optional(),
  })
  .superRefine((values, ctx) => {
    if (values.kind === 'file' && !values.path?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['path'], message: 'Enter a file path.' });
    }
  });

export type TemplateFormValues = z.infer<typeof templateFormSchema>;

/** Split a free-form tag string into individual raw tags (server normalizes them). */
export function parseTagInput(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

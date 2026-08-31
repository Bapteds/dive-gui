// Zod schemas for the saved-chamber-build endpoints. A save's snapshot is the
// exact POST /chamber/build body, so it is validated with the SAME schema the
// build endpoint uses — a save can never hold an unbuildable state.
import { z } from 'zod';
import { CHAMBER_SAVE_NAME_MAX } from '@dive/shared';
import { chamberBuildSchema } from './chamber.schemas';

/** A save's display name: trimmed, non-empty, bounded. */
const saveNameSchema = z
  .string()
  .trim()
  .min(1, 'A name is required')
  .max(CHAMBER_SAVE_NAME_MAX, `At most ${CHAMBER_SAVE_NAME_MAX} characters`);

/** Body for POST /chamber/saves — create a named snapshot. */
export const chamberSaveCreateSchema = z.object({
  name: saveNameSchema,
  snapshot: chamberBuildSchema,
});
export type ChamberSaveCreateInput = z.infer<typeof chamberSaveCreateSchema>;

/**
 * Body for PUT /chamber/saves/:id — overwrite the snapshot and/or rename.
 * At least one of the two must be present.
 */
export const chamberSaveUpdateSchema = z
  .object({
    name: saveNameSchema.optional(),
    snapshot: chamberBuildSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.snapshot !== undefined, {
    message: 'Provide a new name, a new snapshot, or both',
  });
export type ChamberSaveUpdateInput = z.infer<typeof chamberSaveUpdateSchema>;

/** Route params carrying a save id. */
export const chamberSaveIdParamSchema = z.object({
  id: z.string().trim().min(1, 'A save id is required'),
});

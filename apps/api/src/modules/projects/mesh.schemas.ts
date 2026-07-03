// Zod schemas for the 3D mesh viewer endpoints.
import { z } from 'zod';
import { MESH_PATCH_SETTINGS } from '@dive/shared';

/**
 * Body for renaming a boundary patch. `to` must be a valid OpenFOAM word (a
 * single token, letters/digits/underscore, not starting with a digit); an
 * invalid value is rejected as a 422 before the service runs.
 */
export const renamePatchSchema = z.object({
  /** Current patch name. */
  from: z.string().trim().min(1, 'The current patch name is required'),
  /** New patch name (a single OpenFOAM word). */
  to: z
    .string()
    .trim()
    .min(1, 'A new patch name is required')
    .max(80, 'Patch name is too long')
    .regex(
      /^[A-Za-z_][A-Za-z0-9_]*$/,
      'Use letters, digits, or underscore; it must not start with a digit',
    ),
});

export type RenamePatchInput = z.infer<typeof renamePatchSchema>;

/**
 * Body for the autoPatch action. `featureAngle` is the dihedral angle (in
 * degrees) above which adjacent external boundary faces are split into separate
 * patches; OpenFOAM expects a scalar in [0, 180]. Coerced from the JSON number
 * and defaulted to 45 when omitted. Because it is validated to a finite number,
 * it is always a safe argv token (no shell metacharacters can reach the tool).
 */
export const autoPatchSchema = z.object({
  featureAngle: z.coerce
    .number({ invalid_type_error: 'The feature angle must be a number' })
    .min(0, 'The feature angle must be at least 0°')
    .max(180, 'The feature angle must be at most 180°')
    .default(45),
});

export type AutoPatchInput = z.infer<typeof autoPatchSchema>;

/**
 * Body for setting a boundary patch's geometric type OR flow role. `type` must be
 * one of `MESH_PATCH_SETTINGS` (the geometric types plus inlet/outlet roles); a
 * constraint type or a role is then propagated into the 0/ fields by the service.
 */
export const setPatchTypeSchema = z.object({
  /** Patch whose type to change. */
  patch: z.string().trim().min(1, 'The patch name is required'),
  /** New geometric type or flow role. */
  type: z.enum(MESH_PATCH_SETTINGS),
});

export type SetPatchTypeInput = z.infer<typeof setPatchTypeSchema>;

/**
 * Body for a BATCH patch edit (the Visualize "edit names & types" overlay):
 * a non-empty list of `{ from, to, type }`. Each `to` is a valid OpenFOAM word
 * and each `type` one of `MESH_PATCH_TYPES`; cross-edit checks (existence,
 * collisions, duplicate `from`) are done by the service against the live mesh.
 */
export const editPatchesSchema = z.object({
  edits: z
    .array(
      z.object({
        from: z.string().trim().min(1, 'The current patch name is required'),
        to: z
          .string()
          .trim()
          .min(1, 'A new patch name is required')
          .max(80, 'Patch name is too long')
          .regex(
            /^[A-Za-z_][A-Za-z0-9_]*$/,
            'Use letters, digits, or underscore; it must not start with a digit',
          ),
        type: z.enum(MESH_PATCH_SETTINGS),
      }),
    )
    .min(1, 'At least one patch edit is required'),
});

export type EditPatchesInput = z.infer<typeof editPatchesSchema>;

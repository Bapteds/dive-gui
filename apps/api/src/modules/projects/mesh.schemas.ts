// Zod schemas for the 3D mesh viewer endpoints.
import { z } from 'zod';

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

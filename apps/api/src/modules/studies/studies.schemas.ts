// Validation schemas of the optimisation study routes (WS-H spec §7, nested under
// /projects/:id/studies by the §0 amendment).
import { z } from 'zod';
import {
  CHAMBER_OUTPUT_KEYS,
  STUDY_MAX_EVALUATIONS,
  STUDY_MODES,
  STUDY_SAMPLERS,
  STUDY_VORTEX_METRICS,
} from '@dive/shared';

const outputKey = z.enum(CHAMBER_OUTPUT_KEYS);
const band = z.number().finite().gt(0).max(100);
const sessionId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid session id');

const weights = z
  .object({
    headLoss: z.number().finite().min(0).max(1000),
    vortex: z.number().finite().min(0).max(1000),
  })
  .refine((w) => w.headLoss + w.vortex > 0, 'At least one weight must be above 0');

const base = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('save'), saveId: z.string().trim().min(1).max(64) }),
  z.object({ kind: z.literal('meshOrigin') }),
]);

/** Fields shared by create and patch (all optional here). */
const studyFields = {
  bandPct: band.optional(),
  bandOverrides: z.record(outputKey, band).optional(),
  weights: weights.optional(),
  mode: z.enum(STUDY_MODES).optional(),
  sampler: z.enum(STUDY_SAMPLERS).optional(),
  seed: z.number().int().min(0).max(2 ** 31 - 1).nullable().optional(),
  vortexMetric: z.enum(STUDY_VORTEX_METRICS).optional(),
  maxEvaluations: z.number().int().min(1).max(STUDY_MAX_EVALUATIONS).optional(),
  maxDurationHours: z.number().finite().positive().max(24 * 365).nullable().optional(),
  keepBest: z.number().int().min(0).max(100).optional(),
  keepLast: z.number().int().min(0).max(100).optional(),
  meshingSourceId: sessionId.optional(),
  cores: z.number().int().min(1).max(1024).optional(),
};

const name = z.string().trim().min(1, 'A name is required').max(120, 'At most 120 characters');
const keys = z.array(outputKey).min(1, 'Tick at least one parameter to optimise').max(12);

/** Body of POST /projects/:id/studies. */
export const createStudySchema = z.object({ name, base, keys, ...studyFields });
export type CreateStudyInput = z.infer<typeof createStudySchema>;

/** Body of PATCH /projects/:id/studies/:studyId (draft only). */
export const updateStudySchema = z.object({
  name: name.optional(),
  base: base.optional(),
  keys: keys.optional(),
  ...studyFields,
});
export type UpdateStudyInput = z.infer<typeof updateStudySchema>;

/** Route params with a study id. */
export const studyParamSchema = z.object({
  id: z.string().min(1, 'Project id is required'),
  studyId: z.string().regex(/^[A-Za-z0-9_-]+$/, 'Invalid study id'),
});

/** Route params with a study id and an evaluation index. */
export const evaluationParamSchema = studyParamSchema.extend({
  index: z.coerce.number().int().min(0).max(100000),
});

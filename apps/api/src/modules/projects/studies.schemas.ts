// Zod schemas for the diameter-optimization study endpoints. Mirrors the nested
// object style of meshes.schemas' mergePlanSchema.
import { z } from 'zod';
import { LENGTH_UNITS, STUDY_METRICS, sweepValuesM } from '@dive/shared';

/**
 * Max number of solver runs one sweep may enumerate. A brute-force sweep runs the
 * solver once per value, so an absurd range/step (millions of values) is rejected at
 * the door rather than melting the box.
 */
export const MAX_SWEEP_VALUES = 200;

/** A raw point (x, y, z), every component finite. */
const vec3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

const centerlineSchema = z.object({
  points: z.array(vec3Schema).min(2, 'A centerline needs at least 2 points'),
});

const morphSchema = z
  .object({
    wallPatch: z.string().min(1, 'A wall patch is required'),
    centerline: centerlineSchema,
    stationA: z.number().min(0).max(1),
    stationB: z.number().min(0).max(1),
    blend: z.number().min(0).max(1),
    baselineDiameterM: z.number().finite().positive(),
  })
  .refine((m) => m.stationA < m.stationB, {
    message: 'stationA must be strictly less than stationB',
    path: ['stationB'],
  });

const sweepSchema = z
  .object({
    minM: z.number().finite().positive(),
    maxM: z.number().finite().positive(),
    stepM: z.number().finite().positive(),
    unit: z.enum(LENGTH_UNITS),
  })
  .refine((s) => s.maxM >= s.minM, { message: 'maxM must be >= minM', path: ['maxM'] })
  .refine(
    (s) => {
      const n = sweepValuesM(s).length;
      return n >= 1 && n <= MAX_SWEEP_VALUES;
    },
    { message: `The sweep must enumerate between 1 and ${MAX_SWEEP_VALUES} values`, path: ['stepM'] },
  );

const objectiveSchema = z.object({
  inletPatch: z.string().min(1, 'An inlet patch is required'),
  outletPatch: z.string().min(1, 'An outlet patch is required'),
  primary: z.enum(STUDY_METRICS),
  densityKgM3: z.number().finite().positive(),
});

/** Body for creating a study: a full morph + sweep + objective config, optional name. */
export const createStudySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  morph: morphSchema,
  sweep: sweepSchema,
  objective: objectiveSchema,
});
export type CreateStudyInput = z.infer<typeof createStudySchema>;

/** Body for editing a DRAFT study: any subset of name/morph/sweep/objective. */
export const updateStudySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  morph: morphSchema.optional(),
  sweep: sweepSchema.optional(),
  objective: objectiveSchema.optional(),
});
export type UpdateStudyInput = z.infer<typeof updateStudySchema>;

/** Route params carrying a project id and a study id. */
export const studyIdParamSchema = z.object({
  id: z.string().min(1, 'Project id is required'),
  studyId: z.string().min(1, 'Study id is required'),
});

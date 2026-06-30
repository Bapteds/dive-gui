// Zod schemas for the multi-mesh import & merge endpoints.
import { z } from 'zod';

/** One conformal connection in a merge plan: fuse aMesh.aPatch to bMesh.bPatch. */
const stitchPairSchema = z.object({
  aMeshId: z.string().trim().min(1, 'A mesh is required'),
  aPatch: z.string().trim().min(1, 'A patch is required'),
  bMeshId: z.string().trim().min(1, 'A mesh is required'),
  bPatch: z.string().trim().min(1, 'A patch is required'),
});

/**
 * Body for POST /meshes/merge and PUT /meshes/plan: the ordered mesh ids to
 * combine (the first is the master) plus the patch pairs to stitch. `stitches`
 * defaults to [] — combining without connecting is valid.
 */
export const mergePlanSchema = z.object({
  order: z.array(z.string().trim().min(1)).min(1, 'Add at least one mesh to merge'),
  stitches: z.array(stitchPairSchema).default([]),
});

export type MergePlanInput = z.infer<typeof mergePlanSchema>;

/** Route params carrying a project id and a mesh source id. */
export const meshIdParamSchema = z.object({
  id: z.string().min(1, 'Project id is required'),
  meshId: z.string().min(1, 'Mesh id is required'),
});

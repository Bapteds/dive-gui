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
 * One rigid placement of an added part (multi-part assembly): a mesh id, a
 * translation (tx, ty, tz) and a unit quaternion (x, y, z, w). Every component is
 * finite; the transform is applied to the added part's staged points before the
 * merge (see PartTransform / meshTransform). No scaling — a rigid transform only.
 */
const partTransformSchema = z.object({
  meshId: z.string().trim().min(1),
  translation: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  rotation: z.tuple([
    z.number().finite(),
    z.number().finite(),
    z.number().finite(),
    z.number().finite(),
  ]),
});

/**
 * Body for POST /meshes/merge and PUT /meshes/plan: the ordered mesh ids to
 * combine (the first is the master) plus the patch pairs to stitch. `stitches`
 * and `transforms` default to [] — combining without connecting or without
 * placing anything is valid (an absent/empty `transforms` == today's behaviour).
 */
export const mergePlanSchema = z.object({
  order: z.array(z.string().trim().min(1)).min(1, 'Add at least one mesh to merge'),
  stitches: z.array(stitchPairSchema).default([]),
  transforms: z.array(partTransformSchema).default([]),
});

export type MergePlanInput = z.infer<typeof mergePlanSchema>;

/** Route params carrying a project id and a mesh source id. */
export const meshIdParamSchema = z.object({
  id: z.string().min(1, 'Project id is required'),
  meshId: z.string().min(1, 'Mesh id is required'),
});

/** Body for POST /meshes/:meshId/patches/rename — give a library patch a name. */
export const meshSourceRenamePatchSchema = z.object({
  from: z.string().trim().min(1, 'A patch is required'),
  to: z.string().trim().min(1, 'A patch name is required'),
});

export type MeshSourceRenamePatchInput = z.infer<typeof meshSourceRenamePatchSchema>;

/** Body for POST /meshes/:meshId/auto-patch — feature angle (degrees) to split by. */
export const meshSourceAutoPatchSchema = z.object({
  featureAngle: z.coerce.number().finite().min(0).max(180),
});

export type MeshSourceAutoPatchInput = z.infer<typeof meshSourceAutoPatchSchema>;

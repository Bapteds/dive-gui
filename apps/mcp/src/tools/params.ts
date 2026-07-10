// Reusable Zod input-shape fragments shared across the tool modules. Spreading
// one into a tool's `inputSchema` (e.g. `{ ...projectId, path: … }`) keeps the
// argument names consistent everywhere.
import { z } from 'zod';

export const projectId = { projectId: z.string().min(1).describe('Project id.') };

export const runParams = {
  projectId: z.string().min(1).describe('Project id.'),
  runId: z.string().min(1).describe('Solver run id.'),
};

export const meshParams = {
  projectId: z.string().min(1).describe('Project id.'),
  meshId: z.string().min(1).describe('Mesh-library source id (see list_meshes).'),
};

export const templateParams = {
  templateId: z.string().min(1).describe('Template id (see list_templates).'),
};

export const sessionParams = {
  sessionId: z.string().min(1).describe('Meshing session id (see list_meshing_sessions).'),
};

/** A batch of boundary-patch edits (rename + retype). Types are validated server-side. */
export const patchEdits = z
  .array(
    z.object({
      from: z.string().min(1).describe('Current patch name.'),
      to: z.string().min(1).describe('New patch name (an OpenFOAM word).'),
      type: z.string().min(1).describe('New geometric type or flow role.'),
    }),
  )
  .min(1)
  .describe('A non-empty list of { from, to, type } patch edits.');

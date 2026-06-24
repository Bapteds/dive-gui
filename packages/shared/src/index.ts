// Shared API contract for DIVE Turbinen.
//
// Single source of truth for the constants and enums that both the backend
// (@dive/api) and the web client (@dive/web) must agree on. Keeping these here
// removes the latent drift that arises when, e.g., the password length is typed
// as `8` independently on each side.
import { z } from 'zod';

/** Account roles. The super-admin is permanent and cannot be removed or downgraded. */
export const ROLES = ['SUPER_ADMIN', 'USER'] as const;
export type Role = (typeof ROLES)[number];
/** Zod enum for a role, reused by request schemas on both sides. */
export const roleSchema = z.enum(ROLES);

/** Password policy shared by every create / update / change-password path. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

/** Maximum length of a user's display name. */
export const FULL_NAME_MAX_LENGTH = 120;

/** Maximum length of a project title. */
export const PROJECT_TITLE_MAX_LENGTH = 120;

/** Maximum length of a reusable template's name. */
export const TEMPLATE_NAME_MAX_LENGTH = 120;

/** Maximum length of a reusable template's description. */
export const TEMPLATE_DESCRIPTION_MAX_LENGTH = 2000;

/**
 * Maximum size of a case file that may be opened/saved in the in-app editor.
 * Configuration dictionaries are tiny; large mesh files (e.g. `points`) are not
 * meant to be hand-edited and are surfaced as "too large to edit here" instead.
 */
export const EDITABLE_FILE_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * File extension of an Ansys/CFD CGNS mesh source. The frontend uses it for the
 * file picker's `accept`, the backend to validate an upload; a single constant
 * keeps the two from drifting. Compared case-insensitively.
 */
export const CGNS_EXTENSION = '.cgns';

/**
 * Ordered identifiers of the CGNS -> OpenFOAM conversion pipeline steps, shared
 * so the API and the web client label each step (and its log) identically.
 *   - cgnsToVtk:   pvpython CgnsToVtk.py  -> legacy VTK
 *   - vtkToFoam:   vtkUnstructuredToFoam  -> constant/polyMesh
 *   - checkMesh:   checkMesh              -> mesh quality report
 */
export const CONVERSION_STEPS = ['cgnsToVtk', 'vtkToFoam', 'checkMesh'] as const;
export type ConversionStepId = (typeof CONVERSION_STEPS)[number];

/**
 * Directory name (under a project's storage subtree, sibling of `case/` and
 * `cgns/`) holding the rendered 3D-viewer artifacts. Kept apart from the case so
 * a case reset never touches the cached render (mirrors the CGNS decision).
 */
export const VIZ_DIRNAME = 'viz';

/**
 * One boundary patch of a mesh, as surfaced to the 3D "Visualize" tab. Mirrors
 * the original inspector's table semantics (Name / Type / nFaces): `nFaces` is
 * the patch's ORIGINAL boundary face count, not the post-triangulation count.
 */
export interface MeshPatch {
  /** Patch name (matches the named node in the GLB geometry). */
  name: string;
  /** Patch type from constant/polyMesh/boundary (patch | wall | …), `?` if unknown. */
  type: string;
  /** Number of boundary faces in the patch (pre-triangulation). */
  nFaces: number;
  /**
   * Slice of the cell-edge buffer (edges.bin) for this patch: a vertex offset.
   * Units are vertices (3 float32 each). Present when true mesh edges were
   * extracted; absent on an older render (the viewer then falls back).
   */
  edgeOffset?: number;
  /** Number of edge vertices for this patch in edges.bin (even; line-segment pairs). */
  edgeCount?: number;
}

/**
 * Manifest describing the patches in a project's rendered mesh. The patch table
 * (F4) is driven entirely by this JSON, so it never depends on the geometry
 * transport format (GLB).
 */
export interface MeshManifest {
  patches: MeshPatch[];
  /** ISO 8601 timestamp of when the artifacts were built. */
  generatedAt: string;
}

/**
 * Geometric boundary types a mesh patch can be set to from the Visualize tab
 * (the `type` keyword in constant/polyMesh/boundary). The constraint types
 * (empty / symmetry / symmetryPlane / wedge) require every field's boundaryField
 * entry for that patch to use the SAME type, which the app propagates into the
 * 0/ files. cyclic / cyclicAMI / processor are intentionally excluded here: they
 * need a paired neighbour patch (or are parallel-only) and are out of scope for
 * single-patch retyping.
 */
export const MESH_PATCH_TYPES = [
  'patch',
  'wall',
  'symmetry',
  'symmetryPlane',
  'empty',
  'wedge',
] as const;
export type MeshPatchType = (typeof MESH_PATCH_TYPES)[number];

/**
 * Patch types whose field boundaryField BC must match the geometric type exactly
 * (the solver errors otherwise). When a patch is set to one of these, the app
 * rewrites its 0/ boundaryField entries to the same type; when set away from one
 * (to patch/wall), a leftover constraint BC is reset to a valid generic default.
 */
export const CONSTRAINT_PATCH_TYPES = [
  'empty',
  'symmetry',
  'symmetryPlane',
  'wedge',
  'cyclic',
  'cyclicAMI',
  'processor',
] as const;

/**
 * Directory name (under a project's storage subtree, sibling of `case/`,
 * `cgns/`, `viz/`) holding solver-run logs and artifacts. Kept apart from the
 * case so a case reset never wipes the run history/logs (mirrors the viz/cgns
 * decision): logs are outputs, not case inputs.
 */
export const RUN_DIRNAME = 'runs';

/**
 * Lifecycle states of a solver run, shared so the API (Prisma `status` String,
 * the reconciliation logic) and the web client (status badge, history) agree.
 *  - queued/running: active (a process is, or is about to be, executing).
 *  - converged: exit 0 AND the solver printed its "solution converged" banner.
 *  - completed: exit 0, reached endTime, WITHOUT converging (ran to the end).
 *  - diverged: residuals went to nan/inf or a floating-point error occurred.
 *  - failed:   non-zero exit, missing binary, or wall-clock timeout.
 *  - stopped:  the user stopped the run.
 */
export const RUN_STATUSES = [
  'queued',
  'running',
  'converged',
  'completed',
  'diverged',
  'failed',
  'stopped',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Run statuses that count as "active" — the concurrency guard rejects a new run. */
export const ACTIVE_RUN_STATUSES = ['queued', 'running'] as const;

/** Is this run status terminal (the process is no longer executing)? */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return status !== 'queued' && status !== 'running';
}

/**
 * OpenFOAM solver applications the app can run in v1. The actual solver is read
 * from the case's `system/controlDict` `application` keyword; this set bounds
 * what we accept (and is reused by the web client's labels). `foamRun` is the
 * generic launcher the scaffold writes by default; `simpleFoam` is the steady
 * incompressible RANS MVP.
 */
export const SOLVER_IDS = ['simpleFoam', 'foamRun'] as const;
export type SolverId = (typeof SOLVER_IDS)[number];

/**
 * Residual field names the chart plots, shared so the parser, the legend, and
 * the per-series colors stay in sync. The parser stays tolerant to others; this
 * list only drives display ordering and the known palette. Ux/Uy/Uz are kept
 * separate here (the solver prints them separately); the UI may merge them.
 */
export const RESIDUAL_FIELDS = ['Ux', 'Uy', 'Uz', 'p', 'k', 'omega', 'epsilon', 'nuTilda'] as const;
export type ResidualField = (typeof RESIDUAL_FIELDS)[number];

/**
 * One per-iteration residual record: the iteration (solver "Time =") and the
 * Initial residual of each field present in that block. Fields are optional
 * because not every model writes every field. Compact on the wire.
 */
export interface ResidualSample {
  /** Solver iteration / time index (the value after "Time = "). */
  time: number;
  /** Field name -> Initial residual at this iteration. */
  values: Partial<Record<string, number>>;
}

/**
 * Machine-readable error codes the API may emit in its `{ error: { code } }`
 * envelope. The web client maps these to user-facing messages; it adds its own
 * transport-only codes (network failures, unknown) on top of this set.
 */
export const SERVER_ERROR_CODES = [
  'INVALID_CREDENTIALS',
  'INVALID_PASSWORD',
  'ACCOUNT_DISABLED',
  'EMAIL_TAKEN',
  'PROTECTED_ACCOUNT',
  'PROTECTED_ROLE',
  'SELF_DELETE_FORBIDDEN',
  'SELF_DISABLE_FORBIDDEN',
  'USER_NOT_FOUND',
  'COLLABORATOR_EXISTS',
  'NO_FILES_UPLOADED',
  'INVALID_ARCHIVE',
  'INVALID_CGNS',
  'CONVERSION_FAILED',
  'NO_MESH',
  'MESH_NOT_BUILT',
  'MESH_BUILD_FAILED',
  'SCRIPT_MISSING',
  'PATCH_EXISTS',
  'NOT_RUNNABLE',
  'RUN_IN_PROGRESS',
  'RUN_NOT_FOUND',
  'PAYLOAD_TOO_LARGE',
  'FILE_TOO_LARGE',
  'FILE_EXISTS',
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'RATE_LIMITED',
] as const;
export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number];

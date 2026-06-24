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

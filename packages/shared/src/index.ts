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
 *   - cgnsToVtk:   python3 CgnsToVtk.py  -> legacy VTK
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
 * One row of a batch patch edit from the Visualize tab: rename `from` -> `to`
 * (equal when only the type changes) and set its geometric `type`. The server
 * applies every edit in one pass over the boundary file and the 0/ fields.
 */
export interface MeshPatchEdit {
  /** Current (pre-edit) patch name — identifies the patch to change. */
  from: string;
  /** New patch name (a valid OpenFOAM word; equal to `from` to keep the name). */
  to: string;
  /** New geometric type (propagated into the 0/ fields for constraint types). */
  type: MeshPatchType;
}

/**
 * Status of a project's single mesh-backup slot. `kind` is 'original' for the
 * automatic snapshot taken before the first modification, 'manual' for an
 * explicit overwrite. Timestamps are ISO 8601.
 */
export interface MeshBackupInfo {
  /** When the slot was first captured. */
  createdAt: string;
  /** When the slot was last written (original capture or overwrite). */
  updatedAt: string;
  kind: 'original' | 'manual';
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

// ---------------------------------------------------------------------------
// Multi-mesh import & merge (mergeMeshes / stitchMesh).
//
// A project can hold a LIBRARY of imported polyMesh sources, kept apart from the
// case under the meshes/ subtree (like cgns/). The "merge" pipeline combines
// them into the project's single constant/polyMesh — the artifact every other
// feature (Visualize, Solver, Export) already consumes — by combining the meshes
// (mergeMeshes) and conformally fusing chosen patch pairs into internal
// interfaces (stitchMesh). Shared so the API and the web client agree on the
// plan they exchange and the per-step report they render.
// ---------------------------------------------------------------------------

/**
 * Directory name (under a project's storage subtree, sibling of case/, cgns/,
 * viz/, runs/, export/) holding the reusable library of imported polyMesh
 * sources and the transient merge workspace. Kept apart from the case so
 * importing a mesh never touches case inputs and a case reset never wipes the
 * library.
 */
export const MESHES_DIRNAME = 'meshes';

/**
 * Ordered kinds of step the merge pipeline emits. Unlike the fixed-length
 * conversion/export pipelines, a merge runs a VARIABLE number of steps (one
 * `prepare` per source, one `mergeMeshes` per added source, one `stitchMesh` per
 * pair), so each step carries a `kind` (not a unique id) plus a human label.
 *   - prepare:     stage a source as a case + prefix its patches (collision-free)
 *   - mergeMeshes: combine an additional mesh into the master (OpenFOAM mergeMeshes)
 *   - stitchMesh:  conformally fuse a chosen patch pair into an internal interface
 *   - cleanup:     drop the zero-face patches stitchMesh leaves behind
 *   - checkMesh:   validate the combined mesh
 */
export const MERGE_STEP_KINDS = [
  'prepare',
  'mergeMeshes',
  'stitchMesh',
  'cleanup',
  'checkMesh',
] as const;
export type MergeStepKind = (typeof MERGE_STEP_KINDS)[number];

/** One imported polyMesh source in a project's mesh library. */
export interface MeshSource {
  /** Opaque id (also the source's directory name under meshes/). */
  id: string;
  /** Display name (defaults to the uploaded folder/zip name). */
  name: string;
  /** Boundary patches parsed from the source's constant/polyMesh/boundary. */
  patches: MeshPatch[];
  /** ISO 8601 import timestamp (drives the default merge order). */
  createdAt: string;
}

/**
 * One conformal connection to make: fuse patch `aPatch` of mesh `aMeshId` to
 * patch `bPatch` of mesh `bMeshId`. The two patches must be geometrically
 * coincident; stitchMesh turns their faces into an internal interface so flow
 * passes continuously between the two parts.
 */
export interface StitchPair {
  aMeshId: string;
  aPatch: string;
  bMeshId: string;
  bPatch: string;
}

/**
 * A merge plan: the ordered list of source mesh ids to combine (the first is the
 * master) plus the patch pairs to stitch afterwards. An empty `stitches` just
 * combines the meshes side by side without connecting them.
 */
export interface MergePlan {
  order: string[];
  stitches: StitchPair[];
}

/** One executed (or skipped) step of the merge pipeline. */
export interface MergeStep {
  /** Which kind of step this is (see MERGE_STEP_KINDS). */
  kind: MergeStepKind;
  /** Human-readable step name (e.g. "Stitch m1.outlet ↔ m2.inlet"). */
  label: string;
  /** The logical command line that was run (for transparency in the UI). */
  command: string;
  /** 'success' (exit 0), 'failed', or 'skipped' (an earlier step failed). */
  status: 'success' | 'failed' | 'skipped';
  /** Process exit code, or null when killed / never spawned / not a command. */
  exitCode: number | null;
  /** Captured stdout (tail, truncated). */
  stdout: string;
  /** Captured stderr (tail, truncated). */
  stderr: string;
  /** Wall-clock duration in ms (0 for a skipped/instant step). */
  durationMs: number;
}

/**
 * Outcome of a merge run: the per-step report plus the patches of the resulting
 * combined mesh. The API augments this with the refreshed case tree on the wire.
 */
export interface MergeResult {
  /** True only when every step succeeded and the combined mesh was promoted. */
  success: boolean;
  /** The pipeline steps, in execution order. */
  steps: MergeStep[];
  /** Informational notes (sources combined, pairs stitched, patches dropped, …). */
  notes: string[];
  /** Boundary patches of the resulting constant/polyMesh (empty on failure). */
  boundaryPatches: MeshPatch[];
}

// ---------------------------------------------------------------------------
// Mesh-file import (a single .cgns or Fluent .msh -> constant/polyMesh).
//
// Importing a mesh as a FILE (not an OpenFOAM polyMesh folder) runs a small,
// template-less conversion toolchain that lands a constant/polyMesh in a target
// case (the project case for the first import, or a library source for a merge):
//   - .cgns: python3 CgnsToVtk.py -> vtkUnstructuredToFoam -> checkMesh
//   - .msh:  fluent3DMeshToFoam   -> checkMesh   (Fluent/Ansys; gmshToFoam works too)
// Shared so the API and the web client agree on the accepted extensions and the
// per-step report.
// ---------------------------------------------------------------------------

/** Mesh-file extensions the import can convert into a polyMesh (case-insensitive). */
export const MESH_IMPORT_EXTENSIONS = ['.cgns', '.msh'] as const;
export type MeshImportExtension = (typeof MESH_IMPORT_EXTENSIONS)[number];

/** One executed (or skipped) step of a mesh-file conversion. */
export interface ImportStep {
  /** The OpenFOAM/Python tool that ran (e.g. 'vtkUnstructuredToFoam'). */
  tool: string;
  /** Human-readable step name. */
  label: string;
  /** The logical command line that was run (for transparency in the UI). */
  command: string;
  /** 'success' (exit 0), 'failed', or 'skipped' (an earlier step failed). */
  status: 'success' | 'failed' | 'skipped';
  /** Process exit code, or null when killed / never spawned. */
  exitCode: number | null;
  /** Captured stdout (tail, truncated). */
  stdout: string;
  /** Captured stderr (tail, truncated). */
  stderr: string;
  /** Wall-clock duration in ms (0 for a skipped step). */
  durationMs: number;
}

/** Outcome of converting a mesh file into a polyMesh: per-step report + success. */
export interface MeshImportConversion {
  /** True only when every conversion step succeeded. */
  success: boolean;
  /** The conversion steps, in execution order. */
  steps: ImportStep[];
}

/**
 * Directory name (under a project's storage subtree, sibling of `case/`,
 * `cgns/`, `viz/`) holding solver-run logs and artifacts. Kept apart from the
 * case so a case reset never wipes the run history/logs (mirrors the viz/cgns
 * decision): logs are outputs, not case inputs.
 */
export const RUN_DIRNAME = 'runs';

/**
 * Directory name (under a project's storage subtree, sibling of `case/`, `cgns/`,
 * `viz/`, `runs/`) holding the CFD-Post export artifacts (out.cgns, the generated
 * convert script + logs, the case profile, the validation report, the CFD-Post
 * session/memo, and the final REPORT.md). Kept apart from the case so an export
 * never touches case inputs and a case reset never wipes a produced CGNS.
 */
export const EXPORT_DIRNAME = 'export';

/**
 * Ordered identifiers of the OpenFOAM -> CGNS (CFD-Post) export pipeline steps,
 * shared so the API and the web client label each step (and its log) identically.
 *   - inspect:  profile the case (foamDictionary + checkMesh) -> CaseProfile
 *   - convert:  pvbatch FoamToCgns.py -> export/out.cgns (ADF, cell-centered)
 *   - validate: re-read the CGNS + best-effort OpenFOAM reference comparison
 *   - cfdpost:  write the CFD-Post session.cse + load memo
 */
export const EXPORT_STEPS = ['inspect', 'convert', 'validate', 'cfdpost'] as const;
export type ExportStepId = (typeof EXPORT_STEPS)[number];

/** One executed (or skipped) step of the export pipeline. */
export interface ExportStep {
  /** Stable id shared with the client (see EXPORT_STEPS). */
  id: ExportStepId;
  /** Human-readable step name. */
  label: string;
  /** The logical command line that was run (for transparency in the UI). */
  command: string;
  /**
   * 'success' (clean), 'warning' (ran but with caveats — e.g. a best-effort
   * validation that could not compute every reference), 'failed', or 'skipped'
   * (an earlier step failed).
   */
  status: 'success' | 'warning' | 'failed' | 'skipped';
  /** Process exit code, or null when killed / never spawned. */
  exitCode: number | null;
  /** Captured stdout (tail, truncated). */
  stdout: string;
  /** Captured stderr (tail, truncated). */
  stderr: string;
  /** Wall-clock duration in ms (0 for a skipped step). */
  durationMs: number;
}

/**
 * Profile of the OpenFOAM case the export was run on (from the inspect step).
 * Drives the convert (field list) and the CFD-Post memo (pressure-unit caveat).
 */
export interface CaseProfile {
  /** Latest written time directory (the results exported), or null if none. */
  latestTime: string | null;
  /** Steady (single final time) vs transient. */
  steady: boolean;
  /** Incompressible solver => kinematic pressure (p in m^2/s^2), needs xrho note. */
  incompressible: boolean;
  /** Solver application from controlDict (e.g. simpleFoam). */
  solver: string;
  /** Turbulence model (e.g. kEpsilon), or 'unknown'. */
  turbulenceModel: string;
  /** Field names found in the latest time directory. */
  fields: string[];
  /** True when checkMesh reports polyhedral cells (CFD-Post tessellation risk). */
  hasPolyhedra: boolean;
  /** All boundary patch names. */
  patches: string[];
  /** Patches with zero faces (excluded; cause empty surfaces in CFD-Post). */
  emptyPatches: string[];
  /** Best guess at the inlet/outlet patch names (for the session.cse skeleton). */
  inletGuess: string | null;
  outletGuess: string | null;
}

/** One row of the conversion-fidelity validation table. */
export interface ValidationCheck {
  /** What is being checked (e.g. "fields present", "velocity max"). */
  name: string;
  /** OpenFOAM reference value, or '-' when not computed. */
  reference: string;
  /** Value read back from the CGNS, or '-'. */
  cgns: string;
  /** Difference / relative error, or '-'. */
  delta: string;
  verdict: 'pass' | 'fail' | 'info';
}

/** Outcome of the validate step: overall status plus the per-check table. */
export interface ExportValidation {
  status: 'pass' | 'fail';
  checks: ValidationCheck[];
}

/** Which downloadable artifacts the export produced (drives the download buttons). */
export interface ExportArtifacts {
  /** export/out.cgns is present and non-empty. */
  cgns: boolean;
  /** export/session.cse is present. */
  session: boolean;
  /** export/LOAD_CFDPOST.md is present. */
  memo: boolean;
  /** export/REPORT.md is present. */
  report: boolean;
}

/** Outcome of an export run: per-step report + profile + validation + artifacts. */
export interface ExportResult {
  /** True only when every step succeeded (warnings still count as not-failed). */
  success: boolean;
  /** The four pipeline steps, in order. */
  steps: ExportStep[];
  /** Informational notes (latest time exported, caveats, …). */
  notes: string[];
  /** The inspected case profile (null when inspect failed). */
  profile: CaseProfile | null;
  /** The validation table + status (null when convert failed before validation). */
  validation: ExportValidation | null;
  /** Which artifacts are downloadable. */
  artifacts: ExportArtifacts;
}

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
  'NO_MESHES',
  'INVALID_MERGE_PLAN',
  'STITCH_PATCH_NOT_FOUND',
  'MESH_MERGE_FAILED',
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

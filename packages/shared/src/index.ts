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

/** Maximum length of a single template tag (after normalization). */
export const TEMPLATE_TAG_MAX_LENGTH = 24;

/** Maximum number of tags a template may carry. */
export const TEMPLATE_TAGS_MAX = 12;

/**
 * Normalize a tag to a lowercase kebab token (trim, spaces -> hyphens, strip
 * anything but a-z 0-9 and hyphens, collapse/edge-trim hyphens, length-cap). An
 * all-junk input yields ''. Keeps search + sort predictable across the app.
 */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, TEMPLATE_TAG_MAX_LENGTH);
}

/** Normalize, drop empties, dedupe, and cap a list of tags (order preserved). */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
      if (out.length >= TEMPLATE_TAGS_MAX) break;
    }
  }
  return out;
}

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
  /** New geometric type OR flow role (inlet/outlet); propagated into the 0/ fields. */
  type: MeshPatchSetting;
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
 * Semantic flow ROLES a user can assign to a boundary patch in the Visualize tab.
 * Unlike MESH_PATCH_TYPES these are NOT OpenFOAM geometric types (the polyMesh
 * `type` stays `patch`): assigning a role applies a standard field-BC preset to the
 * 0/ fields (inlet = fixedValue on the transported fields + zeroGradient pressure;
 * outlet = inletOutlet + fixedValue pressure), so the user does not wire inlet/outlet
 * boundary conditions by hand.
 */
export const PATCH_ROLES = ['inlet', 'outlet'] as const;
export type PatchRole = (typeof PATCH_ROLES)[number];

/**
 * Everything a patch can be SET to from the Visualize tab: a geometric type OR a
 * flow role. A role writes geometric `type patch;` and applies its field preset.
 * Used by the patch-edit UI and the setPatchType / editMeshPatches schemas.
 */
export const MESH_PATCH_SETTINGS = [...MESH_PATCH_TYPES, ...PATCH_ROLES] as const;
export type MeshPatchSetting = (typeof MESH_PATCH_SETTINGS)[number];

/** Is `value` a flow role (inlet/outlet), rather than a geometric patch type? */
export function isPatchRole(value: string): value is PatchRole {
  return (PATCH_ROLES as readonly string[]).includes(value);
}

/**
 * Patch types whose field boundaryField BC must match the geometric type exactly
 * (the solver errors otherwise). When a patch is set to one of these, the app
 * rewrites its 0/ boundaryField entries to the same type; when set away from one
 * (to patch/wall), a leftover constraint BC is reset to a valid generic default.
 *
 * `cyclicAMI` is the constraint type the Assembly non-conformal couple assigns
 * when it retypes two touching interface patches IN PLACE (Assembly v3, ESI
 * OpenFOAM v2406): a field's boundaryField entry for such a patch must carry that
 * exact type, so it belongs here. (The org-only `nonConformalCyclic` /
 * `nonConformalError` types are gone — that utility does not exist in ESI and the
 * pipeline no longer produces them.)
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
// Boundary-condition presets by hydraulic component (the post-import overlay).
//
// When a mesh is imported the user is asked "what is this?" — a Turbine, Pipe,
// DraftTube or Chamber — and, per type, how the flow is driven. That choice
// rewrites the inlet / outlet / wall boundaryField entries of the 0/ fields with
// the physically correct recipe drawn from the DIVE turbine BC templates
// (documents/*_BCs*.txt). Shared so the API writes exactly the recipe the web
// overlay names, and both agree on which driving modes each type offers.
// ---------------------------------------------------------------------------

/** The kind of hydraulic component an imported mesh represents. */
export const OBJECT_TYPES = ['turbine', 'pipe', 'draftTube', 'chamber'] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

/**
 * How the flow through the component is driven:
 *  - pressure   : total-pressure inlet (net head imposed; the flow rate Q is a
 *                 RESULT). p0 = GRAVITY * head (kinematic).
 *  - flowRate   : volumetric-flow-rate inlet (Q imposed; the head is a result).
 *  - csvProfile : spatially-varying mapped inlet from a runner-exit CSV profile
 *                 (draft tube only) — timeVaryingMappedFixedValue + boundaryData.
 */
export const DRIVING_MODES = ['pressure', 'flowRate', 'csvProfile'] as const;
export type DrivingMode = (typeof DRIVING_MODES)[number];

/**
 * The driving modes each object type offers, in UI order. Mirrors the templates:
 * a turbine is head-driven only; a pipe or chamber can be driven by head or by
 * flow rate; a draft tube's inlet is always the mapped runner-exit profile.
 */
export const OBJECT_TYPE_MODES: Record<ObjectType, readonly DrivingMode[]> = {
  turbine: ['pressure'],
  pipe: ['pressure', 'flowRate'],
  draftTube: ['csvProfile'],
  chamber: ['flowRate', 'pressure'],
};

/** Display metadata for an object type (overlay step 1). */
export interface ObjectTypeInfo {
  id: ObjectType;
  label: string;
  summary: string;
}

/** The four components, in overlay order, each with a one-line "what it is". */
export const OBJECT_TYPE_LIBRARY: ObjectTypeInfo[] = [
  {
    id: 'turbine',
    label: 'Turbine (full machine)',
    summary: 'Complete machine, head-driven. Total-pressure inlet, static-pressure outlet.',
  },
  {
    id: 'pipe',
    label: 'Pipe',
    summary: 'Duct flow, driven by flow rate or by pressure drop.',
  },
  {
    id: 'draftTube',
    label: 'Draft tube',
    summary: 'Standalone draft tube fed by the runner-exit profile from a CSV (keeps the swirl).',
  },
  {
    id: 'chamber',
    label: 'Turbine chamber',
    summary: 'Spiral casing with stay / guide vanes, driven by flow rate or by pressure.',
  },
];

/** Display metadata for a driving mode (overlay step 2). */
export interface DrivingModeInfo {
  id: DrivingMode;
  label: string;
  summary: string;
}

/** Human labels for the driving modes, keyed by id. */
export const DRIVING_MODE_LIBRARY: Record<DrivingMode, DrivingModeInfo> = {
  pressure: {
    id: 'pressure',
    label: 'Pressure-driven',
    summary: 'Net head imposed at the inlet (total pressure); the flow rate is a result.',
  },
  flowRate: {
    id: 'flowRate',
    label: 'Flow-rate-driven',
    summary: 'Volumetric flow rate Q imposed at the inlet; the head is a result.',
  },
  csvProfile: {
    id: 'csvProfile',
    label: 'Mapped inlet profile (CSV)',
    summary: 'Runner-exit velocity profile mapped from an uploaded CSV.',
  },
};

/** Standard gravity [m/s^2], converting net head H [m] to kinematic total pressure p0 = g*H. */
export const GRAVITY = 9.81;

/**
 * Per-object-type turbulence defaults for the inlet BCs. Most components share the
 * template defaults (intensity 5 %, mixing length ~0.07*D_h, seed k=0.06 /
 * omega=10). The draft tube is different: the runner exit is highly turbulent, so
 * the template recommends a higher intensity (~8 %), a shorter mixing length
 * (~0.02*D_runner) and larger seed values (k=0.1 / omega=50). The user can
 * override intensity and mixing length in the overlay; the seeds are internal.
 */
export interface TurbulenceDefaults {
  /** Turbulent intensity as a fraction (0.05 = 5 %). */
  intensity: number;
  /** Turbulence mixing length [m] (~0.07*D_h; ~0.02*D_runner for a draft tube). */
  mixingLength: number;
  /** Seed value written to k (initial internal field + inletOutlet value). */
  kSeed: number;
  /** Seed value written to omega. */
  omegaSeed: number;
}

/** Inlet-turbulence defaults per component (the draft tube runs hotter). */
export const OBJECT_TYPE_TURBULENCE: Record<ObjectType, TurbulenceDefaults> = {
  turbine: { intensity: 0.05, mixingLength: 0.07, kSeed: 0.06, omegaSeed: 10 },
  pipe: { intensity: 0.05, mixingLength: 0.07, kSeed: 0.06, omegaSeed: 10 },
  chamber: { intensity: 0.05, mixingLength: 0.07, kSeed: 0.06, omegaSeed: 10 },
  draftTube: { intensity: 0.08, mixingLength: 0.02, kSeed: 0.1, omegaSeed: 50 },
};

/**
 * Operating-point values the overlay collects. Which ones are required depends on
 * the driving mode: `head` for pressure-driven, `flowRate` for flow-rate-driven;
 * `intensity` / `mixingLength` are always optional (they fall back to the object
 * type's TurbulenceDefaults). All strictly positive.
 */
export interface BoundaryConditionValues {
  /** Net head H [m]. Kinematic total pressure p0 = GRAVITY * head. */
  head?: number;
  /** Volumetric flow rate Q [m^3/s]. */
  flowRate?: number;
  /** Turbulent intensity (fraction, e.g. 0.05). */
  intensity?: number;
  /** Turbulence mixing length [m]. */
  mixingLength?: number;
}

/**
 * A request to apply a component BC preset to a project case. `inlet` / `outlet`
 * are the single inlet / outlet patch names the user assigned from the mesh; the
 * remaining assigned patches are `walls` (no-slip + wall functions). For a draft
 * tube (csvProfile) the CSV file rides alongside as multipart, not in this body.
 */
export interface ApplyBoundaryConditionsRequest {
  objectType: ObjectType;
  mode: DrivingMode;
  inlet: string;
  outlet: string;
  walls: string[];
  values: BoundaryConditionValues;
}

/** What the apply actually wrote, echoed back for the UI summary. */
export interface AppliedBoundaryConditions {
  objectType: ObjectType;
  mode: DrivingMode;
  inlet: string;
  outlet: string;
  walls: string[];
  /** 0/ field files touched, e.g. ['0/U','0/p','0/k','0/omega','0/nut']. */
  fields: string[];
  /** Kinematic total pressure p0 = GRAVITY*head written to the inlet, when pressure-driven. */
  p0?: number;
}

/**
 * Result of applying a component BC preset. `success` is false only on a hard
 * failure. For a draft tube, `csvSteps` carries the CSV -> boundaryData conversion
 * report (never throws; a missing Python/toolchain degrades to a failed step, like
 * the CGNS pipeline). `notes` surfaces advisories (e.g. the CSV lacked a k/omega
 * column so the intensity fallback was used).
 */
export interface ApplyBoundaryConditionsResult {
  success: boolean;
  applied: AppliedBoundaryConditions;
  csvSteps?: ImportStep[];
  notes: string[];
}

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
 * `prepare` per source, one `mergeMeshes` per added source, one coupling step per
 * interface), so each step carries a `kind` (not a unique id) plus a human label.
 *   - prepare:                  stage a source as a case + prefix its patches (collision-free)
 *   - mergeMeshes:              combine an additional mesh into the master (OpenFOAM mergeMeshes)
 *   - stitchMesh:               conformally FUSE a chosen patch pair into an internal interface
 *   - nonConformalCouple:       NON-conformally COUPLE a chosen patch pair by retyping both
 *                               interface patches to cyclicAMI in place (keeps both parts'
 *                               cells + patch names; Assembly default, ESI-compatible)
 *   - cleanup:                  drop the zero-face patches stitchMesh leaves behind (skipped for a couple)
 *   - checkMesh:                validate the combined mesh
 */
export const MERGE_STEP_KINDS = [
  'prepare',
  'mergeMeshes',
  'stitchMesh',
  'nonConformalCouple',
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
 * Sentinel `order[0]` value meaning "start the assembly from the project's own
 * existing case mesh" (the `constant/polyMesh` the Visualize tab shows) instead
 * of a first library source. Added library parts are then positioned + coupled
 * onto it, preserving the case's `0/` physics. No real library source can take
 * this id (a slug is never `__case__`).
 */
export const MERGE_BASE_CASE = '__case__';

/**
 * How a pair of touching interface patches is connected in the merged mesh:
 *   - 'nonConformal': a NON-conformal cyclicAMI coupling. After the meshes are
 *     combined, the two interface patches are retyped IN PLACE to `cyclicAMI`
 *     (cross-linked via `neighbourPatch`, `transform noOrdering`), KEEPING both
 *     parts' cells + patch names; the AMI weights are computed by the solver at
 *     runtime, so only geometric overlap (not node coincidence) is required. This
 *     is a pure textual boundary edit — no OpenFOAM CLI — so it works on any
 *     flavour (the deploy target is ESI OpenFOAM v2406).
 *   - 'stitch': the legacy CONFORMAL fuse (`stitchMesh`) — turns two coincident
 *     patches into one internal interface (node coincidence required).
 *
 * The Assembly default is 'nonConformal'. The pre-v3 literal 'nonConformalCyclic'
 * is still accepted on input and normalized to 'nonConformal' (back-compat for
 * saved plans).
 */
export type InterfaceCoupling = 'nonConformal' | 'stitch';

/**
 * One interface to make between two parts in a merge: connect patch `aPatch` of
 * mesh `aMeshId` to patch `bPatch` of mesh `bMeshId` with the chosen `coupling`.
 * Supersedes `StitchPair` (which is `coupling: 'stitch'`); a mesh id may be
 * `MERGE_BASE_CASE` to reference a base-side patch of the project case mesh.
 */
export interface MeshInterface {
  aMeshId: string;
  aPatch: string;
  bMeshId: string;
  bPatch: string;
  /** Coupling mechanism; the Assembly default is 'nonConformal'. */
  coupling: InterfaceCoupling;
}

/**
 * Rigid placement of an added part in a multi-part assembly:
 *   p' = R(rotation)·p + translation
 * expressed in the part's own polyMesh units (metres, SI). There is NO scaling —
 * a rigid transform cannot rescale, so every part must already share the same
 * units. `rotation` is a unit quaternion in three.js (x, y, z, w) order, and the
 * server mirrors three.js's exact `Matrix4.compose` formula, so the browser live
 * preview and the merged-on-disk result are bit-for-bit identical.
 */
export interface PartTransform {
  /** Id of the library source this transform places (the master is never moved). */
  meshId: string;
  /** Translation (tx, ty, tz) applied after the rotation, in raw polyMesh coords. */
  translation: [number, number, number];
  /** Unit quaternion (x, y, z, w), normalized; identity = [0, 0, 0, 1]. */
  rotation: [number, number, number, number];
}

/**
 * A merge plan: the ordered list of source mesh ids to combine (the first is the
 * master; it may be `MERGE_BASE_CASE` to build onto the project's own case mesh)
 * plus the `interfaces` to couple afterwards. An empty `interfaces` just combines
 * the meshes side by side without connecting them.
 */
export interface MergePlan {
  order: string[];
  /**
   * The interfaces to make after combining (NON-conformal couple or conformal
   * stitch per entry). Supersedes `stitches`.
   */
  interfaces: MeshInterface[];
  /**
   * Optional rigid placements for the added parts (see PartTransform), applied to
   * the transient staged copy before the meshes are combined. Absent, empty, or
   * identity => today's behaviour (nothing is moved). The master — `order[0]` — is
   * always left at identity regardless of what this carries.
   */
  transforms?: PartTransform[];
  /**
   * @deprecated Legacy drafts only carried conformal stitch pairs. Interpreted as
   * `interfaces` with `coupling: 'stitch'` when `interfaces` is empty. New clients
   * send `interfaces` instead.
   */
  stitches?: StitchPair[];
}

/**
 * On-disk record that an assembly is currently applied to a project's case mesh,
 * written ONLY on a successful merge promote (stored as meshes/assembly.json).
 * Drives the Disassemble feature: the UI lists the applied added parts (from
 * `plan.order`) so the user can REMOVE one (re-run a reduced plan) or UNDO the
 * whole assembly, and it is the key the merge's restore-first guard checks to keep
 * a re-merge from STACKING onto an already-merged case. Cleared when the mesh
 * backup is restored (undo-all reverts to the pre-merge original).
 */
export interface AppliedAssembly {
  /** The plan that was applied (order + coupled interfaces + rigid transforms). */
  plan: MergePlan;
  /** True when the assembly was built onto the project's own case mesh (base=case). */
  baseIsCase: boolean;
  /** ISO 8601 timestamp of the successful promote that recorded this assembly. */
  appliedAt: string;
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
 * OpenFOAM solver applications the app accepts as a run target. The actual solver
 * is read from the case's `system/controlDict` `application` keyword; this set
 * bounds what we accept (and is reused by the web client's labels). `simpleFoam`
 * (steady) and `pimpleFoam` (transient) are the incompressible RANS solvers the
 * app can scaffold and configure (see SOLVER_CATALOG). `foamRun` is kept as a
 * legacy generic placeholder the conversion scaffold may write: it is accepted as
 * a name but is deliberately NOT configurable/runnable (the runnable gate refuses
 * it), so a freshly-converted case must be pointed at a real solver first.
 *
 * Invocation is flavour-correct for ESI OpenFOAM.com v2406: classic binaries are
 * run directly (`simpleFoam -case …`, `pimpleFoam -case …`), never `foamRun -solver`.
 */
export const SOLVER_IDS = [
  // Incompressible
  'simpleFoam',
  'pimpleFoam',
  'pisoFoam',
  'icoFoam',
  'nonNewtonianIcoFoam',
  'potentialFoam',
  'SRFSimpleFoam',
  'porousSimpleFoam',
  'adjointShapeOptimizationFoam',
  // Compressible
  'rhoSimpleFoam',
  'rhoPimpleFoam',
  'rhoPorousSimpleFoam',
  // High-speed / supersonic
  'rhoCentralFoam',
  'sonicFoam',
  // Heat transfer & buoyancy
  'buoyantSimpleFoam',
  'buoyantPimpleFoam',
  'chtMultiRegionFoam',
  // Free surface (VoF)
  'interFoam',
  'interIsoFoam',
  'multiphaseInterFoam',
  'interPhaseChangeFoam',
  'compressibleInterFoam',
  'driftFluxFoam',
  'potentialFreeSurfaceFoam',
  // Multiphase (Euler)
  'multiphaseEulerFoam',
  'reactingTwoPhaseEulerFoam',
  // Combustion & reactions
  'reactingFoam',
  'rhoReactingFoam',
  'XiFoam',
  'fireFoam',
  'chemFoam',
  // Particles (Lagrangian)
  'DPMFoam',
  'MPPICFoam',
  'reactingParcelFoam',
  // Basic & scalar
  'laplacianFoam',
  'scalarTransportFoam',
  // Solid mechanics
  'solidDisplacementFoam',
  // Electromagnetics
  'electrostaticFoam',
  'mhdFoam',
  'magneticFoam',
  // Rarefied / molecular
  'dsmcFoam',
  // Legacy generic placeholder (openfoam.org launcher); accepted but never runnable here.
  'foamRun',
] as const;
export type SolverId = (typeof SOLVER_IDS)[number];

/**
 * The solvers the app can fully set up (scaffold) and configure through the
 * Easy/Advanced solver panel. A subset of SOLVER_IDS: `foamRun` is excluded (it is
 * a non-runnable placeholder). Drives the runnable gate, the scaffold renderers,
 * and the frontend solver picker + easy-mode form.
 */
/**
 * Every solver the app guides (scaffold + Easy/Advanced configure) is now the whole
 * library minus `foamRun` (a non-runnable placeholder). Each library solver gets a
 * generated SolverSpec (see buildSolverSpec / SOLVER_CATALOG): the incompressible +
 * compressible RANS families get the full template; the other physics families get a
 * base flow scaffold you extend. `ConfigurableSolverId` is therefore any SolverId.
 * `CONFIGURABLE_SOLVER_IDS` is defined next to SOLVER_CATALOG (needs SOLVER_LIBRARY).
 */
export type ConfigurableSolverId = SolverId;

/** Is `id` a solver the app guides (any library binary, not the foamRun placeholder)? */
export function isConfigurableSolver(id: string): id is ConfigurableSolverId {
  return id !== 'foamRun' && SOLVER_LIBRARY.some((info) => info.id === id);
}

/**
 * How one curated "easy mode" solver parameter is edited, and where it lives. The
 * frontend renders a control by `kind` and, on change, splices the new value into
 * `file` at the dictionary `path` (via the same position-aware FOAM model the
 * per-file editor uses), then saves that one file. This is what lets a single
 * solver form write across controlDict / transportProperties / turbulenceProperties
 * / fvSolution / 0-fields at once.
 */
export interface SolverParamDef {
  /** Stable identity for the control (also its DOM id seed). */
  key: string;
  /** Short human label shown next to the control. */
  label: string;
  /** One concise sentence of help. */
  help?: string;
  /** Control kind: `enum`/`bool` render a <select> (options required), else an input. */
  kind: 'enum' | 'scalar' | 'integer' | 'bool' | 'vector' | 'text';
  /** Allowed tokens for `enum`/`bool` (bool lists the on-token first). */
  options?: string[];
  /** A representative example value (placeholder / default hint). */
  example?: string;
  /** Case file this parameter is written to, e.g. 'system/controlDict'. */
  file: string;
  /** Dictionary path of the leaf within that file, e.g. ['SIMPLE','residualControl','p']. */
  path: string[];
}

/** A solver the app can scaffold and configure, with its files and easy-mode knobs. */
export interface SolverSpec {
  id: ConfigurableSolverId;
  /** Case-archetype label for the picker, e.g. 'Steady-state, incompressible (RANS)'. */
  label: string;
  /** One-line "when to use this" summary. */
  summary: string;
  /** Steady (converges on residuals) vs transient (runs to endTime in time steps). */
  regime: 'steady' | 'transient';
  /** Physical family — bounds which parameters/files make sense (extensible). */
  family: 'incompressible' | 'compressible' | 'multiphase' | 'potential';
  /** Files this case needs to be runnable by this solver, beyond the mesh. */
  requiredFiles: string[];
  /** Curated cross-file parameters exposed in easy mode. */
  easyParams: SolverParamDef[];
  /**
   * `full` = a complete, verified template for its physics (the incompressible +
   * compressible RANS families). `base` = a flow scaffold + the universal knobs the
   * other families share; the solver's physics-specific fields are added by the user.
   */
  tier: 'full' | 'base';
}

/**
 * Files an incompressible RANS case needs beyond the mesh: the system trio plus
 * transport + turbulence properties and the 0/ turbulence fields. simpleFoam and
 * pimpleFoam share this exact set — only the file *contents* differ (steadyState
 * vs Euler time scheme, SIMPLE vs PIMPLE algorithm, steady vs transient control).
 */
export const INCOMPRESSIBLE_RANS_FILES = [
  'system/controlDict',
  'system/fvSchemes',
  'system/fvSolution',
  'constant/transportProperties',
  'constant/turbulenceProperties',
  '0/U',
  '0/p',
  '0/k',
  '0/omega',
  '0/nut',
] as const;

/** Incompressible RANS turbulence models offered in easy mode (RAS.RASModel). */
const RAS_MODEL_OPTIONS = [
  'kOmegaSST',
  'kEpsilon',
  'kOmega',
  'realizableKE',
  'RNGkEpsilon',
  'SpalartAllmaras',
  'LaunderSharmaKE',
];

// Individual easy-mode parameters, composed per solver by buildSolverSpec.
const turbulenceParam: SolverParamDef = {
  key: 'rasModel',
  label: 'Turbulence model',
  help: 'RANS turbulence model. kOmegaSST is a robust all-rounder for wall-bounded flow.',
  kind: 'enum',
  options: RAS_MODEL_OPTIONS,
  example: 'kOmegaSST',
  file: 'constant/turbulenceProperties',
  path: ['RAS', 'RASModel'],
};
const nuParam: SolverParamDef = {
  key: 'nu',
  label: 'Kinematic viscosity (nu)',
  help: 'Fluid kinematic viscosity in m^2/s (water ~ 1e-06, air ~ 1.5e-05).',
  kind: 'text',
  example: '[0 2 -1 0 0 0 0] 1e-06',
  file: 'constant/transportProperties',
  path: ['nu'],
};
const muParam: SolverParamDef = {
  key: 'mu',
  label: 'Dynamic viscosity (mu)',
  help: 'Fluid dynamic viscosity in Pa.s (air ~ 1.8e-05). Used by the const transport model.',
  kind: 'scalar',
  example: '1.8e-05',
  file: 'constant/thermophysicalProperties',
  path: ['mixture', 'transport', 'mu'],
};
const initialUParam: SolverParamDef = {
  key: 'initialU',
  label: 'Initial velocity',
  help: 'Internal field the run starts from, e.g. `uniform (0 0 0)` for fluid at rest.',
  kind: 'text',
  example: 'uniform (0 0 0)',
  file: '0/U',
  path: ['internalField'],
};
const initialTParam: SolverParamDef = {
  key: 'initialT',
  label: 'Initial temperature',
  help: 'Internal temperature field in kelvin, e.g. `uniform 300`.',
  kind: 'text',
  example: 'uniform 300',
  file: '0/T',
  path: ['internalField'],
};
const initialPParam: SolverParamDef = {
  key: 'initialP',
  label: 'Initial pressure',
  help: 'Internal ABSOLUTE pressure field in Pa, e.g. `uniform 100000` (1 atm).',
  kind: 'text',
  example: 'uniform 100000',
  file: '0/p',
  path: ['internalField'],
};
const endTimeParam: SolverParamDef = {
  key: 'endTime',
  label: 'End time / iterations',
  help: 'Final iteration (steady) or simulated time in seconds (transient) the run targets.',
  kind: 'scalar',
  example: '1000',
  file: 'system/controlDict',
  path: ['endTime'],
};
const writeIntervalParam: SolverParamDef = {
  key: 'writeInterval',
  label: 'Write interval',
  help: 'How often results are written, in the unit set by writeControl.',
  kind: 'scalar',
  example: '100',
  file: 'system/controlDict',
  path: ['writeInterval'],
};
const residualPParam: SolverParamDef = {
  key: 'residualP',
  label: 'Convergence residual (p)',
  help: 'The run stops once the pressure residual falls below this (e.g. 1e-4).',
  kind: 'scalar',
  example: '1e-4',
  file: 'system/fvSolution',
  path: ['SIMPLE', 'residualControl', 'p'],
};
const relaxPParam: SolverParamDef = {
  key: 'relaxP',
  label: 'Pressure relaxation',
  help: 'Under-relaxation for pressure (0.3 is safe; higher converges faster but may diverge).',
  kind: 'scalar',
  example: '0.3',
  file: 'system/fvSolution',
  path: ['relaxationFactors', 'fields', 'p'],
};
const deltaTParam: SolverParamDef = {
  key: 'deltaT',
  label: 'Time step (deltaT)',
  help: 'Simulated seconds per step. Keep the Courant number near 1; lower if it diverges.',
  kind: 'scalar',
  example: '1e-4',
  file: 'system/controlDict',
  path: ['deltaT'],
};
const adjustTimeStepParam: SolverParamDef = {
  key: 'adjustTimeStep',
  label: 'Adjust time step',
  help: 'Let the solver adapt deltaT each step to hold the max Courant number.',
  kind: 'bool',
  options: ['yes', 'no'],
  example: 'yes',
  file: 'system/controlDict',
  path: ['adjustTimeStep'],
};
const maxCoParam: SolverParamDef = {
  key: 'maxCo',
  label: 'Max Courant number',
  help: 'Upper bound on the Courant number when adjustTimeStep is on (1 is typical).',
  kind: 'scalar',
  example: '1',
  file: 'system/controlDict',
  path: ['maxCo'],
};
/**
 * Steady-solver toggle for SIMPLEC (SIMPLE-Consistent). Writes `consistent yes|no;`
 * into the SIMPLE block of system/fvSolution. Exposed only on the full steady
 * templates (simpleFoam / rhoSimpleFoam), whose SIMPLE block already carries this key.
 */
const consistentParam: SolverParamDef = {
  key: 'consistent',
  label: 'Consistent (SIMPLEC)',
  help:
    'Switches the steady SIMPLE loop to its SIMPLEC (SIMPLE-Consistent) variant by writing ' +
    '`consistent yes;` in the SIMPLE block of fvSolution. SIMPLEC folds the neighbour-coefficient ' +
    'term into the pressure correction, so pressure no longer needs heavy under-relaxation ' +
    '(you can raise the pressure relaxation toward 1) and a steady run usually converges in ' +
    'noticeably fewer iterations. A safe default for steady internal flow such as turbine ' +
    'passages; if a run turns unstable, switch it off and lower the pressure relaxation instead.',
  kind: 'bool',
  options: ['yes', 'no'],
  example: 'yes',
  file: 'system/fvSolution',
  path: ['SIMPLE', 'consistent'],
};

/**
 * Files a compressible RANS case needs beyond the mesh: like the incompressible
 * set but with thermophysicalProperties instead of transportProperties, a
 * temperature field 0/T, and 0/alphat (turbulent thermal diffusivity). Here 0/p is
 * ABSOLUTE pressure in Pa (not the incompressible kinematic p, which is p/rho).
 */
export const COMPRESSIBLE_RANS_FILES = [
  'system/controlDict',
  'system/fvSchemes',
  'system/fvSolution',
  'constant/thermophysicalProperties',
  'constant/turbulenceProperties',
  '0/U',
  '0/p',
  '0/T',
  '0/k',
  '0/omega',
  '0/nut',
  '0/alphat',
] as const;

/** Categories whose base scaffold + templates are compressible (0/p absolute, thermo, 0/T). */
const COMPRESSIBLE_CATEGORIES = ['compressible', 'supersonic', 'heatTransfer', 'combustion'];
/** Categories with a complete, verified template (full easy-param set). */
const FULL_TEMPLATE_CATEGORIES = ['incompressible', 'compressible', 'supersonic'];
/** Categories that are not fluid flow: no turbulence knob in the base easy form. */
const NON_FLOW_CATEGORIES = ['basic', 'solid', 'electromagnetics', 'molecular'];

/**
 * Build a solver's easy-mode spec from its library entry. Every library solver is
 * guided: the incompressible + compressible RANS families (FULL_TEMPLATE_CATEGORIES)
 * get the complete template + full parameter set; every other family gets a base
 * flow scaffold (the same RANS file set) plus the universal knobs it shares
 * (turbulence, initial velocity, end time, write interval, and time-step controls
 * when transient) — its physics-specific fields are added by the user in Advanced.
 */
function buildSolverSpec(info: SolverInfo): SolverSpec {
  const compressible = COMPRESSIBLE_CATEGORIES.includes(info.category);
  const full = FULL_TEMPLATE_CATEGORIES.includes(info.category);
  const flow = !NON_FLOW_CATEGORIES.includes(info.category);
  const regime = info.regime ?? 'steady';

  const easyParams: SolverParamDef[] = [];
  if (flow) easyParams.push(turbulenceParam);
  if (full && !compressible) easyParams.push(nuParam);
  if (full && compressible) easyParams.push(muParam);
  easyParams.push(initialUParam);
  if (full && compressible) easyParams.push(initialTParam, initialPParam);
  easyParams.push(endTimeParam, writeIntervalParam);
  if (regime === 'transient') easyParams.push(deltaTParam, adjustTimeStepParam, maxCoParam);
  else if (full) easyParams.push(residualPParam, relaxPParam, consistentParam);

  return {
    id: info.id,
    label: info.label,
    summary: info.summary,
    regime,
    family: compressible ? 'compressible' : 'incompressible',
    requiredFiles: compressible ? [...COMPRESSIBLE_RANS_FILES] : [...INCOMPRESSIBLE_RANS_FILES],
    easyParams,
    tier: full ? 'full' : 'base',
  };
}

// SOLVER_CATALOG, CONFIGURABLE_SOLVER_IDS and SOLVER_SPECS are generated from
// SOLVER_LIBRARY (via buildSolverSpec) just after it is defined below — every
// library solver becomes guided, so the catalog is derived, not hand-written.

/**
 * Physics families the solver library is grouped by in the picker overlay. Order
 * here is the display order (most common first). Mirrors the tutorial families in
 * synthese/SYNTHESE.md, mapped to the ESI v2406 classic binaries the box runs.
 */
export const SOLVER_CATEGORIES = [
  { id: 'incompressible', label: 'Incompressible' },
  { id: 'compressible', label: 'Compressible' },
  { id: 'heatTransfer', label: 'Heat transfer & buoyancy' },
  { id: 'freeSurface', label: 'Free surface (VoF)' },
  { id: 'multiphaseEuler', label: 'Multiphase (Euler-Euler)' },
  { id: 'combustion', label: 'Combustion & reactions' },
  { id: 'particle', label: 'Particles (Lagrangian)' },
  { id: 'supersonic', label: 'High-speed / supersonic' },
  { id: 'basic', label: 'Basic & scalar transport' },
  { id: 'solid', label: 'Solid mechanics' },
  { id: 'electromagnetics', label: 'Electromagnetics' },
  { id: 'molecular', label: 'Rarefied / molecular' },
] as const;
export type SolverCategory = (typeof SOLVER_CATEGORIES)[number]['id'];

/**
 * One entry in the full solver library shown in the picker overlay: the ESI binary
 * name, a human label, a one-line description, its physics family, and (when known)
 * its time regime. Whether the app can fully scaffold + easy-configure a solver is
 * NOT stored here: it is derived from SOLVER_CATALOG via isConfigurableSolver(id).
 * Every other solver is still selectable (it sets controlDict `application` and is
 * configured through the case-file editor).
 */
export interface SolverInfo {
  id: SolverId;
  label: string;
  summary: string;
  category: SolverCategory;
  regime?: 'steady' | 'transient';
}

/** The full ESI v2406 solver library (drives the selection overlay). */
export const SOLVER_LIBRARY: SolverInfo[] = [
  // Incompressible
  { id: 'simpleFoam', label: 'Steady-state, incompressible (RANS)', summary: 'Time-averaged single-phase flow that settles to a steady solution.', category: 'incompressible', regime: 'steady' },
  { id: 'pimpleFoam', label: 'Transient, incompressible (URANS)', summary: 'Time-accurate single-phase flow for unsteady dynamics.', category: 'incompressible', regime: 'transient' },
  { id: 'pisoFoam', label: 'Transient, incompressible (PISO)', summary: 'Transient single-phase flow with the PISO pressure-velocity loop.', category: 'incompressible', regime: 'transient' },
  { id: 'icoFoam', label: 'Transient laminar (icoFoam)', summary: 'Transient laminar Newtonian flow. The classic lid-driven cavity solver.', category: 'incompressible', regime: 'transient' },
  { id: 'nonNewtonianIcoFoam', label: 'Transient laminar, non-Newtonian', summary: 'Transient laminar flow with a non-Newtonian rheology model.', category: 'incompressible', regime: 'transient' },
  { id: 'potentialFoam', label: 'Potential flow', summary: 'Inviscid potential flow, usually used to initialise a velocity field.', category: 'incompressible' },
  { id: 'SRFSimpleFoam', label: 'Steady, single rotating frame (SRF)', summary: 'Steady incompressible flow in one rotating reference frame (SRF).', category: 'incompressible', regime: 'steady' },
  { id: 'porousSimpleFoam', label: 'Steady, incompressible + porous', summary: 'Steady incompressible flow with porous-media momentum sources.', category: 'incompressible', regime: 'steady' },
  { id: 'adjointShapeOptimizationFoam', label: 'Adjoint shape optimisation', summary: 'Adjoint-based shape optimisation for steady incompressible flow.', category: 'incompressible', regime: 'steady' },
  // Compressible
  { id: 'rhoSimpleFoam', label: 'Steady-state, compressible (RANS)', summary: 'Time-averaged compressible flow with heat, settling to steady.', category: 'compressible', regime: 'steady' },
  { id: 'rhoPimpleFoam', label: 'Transient, compressible (RANS)', summary: 'Time-accurate compressible flow with heat, for unsteady dynamics.', category: 'compressible', regime: 'transient' },
  { id: 'rhoPorousSimpleFoam', label: 'Steady, compressible + porous', summary: 'Steady compressible flow with porous zones and heat transfer.', category: 'compressible', regime: 'steady' },
  // High-speed / supersonic
  { id: 'rhoCentralFoam', label: 'Density-based, high-speed', summary: 'Density-based compressible solver for shocks (Kurganov-Tadmor).', category: 'supersonic', regime: 'transient' },
  { id: 'sonicFoam', label: 'Transient, trans/supersonic', summary: 'Transient compressible flow through the transonic and supersonic range.', category: 'supersonic', regime: 'transient' },
  // Heat transfer & buoyancy
  { id: 'buoyantSimpleFoam', label: 'Steady, buoyant (natural convection)', summary: 'Steady compressible flow driven by buoyancy (natural convection).', category: 'heatTransfer', regime: 'steady' },
  { id: 'buoyantPimpleFoam', label: 'Transient, buoyant', summary: 'Transient compressible flow driven by buoyancy and heat.', category: 'heatTransfer', regime: 'transient' },
  { id: 'chtMultiRegionFoam', label: 'Conjugate heat transfer (CHT)', summary: 'Coupled heat transfer across solid and fluid regions.', category: 'heatTransfer' },
  // Free surface (VoF)
  { id: 'interFoam', label: 'Two-phase free surface (VoF)', summary: 'Two incompressible phases with a sharp interface (Volume of Fluid).', category: 'freeSurface', regime: 'transient' },
  { id: 'interIsoFoam', label: 'Two-phase VoF (isoAdvector)', summary: 'interFoam with the geometric isoAdvector interface capturing scheme.', category: 'freeSurface', regime: 'transient' },
  { id: 'multiphaseInterFoam', label: 'Many-phase free surface (VoF)', summary: 'More than two incompressible phases with sharp interfaces (VoF).', category: 'freeSurface', regime: 'transient' },
  { id: 'interPhaseChangeFoam', label: 'Two-phase VoF + cavitation', summary: 'Two-phase VoF with phase change, for cavitation.', category: 'freeSurface', regime: 'transient' },
  { id: 'compressibleInterFoam', label: 'Two-phase compressible free surface', summary: 'Two compressible phases with a sharp free surface.', category: 'freeSurface', regime: 'transient' },
  { id: 'driftFluxFoam', label: 'Drift-flux mixture', summary: 'Mixture drift-flux for settling suspensions (sludge, sediment).', category: 'freeSurface', regime: 'transient' },
  { id: 'potentialFreeSurfaceFoam', label: 'Potential free surface', summary: 'Incompressible flow with a linearised potential free surface.', category: 'freeSurface', regime: 'transient' },
  // Multiphase (Euler-Euler)
  { id: 'multiphaseEulerFoam', label: 'Euler-Euler multiphase', summary: 'Interpenetrating phases: bubble columns, fluidised beds, boiling.', category: 'multiphaseEuler', regime: 'transient' },
  { id: 'reactingTwoPhaseEulerFoam', label: 'Two-phase Euler + reactions', summary: 'Two Euler-Euler phases with mass transfer, reactions and heat.', category: 'multiphaseEuler', regime: 'transient' },
  // Combustion & reactions
  { id: 'reactingFoam', label: 'Combustion (detailed chemistry)', summary: 'Compressible reacting flow with detailed finite-rate chemistry.', category: 'combustion', regime: 'transient' },
  { id: 'rhoReactingFoam', label: 'Combustion (density-based)', summary: 'Density-based compressible combustion with chemistry.', category: 'combustion', regime: 'transient' },
  { id: 'XiFoam', label: 'Premixed combustion', summary: 'Premixed and partially premixed turbulent combustion (Xi model).', category: 'combustion', regime: 'transient' },
  { id: 'fireFoam', label: 'Fire and spray', summary: 'Fire, pool fires and spray combustion with radiation.', category: 'combustion', regime: 'transient' },
  { id: 'chemFoam', label: 'Single-cell chemistry', summary: 'Zero-dimensional chemistry for validating a reaction mechanism.', category: 'combustion', regime: 'transient' },
  // Particles (Lagrangian)
  { id: 'DPMFoam', label: 'Dense discrete particles (DPM)', summary: 'Dense Lagrangian particles two-way coupled to a carrier fluid.', category: 'particle', regime: 'transient' },
  { id: 'MPPICFoam', label: 'Dense particle cloud (MP-PIC)', summary: 'Dense particle cloud without resolving inter-particle collisions.', category: 'particle', regime: 'transient' },
  { id: 'reactingParcelFoam', label: 'Reacting Lagrangian parcels', summary: 'Reacting Lagrangian parcels (sprays, droplets) in a reacting gas.', category: 'particle', regime: 'transient' },
  // Basic & scalar transport
  { id: 'laplacianFoam', label: 'Laplace / diffusion', summary: 'Solves the Laplace equation: pure diffusion of a scalar.', category: 'basic', regime: 'transient' },
  { id: 'scalarTransportFoam', label: 'Passive scalar transport', summary: 'Transports a passive scalar through a frozen velocity field.', category: 'basic', regime: 'transient' },
  // Solid mechanics
  { id: 'solidDisplacementFoam', label: 'Linear-elastic solid stress', summary: 'Small-strain linear-elastic stress and displacement in a solid.', category: 'solid', regime: 'transient' },
  // Electromagnetics
  { id: 'electrostaticFoam', label: 'Electrostatics', summary: 'Electrostatic potential with charge density transport.', category: 'electromagnetics', regime: 'transient' },
  { id: 'mhdFoam', label: 'Magnetohydrodynamics', summary: 'Incompressible conducting fluid coupled to a magnetic field (MHD).', category: 'electromagnetics', regime: 'transient' },
  { id: 'magneticFoam', label: 'Magnetostatics', summary: 'Magnetic field of a set of permanent magnets.', category: 'electromagnetics' },
  // Rarefied / molecular
  { id: 'dsmcFoam', label: 'Rarefied gas (DSMC)', summary: 'Direct Simulation Monte Carlo for rarefied and high-Knudsen gas.', category: 'molecular', regime: 'transient' },
];

/**
 * The solver catalog: one SolverSpec per library solver, generated from
 * SOLVER_LIBRARY via buildSolverSpec. The single source of truth both the backend
 * (runnable gate, scaffold renderers) and the frontend (solver picker, easy-mode
 * form) consume. Every library binary is guided; foamRun stays out (placeholder).
 */
export const SOLVER_CATALOG = Object.fromEntries(
  SOLVER_LIBRARY.map((info) => [info.id, buildSolverSpec(info)]),
) as Record<SolverId, SolverSpec>;

/** Every guided solver id (the full library, in picker order). */
export const CONFIGURABLE_SOLVER_IDS: SolverId[] = SOLVER_LIBRARY.map((info) => info.id);

/** The catalog as an ordered list (library order). */
export const SOLVER_SPECS: SolverSpec[] = CONFIGURABLE_SOLVER_IDS.map((id) => SOLVER_CATALOG[id]);

/**
 * One turbulence model offered in the setup wizard's second step. `simulationType`
 * is what goes into constant/turbulenceProperties: `laminar` disables turbulence
 * (the RAS/RASModel entry is then irrelevant); `RAS` writes RAS.RASModel = `id`.
 * These models apply to every incompressible and compressible RANS solver here.
 */
export interface TurbulenceModelSpec {
  /** OpenFOAM RAS.RASModel / LES.LESModel token, or 'laminar' for no model. */
  id: string;
  /** Short human label shown on the card. */
  label: string;
  /** One-line "when to use this" summary. */
  summary: string;
  /** Modelling approach, written as simulationType in turbulenceProperties. */
  simulationType: 'laminar' | 'RAS' | 'LES';
  /**
   * The 0/ turbulence fields this model actually reads (basenames, e.g.
   * ['k','omega','nut']). Single source of truth for which fields the case
   * generator writes — and which it deletes on a model switch: k-epsilon carries
   * epsilon (never omega), Spalart-Allmaras carries nuTilda, the Reynolds-stress
   * models carry R, and laminar carries none.
   */
  fields: readonly string[];
}

/** Turbulence approaches for grouping the models in the picker (laminar first). */
export const TURBULENCE_APPROACHES = [
  { id: 'laminar', label: 'Laminar / DNS' },
  { id: 'RAS', label: 'RANS (time-averaged)' },
  { id: 'LES', label: 'LES / DES (scale-resolving)' },
] as const;
export type TurbulenceApproach = (typeof TURBULENCE_APPROACHES)[number]['id'];

/**
 * Turbulence models offered by the setup wizard, grouped by approach in the UI via
 * simulationType. Covers laminar/DNS, the common RANS models (including two
 * Reynolds-stress models) and the LES/DES subgrid models. kOmegaSST is the default.
 */
export const TURBULENCE_MODELS: TurbulenceModelSpec[] = [
  // Laminar / DNS
  {
    id: 'laminar',
    label: 'Laminar (no model)',
    summary: 'No turbulence model. For low Reynolds number, creeping flow, or a resolved DNS.',
    simulationType: 'laminar',
    fields: [],
  },
  // RANS
  {
    id: 'kOmegaSST',
    label: 'k-omega SST',
    summary: 'Robust all-rounder for wall-bounded flow and adverse pressure gradients.',
    simulationType: 'RAS',
    fields: ['k', 'omega', 'nut'],
  },
  {
    id: 'kOmega',
    label: 'k-omega',
    summary: 'Strong near walls and at low Reynolds number; sensitive to the freestream.',
    simulationType: 'RAS',
    fields: ['k', 'omega', 'nut'],
  },
  {
    id: 'kEpsilon',
    label: 'k-epsilon',
    summary: 'Classic model for fully turbulent free-shear and internal flows.',
    simulationType: 'RAS',
    fields: ['k', 'epsilon', 'nut'],
  },
  {
    id: 'realizableKE',
    label: 'Realizable k-epsilon',
    summary: 'A k-epsilon variant that does better on swirling and separated flow.',
    simulationType: 'RAS',
    fields: ['k', 'epsilon', 'nut'],
  },
  {
    id: 'RNGkEpsilon',
    label: 'RNG k-epsilon',
    summary: 'Renormalisation-group k-epsilon, improved for strained and swirling flow.',
    simulationType: 'RAS',
    fields: ['k', 'epsilon', 'nut'],
  },
  {
    id: 'LaunderSharmaKE',
    label: 'Launder-Sharma k-epsilon',
    summary: 'Low-Reynolds k-epsilon that integrates to the wall (no wall functions).',
    simulationType: 'RAS',
    fields: ['k', 'epsilon', 'nut'],
  },
  {
    id: 'kOmegaSSTLM',
    label: 'k-omega SST LM (transition)',
    summary: 'k-omega SST with the Langtry-Menter laminar-turbulent transition model.',
    simulationType: 'RAS',
    // Transition adds gammaInt/ReThetat; the core turbulence fields are k/omega/nut.
    fields: ['k', 'omega', 'nut'],
  },
  {
    id: 'SpalartAllmaras',
    label: 'Spalart-Allmaras',
    summary: 'One-equation model tuned for external aerodynamics.',
    simulationType: 'RAS',
    fields: ['nuTilda', 'nut'],
  },
  {
    id: 'LRR',
    label: 'Reynolds stress (LRR)',
    summary: 'Reynolds-stress model: resolves anisotropy, no eddy-viscosity assumption.',
    simulationType: 'RAS',
    fields: ['R', 'k', 'epsilon', 'nut'],
  },
  {
    id: 'SSG',
    label: 'Reynolds stress (SSG)',
    summary: 'Speziale-Sarkar-Gatski Reynolds-stress model for strongly anisotropic flow.',
    simulationType: 'RAS',
    fields: ['R', 'k', 'epsilon', 'nut'],
  },
  // LES / DES
  {
    id: 'Smagorinsky',
    label: 'Smagorinsky',
    summary: 'Algebraic subgrid model. Simple and cheap; needs near-wall damping.',
    simulationType: 'LES',
    fields: ['nut'],
  },
  {
    id: 'kEqn',
    label: 'kEqn',
    summary: 'One-equation subgrid kinetic-energy model. A common LES default.',
    simulationType: 'LES',
    fields: ['k', 'nut'],
  },
  {
    id: 'dynamicKEqn',
    label: 'Dynamic kEqn',
    summary: 'kEqn with dynamically computed model coefficients.',
    simulationType: 'LES',
    fields: ['k', 'nut'],
  },
  {
    id: 'WALE',
    label: 'WALE',
    summary: 'Wall-adapting subgrid model with correct near-wall scaling.',
    simulationType: 'LES',
    fields: ['nut'],
  },
  {
    id: 'dynamicLagrangian',
    label: 'Dynamic Lagrangian',
    summary: 'Dynamic Smagorinsky with Lagrangian averaging along pathlines.',
    simulationType: 'LES',
    fields: ['nut'],
  },
  {
    id: 'SpalartAllmarasDES',
    label: 'Spalart-Allmaras DES',
    summary: 'Detached Eddy Simulation on the Spalart-Allmaras base.',
    simulationType: 'LES',
    fields: ['nuTilda', 'nut'],
  },
  {
    id: 'SpalartAllmarasDDES',
    label: 'Spalart-Allmaras DDES',
    summary: 'Delayed DES: shields the boundary layer from grid-induced separation.',
    simulationType: 'LES',
    fields: ['nuTilda', 'nut'],
  },
  {
    id: 'SpalartAllmarasIDDES',
    label: 'Spalart-Allmaras IDDES',
    summary: 'Improved delayed DES with wall-modelled LES near walls.',
    simulationType: 'LES',
    fields: ['nuTilda', 'nut'],
  },
  {
    id: 'kOmegaSSTDES',
    label: 'k-omega SST DES',
    summary: 'Detached Eddy Simulation built on k-omega SST.',
    simulationType: 'LES',
    fields: ['k', 'omega', 'nut'],
  },
];

/**
 * Every 0/ turbulence field the app may generate for an incompressible/compressible
 * RANS/LES case. Used to DELETE the fields a chosen model does not read (so a
 * k-epsilon case ships no stale omega). `nut` is common to every turbulence model;
 * the rest are model-specific.
 */
export const TURBULENCE_FIELD_NAMES = ['k', 'epsilon', 'omega', 'nut', 'nuTilda', 'R'] as const;

/**
 * The 0/ turbulence field basenames a model reads. The single source of truth the
 * case generator uses to write EXACTLY the fields a model needs (k-epsilon →
 * k/epsilon/nut, k-omega → k/omega/nut, Spalart-Allmaras → nuTilda/nut, RSM →
 * R/k/epsilon/nut) and to remove the others. `laminar` reads none. An unknown id
 * falls back to the k-omega set (the app default family), never [].
 */
export function turbulenceFieldsFor(modelId: string): string[] {
  const model = TURBULENCE_MODELS.find((entry) => entry.id === modelId);
  if (!model) return ['k', 'omega', 'nut'];
  return [...model.fields];
}

/**
 * The wall-function boundary type for a turbulence field on a `wall` patch under
 * `modelId`, or null when the field is not one the model reads (caller then uses a
 * generic BC). Standard high-Re wall functions, valid for ESI OpenFOAM.com v2406:
 *   nut     → nutkWallFunction (k-based models) | nutUSpaldingWallFunction (no-k: SA, algebraic LES)
 *   k       → kqRWallFunction
 *   epsilon → epsilonWallFunction
 *   omega   → omegaWallFunction
 *   R       → kqRWallFunction
 *   nuTilda → fixedValue (0 at the wall)
 * These are the model-aware BCs the app writes automatically when a patch is a wall,
 * so the user never wires them by hand.
 */
export function turbulenceWallBc(fieldName: string, modelId: string): string | null {
  const fields = turbulenceFieldsFor(modelId);
  if (!fields.includes(fieldName)) return null;
  switch (fieldName) {
    case 'k':
      return 'kqRWallFunction';
    case 'epsilon':
      return 'epsilonWallFunction';
    case 'omega':
      return 'omegaWallFunction';
    case 'R':
      return 'kqRWallFunction';
    case 'nuTilda':
      return 'fixedValue';
    case 'nut':
      return fields.includes('k') ? 'nutkWallFunction' : 'nutUSpaldingWallFunction';
    default:
      return null;
  }
}

/** The turbulence model ids, as a literal tuple for zod validation. Matches TURBULENCE_MODELS. */
export const TURBULENCE_MODEL_IDS = [
  'laminar',
  'kOmegaSST',
  'kOmega',
  'kEpsilon',
  'realizableKE',
  'RNGkEpsilon',
  'LaunderSharmaKE',
  'kOmegaSSTLM',
  'SpalartAllmaras',
  'LRR',
  'SSG',
  'Smagorinsky',
  'kEqn',
  'dynamicKEqn',
  'WALE',
  'dynamicLagrangian',
  'SpalartAllmarasDES',
  'SpalartAllmarasDDES',
  'SpalartAllmarasIDDES',
  'kOmegaSSTDES',
] as const;
export type TurbulenceModelId = (typeof TURBULENCE_MODEL_IDS)[number];

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
  'INVALID_BC_PLAN',
  'BC_CSV_REQUIRED',
  'BC_APPLY_FAILED',
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

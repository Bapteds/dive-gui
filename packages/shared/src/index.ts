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
 * How a turbine's rotating region is coupled to the stationary flow:
 *  - 'frozenRotor': steady Multiple Reference Frame (MRF). The rotor cell zone is
 *    solved in a rotating frame at a constant omega; the mesh does NOT move. Fast,
 *    runs with the steady simpleFoam solver. Writes constant/MRFProperties.
 *  - 'movingRotor': transient rigid-body rotation (sliding mesh). The rotor cell
 *    zone is physically rotated each time step. Physically accurate but needs a
 *    transient solver (pimpleFoam) and a cyclicAMI interface. Writes
 *    constant/dynamicMeshDict.
 */
export const ROTOR_MODES = ['frozenRotor', 'movingRotor'] as const;
export type RotorMode = (typeof ROTOR_MODES)[number];

/** Display metadata for a rotor mode (picker card + which constant/ file it writes). */
export interface RotorModeInfo {
  id: RotorMode;
  label: string;
  summary: string;
  /** The OpenFOAM constant/ dictionary written for this mode. */
  file: 'constant/MRFProperties' | 'constant/dynamicMeshDict';
}

export const ROTOR_MODE_LIBRARY: Record<RotorMode, RotorModeInfo> = {
  frozenRotor: {
    id: 'frozenRotor',
    label: 'Frozen Rotor (MRF)',
    summary:
      'Steady multiple reference frame. The rotor zone is solved in a rotating frame; the mesh stays put. Fast, works with simpleFoam.',
    file: 'constant/MRFProperties',
  },
  movingRotor: {
    id: 'movingRotor',
    label: 'Moving Rotor (sliding mesh)',
    summary:
      'Transient rigid-body rotation of the rotor zone. Most accurate, but needs a transient solver (pimpleFoam) and a cyclicAMI interface.',
    file: 'constant/dynamicMeshDict',
  },
};

/**
 * A moving rotor is either driven at an imposed speed ('forced', solidBodyMotion /
 * rotatingMotion) or spins freely under the flow forces ('free', a 6-DoF rigid
 * body). Only meaningful when the rotor mode is 'movingRotor'.
 */
export const MOVING_ROTOR_KINDS = ['forced', 'free'] as const;
export type MovingRotorKind = (typeof MOVING_ROTOR_KINDS)[number];

/** Display metadata for a moving-rotor sub-kind (forced vs free). */
export interface MovingRotorKindInfo {
  id: MovingRotorKind;
  label: string;
  summary: string;
}

export const MOVING_ROTOR_KIND_LIBRARY: Record<MovingRotorKind, MovingRotorKindInfo> = {
  forced: {
    id: 'forced',
    label: 'Forced rotation',
    summary:
      'The rotor spins at an imposed constant speed (omega). solidBodyMotionFvMesh + rotatingMotion.',
  },
  free: {
    id: 'free',
    label: 'Free (fluid-driven)',
    summary:
      'The rotor spins freely under the flow forces: a 6-DoF rigid body about one axis. Needs mass and inertia.',
  },
};

/**
 * Free (6-DoF) rotor parameters, used when a moving rotor is fluid-driven
 * (movingKind === 'free'). Mirrors documents/dynamicMeshDict.notforced: the moving
 * wall `patches` form a rigid body constrained to rotate about `axis` through its
 * `centreOfMass` (the fixed point), with `mass` and `momentOfInertia`, morphing
 * between `innerDistance`/`outerDistance`, an `rhoInf` density and an angular damper.
 */
export interface SixDofRotorConfig {
  /** The moving wall patch(es) that form the rigid body (e.g. the runner blades). */
  patches: string[];
  /** Free rotation axis (the sixDoF `axis` constraint). */
  axis: [number, number, number];
  /** Centre of mass = centre of rotation (the fixed point). */
  centreOfMass: [number, number, number];
  /** Rigid-body mass [kg]. */
  mass: number;
  /** Moment of inertia [kg m^2] about (x, y, z). */
  momentOfInertia: [number, number, number];
  /** Fluid density for the incompressible rhoInf handling [kg/m^3]. */
  rhoInf: number;
  /** Inner morphing distance (solid-body region limit) [m]. */
  innerDistance: number;
  /** Outer morphing distance (interpolation region limit) [m]. */
  outerDistance: number;
  /** Spherical angular damper coefficient [N m s/rad]. */
  damperCoeff: number;
}

/**
 * The rotation setup for a turbine's rotor. `omega` is the angular velocity in
 * rad/s (the UI may collect rpm and convert). `origin` is any point on the axis of
 * rotation; `axis` is its direction (need not be a unit vector). `cellZone` is the
 * mesh cell zone that rotates. For frozenRotor, `nonRotatingPatches` lists patches
 * inside that zone that stay stationary (e.g. the casing walls); it is ignored for
 * movingRotor. For a movingRotor, `movingKind` picks forced (imposed omega) vs free
 * (6-DoF, `sixDof` required); it defaults to 'forced'.
 */
export interface RotorConfig {
  mode: RotorMode;
  cellZone: string;
  origin: [number, number, number];
  axis: [number, number, number];
  omega: number;
  nonRotatingPatches?: string[];
  /** Moving-rotor sub-kind: imposed speed ('forced', default) or fluid-driven ('free'). */
  movingKind?: MovingRotorKind;
  /** 6-DoF parameters, required when mode === 'movingRotor' && movingKind === 'free'. */
  sixDof?: SixDofRotorConfig;
}

/**
 * A request to apply a component BC preset to a project case. `inlet` / `outlet`
 * are the single inlet / outlet patch names the user assigned from the mesh; the
 * remaining assigned patches are `walls` (no-slip + wall functions). For a draft
 * tube (csvProfile) the CSV file rides alongside as multipart, not in this body.
 * `rotor` is only meaningful for a turbine (its rotating region); it writes the
 * MRF or dynamic-mesh dictionary in addition to the 0/ boundary conditions.
 */
export interface ApplyBoundaryConditionsRequest {
  objectType: ObjectType;
  mode: DrivingMode;
  inlet: string;
  outlet: string;
  walls: string[];
  values: BoundaryConditionValues;
  rotor?: RotorConfig;
}

/** The rotor dictionary written, echoed back for the UI summary. */
export interface AppliedRotor {
  mode: RotorMode;
  cellZone: string;
  /** Angular velocity written, in rad/s (0 for a free/fluid-driven moving rotor). */
  omega: number;
  /** The constant/ file written (MRFProperties or dynamicMeshDict). */
  file: string;
  /** For a moving rotor: forced (imposed omega) vs free (6-DoF). */
  movingKind?: MovingRotorKind;
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
  /** The rotor dictionary written (turbine with a rotor config), when applicable. */
  rotor?: AppliedRotor;
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
 *   - splitMeshRegions:         make one cellZone per combined region (OpenFOAM splitMeshRegions
 *                               -makeCellZones), so the parts stay addressable after the merge
 *                               (e.g. as the turbine MRF rotor cellZone). Runs before coupling.
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
  'splitMeshRegions',
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
  /**
   * cellZones of the resulting mesh — one per combined part, created by
   * splitMeshRegions on a multi-part assembly (empty for a single mesh or on
   * failure). These are the zones the turbine template can point MRFProperties at
   * (a rotating region becomes the MRF rotor cellZone).
   */
  cellZones: string[];
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

// ---------------------------------------------------------------------------
// Meshing sessions (STL surface -> snappyHexMesh -> constant/polyMesh).
//
// A standalone workspace (NOT project-scoped): a session holds one or more STL
// surface files and a snappyHexMesh configuration, and produces a volume mesh
// the user can visualize and download. Shared so the API and the web client
// agree on the config shape, the session shape, and the per-step run report
// (which reuses the mesh-import ImportStep / MeshImportConversion above).
// ---------------------------------------------------------------------------

/** Root directory (under STORAGE_DIR) holding every meshing session. */
export const MESHING_DIRNAME = 'meshing';

/** File extensions a meshing session accepts as an input surface. */
export const STL_EXTENSION = '.stl';
/** cfMesh's native surface format (geometry + feature edges + patches in one file). */
export const FMS_EXTENSION = '.fms';

/**
 * The mesh generator a session uses, chosen at creation and fixed for its life:
 *  - snappy : snappyHexMesh on STL surface(s) (the original flow).
 *  - cfmesh : cfMesh cartesianMesh (hex-dominant) on merged STL(s) or a single FMS.
 * The two take DIFFERENT settings (SnappyConfig vs CfMeshConfig) and DIFFERENT
 * inputs (snappy: STL only; cfmesh: STL(s) or one FMS).
 */
export const MESHING_ENGINES = ['snappy', 'cfmesh'] as const;
export type MeshingEngine = (typeof MESHING_ENGINES)[number];

/**
 * Which side of the surface the volume mesh keeps — the single knob that flips a
 * snappyHexMesh run between the two flow regimes:
 *  - internal : the fluid is INSIDE the geometry (e.g. the bore of a pipe /
 *    chamber). locationInMesh sits inside the surface; snappy keeps the interior.
 *  - external : the fluid is AROUND the geometry (flow past a body). locationInMesh
 *    sits in the background box but outside the surface; snappy keeps the exterior.
 */
export const DOMAIN_TYPES = ['internal', 'external'] as const;
export type DomainType = (typeof DOMAIN_TYPES)[number];

/** Axis-aligned bounding box (metres) — the union of a session's STL surfaces. */
export interface MeshBounds {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * The snappyHexMesh tunables for one run. Sensible auto defaults
 * (DEFAULT_SNAPPY_CONFIG) drive the simple path; the Advanced section exposes the
 * rest. `baseCellSize` null and `locationInMesh` null mean "derive from the STL
 * bounds server-side" (background cell ≈ bbox diagonal / 40; keep-point = the
 * bbox centre for internal, a background-box corner for external).
 */
/** A surface refinement level range (min <= max). */
export interface SurfaceRefinement {
  min: number;
  max: number;
}

/**
 * Per-surface boundary-layer override (snappy), keyed by STL file name. Absent key
 * => the config's global nLayers / expansionRatio / finalLayerThickness are used.
 * `relativeSizes` is NOT here: it is a single addLayersControls switch with no
 * per-region equivalent in OpenFOAM, so it stays global on AddLayersConfig.
 */
export interface SurfaceLayerSpec {
  /** Number of prism layers on this surface (>= 1). */
  nLayers: number;
  /** Growth ratio between successive layers (>= 1). */
  expansionRatio: number;
  /** Near-wall layer thickness (relative or absolute per the global relativeSizes). */
  finalLayerThickness: number;
}

/** Boundary-layer (prism) growth controls for the surfaces. */
export interface AddLayersConfig {
  enabled: boolean;
  /**
   * The STL surfaces (by file name) on which to grow layers — the boundaries the
   * prism layers attach to. Omitted or empty means every surface (legacy default),
   * so an old config keeps working; the UI lists one checkbox per surface.
   */
  surfaces?: string[];
  /** Global default number of prism layers (per-surface override wins). */
  nLayers: number;
  /**
   * When true, `finalLayerThickness` is a fraction of the local cell size;
   * when false it is an absolute length (metres). Maps to snappy `relativeSizes`.
   * GLOBAL only — OpenFOAM has no per-region relativeSizes.
   */
  relativeSizes: boolean;
  /** Global default near-wall layer thickness (per-surface override wins). */
  finalLayerThickness: number;
  /** Global default growth ratio between successive layers (>= 1) (per-surface override wins). */
  expansionRatio: number;
  /** Per-surface overrides keyed by STL file name; absent key => the globals above. */
  perSurface?: Record<string, SurfaceLayerSpec>;
}

/**
 * Per-patch feature-edge extraction override (snappy), keyed by STL file name.
 * Absent key => the config's global `featureAngle` / `featureLevel` are used.
 */
export interface FeatureRefinement {
  /** surfaceFeatureExtract includedAngle threshold in degrees (0–180). */
  includedAngle: number;
  /** snappy octree refinement level applied near the extracted edges (int 0–10). */
  level: number;
}

export interface SnappyConfig {
  /** Discriminates the meshing-config union; always 'snappy' here. */
  engine: 'snappy';
  domainType: DomainType;
  /** Background (blockMesh) cell edge length in metres; null => derive from bounds. */
  baseCellSize: number | null;
  /** Background-box padding as a fraction of the STL bbox diagonal (e.g. 0.1). */
  marginFactor: number;
  /** Default surface refinement applied to a region with no per-surface override. */
  surfaceRefinement: SurfaceRefinement;
  /** Per-surface refinement keyed by STL file name; falls back to `surfaceRefinement`. */
  surfaceRefinements?: Record<string, SurfaceRefinement>;
  /** Global default feature-edge (eMesh) refinement level; per-patch override wins. */
  featureLevel: number;
  /** Global default surfaceFeatureExtract includedAngle (deg); per-patch override wins. */
  featureAngle: number;
  /** Per-STL feature overrides keyed by file name; absent key => the two globals above. */
  featureRefinements?: Record<string, FeatureRefinement>;
  /**
   * STL surfaces (by file name) whose feature edges are extracted + refined. Omitted
   * or empty means EVERY surface (legacy default), so an old config keeps working. A
   * surface not in this list is excluded from surfaceFeatureExtractDict AND from the
   * snappyHexMeshDict `features` list — its edges are not captured.
   */
  featureSurfaces?: string[];
  /** Explicit keep-point; null => derive from bounds + domainType. */
  locationInMesh: [number, number, number] | null;
  /** Boundary-layer (prism) growth on the surfaces. */
  addLayers: AddLayersConfig;
  /**
   * CPU cores for the run. 1 meshes serially (the classic
   * blockMesh -> surfaceFeatureExtract -> snappyHexMesh -> checkMesh chain); more
   * runs snappyHexMesh in parallel (decomposePar -> mpirun -np N snappyHexMesh
   * -parallel -> reconstructParMesh), which is dramatically faster on a fine mesh.
   * Clamped server-side to the machine's core budget.
   */
  cores: number;
}

/** The auto/minimal defaults the config form starts from. */
export const DEFAULT_SNAPPY_CONFIG: SnappyConfig = {
  engine: 'snappy',
  domainType: 'internal',
  baseCellSize: null,
  marginFactor: 0.1,
  surfaceRefinement: { min: 1, max: 2 },
  featureLevel: 2,
  featureAngle: 150,
  locationInMesh: null,
  addLayers: {
    enabled: false,
    nLayers: 3,
    relativeSizes: true,
    finalLayerThickness: 0.5,
    expansionRatio: 1.2,
  },
  cores: 1,
};

/**
 * Per-patch boundary-layer override (cfMesh), keyed by patch name (STL solid / FMS
 * patch). Absent key => the config's global cfMesh layer values are used. Rendered
 * as a `patchBoundaryLayers` sub-block, cfMesh's native per-patch mechanism.
 */
export interface CfMeshPatchLayerSpec {
  /** Number of prism layers on this patch (>= 1). */
  nLayers: number;
  /** Growth ratio (cfMesh thicknessRatio, >= 1). */
  thicknessRatio: number;
  /** Cap on the first (near-wall) layer thickness in metres; null => cfMesh decides. */
  maxFirstLayerThickness: number | null;
}

/**
 * cfMesh (cartesianMesh) boundary-layer controls. cfMesh sizes are ABSOLUTE
 * lengths and use a different vocabulary from snappy: growth is `thicknessRatio`
 * and the near-wall layer is capped by `maxFirstLayerThickness` (rather than
 * snappy's relativeSizes / finalLayerThickness / expansionRatio). The global
 * fields are the default; `perPatch` overrides them for named patches.
 */
export interface CfMeshLayersConfig {
  enabled: boolean;
  /** Global default number of prism layers. */
  nLayers: number;
  /** Global default growth ratio (>= 1). Maps to cfMesh thicknessRatio. */
  thicknessRatio: number;
  /** Global default cap on the first-layer thickness (m); null => cfMesh decides. */
  maxFirstLayerThickness: number | null;
  /** Per-patch overrides keyed by patch name; absent key => the globals above. */
  perPatch?: Record<string, CfMeshPatchLayerSpec>;
  /**
   * Patches that grow NO boundary layers, keyed by patch name. Rendered as a
   * `patchBoundaryLayers { "<patch>" { nLayers 0; } }` entry. Absent or empty =>
   * no patch is force-disabled (every patch inherits the global block unless it
   * has a `perPatch` custom override). A name in both `perPatch` and here is
   * treated as custom (perPatch wins).
   */
  noLayerPatches?: string[];
}

/**
 * OpenFOAM boundary-patch types a cfMesh patch can be assigned (via meshDict
 * renameBoundary). `cyclic`/`wedge` need extra coefficients so they are out of
 * scope here; these are the standalone types the UI offers. An unassigned patch
 * keeps whatever type the FMS / cfMesh gave it.
 */
export const CFMESH_PATCH_TYPES = ['patch', 'wall', 'symmetry', 'symmetryPlane', 'empty'] as const;
export type CfMeshPatchType = (typeof CFMESH_PATCH_TYPES)[number];

/** A discovered boundary patch: its name and its CURRENT type (from the FMS), or null. */
export interface MeshingPatch {
  name: string;
  /** The type read from the FMS header, or null (an STL has no patch types). */
  type: string | null;
}

/**
 * cfMesh cartesianMesh tunables. Writes system/meshDict. cfMesh meshes the volume
 * bounded by the (closed) surface — INTERNAL flow — so there is no domain-type /
 * keep-point knob like snappy. Sizes are absolute metres; `maxCellSize` null means
 * "derive from the STL bounds" (diag/40), which requires known bounds — a raw FMS
 * has none, so `maxCellSize` must be set for an FMS input.
 */
/**
 * Per-patch local cell-size refinement (cfMesh), keyed by patch name. Rendered as a
 * meshDict `localRefinement { "<patch>" { cellSize X; } }` entry. Absent key => the
 * patch uses the global sizing (boundaryCellSize if set, else maxCellSize).
 */
export interface CfMeshLocalRefinement {
  /** Target cell size at this patch, in metres (> 0). */
  cellSize: number;
}

export interface CfMeshConfig {
  /** Discriminates the meshing-config union; always 'cfmesh' here. */
  engine: 'cfmesh';
  /** Base (max) cell size in metres. null => derive from the STL bounds (diag/40). */
  maxCellSize: number | null;
  /** Optional refinement floor (min cell size, m); null => no size-based refinement. */
  minCellSize: number | null;
  /** Optional cell size at the boundary (m); null => same as maxCellSize. */
  boundaryCellSize: number | null;
  /** STL input: extract feature edges (surfaceFeatureEdges) into an FMS first. */
  extractFeatures: boolean;
  /** Feature angle (deg) for the edge extraction. */
  featureAngle: number;
  /** Boundary (prism) layers, applied to all boundaries. */
  addLayers: CfMeshLayersConfig;
  /**
   * Per-boundary OpenFOAM patch type, keyed by patch name (the FMS patch names, or
   * the STL solid / file names). A patch absent here keeps its FMS/cfMesh default.
   * Written to meshDict as a `renameBoundary` block.
   */
  patchTypes?: Record<string, CfMeshPatchType>;
  /**
   * Per-patch local cell-size refinement keyed by patch name; absent key => the
   * patch uses the global sizing. Rendered as a meshDict `localRefinement` block.
   */
  localRefinement?: Record<string, CfMeshLocalRefinement>;
  /** OpenMP threads for cartesianMesh (cfMesh is multithreaded, not MPI-decomposed). */
  cores: number;
}

/** The config a run/session carries; its `engine` selects the shape. */
export type MeshingConfig = SnappyConfig | CfMeshConfig;

/**
 * A chamber build's patches transfer into a meshing session as one STL per patch;
 * the pre-merged domain.stl in trisurface.zip is NEVER transferred (it would
 * duplicate every patch's triangles). Both engines consume the per-patch files:
 * snappy directly, cfMesh via its existing run-time merge.
 */
export const CHAMBER_TRANSFER_EXCLUDED_STL = 'domain.stl';

/** The auto/minimal cfMesh defaults the config form starts from. */
export const DEFAULT_CFMESH_CONFIG: CfMeshConfig = {
  engine: 'cfmesh',
  maxCellSize: null,
  minCellSize: null,
  boundaryCellSize: null,
  extractFeatures: true,
  featureAngle: 45,
  addLayers: { enabled: false, nLayers: 3, thicknessRatio: 1.2, maxFirstLayerThickness: null },
  cores: 1,
};

/** The default config for a given engine. */
export function defaultMeshingConfig(engine: MeshingEngine): MeshingConfig {
  return engine === 'cfmesh' ? DEFAULT_CFMESH_CONFIG : DEFAULT_SNAPPY_CONFIG;
}

/** One uploaded input surface of a meshing session. */
export interface StlFile {
  /** File name within the session's constant/triSurface directory. */
  name: string;
  sizeBytes: number;
}

/** The last meshing run of a session: the config used and its per-step report. */
export interface MeshingRun {
  config: MeshingConfig;
  result: MeshImportConversion;
  /** ISO 8601 timestamp of the run. */
  at: string;
}

/**
 * The lifecycle status of a meshing run, a background job (mirrors the solver's
 * run states, pared to what the mesher needs):
 *  - 'running'   — the pipeline is executing; the log is streaming.
 *  - 'succeeded' — every step passed (a usable polyMesh was produced).
 *  - 'failed'    — a step failed (a tool error, or a missing binary).
 *  - 'stopped'   — the user cancelled the run mid-flight.
 */
export type MeshingRunStatus = 'running' | 'succeeded' | 'failed' | 'stopped';

/** Meshing statuses that are still executing (worth polling the log for). */
export const ACTIVE_MESHING_STATUSES: readonly MeshingRunStatus[] = ['running'];

/** Is this meshing status still active (the run is executing)? 'idle'/undefined ⇒ no. */
export function isMeshingRunActive(status: MeshingRunStatus | 'idle' | undefined): boolean {
  return status !== undefined && (ACTIVE_MESHING_STATUSES as readonly string[]).includes(status);
}

/** Persisted lifecycle state of a session's most recent run (the status.json sidecar). */
export interface MeshingRunState {
  status: MeshingRunStatus;
  /** ISO 8601 timestamp the run started. */
  startedAt: string;
  /** ISO 8601 timestamp the run finished, or null while it is still running. */
  finishedAt: string | null;
}

/**
 * Live-log poll payload for a meshing session's current/last run — the mesher's
 * analogue of the solver's RunLogPayload. Polled by the client while a run is
 * active, then once more when it reaches a terminal status.
 */
export interface MeshingLogPayload {
  /** The run's lifecycle status; 'idle' when no run has ever started. */
  status: MeshingRunStatus | 'idle';
  /** ISO 8601 start time, or null when idle. */
  startedAt: string | null;
  /** ISO 8601 finish time, or null while running / idle. */
  finishedAt: string | null;
  /** Bounded tail of the streamed mesher output (the whole log when small). */
  logTail: string;
  /** Total size of the log on disk in bytes. */
  logBytes: number;
  /** The finished run report (config + per-step steps), present once a run completes. */
  run: MeshingRun | null;
}

/** A meshing session as shown in the list (no surface/run detail). */
export interface MeshingSessionSummary {
  id: string;
  name: string;
  /** The mesh generator this session uses (fixed at creation). */
  engine: MeshingEngine;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  stlCount: number;
  /** True once a run has produced constant/polyMesh. */
  hasMesh: boolean;
}

/** A full meshing session: summary + its surfaces, bounds, and last run. */
export interface MeshingSession extends MeshingSessionSummary {
  stls: StlFile[];
  /** Union bounding box of the STLs (null when none uploaded / unparseable). */
  bounds: MeshBounds | null;
  lastRun: MeshingRun | null;
  /**
   * The last config the user edited (autosaved), independent of a run — so manual
   * settings survive a reload even before the mesh is generated. Null when the
   * session has never been configured; the form then seeds from `lastRun.config`.
   * Its `engine` always matches the session's engine.
   */
  savedConfig: MeshingConfig | null;
  /** Max cores a run may request (the machine's core budget). */
  maxCores: number;
  /**
   * Lifecycle status of the session's current/last run ('idle' when none has ever
   * started). Lets the page lock the Run button and resume tailing a live run on
   * load, before the first log poll returns.
   */
  runStatus: MeshingRunStatus | 'idle';
  /**
   * Boundary patches discovered from the input surface (cfMesh only): the FMS
   * patches (with their current type), the STL solid names, or the merged file
   * names. Empty for snappy (whose patches are per-STL) or when nothing is
   * uploaded. Drives the per-patch boundary-type editor.
   */
  patches: MeshingPatch[];
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

// ---------------------------------------------------------------------------
// Chamber Creation (standalone /chamber page).
//
// Three empirical inputs (X1, X2, X3) drive twelve geometry parameters through
// a fitted regression model (11 linear, 1 power), replacing the old Excel
// calculator. Each output keeps the calculator's optional Min / Max / Exact
// override -> FINAL value + Status. The twelve FINAL values (mm), plus a direct
// LENGTH input (mm), are the geometry parameters the buildChamber.py builder
// consumes (converted to metres). This model is the single source of truth for
// the whole feature (the Python builder receives already-resolved params, so it
// carries no model logic).
// ---------------------------------------------------------------------------

/**
 * Directory name (under STORAGE_DIR) holding a chamber build's rendered
 * artifacts, keyed by a hash of its inputs. Global, not project-scoped (mirrors
 * MESHING_DIRNAME): the chamber generator is a standalone tool.
 */
export const CHAMBER_DIRNAME = 'chamber';

/** Model outputs and the LENGTH input are in millimetres; the builder converts to metres. */
export const CHAMBER_UNIT = 'mm';

/**
 * Valid input ranges for the three empirical inputs (from the fit's training
 * span; extrapolate with care). Used by the input form's validation.
 */
export const CHAMBER_INPUT_RANGES = {
  x1: { min: 700, max: 2420 },
  x2: { min: 1.8, max: 14.9 },
  x3: { min: 1, max: 23 },
} as const;

/**
 * The twelve output parameter keys, in display order. Each key is also the JSON
 * key the buildChamber.py builder reads (plus `length`, a direct input).
 */
export const CHAMBER_OUTPUT_KEYS = [
  'width',
  'height',
  'distFromSideChamfer1',
  'chamferLength1',
  'chamferWidth1',
  'chamferLength2',
  'chamferWidth2',
  'distFromEnd',
  'dLast',
  'hMiddle',
  'hMiddlePlusFirst',
  'hLast',
] as const;
export type ChamberOutputKey = (typeof CHAMBER_OUTPUT_KEYS)[number];

/** Honesty labels for a parameter's leave-one-out cross-validation error. */
export type ChamberConfidence = 'Good' | 'High' | 'Moderate' | 'Low';

/** The functional form of a parameter's own X1–X3 fit. */
export type ChamberForm = 'linear' | 'power';

/** A structural relation's kind: refine a fit from a measured partner, or a
 * linear combination of other outputs' FINAL values. */
export type ChamberRelationKind = 'refine' | 'combination';

/**
 * A toggleable structural relation for one output. When ON it overrides the
 * output's own X1–X3 fit (precedence: a Set-exact override still wins over it,
 * and Min/Max still clamp after). Two shapes:
 *  - 'refine': when the PARTNER output has a measured (Exact) value, use a sharper
 *    fit a + b*X1 + c*X2 + d*X3 + p*(partner Exact). With no measured partner it
 *    falls back to this output's own base fit, so toggling it on is harmless.
 *  - 'combination': FINAL = constant + Σ coeff × partner.final (e.g. LEB = 2·HLE,
 *    LT = LF1 + LF2, LE = 255.16 + 3.4954·HLE). Reads partners' FINAL values, so
 *    an override on a partner propagates.
 */
export interface ChamberRelation {
  kind: ChamberRelationKind;
  /** Whether the toggle defaults to on. */
  defaultOn: boolean;
  /** Toggle name and (for combinations) the Status label, e.g. '= LEB + LEOW'. */
  label: string;
  /** One-line explanation for the per-relation dropdown. */
  description: string;
  /** 'refine': the partner whose measured (Exact) value sharpens this output. */
  partner?: ChamberOutputKey;
  /** 'refine': sharper-fit coefficients a + b*X1 + c*X2 + d*X3 + p*(partner Exact). */
  refineCoeffs?: { a: number; b: number; c: number; d: number; p: number };
  /** 'combination': terms of constant + Σ coeff × partner.final. */
  terms?: readonly { key: ChamberOutputKey; coeff: number }[];
  /** 'combination': additive constant (default 0). */
  constant?: number;
}

/**
 * The fitted model for one output. `form` is its own X1–X3 fit — `linear`:
 * a + b*X1 + c*X2 + d*X3, `power`: k * X1^e1 * X2^e2 * X3^e3 — always present and
 * used when the output has no active relation. `cvError` is the leave-one-out
 * RMSE as a percent of the mean (lower is better); `confidence` is its honesty
 * label. `relation`, when present, is a toggleable structural relation that
 * overrides the base fit while it is on.
 */
export interface ChamberOutputSpec {
  key: ChamberOutputKey;
  label: string;
  form: ChamberForm;
  cvError: number;
  confidence: ChamberConfidence;
  /** Base X1–X3 fit coefficients (every output has one). */
  coeffs:
    | { a: number; b: number; c: number; d: number }
    | { k: number; e1: number; e2: number; e3: number };
  relation?: ChamberRelation;
}

/**
 * The fitted coefficients for all twelve outputs (full precision). P4/P5
 * (chamfer 1 length/width) intentionally share one formula. Single source of
 * truth for the model on both the client (live preview) and the server.
 */
export const CHAMBER_OUTPUT_SPECS: readonly ChamberOutputSpec[] = [
  // P1: width. Refines from a measured B1 (P3).
  { key: 'width', label: 'B Kammer', form: 'linear', cvError: 18.8, confidence: 'Moderate',
    coeffs: { a: 3501.480486, b: -0.01990289598, c: -104.4968392, d: 224.0149301 },
    relation: { kind: 'refine', defaultOn: true, partner: 'distFromSideChamfer1',
      label: 'refine from B1', description: 'Sharpen B Kammer from a measured B1 (its Exact); R² 0.51 → 0.81.',
      refineCoeffs: { a: 1101.528235, b: 0.5004560281, c: -19.97360475, d: 78.2136825, p: 0.976665205 } } },
  // P2: height. Own linear fit; relation = LEB + LEOW.
  { key: 'height', label: 'H Kammer', form: 'linear', cvError: 28.6, confidence: 'Moderate',
    coeffs: { a: -2655.561158, b: 3.469850592, c: 500.9913764, d: -178.9974433 },
    relation: { kind: 'combination', defaultOn: true, label: '= LEB + LEOW',
      description: 'H Kammer = LEB + LEOW (middle+first plus last cylinder height).',
      terms: [{ key: 'hMiddlePlusFirst', coeff: 1 }, { key: 'hLast', coeff: 1 }] } },
  // P3: distFromSideChamfer1. Refines from a measured B Kammer (P1).
  { key: 'distFromSideChamfer1', label: 'B1', form: 'linear', cvError: 32.0, confidence: 'Low',
    coeffs: { a: 1913.645229, b: -0.1144287145, c: -38.895132, d: 115.1237973 },
    relation: { kind: 'refine', defaultOn: true, partner: 'width',
      label: 'refine from B Kammer', description: 'Sharpen B1 from a measured B Kammer (its Exact); R² 0.09 → 0.62.',
      refineCoeffs: { a: -417.365864, b: -0.2106437417, c: 14.17960421, d: -32.6306581, p: 0.7098088714 } } },
  // P4: chamferLength1. No relation.
  { key: 'chamferLength1', label: 'LF1', form: 'linear', cvError: 20.6, confidence: 'Moderate',
    coeffs: { a: -2.009758353, b: 0.9116908157, c: 16.38088606, d: -19.61930855 } },
  // P5: chamferWidth1. relation = LF1.
  { key: 'chamferWidth1', label: 'BF1', form: 'linear', cvError: 20.6, confidence: 'Moderate',
    coeffs: { a: -2.009758353, b: 0.9116908157, c: 16.38088606, d: -19.61930855 },
    relation: { kind: 'combination', defaultOn: true, label: '= LF1',
      description: 'BF1 = LF1 (chamfer 1 width equals its length).',
      terms: [{ key: 'chamferLength1', coeff: 1 }] } },
  // P6: chamferLength2. relation = LF1 (both chamfers equal).
  { key: 'chamferLength2', label: 'LF2', form: 'linear', cvError: 18.6, confidence: 'Moderate',
    coeffs: { a: 810.7255952, b: 0.1366396239, c: -70.24908474, d: 55.86948952 },
    relation: { kind: 'combination', defaultOn: true, label: '= LF1',
      description: 'LF2 = LF1 (both chamfers equal).',
      terms: [{ key: 'chamferLength1', coeff: 1 }] } },
  // P7: chamferWidth2. relation = LF2.
  { key: 'chamferWidth2', label: 'BF2', form: 'linear', cvError: 22.0, confidence: 'Moderate',
    coeffs: { a: 1207.055875, b: -0.137521288, c: -128.8078895, d: 79.76891504 },
    relation: { kind: 'combination', defaultOn: true, label: '= LF2',
      description: 'BF2 = LF2 (chamfer 2 width equals its length).',
      terms: [{ key: 'chamferLength2', coeff: 1 }] } },
  // P8: distFromEnd. relation = LF1 + LF2 (chamfered part).
  { key: 'distFromEnd', label: 'LT', form: 'linear', cvError: 27.2, confidence: 'Moderate',
    coeffs: { a: -359.9271681, b: 2.188772589, c: 48.83409566, d: -45.9108988 },
    relation: { kind: 'combination', defaultOn: true, label: '= LF1 + LF2',
      description: 'LT = LF1 + LF2 (the chamfered part).',
      terms: [{ key: 'chamferLength1', coeff: 1 }, { key: 'chamferLength2', coeff: 1 }] } },
  // P9: dLast. relation = 255.16 + 3.4954 × HLE.
  { key: 'dLast', label: 'LE (Durchmesser)', form: 'linear', cvError: 8.1, confidence: 'Good',
    coeffs: { a: 221.4522145, b: 1.498949106, c: -9.02505593, d: 14.40321366 },
    relation: { kind: 'combination', defaultOn: true, label: '= f(HLE)',
      description: 'LE = 255.16 + 3.4954 × HLE.',
      constant: 255.16, terms: [{ key: 'hMiddle', coeff: 3.4954 }] } },
  // P10: hMiddle. No relation.
  { key: 'hMiddle', label: 'HLE', form: 'linear', cvError: 5.8, confidence: 'High',
    coeffs: { a: 17.17464869, b: 0.435873881, c: -6.126007422, d: 2.320487817 } },
  // P11: hMiddlePlusFirst. Own power fit; relation = 2 × HLE.
  { key: 'hMiddlePlusFirst', label: 'LEB', form: 'power', cvError: 24.9, confidence: 'Moderate',
    coeffs: { k: 0.0000000238913334, e1: 3.631996617, e2: 0.647878341, e3: -1.281050007 },
    relation: { kind: 'combination', defaultOn: true, label: '= 2 × HLE',
      description: 'LEB = 2 × HLE (middle+first height is twice the middle height).',
      terms: [{ key: 'hMiddle', coeff: 2 }] } },
  // P12: hLast. No relation.
  { key: 'hLast', label: 'LEOW', form: 'linear', cvError: 38.9, confidence: 'Low',
    coeffs: { a: 506.0051287, b: -0.4315856534, c: 312.7206124, d: 47.41062013 } },
];

/** UI descriptor for one toggleable relation (derived from the specs). */
export interface ChamberRelationInfo {
  /** The output the relation drives (also the toggle's id in ChamberInput.relations). */
  key: ChamberOutputKey;
  /** The output's parameter label, e.g. 'H Kammer'. */
  label: string;
  /** The relation's short label, e.g. '= LEB + LEOW' or 'refine from B1'. */
  relationLabel: string;
  /** One-line explanation for the dropdown. */
  description: string;
  /** Default toggle state. */
  defaultOn: boolean;
}

/** The toggleable relations, in output order — the per-relation dropdown iterates this. */
export const CHAMBER_RELATIONS: readonly ChamberRelationInfo[] = CHAMBER_OUTPUT_SPECS.filter(
  (s) => s.relation,
).map((s) => ({
  key: s.key,
  label: s.label,
  relationLabel: s.relation!.label,
  description: s.relation!.description,
  defaultOn: s.relation!.defaultOn,
}));

/** An optional per-output override: pin an Exact value, or clamp to Min / Max. */
export interface ChamberConstraint {
  min?: number;
  max?: number;
  exact?: number;
}

/**
 * The cylinder-stack design options:
 *  - 'stepped': three solid coaxial cylinders (first/middle/last) - the default.
 *  - 'hollow' : first/middle solid, the LAST cylinder an open-top hollow shell
 *    (walls carved out) of a hand-set length, plus a central cylinder (Ø 0.75*X1,
 *    height 0.75*P12) rising from the middle with an oval dome (20% of its height).
 */
export const CHAMBER_VARIANTS = ['stepped', 'hollow'] as const;
export type ChamberVariant = (typeof CHAMBER_VARIANTS)[number];

/** Default wall thickness (mm) of the hollow last cylinder in the 'hollow' variant. */
export const CHAMBER_WALL_THICKNESS_MM = 50;

// Fixed geometry ratios that derive secondary dimensions from the model outputs.
// Single source of truth for the derivation used when a manual override is absent:
// consumed by the API (resolveGeometryParams) and mirrored as the placeholder
// "auto" hints in the web form. The Python builder keeps its own copies of the two
// diameter ratios (it cannot import TS) — keep the values here in sync with it.

/** Runner-case (first cylinder) Ø = this × D_last (from the original Part.stl). */
export const CHAMBER_D_FIRST_OVER_LAST = 1.14703;
/** Guide-vanes / middle-cylinder Ø = this × D_last (both variants). */
export const CHAMBER_D_MIDDLE_OVER_LAST = 0.8;
/** Generator (central cylinder) Ø = this × X1 (hollow variant). */
export const CHAMBER_CENTRAL_DIAMETER_OVER_X1 = 0.75;
/** Generator (central cylinder) height = this × its own diameter (hollow variant). */
export const CHAMBER_CENTRAL_HEIGHT_OVER_DIAMETER = 1.33;
/** Dome height = this × the central cylinder height (hollow variant). */
export const CHAMBER_DOME_HEIGHT_OVER_CENTRAL_HEIGHT = 0.2;

/**
 * The chamber build request: the three empirical inputs, optional per-output
 * Min / Max / Exact overrides, the cylinder design variant, and geometry inputs
 * that are NOT part of the empirical model (all lengths in mm).
 */
export interface ChamberInput {
  x1: number;
  x2: number;
  x3: number;
  constraints?: Partial<Record<ChamberOutputKey, ChamberConstraint>>;
  /**
   * Master switch for ALL structural relations (a hard override). When false,
   * every relation is forced off and each output uses its own X1/X2/X3 fit,
   * regardless of `relations`. Default true.
   */
  relationsMaster?: boolean;
  /**
   * Per-relation on/off, keyed by the driven output. Only consulted when
   * `relationsMaster` is not false. A missing entry uses the relation's own
   * default (all ship on). Keys without a relation are ignored.
   */
  relations?: Partial<Record<ChamberOutputKey, boolean>>;
  /** Cylinder design (default 'stepped'). */
  variant?: ChamberVariant;
  /**
   * Torque-foot orientation in degrees, 0–180: 0/180 = tangential to the cylinder
   * (opposite directions), 90 = radial. Default 45. The triangular gusset only
   * forms at intermediate angles (~37–143°, excluding ~90°); near 0/90/180 the
   * build is refused. Geometry-only (not part of the empirical model).
   */
  footAngleDeg?: number;
  /**
   * Replace the middle-cylinder throat with a scaled ring of guide vanes.
   * Geometry-only (not part of the empirical model); works with both variants.
   * Default false.
   */
  guideVanes?: boolean;
  /**
   * Cut the two asymmetric corners at the box's inlet end (the chamfer).
   * Geometry-only (not part of the empirical model) — the chamfer's own model
   * values (chamferLength1/2, chamferWidth1/2, distFromSideChamfer1,
   * distFromEnd) are still computed and shown in the outputs table, and the
   * internal part's position is unaffected, regardless of this flag. Default
   * true.
   */
  chamferEnabled?: boolean;
  /**
   * Cut the four torque-foot voids (both variants). Geometry-only (not part of
   * the empirical model) — footAngleDeg is still validated/shown, but no feet
   * are cut when this is false, so the box keeps solid corners there. Default
   * true.
   */
  feetEnabled?: boolean;
  /**
   * Absolute guide-vane open angle in degrees. The asset is baked at 50°; the
   * builder swings each blade about its OWN vertical spindle (pivot) axis at
   * pivotRadius by (vaneAngleDeg − 50) to reach this angle. Range 45..55 (±5° about
   * the 50° base). Only affects guide-vane builds (ignored when guideVanes is
   * false). Geometry-only (not part of the empirical model). Default 50.
   */
  vaneAngleDeg?: number;
  /**
   * Outlet inner/outer diameter ratio (0.35..0.50, default 0.45). The outlet's
   * OUTER diameter is X1 (see resolveGeometryParams); the inner diameter is
   * outletRatio * outer. Geometry-only (not part of the empirical model). Only
   * affects guide-vane builds (ignored when guideVanes is false).
   */
  outletRatio?: number;
  /**
   * Uniform scale for the WHOLE internal assembly at once — the three cylinders
   * (and the hollow-variant cup / central cylinder / dome), the four torque feet,
   * and the guide vanes (which key off the last diameter). The BOX (width /
   * length / height), the chamfers, and the part AXIS (positioned by
   * distFromSideChamfer1 / distFromEnd) are NOT scaled, so the cavity grows or
   * shrinks about its own floor-anchored axis inside an unchanged box. Geometry-
   * only (not part of the empirical model). Default 1. Scaling down is unbounded.
   * When the internal stack would overgrow the box height the two designs differ:
   * the STEPPED design REFUSES the build (a clear error) so the entered heights are
   * never silently ignored; the HOLLOW (cone) design — whose generator + dome are
   * meant to fill and usually exceed the box — scales the internal part down to fit
   * (with a warning), which also reduces its heights.
   */
  partScale?: number;
  /** Box length along Y (mm). Omitted => 2 x the (final) width. */
  lengthOverride?: number;
  /** Height (mm) of the hollow last cylinder. Required for the 'hollow' variant. */
  hollowLength?: number;
  /** Wall thickness (mm) of the hollow last cylinder. Default CHAMBER_WALL_THICKNESS_MM. */
  wallThickness?: number;
  /**
   * Manual override for the RUNNER CASE (first cylinder) diameter, in mm. Omitted =>
   * CHAMBER_D_FIRST_OVER_LAST × D_last. Scaled by partScale like the derived value.
   * Both variants. Geometry-only.
   */
  dFirst?: number;
  /**
   * Manual override for the GUIDE-VANES / middle-cylinder diameter, in mm. Omitted =>
   * CHAMBER_D_MIDDLE_OVER_LAST × D_last. In a guide-vane build this drives the vane
   * ring's radial scale (the blade pivot-circle Ø); otherwise it is the middle
   * cylinder's diameter. Scaled by partScale. Both variants. Geometry-only.
   */
  dMiddle?: number;
  /**
   * Manual override for the GENERATOR (central cylinder) diameter, in mm. Omitted =>
   * CHAMBER_CENTRAL_DIAMETER_OVER_X1 × X1. Hollow variant only. Geometry-only.
   */
  centralDiameter?: number;
  /**
   * Manual override for the GENERATOR (central cylinder) height, in mm. Omitted =>
   * CHAMBER_CENTRAL_HEIGHT_OVER_DIAMETER × the (resolved) central diameter. Hollow
   * variant only. Geometry-only.
   */
  centralHeight?: number;
  /**
   * Manual override for the DOME height, in mm. Omitted =>
   * CHAMBER_DOME_HEIGHT_OVER_CENTRAL_HEIGHT × the (resolved) central height. Hollow
   * variant only. Geometry-only.
   */
  domeHeight?: number;
}

/** Longest allowed saved-chamber-build name (trimmed). */
export const CHAMBER_SAVE_NAME_MAX = 80;

/** Attribution shown on a saved chamber build (its author). */
export interface ChamberSaveOwner {
  id: string;
  fullName: string;
}

/**
 * A named, team-shared saved chamber build: the exact `POST /chamber/build`
 * body (`ChamberInput`) under a unique name. Everyone can list and load every
 * save; only the author (or a super-admin) may overwrite, rename, or delete
 * one. Saving is always optional — building never requires a save.
 */
export interface ChamberSaveSummary {
  id: string;
  name: string;
  snapshot: ChamberInput;
  owner: ChamberSaveOwner;
  createdAt: string;
  updatedAt: string;
}

/** What the FINAL clamp did to a model value, mirroring the calculator. A value
 * sourced from an active structural relation reads 'from relation' and carries
 * the human relation label in `ChamberOutput.relationLabel`. */
export type ChamberStatus =
  | 'within range'
  | 'capped at max'
  | 'raised to min'
  | 'set exact'
  | '! min>max'
  | 'from relation';

/** One computed output: the raw model value, the clamped FINAL, and metadata. */
export interface ChamberOutput {
  key: ChamberOutputKey;
  label: string;
  form: ChamberForm;
  /** Raw regression value (mm). */
  model: number;
  /** Value after the Min / Max / Exact override (mm) — what the builder uses. */
  final: number;
  status: ChamberStatus;
  /** Present when status is 'from relation': the relation label, e.g. '= LEB + LEOW'. */
  relationLabel?: string;
  cvError: number;
  confidence: ChamberConfidence;
  /**
   * True when the model value came from an active 'refine' relation (this output's
   * partner had a measured Exact value and the relation was on).
   */
  refined: boolean;
  /**
   * True when this output cannot influence the built geometry with the current
   * settings. Only LEOW (hLast) is ever flagged: the builder never consumes it
   * directly (the stepped last cylinder is pinned through the box top; the hollow
   * build ignores it), so its one lever is the H Kammer = LEB + LEOW relation —
   * an Exact H Kammer or an inactive relation disconnects it.
   */
  noEffect?: boolean;
}

/**
 * Evaluate one output's own X1–X3 fit at (x1, x2, x3). When `partnerKnown` is
 * provided and the spec has a 'refine' relation, the sharper fit
 * (a + b*X1 + c*X2 + d*X3 + p*partnerKnown) is used instead of the base fit.
 */
export function evalChamberSpec(
  spec: ChamberOutputSpec,
  x1: number,
  x2: number,
  x3: number,
  partnerKnown?: number,
): number {
  if (spec.relation?.kind === 'refine' && spec.relation.refineCoeffs && partnerKnown != null) {
    const r = spec.relation.refineCoeffs;
    return r.a + r.b * x1 + r.c * x2 + r.d * x3 + r.p * partnerKnown;
  }
  if (spec.form === 'power') {
    const c = spec.coeffs as { k: number; e1: number; e2: number; e3: number };
    return c.k * Math.pow(x1, c.e1) * Math.pow(x2, c.e2) * Math.pow(x3, c.e3);
  }
  const c = spec.coeffs as { a: number; b: number; c: number; d: number };
  return c.a + c.b * x1 + c.c * x2 + c.d * x3;
}

/**
 * Apply a Min / Max / Exact override to a model value. `baseStatus` is what to
 * report when no override is active — 'within range' for a fitted output, or an
 * identity's own structural-relation label (e.g. '= LEB + LEOW'). Exact wins;
 * an inverted range is flagged and leaves the model value; otherwise clamp.
 */
function resolveChamberFinal(
  model: number,
  con: ChamberConstraint,
  baseStatus: ChamberStatus,
): { final: number; status: ChamberStatus } {
  if (con.exact != null) return { final: con.exact, status: 'set exact' };
  if (con.min != null && con.max != null && con.min > con.max)
    return { final: model, status: '! min>max' };
  if (con.max != null && model > con.max) return { final: con.max, status: 'capped at max' };
  if (con.min != null && model < con.min) return { final: con.min, status: 'raised to min' };
  return { final: model, status: baseStatus };
}

/**
 * Compute the twelve outputs for a set of inputs: the raw model value and the
 * FINAL after the optional Min / Max / Exact override, with a Status. This is
 * the one place the model lives; the Python builder receives the resolved FINAL
 * values and does no model math.
 */
export function computeChamberOutputs(input: ChamberInput): ChamberOutput[] {
  const { x1, x2, x3, constraints } = input;
  // Hard master override: when false, EVERY relation is off. Otherwise each
  // relation follows its per-key toggle, defaulting to its own defaultOn.
  const masterOn = input.relationsMaster !== false;
  const relationOn = (spec: ChamberOutputSpec): boolean =>
    masterOn && !!spec.relation && (input.relations?.[spec.key] ?? spec.relation.defaultOn);

  const byKey = new Map<ChamberOutputKey, ChamberOutput>();
  const setOutput = (
    spec: ChamberOutputSpec,
    model: number,
    baseStatus: ChamberStatus,
    refined: boolean,
    relationLabel?: string,
  ) => {
    const con = constraints?.[spec.key] ?? {};
    const { final, status } = resolveChamberFinal(model, con, baseStatus);
    byKey.set(spec.key, {
      key: spec.key,
      label: spec.label,
      form: spec.form,
      model,
      final,
      status,
      relationLabel: status === 'from relation' ? relationLabel : undefined,
      cvError: spec.cvError,
      confidence: spec.confidence,
      refined,
    });
  };

  // Pass 1: outputs whose value does NOT need another output's FINAL — i.e. no
  // relation, an off relation, or a 'refine' relation (which reads a partner's
  // input Exact, not its computed FINAL). 'combination' relations that are ON are
  // deferred to pass 2. A refine relation is harmless when on but unmeasured: it
  // falls back to the base fit.
  for (const spec of CHAMBER_OUTPUT_SPECS) {
    const on = relationOn(spec);
    if (on && spec.relation!.kind === 'combination') continue; // pass 2
    const partnerKnown =
      on && spec.relation!.kind === 'refine' && spec.relation!.partner
        ? constraints?.[spec.relation!.partner]?.exact
        : undefined;
    const refined = partnerKnown != null;
    const model = evalChamberSpec(spec, x1, x2, x3, partnerKnown);
    setOutput(spec, model, 'within range', refined);
  }

  // Pass 2: ON 'combination' relations — MODEL = constant + Σ coeff × partner.final.
  // They can chain (LEB = 2·HLE, then H Kammer = LEB + LEOW), so resolve to a
  // fixpoint: emit any whose terms are all resolved until none remain. Reading each
  // term's FINAL means an override on a partner (or a chained relation) propagates.
  const combos = CHAMBER_OUTPUT_SPECS.filter((s) => relationOn(s) && s.relation!.kind === 'combination');
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const spec of combos) {
      if (byKey.has(spec.key)) continue;
      const rel = spec.relation!;
      if (!rel.terms!.every((t) => byKey.has(t.key))) continue;
      const model =
        (rel.constant ?? 0) + rel.terms!.reduce((sum, t) => sum + t.coeff * byKey.get(t.key)!.final, 0);
      setOutput(spec, model, 'from relation', false, rel.label);
      progressed = true;
    }
  }

  // LEOW (hLast) only reaches the build through H Kammer = LEB + LEOW: the
  // builder pins the stepped last cylinder through the box top and the hollow
  // build never reads it. When that relation is inactive, or H Kammer is pinned
  // by an Exact, LEOW has no effect on the geometry — flag it so the UI can say so.
  const heightSpec = CHAMBER_OUTPUT_SPECS.find((s) => s.key === 'height')!;
  const heightReadsLeow = relationOn(heightSpec) && constraints?.height?.exact == null;
  if (!heightReadsLeow) byKey.get('hLast')!.noEffect = true;

  return CHAMBER_OUTPUT_KEYS.map((k) => byKey.get(k)!);
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
  'CHAMBER_BUILD_FAILED',
  'CHAMBER_NOT_BUILT',
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
  'NO_STL',
  'INVALID_STL',
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

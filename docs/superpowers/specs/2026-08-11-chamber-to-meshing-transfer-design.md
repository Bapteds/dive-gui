# Chamber → Meshing transfer + session copy — design

**Date:** 2026-08-11
**Feature:** Chamber Creation → Meshing hand-off, and Meshing session duplication
**Scope:** shared types + API (meshing module) + web (Chamber export panel, Meshing list/session UI) + tests. **No change** to `buildChamber.py`, to the empirical model, or to the meshing pipelines (snappy/cfMesh) themselves — this is plumbing that moves already-produced geometry between two existing standalone tools and duplicates an existing session.

---

## 1. Goal

Two connected capabilities, built so both the manual UI and a future headless optimization loop use the **same API**:

1. **Transfer** a built chamber design into a Meshing session — its named patches become the session's input surfaces, ready to mesh with either engine.
2. **Copy** an existing Meshing session (its engine + config + surfaces) into a new session, so a user can re-inject fresh geometry while keeping the prior meshing setup.

The two compose: a single call can copy a session's setup **and** inject a chamber design into the copy in one step (the core operation an optimization iteration performs).

Explicitly **out of scope** (confirmed with the user): the optimization loop itself (design generation, objective functions, iteration control). This task delivers the transfer + copy building blocks only.

## 2. Current mechanism (verified in code)

- **Chamber** (`apps/api/src/modules/chamber/`, `lib/chamberStorage.ts`) is a global, hash-keyed generator. A build already writes `exports/trisurface.zip` containing one ASCII STL per named patch (`inlet.stl`, `outlet.stl`, `cylinder_walls.stl`, `walls.stl`; guide-vane builds emit `hub`/`shroud`/`guide_vanes`/etc.) **plus** a pre-merged multi-solid `domain.stl` (`buildChamber.py:1524-1536`). `readChamberExport(hash, 'trisurface')` returns the zip bytes (`chamberStorage.ts:139-148`).
- **Meshing** (`apps/api/src/modules/meshing/`, `lib/meshingStorage.ts`) is a global, slug-keyed session store. Geometry today enters **only** via multipart upload (`POST /meshing/:id/stl` → `addStlFiles` → `writeStl`, one file per named surface under `constant/triSurface/`). A session's config lives in a `config.json` sidecar (`writeConfig`/`readConfig`), separate from `run.json` and the produced `constant/polyMesh/`.
- **Engine handling of multiple surfaces:** snappy meshes each STL as its own boundary. cfMesh's pipeline **already merges** all of a session's STLs into one ASCII multi-solid surface at run time via `mergeStlFilesToAscii` (`stlMerge.ts`), each file's stem becoming a patch name. So the same per-patch transfer feeds both engines correctly — snappy uses the files directly; cfMesh auto-merges them. **No new merge code, and `domain.stl` must NOT be transferred** (it would duplicate every patch's triangles on top of the per-patch files).
- The app already unzips archives server-side with `adm-zip` (`fileTreeStorage.ts:111`, `exportStorage.ts`), and already duplicates case directories with `fs.cp(src, dest, {recursive:true})` (`meshes.service.ts:658`, `meshBackupStorage.ts:71`).
- No cross-feature hand-off or session-copy mechanism exists today; all of this is new but sits entirely on established patterns.

## 3. Decisions (locked with the user)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Scope | Transfer + copy building blocks only; optimization loop is a separate future project. |
| 2 | Patch granularity | Transfer **each named patch as its own STL**, for both engines (snappy needs them separate; cfMesh's existing run-time merge produces the single ASCII surface it needs). `domain.stl` is excluded. |
| 3 | Transfer target | Support **new session** (default) **and existing session**. |
| 4 | Copy contents | Copy engine + `config.json` + the source's `constant/triSurface/*` surfaces. Do **not** copy run output (`run.json`, `constant/polyMesh/`, `system/*`, `.viz/`). |
| 5 | Combined vs separate | Provide **both**: standalone copy, standalone transfer, **and** a combined "copy setup + inject chamber" path. |
| 6 | Overwrite semantics | Injecting into a session with existing surfaces is **additive with overwrite-by-name** (reuses today's `writeStl` behaviour): a patch whose sanitized filename matches an existing surface replaces it; surfaces with names not in the incoming set are left in place. (Noted caveat below.) |

**Overwrite caveat (documented, not guarded):** if a copied session's surfaces use patch names the new chamber build does not emit (e.g. copying a stepped-variant session, then injecting a guide-vane build that has `hub`/`shroud` instead of `cylinder_walls`), the old non-matching surfaces linger. This matches the user's chosen "config + surfaces" copy semantics; the UI will note it, and the combined path returns the final surface list so a caller can see exactly what the session ended up with.

## 4. Shared types (`packages/shared/src/index.ts`)

Add near the other Meshing types (`MeshingSession` block, ~line 1004-1090):

```ts
/**
 * A chamber build's patch surfaces are transferred into a meshing session as one
 * STL per patch (never the pre-merged domain.stl). Both engines consume the
 * per-patch files: snappy directly, cfMesh via its existing run-time merge.
 */
export const CHAMBER_TRANSFER_EXCLUDED_STL = 'domain.stl';
```

No new interfaces are strictly required (endpoints reuse `MeshingSession`), but for the web client's typed request bodies we add three input shapes mirrored from the zod schemas in §5 (kept in the API module, not shared, since they are request DTOs — consistent with how `CreateSessionInput` etc. live in `meshing.schemas.ts`, not shared).

## 5. API (meshing module)

All new routes mount under the existing `/api/v1/meshing` router, behind `requireAuth`, following the existing controller/service/schema split.

### 5.1 Schemas (`meshing.schemas.ts`)

```ts
/** Body for POST /meshing/copy — duplicate a session's engine + config + surfaces. */
export const copySessionSchema = z.object({
  sourceId: z.string().trim().min(1, 'A source session id is required'),
  name: z.string().trim().min(1).max(120).optional(), // default: "<source name> (copy)"
});
export type CopySessionInput = z.infer<typeof copySessionSchema>;

/**
 * Body for POST /meshing/from-chamber — import a built chamber's patch surfaces
 * into a meshing session. `mode` selects the target:
 *  - 'new':      create a session (name + engine required) and import into it.
 *  - 'existing': import into `sessionId` (its engine governs meshing).
 *  - 'copyFrom': copy `sourceId` (engine + config + surfaces) into a new session,
 *                then import — the combined optimization-iteration operation.
 */
export const fromChamberSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('new'),
    chamberHash: z.string().trim().min(1),
    name: z.string().trim().min(1).max(120),
    engine: z.enum(MESHING_ENGINES).default('snappy'),
  }),
  z.object({
    mode: z.literal('existing'),
    chamberHash: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
  }),
  z.object({
    mode: z.literal('copyFrom'),
    chamberHash: z.string().trim().min(1),
    sourceId: z.string().trim().min(1),
    name: z.string().trim().min(1).max(120).optional(),
  }),
]);
export type FromChamberInput = z.infer<typeof fromChamberSchema>;
```

### 5.2 Storage helpers (`meshingStorage.ts`)

```ts
/**
 * Copy a session's reusable setup into a NEW session: engine (meta) + config.json
 * + every file under constant/triSurface/. Deliberately omits run output
 * (run.json, constant/polyMesh, system/, .viz) — the copy is meant to be re-meshed.
 * Returns the new session's meta. @throws when the source is absent.
 */
export async function copySessionSetup(sourceId: string, name?: string): Promise<MeshingMeta>;
```

Implementation: `readMeta(sourceId)` (404 if null) → `createSession(name ?? \`${src.name} (copy)\`, src.engine)` → `fs.cp(triSurfaceDir(sourceId), triSurfaceDir(newId), {recursive:true})` if it exists → copy `config.json` if present (`readConfig`→`writeConfig`, so it round-trips through the validated type). Everything else is left uncreated.

### 5.3 Service (`meshing.service.ts`)

```ts
/** Copy a session's setup (engine + config + surfaces) into a new session. */
export async function copyMeshingSession(sourceId: string, name?: string): Promise<MeshingSession> {
  const meta = await copySessionSetup(sourceId, name);
  return assembleSession(meta);
}

/**
 * Read a built chamber's triSurface zip and return its per-patch STLs as
 * StlUpload[], excluding the pre-merged domain.stl. @throws 404 CHAMBER_NOT_BUILT
 * when the build/zip is absent, 422 when the zip has no usable patch STL.
 */
async function chamberPatchUploads(chamberHash: string): Promise<StlUpload[]>;

/**
 * Import a chamber build's patches into a meshing session (new / existing /
 * copyFrom). Returns the resulting session. Reuses addStlFiles for validation +
 * overwrite-by-name, so a cfMesh target still enforces its one-surfaceFile rules
 * against the incoming STLs, and snappy validates each is a parseable STL.
 */
export async function importChamberIntoMeshing(input: FromChamberInput): Promise<MeshingSession>;
```

- `chamberPatchUploads`: `readChamberExport(hash,'trisurface')` (→ 404 `CHAMBER_NOT_BUILT` if null), `new AdmZip(buf)`, take entries whose name ends `.stl` and is not `CHAMBER_TRANSFER_EXCLUDED_STL`, map to `{name: entry.name, data: entry.getData()}`. Empty → 422.
- `importChamberIntoMeshing`: resolve target session id per `mode` (`new` → `createSessionDir`; `existing` → `requireSession`; `copyFrom` → `copySessionSetup`), then `addStlFiles(sessionId, uploads)` and return its result (already an assembled `MeshingSession`). `addStlFiles` gives free reuse of the cfMesh mutual-exclusion checks and per-file STL validation.

**cfMesh note:** transferring 4 patch STLs into a cfMesh session is fine — they are STLs, and cfMesh accepts multiple STLs (merged at run time). The "single .fms" rule only blocks mixing an FMS with STLs; a fresh/copied cfMesh session has no FMS, so the import passes.

### 5.4 Controllers + routes

`meshing.controller.ts`: `copySessionController` (`POST /meshing/copy`), `fromChamberController` (`POST /meshing/from-chamber`), each a thin adapter returning `{ session }` (201). `meshing.routes.ts`: register both with `validate({ body: … })`. Place `POST /meshing/copy` and `POST /meshing/from-chamber` **before** the `/:id` routes are irrelevant (distinct paths), but keep them grouped with session create for readability.

## 6. Web

### 6.1 API client + hooks

- `apps/web/src/lib/api/meshing.ts`: `copyMeshingSession(sourceId, name?)` → `POST /meshing/copy`; `transferChamberToMeshing(body: FromChamberBody)` → `POST /meshing/from-chamber`. Add the `FromChamberBody` union + `CopySessionBody` types to `apps/web/src/lib/api/types.ts` (mirroring §5.1; the web layer re-declares request DTOs as it already does).
- `apps/web/src/features/meshing/useMeshing.ts`: `useCopyMeshingSession()` and `useTransferChamberToMeshing()` mutations, both invalidating `meshingSessionsKey` (and seeding `meshingSessionKey(id)` from the returned session) on success.

### 6.2 Chamber "Send to Meshing"

In `ChamberPage.tsx`'s Export card (next to `ChamberExportButtons`, gated on `hash`), add a **"Send to Meshing"** button opening a new `SendToMeshingDialog` (`features/chamber/`). The dialog offers three modes (radio / segmented):

1. **New session** — name (prefilled e.g. `chamber-<hash>`), engine (`snappy`/`cfMesh`, reusing the `SegmentedRadioGroup` from MeshingPage).
2. **Existing session** — a `NativeSelect` populated from `useMeshingSessions()`; engine is the chosen session's (shown, not editable).
3. **Copy a session's setup** — a `NativeSelect` of sessions to copy from + optional new name; engine inherited from the source.

On submit → `useTransferChamberToMeshing()` with the matching `mode` payload → on success, toast + `navigate('/meshing/'+session.id)` so the user lands on the imported surfaces. Design sequence per CLAUDE.md §0 (tokens only, one orange CTA = the dialog's confirm, full loading/empty/error states, reuse existing primitives — Dialog, NativeSelect, SegmentedRadioGroup, Field, Button). A note in mode 2/3 explains overwrite-by-name (the §3 caveat).

### 6.3 Meshing "Duplicate"

On `MeshingPage`'s session table, add a per-row **Duplicate** action (icon button, `variant="secondary"`; mirrors the app's other row controls) → `useCopyMeshingSession(session.id)` → toast + refresh list (optionally navigate to the copy). Keeps the standalone copy building block visible in the UI, independent of Chamber.

## 7. Automation contract (why these endpoints, unchanged, serve the loop)

The optimization loop, when built, drives the existing global endpoints with no UI and no per-project scoping:

1. `POST /chamber/build` `{x1,x2,x3,…}` → `{hash}` (already exists).
2. `POST /meshing/from-chamber` `{mode:'copyFrom', chamberHash, sourceId}` → a new meshing session preloaded with the design **and** a known-good reference setup → `{session:{id,…}}`.
3. `POST /meshing/:id/run` `{engine,…}` (already exists) → mesh.
4. (future) solver run on the produced case.

Steps 2-3 are exactly the manual UI's calls, so the loop and the human share one tested path — the reason `from-chamber` is a first-class server operation rather than a UI-only convenience.

## 8. Tests

- `apps/api/tests/meshing.test.ts` (extend; it already fakes the mesher via the injectable command runner):
  - copy: create source (with an uploaded STL + a saved config) → `POST /meshing/copy` → new session has the same engine, the surface, the config; source untouched; run output NOT present on the copy.
  - from-chamber `new`: seed a fake chamber build on disk (write a minimal `trisurface.zip` with two named solids + a `domain.stl` under `chamberPaths(hash).exportsDir`) → `POST /meshing/from-chamber` `{mode:'new'}` → session has exactly the two patch STLs, `domain.stl` excluded.
  - from-chamber `existing`: import into a pre-made session; overwrite-by-name replaces a same-named surface, leaves others.
  - from-chamber `copyFrom`: source with config+surfaces → new session has source config + injected patches (overwrite-by-name applied).
  - errors: unknown `chamberHash` → 404 `CHAMBER_NOT_BUILT`; unknown `sourceId`/`sessionId` → 404; a zip with only `domain.stl` → 422.
- `apps/api/tests/meshingStorage.test.ts` (or the storage test file): `copySessionSetup` copies triSurface + config, omits polyMesh/run/system/viz.
- Web: a `SendToMeshingDialog` test (mode switch renders the right fields; submit calls the mutation with the right payload) if the existing web test conventions cover dialogs (mirror `TopoSetDialog`/`BoundaryConditionDialog` tests). Keep it light — the logic is server-side.

## 9. Verification plan

- API vitest suite green (the fake runner covers the mesh step; these tests exercise the transfer/copy plumbing, not real meshing).
- Manual/browser (WSL dev server, per project convention): build a chamber → **Send to Meshing → New session (snappy)** → land on `/meshing/:id` with `inlet/outlet/cylinder_walls/walls` surfaces (no `domain`) → run snappy → mesh appears. Repeat with **cfMesh** → confirm the run merges them (one surfaceFile) and meshes. Then **Duplicate** that session → copy has same config+surfaces, no mesh → **Send to Meshing → Copy setup + inject** a *different* chamber build into it → confirm the new geometry is in place with the copied config.
- Confirm the guide-vane variant transfers its `hub`/`shroud`/`guide_vanes` patches and note the overwrite caveat when injected over a stepped-variant copy.

## 10. Out of scope

- `buildChamber.py` / empirical model / meshing pipeline internals — untouched.
- The optimization loop (design generation, objectives, iteration).
- Project-scoped meshing (both tools stay global/standalone).
- Any change to how cfMesh merges surfaces (its existing run-time merge is reused as-is).

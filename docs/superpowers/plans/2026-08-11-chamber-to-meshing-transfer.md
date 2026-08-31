# Chamber → Meshing Transfer + Session Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a built chamber design be transferred into a Meshing session (new / existing / copy-of-existing), and let a Meshing session be duplicated (engine + config + surfaces), via one shared API that both the manual UI and a future headless optimization loop call.

**Architecture:** Pure plumbing in the existing **meshing module**. A chamber build's `trisurface.zip` is read via `readChamberExport` and unzipped with the app's existing `adm-zip`; each per-patch STL (excluding the pre-merged `domain.stl`) is fed through the existing `addStlFiles` (free validation + overwrite-by-name). Session copy reuses `fs.cp` + the existing `config.json` sidecar. Snappy consumes the per-patch STLs directly; cfMesh's existing run-time merge (`stlMerge.ts`) turns them into its single ASCII surface — no new geometry or merge code.

**Tech Stack:** TypeScript (Node/Express API, React + react-hook-form + zod + React Query web), Vitest, `adm-zip` (already a dependency).

## Global Constraints

- No change to `buildChamber.py`, the empirical model, or the snappy/cfMesh pipeline internals.
- Both tools stay **global/standalone** (no `projectId` scoping).
- `domain.stl` (the chamber's pre-merged multi-solid) is **never** transferred — only the per-patch STLs (`inlet.stl`, `outlet.stl`, `cylinder_walls.stl`, `walls.stl`, or `hub`/`shroud`/`guide_vanes`/etc.). Transferring `domain.stl` too would duplicate every patch's triangles.
- Injection into a session with existing surfaces is **additive with overwrite-by-name** (today's `writeStl` behaviour) — matching filenames replace, non-matching old surfaces linger (documented caveat, not guarded).
- Copy duplicates engine + `config.json` + `constant/triSurface/*` only — never `run.json`, `constant/polyMesh/`, `system/*`, `.viz/`.
- Error codes reuse the chamber convention: **`CHAMBER_NOT_BUILT` is a 409** (matches `chamber.service.ts:196`), not 404.
- All new endpoints mount under `/api/v1/meshing` behind `requireAuth`.
- Web work follows CLAUDE.md §0 (tokens only, one orange CTA per action, reuse existing primitives: Dialog, NativeSelect, SegmentedRadioGroup, Field, Button; full loading/empty/error states; light theme; AA).
- Spec: `docs/superpowers/specs/2026-08-11-chamber-to-meshing-transfer-design.md`.

---

### Task 1: Storage — `copySessionSetup` (TDD)

**Files:**
- Modify: `apps/api/src/lib/meshingStorage.ts` (add `copySessionSetup`, after `createSession` ~line 119)
- Test: `apps/api/tests/meshingStorage.test.ts`

**Interfaces:**
- Consumes: existing `meshingStorage` exports — `createSession`, `readMeta`, `triSurfaceDir`, `sessionDirAbsolute`, `readConfig`, `writeConfig`, `type MeshingMeta`.
- Produces: `export async function copySessionSetup(sourceId: string, name?: string): Promise<MeshingMeta>` — creates a NEW session carrying the source's engine + config.json + constant/triSurface/*; returns its meta. Returns-by-throw is not used; callers get `null`-safety by the service's `requireSession` before calling.

- [ ] **Step 1: Read the existing test file's helpers**

Open `apps/api/tests/meshingStorage.test.ts` and note how it constructs a storage root and calls storage functions (it exercises `meshingStorage` directly). Match its existing setup/teardown style for the new test.

- [ ] **Step 2: Write the failing test**

Append to `apps/api/tests/meshingStorage.test.ts` a test that:

```ts
  it('copySessionSetup duplicates engine + config + surfaces, not run output', async () => {
    // Arrange: a source session with a surface, a saved config, and fake run output.
    const src = await createSession('Source design', 'cfmesh');
    await writeStl(src.id, 'inlet.stl', Buffer.from('solid inlet\nendsolid inlet'));
    await writeConfig(src.id, {
      engine: 'cfmesh',
      maxCellSize: 0.2,
      minCellSize: null,
      boundaryCellSize: null,
      extractFeatures: true,
      featureAngle: 45,
      addLayers: { enabled: false, nLayers: 3, thicknessRatio: 1.2, maxFirstLayerThickness: null },
      cores: 1,
    });
    // Fake run output that must NOT be copied.
    const polyMesh = path.join(sessionDirAbsolute(src.id), 'constant', 'polyMesh');
    await fs.mkdir(polyMesh, { recursive: true });
    await fs.writeFile(path.join(polyMesh, 'points'), 'x');

    // Act
    const copy = await copySessionSetup(src.id);

    // Assert: new id, same engine, name defaulted, surface + config copied, no polyMesh.
    expect(copy.id).not.toBe(src.id);
    expect(copy.engine).toBe('cfmesh');
    expect(copy.name).toBe('Source design (copy)');
    const stls = await listStl(copy.id);
    expect(stls.map((s) => s.name)).toEqual(['inlet.stl']);
    expect(await readConfig(copy.id)).not.toBeNull();
    await expect(
      fs.stat(path.join(sessionDirAbsolute(copy.id), 'constant', 'polyMesh')),
    ).rejects.toThrow();
  });
```

Ensure the file's imports include `createSession`, `writeStl`, `writeConfig`, `readConfig`, `listStl`, `sessionDirAbsolute`, `copySessionSetup` from `../src/lib/meshingStorage`, plus `fs`/`path` and `describe/it/expect`. Add any missing to the existing import block.

- [ ] **Step 3: Run the test to verify it fails**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build:shared && npm run test -w @dive/api -- meshingStorage.test.ts -t 'copySessionSetup'"
```

Expected: FAIL — `copySessionSetup` is not exported (`TypeError`/import error).

- [ ] **Step 4: Implement `copySessionSetup`**

In `apps/api/src/lib/meshingStorage.ts`, add after `createSession` (~line 119):

```ts
/**
 * Copy a session's reusable setup into a NEW session: its engine (meta) + the
 * autosaved config.json + every file under constant/triSurface/. Deliberately
 * omits run output (run.json, constant/polyMesh, system/, .viz) — the copy is
 * meant to be re-meshed with fresh geometry. `name` defaults to "<source> (copy)".
 * @throws when the source session has no readable metadata.
 */
export async function copySessionSetup(sourceId: string, name?: string): Promise<MeshingMeta> {
  const source = await readMeta(sourceId);
  if (!source) {
    throw new Error(`Meshing session "${sourceId}" not found.`);
  }
  const meta = await createSession(name ?? `${source.name} (copy)`, source.engine);
  // Copy the input surfaces (if any) verbatim.
  const srcTri = triSurfaceDir(sourceId);
  try {
    await fs.cp(srcTri, triSurfaceDir(meta.id), { recursive: true });
  } catch {
    // No triSurface dir on the source (never had a surface) — nothing to copy.
  }
  // Copy the autosaved config (round-trips through the validated type).
  const config = await readConfig(sourceId);
  if (config) await writeConfig(meta.id, config);
  return meta;
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run test -w @dive/api -- meshingStorage.test.ts"
```

Expected: PASS — all `meshingStorage.test.ts` tests green, including the new one.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/meshingStorage.ts apps/api/tests/meshingStorage.test.ts
git commit -m "feat(meshing): copySessionSetup duplicates engine + config + surfaces"
```

---

### Task 2: Shared constant + API schemas

**Files:**
- Modify: `packages/shared/src/index.ts` (add `CHAMBER_TRANSFER_EXCLUDED_STL` near the Meshing types, ~line 1004)
- Modify: `apps/api/src/modules/meshing/meshing.schemas.ts` (add `copySessionSchema`, `fromChamberSchema`)

**Interfaces:**
- Consumes: `MESHING_ENGINES` (already exported from shared, `index.ts:836`).
- Produces: `CHAMBER_TRANSFER_EXCLUDED_STL: 'domain.stl'` (shared); `copySessionSchema`/`CopySessionInput` and `fromChamberSchema`/`FromChamberInput` (API schemas). `FromChamberInput` is a discriminated union on `mode` with variants `'new'` (chamberHash, name, engine), `'existing'` (chamberHash, sessionId), `'copyFrom'` (chamberHash, sourceId, name?).

- [ ] **Step 1: Add the shared constant**

In `packages/shared/src/index.ts`, immediately after `export type MeshingConfig = …` (~line 1004), add:

```ts
/**
 * A chamber build's patches transfer into a meshing session as one STL per patch;
 * the pre-merged domain.stl in trisurface.zip is NEVER transferred (it would
 * duplicate every patch's triangles). Both engines consume the per-patch files:
 * snappy directly, cfMesh via its existing run-time merge.
 */
export const CHAMBER_TRANSFER_EXCLUDED_STL = 'domain.stl';
```

- [ ] **Step 2: Add the API schemas**

In `apps/api/src/modules/meshing/meshing.schemas.ts`, after `createSessionSchema` (~line 10), add:

```ts
/** Body for POST /meshing/copy — duplicate a session's engine + config + surfaces. */
export const copySessionSchema = z.object({
  sourceId: z.string().trim().min(1, 'A source session id is required'),
  name: z.string().trim().min(1).max(120).optional(),
});
export type CopySessionInput = z.infer<typeof copySessionSchema>;

/**
 * Body for POST /meshing/from-chamber — import a built chamber's patch surfaces
 * into a meshing session. `mode` selects the target:
 *  - 'new':      create a session (name + engine) and import into it.
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

`MESHING_ENGINES` is already imported at the top of the file (`meshing.schemas.ts:3`).

- [ ] **Step 3: Build shared + typecheck**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build:shared && npm run typecheck -w @dive/api"
```

Expected: exit 0 (the schemas compile; nothing consumes them yet).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/index.ts apps/api/src/modules/meshing/meshing.schemas.ts
git commit -m "feat(meshing): shared domain.stl exclusion + copy/from-chamber schemas"
```

---

### Task 3: Service — `copyMeshingSession` + `importChamberIntoMeshing` (TDD)

**Files:**
- Modify: `apps/api/src/modules/meshing/meshing.service.ts`
- Test: `apps/api/tests/meshing.test.ts`

**Interfaces:**
- Consumes: `copySessionSetup` (Task 1); `FromChamberInput` (Task 2); `CHAMBER_TRANSFER_EXCLUDED_STL` (Task 2); existing service internals `requireSession`, `addStlFiles`, `assembleSession`, `type StlUpload`; existing storage `createSession as createSessionDir`; `readChamberExport` + `chamberHash`-keyed storage from `../../lib/chamberStorage`; `AdmZip` from `adm-zip`; `AppError`.
- Produces:
  - `export async function copyMeshingSession(sourceId: string, name?: string): Promise<MeshingSession>`
  - `export async function importChamberIntoMeshing(input: FromChamberInput): Promise<MeshingSession>`

- [ ] **Step 1: Write the failing tests**

In `apps/api/tests/meshing.test.ts`, add a helper to seed a fake chamber build and a new `describe` block. Put the helper near the top (after the STL helpers) and the tests after the existing `describe('Meshing sessions', …)` body (before its closing). Use the existing `chamberStorage` to locate the build dir so the test writes exactly where the service reads.

Helper + tests:

```ts
import AdmZip from 'adm-zip';
import { chamberPaths } from '../src/lib/chamberStorage';

/** Seed a fake chamber build's trisurface.zip on disk (2 patches + domain.stl). */
async function seedChamberBuild(hash: string): Promise<void> {
  const zip = new AdmZip();
  const inlet = 'solid inlet\nendsolid inlet';
  const walls = 'solid walls\nendsolid walls';
  zip.addFile('inlet.stl', Buffer.from(inlet));
  zip.addFile('walls.stl', Buffer.from(walls));
  zip.addFile('domain.stl', Buffer.from(inlet + '\n' + walls)); // must be excluded
  const { exportsDir } = chamberPaths(hash);
  await fs.mkdir(exportsDir, { recursive: true });
  await fs.writeFile(path.join(exportsDir, 'trisurface.zip'), zip.toBuffer());
}
```

```ts
describe('Meshing transfer + copy', () => {
  it('copies a session (engine + config + surfaces), leaving the source intact', async () => {
    const auth = authHeader(await createTestUser());
    const created = await request(app)
      .post('/api/v1/meshing').set('Authorization', auth).send({ name: 'Src', engine: 'snappy' }).expect(201);
    const srcId = created.body.session.id as string;
    await request(app)
      .post(`/api/v1/meshing/${srcId}/stl`).set('Authorization', auth)
      .attach('files', CUBE_STL, 'cube.stl').expect(201);

    const copied = await request(app)
      .post('/api/v1/meshing/copy').set('Authorization', auth).send({ sourceId: srcId }).expect(201);
    expect(copied.body.session.id).not.toBe(srcId);
    expect(copied.body.session.engine).toBe('snappy');
    expect(copied.body.session.stlCount).toBe(1);
    expect(copied.body.session.hasMesh).toBe(false);
  });

  it('imports a chamber build into a NEW session, excluding domain.stl', async () => {
    const auth = authHeader(await createTestUser());
    await seedChamberBuild('deadbeefdeadbeef');
    const res = await request(app)
      .post('/api/v1/meshing/from-chamber').set('Authorization', auth)
      .send({ mode: 'new', chamberHash: 'deadbeefdeadbeef', name: 'From chamber', engine: 'snappy' })
      .expect(201);
    const names = (res.body.session.stls as { name: string }[]).map((s) => s.name).sort();
    expect(names).toEqual(['inlet.stl', 'walls.stl']);
  });

  it('imports a chamber build into an EXISTING session (overwrite by name)', async () => {
    const auth = authHeader(await createTestUser());
    await seedChamberBuild('cafecafecafecafe');
    const created = await request(app)
      .post('/api/v1/meshing').set('Authorization', auth).send({ name: 'Target', engine: 'snappy' }).expect(201);
    const id = created.body.session.id as string;
    const res = await request(app)
      .post('/api/v1/meshing/from-chamber').set('Authorization', auth)
      .send({ mode: 'existing', chamberHash: 'cafecafecafecafe', sessionId: id })
      .expect(201);
    expect((res.body.session.stls as { name: string }[]).map((s) => s.name).sort())
      .toEqual(['inlet.stl', 'walls.stl']);
  });

  it('copies a session AND injects a chamber build in one call (copyFrom)', async () => {
    const auth = authHeader(await createTestUser());
    await seedChamberBuild('f00df00df00df00d');
    const created = await request(app)
      .post('/api/v1/meshing').set('Authorization', auth).send({ name: 'Ref setup', engine: 'snappy' }).expect(201);
    const srcId = created.body.session.id as string;
    const res = await request(app)
      .post('/api/v1/meshing/from-chamber').set('Authorization', auth)
      .send({ mode: 'copyFrom', chamberHash: 'f00df00df00df00d', sourceId: srcId })
      .expect(201);
    expect(res.body.session.id).not.toBe(srcId);
    expect((res.body.session.stls as { name: string }[]).map((s) => s.name).sort())
      .toEqual(['inlet.stl', 'walls.stl']);
  });

  it('returns 409 CHAMBER_NOT_BUILT for an unknown chamber hash', async () => {
    const auth = authHeader(await createTestUser());
    const res = await request(app)
      .post('/api/v1/meshing/from-chamber').set('Authorization', auth)
      .send({ mode: 'new', chamberHash: 'notarealhash1234', name: 'X', engine: 'snappy' })
      .expect(409);
    expect(res.body.error.code).toBe('CHAMBER_NOT_BUILT');
  });
});
```

Note: the `beforeEach` currently only calls `resetDatabase()`. Chamber builds live under `<STORAGE_DIR>/chamber/<hash>` and meshing sessions under `<STORAGE_DIR>/meshing/`; since the hashes here are unique per test and sessions are name-slugged, no extra cleanup is required for these tests to be deterministic. (If a later run collides on a session slug, that is pre-existing behaviour, not introduced here.)

- [ ] **Step 2: Run the tests to verify they fail**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build:shared && npm run test -w @dive/api -- meshing.test.ts -t 'transfer'"
```

Expected: FAIL — routes `/meshing/copy` and `/meshing/from-chamber` 404 (not yet mounted).

- [ ] **Step 3: Implement the service functions**

In `apps/api/src/modules/meshing/meshing.service.ts`:

Add imports near the top (with the other imports):

```ts
import AdmZip from 'adm-zip';
import { CHAMBER_TRANSFER_EXCLUDED_STL } from '@dive/shared';
import { readChamberExport } from '../../lib/chamberStorage';
import { copySessionSetup } from '../../lib/meshingStorage';
import type { FromChamberInput } from './meshing.schemas';
```

(`createSession as createSessionDir` is already imported from `meshingStorage`; `AppError`, `addStlFiles`, `assembleSession`, `requireSession`, `type StlUpload` already exist in this file.)

Add the functions (place after `getMeshingSession`, ~line 176):

```ts
/** Copy a session's setup (engine + config + surfaces) into a new session. */
export async function copyMeshingSession(sourceId: string, name?: string): Promise<MeshingSession> {
  await requireSession(sourceId); // clean 404 when the source is absent
  const meta = await copySessionSetup(sourceId, name);
  return assembleSession(meta);
}

/**
 * Read a built chamber's triSurface zip and return its per-patch STLs as uploads,
 * excluding the pre-merged domain.stl. @throws 409 CHAMBER_NOT_BUILT when the
 * build/zip is absent, 422 when the zip carries no usable patch STL.
 */
async function chamberPatchUploads(chamberHash: string): Promise<StlUpload[]> {
  const zipBytes = await readChamberExport(chamberHash, 'trisurface');
  if (!zipBytes) {
    throw new AppError(409, 'CHAMBER_NOT_BUILT', 'This chamber has not been built yet.');
  }
  const zip = new AdmZip(zipBytes);
  const uploads: StlUpload[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const base = entry.entryName.split('/').pop() ?? entry.entryName;
    if (!base.toLowerCase().endsWith('.stl')) continue;
    if (base === CHAMBER_TRANSFER_EXCLUDED_STL) continue;
    uploads.push({ name: base, data: entry.getData() });
  }
  if (uploads.length === 0) {
    throw new AppError(422, 'INVALID_STL', 'The chamber export has no patch surfaces to transfer.');
  }
  return uploads;
}

/**
 * Import a chamber build's patches into a meshing session (new / existing /
 * copyFrom) and return the resulting session. Reuses addStlFiles, so a cfMesh
 * target still enforces its one-surfaceFile rules and every STL is validated.
 */
export async function importChamberIntoMeshing(input: FromChamberInput): Promise<MeshingSession> {
  const uploads = await chamberPatchUploads(input.chamberHash);
  let sessionId: string;
  if (input.mode === 'new') {
    const meta = await createSessionDir(input.name, input.engine);
    sessionId = meta.id;
  } else if (input.mode === 'existing') {
    const meta = await requireSession(input.sessionId);
    sessionId = meta.id;
  } else {
    await requireSession(input.sourceId); // clean 404 when the source is absent
    const meta = await copySessionSetup(input.sourceId, input.name);
    sessionId = meta.id;
  }
  return addStlFiles(sessionId, uploads);
}
```

- [ ] **Step 4: Add controllers**

In `apps/api/src/modules/meshing/meshing.controller.ts`:

Extend the service import to include the new functions:

```ts
import {
  addStlFiles,
  copyMeshingSession,
  createMeshingSession,
  downloadSessionZip,
  getMeshingSession,
  getResultEdges,
  getResultGeometry,
  getResultManifest,
  importChamberIntoMeshing,
  listMeshingSessions,
  readStlBytes,
  removeMeshingSession,
  removeStlFile,
  runMeshing,
  saveMeshingConfig,
  type StlUpload,
} from './meshing.service';
import type {
  CopySessionInput,
  CreateSessionInput,
  FromChamberInput,
  MeshingConfigInput,
  StlNameQuery,
} from './meshing.schemas';
```

Add the two controllers (after `createSessionController`, ~line 36):

```ts
/** POST /meshing/copy — duplicate a session's engine + config + surfaces. */
export async function copySessionController(req: Request, res: Response): Promise<void> {
  const { sourceId, name } = req.body as CopySessionInput;
  const session = await copyMeshingSession(sourceId, name);
  res.status(201).json({ session });
}

/** POST /meshing/from-chamber — import a chamber build's patches into a session. */
export async function fromChamberController(req: Request, res: Response): Promise<void> {
  const session = await importChamberIntoMeshing(req.body as FromChamberInput);
  res.status(201).json({ session });
}
```

- [ ] **Step 5: Register the routes**

In `apps/api/src/modules/meshing/meshing.routes.ts`, add the schema imports and the two routes. Add to the `./meshing.controller` import list: `copySessionController`, `fromChamberController`. Add to the `./meshing.schemas` import list: `copySessionSchema`, `fromChamberSchema`. Then register both **before** the `/:id` routes (so `copy` / `from-chamber` are never captured as an `:id`):

```ts
  // Sessions: list + create.
  router.get('/', asyncHandler(listSessionsController));
  router.post('/', validate({ body: createSessionSchema }), asyncHandler(createSessionController));

  // Copy a session's setup; import a chamber build's patches (new/existing/copyFrom).
  router.post('/copy', validate({ body: copySessionSchema }), asyncHandler(copySessionController));
  router.post(
    '/from-chamber',
    validate({ body: fromChamberSchema }),
    asyncHandler(fromChamberController),
  );

  // One session: read + delete.
  router.get('/:id', validate({ params: sessionIdParamSchema }), asyncHandler(getSessionController));
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build:shared && npm run test -w @dive/api -- meshing.test.ts"
```

Expected: PASS — all `meshing.test.ts` tests green, including the five new ones.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/meshing/meshing.service.ts apps/api/src/modules/meshing/meshing.controller.ts apps/api/src/modules/meshing/meshing.routes.ts apps/api/tests/meshing.test.ts
git commit -m "feat(meshing): copy + from-chamber endpoints (new/existing/copyFrom)"
```

---

### Task 4: Web API client + hooks + types

**Files:**
- Modify: `apps/web/src/lib/api/types.ts` (add request DTO types)
- Modify: `apps/web/src/lib/api/meshing.ts` (add two client functions)
- Modify: `apps/web/src/features/meshing/useMeshing.ts` (add two mutations)

**Interfaces:**
- Consumes: `MeshingEngine`, `MeshingSession`, `MeshingSessionResponse` (already in types.ts / shared).
- Produces:
  - types: `CopySessionBody`, `FromChamberBody` (discriminated union on `mode`).
  - client: `copyMeshingSession(body: CopySessionBody): Promise<MeshingSession>`, `transferChamberToMeshing(body: FromChamberBody): Promise<MeshingSession>`.
  - hooks: `useCopyMeshingSession()`, `useTransferChamberToMeshing()`.

- [ ] **Step 1: Add request DTO types**

In `apps/web/src/lib/api/types.ts`, near the Meshing response types (~line 828), add:

```ts
/** Body for `POST /meshing/copy`. */
export interface CopySessionBody {
  sourceId: string;
  name?: string;
}

/** Body for `POST /meshing/from-chamber` (discriminated by `mode`). */
export type FromChamberBody =
  | { mode: 'new'; chamberHash: string; name: string; engine: import('@dive/shared').MeshingEngine }
  | { mode: 'existing'; chamberHash: string; sessionId: string }
  | { mode: 'copyFrom'; chamberHash: string; sourceId: string; name?: string };
```

- [ ] **Step 2: Add the client functions**

In `apps/web/src/lib/api/meshing.ts`, extend the type import to include `CopySessionBody`, `FromChamberBody`, and add after `createMeshingSession` (~line 34):

```ts
/** Duplicate a session's engine + config + surfaces into a new session. */
export async function copyMeshingSession(body: CopySessionBody): Promise<MeshingSession> {
  const data = await apiClient.post<MeshingSessionResponse>('/meshing/copy', body);
  return data.session;
}

/** Import a built chamber's patch surfaces into a meshing session (new/existing/copyFrom). */
export async function transferChamberToMeshing(body: FromChamberBody): Promise<MeshingSession> {
  const data = await apiClient.post<MeshingSessionResponse>('/meshing/from-chamber', body);
  return data.session;
}
```

- [ ] **Step 3: Add the hooks**

In `apps/web/src/features/meshing/useMeshing.ts`, extend the api import to include `copyMeshingSession`, `transferChamberToMeshing`, extend the type import to include `CopySessionBody`, `FromChamberBody`, and add after `useCreateMeshingSession` (~line 68):

```ts
/** Copy a session's setup into a new session, then refresh the list. */
export function useCopyMeshingSession() {
  const queryClient = useQueryClient();
  return useMutation<MeshingSession, Error, CopySessionBody>({
    mutationFn: (body) => copyMeshingSession(body),
    onSuccess: (session) => {
      queryClient.setQueryData(meshingSessionKey(session.id), session);
      void queryClient.invalidateQueries({ queryKey: meshingSessionsKey });
    },
  });
}

/** Import a chamber build into a meshing session, then refresh the list. */
export function useTransferChamberToMeshing() {
  const queryClient = useQueryClient();
  return useMutation<MeshingSession, Error, FromChamberBody>({
    mutationFn: (body) => transferChamberToMeshing(body),
    onSuccess: (session) => {
      queryClient.setQueryData(meshingSessionKey(session.id), session);
      void queryClient.invalidateQueries({ queryKey: meshingSessionsKey });
    },
  });
}
```

- [ ] **Step 4: Typecheck + lint**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run typecheck -w @dive/web"
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npx eslint apps/web/src/lib/api/meshing.ts apps/web/src/lib/api/types.ts apps/web/src/features/meshing/useMeshing.ts"
```

Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api/types.ts apps/web/src/lib/api/meshing.ts apps/web/src/features/meshing/useMeshing.ts
git commit -m "feat(meshing): web client + hooks for copy and chamber transfer"
```

---

### Task 5: Web — Chamber "Send to Meshing" dialog

**Files:**
- Create: `apps/web/src/features/chamber/SendToMeshingDialog.tsx`
- Modify: `apps/web/src/pages/ChamberPage.tsx` (mount the dialog in the Export card)

**Interfaces:**
- Consumes: `useMeshingSessions`, `useTransferChamberToMeshing` (Task 4); `FromChamberBody` (Task 4); UI primitives `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogFooter` (`@/components/ui/dialog`), `NativeSelect`, `SegmentedRadioGroup`, `Field`, `Button`, `toast`; `useNavigate` (react-router-dom).
- Produces: `export function SendToMeshingDialog({ hash, open, onOpenChange }: { hash: string; open: boolean; onOpenChange: (o: boolean) => void })`.

- [ ] **Step 1: Create the dialog component**

Create `apps/web/src/features/chamber/SendToMeshingDialog.tsx`:

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SegmentedRadioGroup } from '@/components/ui/segmented';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import type { FromChamberBody } from '@/lib/api/types';
import type { MeshingEngine } from '@/lib/api/types';
import { useMeshingSessions, useTransferChamberToMeshing } from '@/features/meshing/useMeshing';

type Mode = 'new' | 'existing' | 'copyFrom';

/**
 * SendToMeshingDialog - transfer the built chamber (identified by `hash`) into a
 * meshing session. Three modes: a new session (name + engine), an existing
 * session, or a copy of an existing session's setup with the geometry injected.
 * On success, navigates to the target session so the imported surfaces show.
 */
export function SendToMeshingDialog({
  hash,
  open,
  onOpenChange,
}: {
  hash: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const navigate = useNavigate();
  const transfer = useTransferChamberToMeshing();
  const { data: sessions } = useMeshingSessions();

  const [mode, setMode] = useState<Mode>('new');
  const [name, setName] = useState(`chamber-${hash.slice(0, 8)}`);
  const [engine, setEngine] = useState<MeshingEngine>('snappy');
  const [sessionId, setSessionId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [copyName, setCopyName] = useState('');

  const list = sessions ?? [];

  function buildBody(): FromChamberBody | null {
    if (mode === 'new') return { mode: 'new', chamberHash: hash, name: name.trim(), engine };
    if (mode === 'existing') {
      if (!sessionId) return null;
      return { mode: 'existing', chamberHash: hash, sessionId };
    }
    if (!sourceId) return null;
    return { mode: 'copyFrom', chamberHash: hash, sourceId, name: copyName.trim() || undefined };
  }

  async function onConfirm() {
    const body = buildBody();
    if (!body) {
      toast.error('Choose a session first.');
      return;
    }
    try {
      const session = await transfer.mutateAsync(body);
      toast.success('Sent to Meshing.');
      onOpenChange(false);
      navigate(`/meshing/${session.id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send to Meshing.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send to Meshing</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <SegmentedRadioGroup
            name="send-mode"
            value={mode}
            onChange={(v) => setMode(v as Mode)}
            ariaLabel="Transfer mode"
            options={[
              { value: 'new', label: 'New session' },
              { value: 'existing', label: 'Existing session' },
              { value: 'copyFrom', label: 'Copy a setup' },
            ]}
          />

          {mode === 'new' && (
            <>
              <Field label="Session name">
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-medium text-text">Mesh engine</legend>
                <SegmentedRadioGroup
                  name="send-engine"
                  value={engine}
                  onChange={(v) => setEngine(v as MeshingEngine)}
                  ariaLabel="Mesh engine"
                  options={[
                    { value: 'snappy', label: 'snappyHexMesh' },
                    { value: 'cfmesh', label: 'cfMesh' },
                  ]}
                />
              </fieldset>
            </>
          )}

          {mode === 'existing' && (
            <Field label="Target session">
              <NativeSelect value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
                <option value="">Select a session…</option>
                {list.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.engine === 'cfmesh' ? 'cfMesh' : 'snappyHexMesh'})
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}

          {mode === 'copyFrom' && (
            <>
              <Field label="Copy setup from">
                <NativeSelect value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                  <option value="">Select a session…</option>
                  {list.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.engine === 'cfmesh' ? 'cfMesh' : 'snappyHexMesh'})
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="New session name (optional)">
                <Input
                  value={copyName}
                  onChange={(e) => setCopyName(e.target.value)}
                  placeholder="Defaults to “<source> (copy)”"
                />
              </Field>
            </>
          )}

          {(mode === 'existing' || mode === 'copyFrom') && (
            <p className="text-xs text-text-secondary">
              Patches with the same name replace existing surfaces; other surfaces already in the
              session are kept.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" loading={transfer.isPending} onClick={() => void onConfirm()}>
            Send to Meshing
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default SendToMeshingDialog;
```

Note: confirm the exact `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogFooter` export names against `apps/web/src/components/ui/dialog.tsx` and the `SegmentedRadioGroup` prop names against `apps/web/src/components/ui/segmented.tsx` before running the typecheck (they are used verbatim in `MeshingPage.tsx:144-153` and elsewhere; mirror that usage). If `Field` requires an `htmlFor`/id, mirror how `ChamberInputsForm.tsx` uses it.

- [ ] **Step 2: Mount the dialog in ChamberPage's Export card**

In `apps/web/src/pages/ChamberPage.tsx`:

Add imports:

```ts
import { SendToMeshingDialog } from '@/features/chamber/SendToMeshingDialog';
```

Add state near the other `useState` hooks (~line 49):

```ts
  const [sendOpen, setSendOpen] = useState(false);
```

In the Export card (the `<div>` block containing `<ChamberExportButtons hash={hash} />`, ~line 126-132), add a "Send to Meshing" button and the dialog, gated on `hash`:

```tsx
          <div className="rounded-md border border-border bg-surface p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-text">Export</h2>
            <p className="mb-4 mt-1 text-sm text-text-secondary">
              Download the built chamber for meshing or CAD.
            </p>
            <ChamberExportButtons hash={hash} />
            <div className="mt-4 border-t border-border pt-4">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!hash}
                onClick={() => setSendOpen(true)}
              >
                <Send className="size-4" strokeWidth={1.75} aria-hidden="true" />
                Send to Meshing
              </Button>
            </div>
            {hash && (
              <SendToMeshingDialog hash={hash} open={sendOpen} onOpenChange={setSendOpen} />
            )}
          </div>
```

Add `Send` to the existing `lucide-react` import in ChamberPage (it currently imports `Loader2`), and ensure `Button` is imported (it is used elsewhere in the page; if not already imported, add `import { Button } from '@/components/ui/button';`).

- [ ] **Step 3: Typecheck + lint**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run typecheck -w @dive/web"
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npx eslint apps/web/src/features/chamber/SendToMeshingDialog.tsx apps/web/src/pages/ChamberPage.tsx"
```

Expected: both exit 0. Fix any export-name / prop mismatches surfaced here against the real primitives.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/features/chamber/SendToMeshingDialog.tsx apps/web/src/pages/ChamberPage.tsx
git commit -m "feat(chamber): Send to Meshing dialog (new/existing/copy setup)"
```

---

### Task 6: Web — Meshing "Duplicate" row action

**Files:**
- Modify: `apps/web/src/pages/MeshingPage.tsx` (add a Duplicate action per session row)

**Interfaces:**
- Consumes: `useCopyMeshingSession` (Task 4); `Button`, `toast`, `ApiError`; existing `SessionsTable`.
- Produces: no new exports — an in-page action column.

- [ ] **Step 1: Add the Duplicate control to the session table**

In `apps/web/src/pages/MeshingPage.tsx`:

Add imports: `Copy` from `lucide-react` (extend the existing `lucide-react` import), `useCopyMeshingSession` (extend the existing `@/features/meshing/useMeshing` import), `ApiError` from `@/lib/api/client`, and `toast` from `@/components/ui/sonner` (already imported).

Add a trailing header cell in both `SessionsTable` and `SessionsSkeleton` `<TableHeader>` rows:

```tsx
            <TableHead scope="col" className="text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
```

In `SessionsTable`, add a hook at the top of the component:

```tsx
  const copy = useCopyMeshingSession();
```

Add a trailing cell in each session `<TableRow>` (after the Created cell):

```tsx
              <TableCell className="text-right">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  loading={copy.isPending && copy.variables?.sourceId === session.id}
                  onClick={() => {
                    copy.mutate(
                      { sourceId: session.id },
                      {
                        onSuccess: () => toast.success('Session duplicated.'),
                        onError: (err) =>
                          toast.error(
                            err instanceof ApiError ? err.message : 'Could not duplicate the session.',
                          ),
                      },
                    );
                  }}
                >
                  <Copy className="size-4" strokeWidth={1.75} aria-hidden="true" />
                  Duplicate
                </Button>
              </TableCell>
```

Add a matching skeleton cell in `SessionsSkeleton`'s row:

```tsx
              <TableCell className="text-right">
                <div className="flex justify-end">
                  <Skeleton className="h-8 w-24" />
                </div>
              </TableCell>
```

- [ ] **Step 2: Typecheck + lint**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run typecheck -w @dive/web"
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npx eslint apps/web/src/pages/MeshingPage.tsx"
```

Expected: both exit 0. If `useMutation`'s `variables` typing complains, guard with `copy.variables && copy.variables.sourceId === session.id`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/MeshingPage.tsx
git commit -m "feat(meshing): Duplicate action on the session list"
```

---

### Task 7: Full gates, browser verification, PLAN.md changelog

**Files:**
- Read-only verification (no source changes)
- Modify: `PLAN.md` (append changelog entry per CLAUDE.md §0)

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: nothing new — the Definition-of-Done gate.

- [ ] **Step 1: Full test suite**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run test"
```

Expected: all suites green except the known pre-existing, unrelated `meshes.test.ts` "undo-all" flake (documented in `PLAN.md`, 2026-08-06 entry). If the API suite short-circuits the chain, also run the web suite directly:

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run test -w @dive/web"
```

Any *other* failure → stop and investigate before continuing.

- [ ] **Step 2: Full typecheck**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run typecheck"
```

Expected: exit 0.

- [ ] **Step 3: Start the dev server (background)**

The dev DB was provisioned in the prior feature; if `apps/api/dev.db` is missing, run `npm run db:migrate && npm run db:seed -w @dive/api` first (WSL). Then, using the PowerShell tool with `run_in_background: true` (avoids Git Bash `/`-path mangling), run:

```
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && exec npm run dev > /tmp/dive-dev.log 2>&1"
```

Poll `/tmp/dive-dev.log` (via PowerShell `wsl.exe -e bash -lc "tail -n 30 /tmp/dive-dev.log"`) until Vite prints `Local: http://localhost:5173/` and the API prints `API listening on http://localhost:4000`. If ports are already held by a prior dev server, kill that tree first (per the prior feature's notes) so you test the committed code.

- [ ] **Step 4: Browser verification (snappy path)**

Using the Browser tool:
1. `preview_start` / navigate to the web URL; log in with `admin@dive-turbinen.de` / `ChangeMe!2026`.
2. Go to `/chamber`, keep defaults, **Generate** (real CadQuery build; wait for the 200 from `POST /chamber/build`).
3. In the Export card, click **Send to Meshing** → **New session**, engine **snappyHexMesh**, confirm → lands on `/meshing/:id`.
4. Confirm the session shows exactly the chamber patches as surfaces (`inlet.stl`, `outlet.stl`, `cylinder_walls.stl`, `walls.stl`) and **no `domain.stl`**.
5. Run snappy on that session (existing UI) → confirm it meshes (a polyMesh render appears), no console errors.

- [ ] **Step 5: Browser verification (cfMesh + copy paths)**

1. Back on `/chamber` (still built), **Send to Meshing** → **New session**, engine **cfMesh**, confirm → session has the same four surfaces. Run cfMesh → confirm it meshes (the run-time merge produces one surface, no error).
2. On `/meshing`, click **Duplicate** on a session → a `<name> (copy)` session appears with the same engine + surface count, **not meshed**.
3. On `/chamber`, **Send to Meshing** → **Copy a setup**, pick a source session, confirm → new session created with the source's config and the (possibly overwritten-by-name) chamber patches; lands on it.

- [ ] **Step 6: Stop the dev server**

Stop the background task (TaskStop with its id) and confirm ports 4000/5173 are free (`ss -tlnp | grep -E ':4000|:5173'`).

- [ ] **Step 7: Append the PLAN.md changelog entry**

Append at the very end of `PLAN.md`, matching the file's French, bolded-label style:

```markdown

#### Feature — Chamber → Meshing : transfert de géométrie + duplication de session [shared+backend+frontend+tests] (2026-08-11)
Demande user : transférer un design de chambre (onglet Chamber) vers l'onglet Meshing — usage manuel d'abord, puis automatique dans une boucle d'optimisation (générer des designs → mailler → simuler) — et pouvoir **copier une session de meshing** pour réinjecter la nouvelle géométrie avec le setup de l'ancienne. Spec+plan : `docs/superpowers/specs/2026-08-11-chamber-to-meshing-transfer-design.md`, `docs/superpowers/plans/2026-08-11-chamber-to-meshing-transfer.md`. **Périmètre** (confirmé) : les briques transfert + copie seulement ; la boucle d'optimisation elle-même est un projet futur, mais l'API est conçue pour qu'elle et l'UI manuelle partagent **le même chemin**. **Constat clé** : aucun code de géométrie neuf — le build chamber écrit déjà un STL ASCII par patch **plus** un `domain.stl` pré-fusionné dans `trisurface.zip` ; snappy consomme les STL par patch directement, et cfMesh les **fusionne déjà à l'exécution** (`stlMerge.ts`) en une surface ASCII unique. Le transfert envoie donc chaque patch comme STL (en **excluant `domain.stl`**, sinon doublon de triangles) via l'`addStlFiles` existant (validation + overwrite-par-nom gratuits). **Backend** (module meshing) : `copySessionSetup` (`meshingStorage.ts`) duplique moteur + `config.json` + `constant/triSurface/*` (jamais run.json/polyMesh/system/.viz) via `fs.cp` ; `copyMeshingSession` + `importChamberIntoMeshing` (`meshing.service.ts`, lit le zip via `readChamberExport` + `adm-zip`) ; deux routes `POST /meshing/copy` et `POST /meshing/from-chamber` (union discriminée `mode` : `new`/`existing`/`copyFrom` — ce dernier = copie du setup + injection en un appel, l'opération d'une itération d'optim). Codes d'erreur : `CHAMBER_NOT_BUILT` (409, réutilise la convention chamber), `INVALID_STL` (422, zip sans patch). **Shared** : `CHAMBER_TRANSFER_EXCLUDED_STL = 'domain.stl'`. **Web** : hooks `useCopyMeshingSession`/`useTransferChamberToMeshing` ; dialog **« Send to Meshing »** dans la carte Export de ChamberPage (3 modes : nouvelle session + moteur / session existante / copie d'un setup) → navigue vers `/meshing/:id` ; action **« Duplicate »** par ligne sur la liste Meshing. Réutilise Dialog/NativeSelect/SegmentedRadioGroup/Field/Button existants (séquence §0, aucun langage visuel neuf). **Caveat documenté** (choix user « config + surfaces ») : injecter un build aux patches différents (ex. guide-vane `hub`/`shroud` sur une copie stepped `cylinder_walls`) laisse les anciennes surfaces non-homonymes en place ; l'UI le signale et la session renvoyée montre la liste finale. **Tests** : `meshingStorage.test.ts` +1 (copie moteur+config+surfaces, pas de run output) ; `meshing.test.ts` +5 (copy ; from-chamber new/existing/copyFrom exclut domain.stl ; 409 hash inconnu). **Gates** : build:shared/typecheck OK, suite verte (hors flake `meshes.test.ts` "undo-all" pré-existant), eslint 0 erreur. **Vérifié navigateur** (dev server WSL) : Chamber → Send to Meshing (new snappy) → `/meshing/:id` avec inlet/outlet/cylinder_walls/walls, pas de domain.stl → run snappy OK ; new cfMesh → run OK (fusion à l'exécution) ; Duplicate → copie non-maillée ; copyFrom → setup copié + géométrie injectée. Non commité en attente de revue app.
```

- [ ] **Step 8: Commit**

```bash
git add PLAN.md
git commit -m "docs(meshing): log chamber→meshing transfer + session copy in PLAN.md"
```

---

## Self-Review Notes

- **Spec coverage:** §4 shared constant → Task 2; §5.1 schemas → Task 2; §5.2 storage → Task 1; §5.3 service → Task 3; §5.4 controllers/routes → Task 3; §6.1 client+hooks → Task 4; §6.2 Send-to-Meshing → Task 5; §6.3 Duplicate → Task 6; §7 automation contract → satisfied by the endpoints in Tasks 2-3 (no extra work); §8 tests → Tasks 1 & 3 (API) and covered by browser verification for the UI (§9); §9 verification → Task 7. UI dialog unit test (§8 last bullet) is intentionally folded into Task 5 as "light/optional" — the plan relies on typecheck + browser verification for the dialog rather than a brittle unit test, matching the spec's "keep it light — the logic is server-side."
- **Type consistency:** `FromChamberInput` (API, Task 2) and `FromChamberBody` (web, Task 4) carry the same three `mode` variants and field names (`chamberHash`, `name`, `engine`, `sessionId`, `sourceId`). `copySessionSetup`/`copyMeshingSession`/`importChamberIntoMeshing` signatures are used consistently across Tasks 1, 3, 4. `CHAMBER_NOT_BUILT` is 409 everywhere (matches existing chamber service).
- **No placeholders:** every code step shows the exact code; every command shows expected output.

# 3D_PLAN.md — Integrated 3D Mesh Viewer ("Visualize" tab)

> **Goal.** Take the standalone Python `patch_viewer` tool (PyVista + Trame + VTK,
> German comments) and bring its functionality **into the DIVE Turbinen web app** as
> a **Visualize** tab inside the project detail page. Clicking the tab hides the
> project detail content and shows the 3D mesh render full-size. All original
> functions are preserved. The tab is only available when a `constant/polyMesh`
> folder exists for the project. Code is **optimized** and **translated to English**.

> **Status:** PLAN — no production code written yet. This document is the
> specification to review before implementation. Each implemented change will be
> logged at the bottom of `PLAN.md` (per the project rule in `CLAUDE.md`).

---

## 1. What the original `patch_viewer` does (baseline to preserve)

Source: `../patch_viewer/patch_viewer.py` (sibling folder, **outside** the app repo).

| # | Function | Where (original) |
|---|----------|------------------|
| F1 | Read an OpenFOAM case and extract **boundary patches** as surfaces | `load_patches()` via `pv.OpenFOAMReader` + `extract_surface` |
| F2 | Read each patch **type** (`patch` / `wall` / …) from `constant/polyMesh/boundary` | `parse_boundary_types()` (regex) |
| F3 | Render every patch in 3D, neutral grey, **with mesh edges visible** | `build_scene()` → `EdgeVisibilityOn` |
| F4 | **Patch table**: Name / Type / nFaces | `build_ui()` left column |
| F5 | **Click a row → highlight that patch orange, dim the others** (opacity 0.12) | `pick()` + `apply_highlight()` |
| F6 | **"Show all"** button → clear selection | `VBtn("Alle anzeigen")` |
| F7 | Orbit / zoom / pan; reset camera | VTK interactor + `ResetCamera` |
| F8 | Client-side WebGL rendering (no GPU/X needed on server) | Trame `VtkLocalView` |
| F9 | Normalize 3 case layouts into `constant/polyMesh` | `ensure_standard_layout()` |

**Key insight for the port:** F8 (client-side WebGL) and F9 (layout normalization) are
*delivery mechanics*, not user features. In the web app:

- **F9 is already handled** by the backend storage layer
  (`normalizeCasePaths`/`caseStorage.ts` nests a bare `polyMesh/` under `constant/`),
  so the viewer can assume the standard layout.
- **F8 becomes "render in the browser with three.js"** — we keep client-side WebGL,
  but native to React instead of via a Trame server.

Everything else (F1–F7) is a true user feature and **must be preserved**.

---

## 2. Architecture decision

The original renders via a **long-running Python (Trame) server**. That does not fit a
React + Node/Express app cleanly. Three integration strategies were considered:

| Option | How | Pros | Cons | Verdict |
|--------|-----|------|------|---------|
| **A. Embed Trame in an `<iframe>`** | Run the (translated) Python app as a per-session subprocess; embed `localhost:PORT` | Literally the same code/features | Needs a **persistent Python+VTK+Trame process per viewing session**; port/lifecycle management; the Trame server is unauthenticated; iframe ignores the design system; does not match the app's "one-shot command" precedent | ❌ Rejected |
| **B. Pure-JS, parse polyMesh in TypeScript** | Parse `points/faces/owner/neighbour/boundary` in JS, reconstruct boundary surfaces, render with three.js | No Python at runtime | Re-implements VTK's `OpenFOAMReader`; parsing 807k pts / 2.3M faces of **ASCII** in-browser is slow & memory-heavy; high effort, high risk | ❌ Rejected |
| **C. Python extracts boundary patches offline → compact GLB + manifest → three.js renders** ✅ | A one-shot Python script (reusing PyVista) extracts only the boundary surfaces into a small `.glb` + `manifest.json`, cached on disk; the API serves them; the React viewer renders with three.js | **Reuses the app's existing Python-script-via-`commandRunner` precedent** (identical to `CgnsToVtk.py`); heavy parsing done **once** by the robust VTK reader, not in-browser; transported asset is tiny (boundary faces only ≈ 78k tris for the sample case); **fully integrated** into React + design tokens; cacheable; no long-running server | Requires Python+PyVista on the server (already required for `pvpython`/CGNS); needs a new script + endpoints | ✅ **Chosen** |

### 2.1 Why Option C fits this codebase specifically
The backend **already** shells out to Python for the CGNS→Foam conversion:
`conversion.service.ts` runs `pvpython scripts/CgnsToVtk.py …` through
`commandRunner.runCommand(...)`, with the script path resolved via
`path.resolve(__dirname, '../../../scripts/...')`, an existence pre-check, an
`env`-configurable interpreter (`PVPYTHON_BIN`) and timeout
(`CONVERSION_STEP_TIMEOUT_MS`), and it is **fully unit-tested by swapping the runner
with `setCommandRunner(...)`**. Our mesh extractor is the *same shape* — we follow
that template exactly.

### 2.2 Rendering library: **three.js** (recommended) vs vtk.js
- **three.js (chosen).** Lighter bundle, ubiquitous, first-class **GLTFLoader** and
  `OrbitControls`. Per-patch highlight (F5) is a one-line material swap; edges (F3)
  are an `EdgesGeometry`/wireframe overlay; "fit camera" is a bounding-sphere helper.
  GLB is the most compact standard transport.
- **vtk.js (alternative).** Native VTK/`.vtp` data (closest to the original VTK code),
  but a heavier, more niche bundle. Documented as the fallback if GLB export proves
  awkward — in that case the transport becomes a `.vtp`/`.vtm` multiblock and the
  viewer uses `@kitware/vtk.js`.

> **Transport detail.** Primary: a single **`patches.glb`** with **one named mesh node
> per patch** (node name = patch name), plus **`manifest.json`** = `[{name, type, nFaces}]`.
> Fallback if `trimesh` GLB export is unavailable: a **raw binary** (`patches.bin`,
> concatenated Float32 positions + Uint32 indices) described by `manifest.json`
> (per-patch byte offsets); the viewer builds `BufferGeometry` directly. Both keep the
> patch metadata in JSON so the table (F4) never depends on the geometry format.

---

## 3. Data flow

```
constant/polyMesh/{points,faces,owner,neighbour,boundary}
        │
        │  (one-shot, on demand, cached)              ── BACKEND ──
        ▼
apps/api/scripts/extractPatches.py        # PyVista: read case → boundary surfaces
        │   reads case dir, writes:        #          → triangulate → GLB + manifest
        ▼
storage/projects/<id>/viz/patches.glb     # geometry (one named node per patch)
storage/projects/<id>/viz/manifest.json   # [{ name, type, nFaces }]
        │
        │  Express endpoints (auth + project-visibility scoped)
        ▼
GET /api/v1/projects/:id/mesh/manifest    # builds if missing/stale → returns manifest
GET /api/v1/projects/:id/mesh/geometry    # streams patches.glb (model/gltf-binary)
        │
        │  apiClient (getBlob for binary)             ── FRONTEND ──
        ▼
features/visualize/useMesh.ts             # react-query: manifest + GLB blob
        ▼
features/visualize/MeshViewer.tsx         # three.js scene (lazy-loaded chunk)
features/visualize/PatchTable.tsx         # Name/Type/nFaces, click-to-select
        ▼
pages/ProjectDetailPage.tsx               # <Tabs> Detail | Visualize  (gated on hasPolyMesh)
```

---

## 4. Backend design

### 4.1 New Python script — `apps/api/scripts/extractPatches.py`
A **stripped-down, English** descendant of `patch_viewer.py`. It keeps F1+F2 and drops
**all** Trame/VTK-rendering/GUI/server code (no more `vtk`, `trame`, `build_scene`,
`build_ui`, highlight logic — those move to three.js).

- **CLI:** `python extractPatches.py <caseDirOrFoamFile> <out.glb> <out_manifest.json>`
- **Deps:** `pyvista`, `trimesh`, `numpy` (document in a `scripts/requirements.txt`;
  the deploy target already provides Python for `pvpython`).
- **Logic (optimized):**
  1. Resolve `case.foam` marker (create if missing), assume `constant/polyMesh` exists
     (layout already normalized by the backend — F9 no longer needed in Python).
  2. `reader = pv.OpenFOAMReader(foam); reader.enable_all_patch_arrays()`; read **only**
     the `boundary` block (skip `internalMesh` → big speed/memory win vs. the original
     which built actors for everything).
  3. For each patch: `extract_surface(...)`, `.triangulate()`, pull
     `points` (Float32) + `faces` (Uint32 triangles).
  4. Parse patch **types** from `constant/polyMesh/boundary` (reuse the original regex,
     translated).
  5. Build a `trimesh.Scene`, `add_geometry(mesh, node_name=name)` per patch; `export(out.glb)`.
  6. Write `manifest.json` = `[{ "name", "type", "nFaces" }, …]` (nFaces from the
     **original** boundary count, not post-triangulation, to match F4 semantics).
  7. Print `OK:`/`KO:` and exit non-zero on failure (same contract as `CgnsToVtk.py`).
- **A committed test stub** (`apps/api/tests/fixtures/extractPatches.py`) mirrors
  `tests/fixtures/CgnsToVtk.py`: writes a tiny valid GLB + manifest so the existence
  check and pipeline pass in CI without PyVista.

### 4.2 Storage — extend `caseStorage.ts` (or a small `vizStorage.ts`)
- Artifacts live at `storage/projects/<id>/viz/` (sibling of `case/`, `cgns/`), so a
  case **reset never touches** the rendered cache (mirrors the CGNS decision).
- Helpers:
  - `vizDirAbsolute(projectId)` → `path.join(storageRoot(),'projects',projectId,'viz')`
  - `vizArtifactPaths(projectId)` → `{ glb, manifest }`
  - `readVizGlb(projectId): Promise<Buffer | null>`
  - `vizIsStale(projectId): Promise<boolean>` — true if `glb` missing **or** older than
    `constant/polyMesh/boundary`/`points` (mtime compare). Reuses `caseFileExists` /
    `caseDirAbsolute`.
- `assertSafeId` guards the id path segment (same as existing storage).

### 4.3 Service — `apps/api/src/modules/projects/mesh.service.ts`
Follows `conversion.service.ts` patterns (visibility check, `__dirname`-resolved script,
existence pre-check, `runCommand`, output-exists post-check).

```ts
// illustrative
export async function getMeshManifest(viewer: Viewer, projectId: string) {
  await assertProjectVisible(viewer, projectId);          // 404 if not visible (no leak)
  if (!(await hasPolyMesh(projectId)))                    // gate F: polyMesh required
    throw new AppError(409, 'NO_MESH', 'No polyMesh found for this project.');
  if (await vizIsStale(projectId)) await buildViz(projectId);   // build-on-demand (sync)
  return readManifest(projectId);                         // { patches, generatedAt }
}

export async function getMeshGeometry(viewer: Viewer, projectId: string): Promise<Buffer> {
  await assertProjectVisible(viewer, projectId);
  const glb = await readVizGlb(projectId);
  if (!glb) throw new AppError(409, 'MESH_NOT_BUILT', 'Mesh not built yet.');
  return glb;
}

async function buildViz(projectId: string) {
  const script = path.resolve(__dirname, '../../../scripts/extractPatches.py');
  // (env-overridable via env.EXTRACT_PATCHES_SCRIPT, like CGNS_TO_VTK_SCRIPT)
  if (!(await pathExists(script))) throw new AppError(500, 'SCRIPT_MISSING', ...);
  const { glb, manifest } = vizArtifactPaths(projectId);
  await fs.mkdir(vizDirAbsolute(projectId), { recursive: true });
  const r = await runCommand({
    command: env.MESH_PYTHON_BIN,                         // default "python3"
    args: [script, caseDirAbsolute(projectId), glb, manifest],
    cwd: caseDirAbsolute(projectId),
    env: process.env,
    timeoutMs: env.MESH_BUILD_TIMEOUT_MS,                 // reuse CONVERSION_STEP_TIMEOUT_MS default
  });
  if (r.spawnError || r.exitCode !== 0 || !(await pathExists(glb)))
    throw new AppError(502, 'MESH_BUILD_FAILED', summarize(r));   // structured, actionable
}
```

- **Sync vs async.** v1 is **synchronous in-request**, exactly like the CGNS conversion
  (bounded by `MESH_BUILD_TIMEOUT_MS`). Boundary extraction of the sample case is a few
  seconds; the cost is the one-time VTK read of the ASCII mesh, well under the 600 s
  timeout. Async/job-queue is noted as **future work** (§11) — no queue exists today.
- `hasPolyMesh(projectId)` = `MESH_FILES.every(f => caseFileExists(projectId,f))` (reuse
  `openfoamCase.ts` `MESH_FILES`). This is the **server-side** gate behind the
  client-side gate.

### 4.4 Controller + routes
- `mesh.controller.ts`: `requireViewer(req)` → service; for geometry set headers and send
  the buffer (mirror the zip-download controller):
  ```ts
  res.setHeader('Content-Type', 'model/gltf-binary');
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.status(200).send(glb);          // Buffer
  ```
- Register in `createProjectsRouter()` (`projects.routes.ts`), after
  `router.use(asyncHandler(requireAuth))`, validated by `projectIdParamSchema`:
  - `GET /:id/mesh/manifest`
  - `GET /:id/mesh/geometry`
  - *(optional)* `POST /:id/mesh/rebuild` → force `buildViz` then return manifest.

### 4.5 Config / env — `apps/api/src/config/env.ts` + `.env.example`
Add (all optional with safe defaults, validated by the existing zod env schema):
- `MESH_PYTHON_BIN` (default `python3`)
- `EXTRACT_PATCHES_SCRIPT` (default empty → resolve via `__dirname`)
- `MESH_BUILD_TIMEOUT_MS` (default `600000`)

### 4.6 Shared types — `packages/shared/src/index.ts`
- `export interface MeshPatch { name: string; type: string; nFaces: number }`
- `export interface MeshManifest { patches: MeshPatch[]; generatedAt: string }`
- *(optional)* a `VIZ_DIRNAME = 'viz'` constant.

---

## 5. Frontend design

> **Mandatory before any JSX/CSS (CLAUDE.md §0):** run the skills in order —
> `ui-ux-pro-max` → `frontend-design` → `design-taste-frontend` → `web-design-guidelines`.
> No component code is written until skills 1–3 have been consulted.

### 5.1 New dependency
- Add `three` to `apps/web/package.json` (use `three/examples/jsm/controls/OrbitControls`
  and `three/examples/jsm/loaders/GLTFLoader`). `@types/three` as dev dep.
- **Code-split it.** In `vite.config.ts`, add a `'three'` entry to `manualChunks`
  (mirror the existing `'codemirror'` split) and **lazy-load** `MeshViewer` so three.js
  never weighs on initial load.

### 5.2 API client — `apps/web/src/lib/api/projects.ts`
- `getMeshManifest(id): Promise<MeshManifest>` → `apiClient.get('/projects/'+id+'/mesh/manifest')`
- `getMeshGeometry(id): Promise<Blob>` → `apiClient.getBlob('/projects/'+id+'/mesh/geometry')`
- Types imported from `@dive/shared`; mirror into `lib/api/types.ts` if needed.

### 5.3 Hook — `apps/web/src/features/visualize/useMesh.ts`
- `useMeshManifestQuery(projectId)` → react-query key `['projects', id, 'mesh', 'manifest']`
  (this call triggers the server-side build; show a "Building preview…" state on first load).
- `useMeshGeometry(projectId, enabled)` → fetch the GLB **Blob**, then parse to an
  `ArrayBuffer` and hand it to `GLTFLoader.parse(...)`. Key `['projects', id, 'mesh', 'glb']`.
- `staleTime` generous; the artifact is cached server-side and stable until the mesh changes.

### 5.4 `MeshViewer.tsx` (three.js) — preserves F1, F3, F5, F7, F8
Vanilla three.js inside a `useEffect` (no need for `@react-three/fiber`):
- `Scene`, `PerspectiveCamera`, `WebGLRenderer({ antialias:true })`, `OrbitControls`,
  `AmbientLight` + `DirectionalLight`. Background = a token-driven light neutral
  (`--color-bg`) by default; the exact canvas background and contrast are settled in the
  skills pass (a CFD viewer often wants a darker stage — decide there, but stay within
  the brand palette).
- For each patch node from the GLB: a `Mesh` with a grey `MeshStandardMaterial`
  (`DoubleSide`), **plus** a subtle edges overlay (`EdgesGeometry` → `LineSegments`) to
  reproduce **F3** (visible mesh lines). Store `mesh.name = patchName`.
- **Highlight (F5):** on `selected` change, for each patch material:
  - `selected === null` → grey, `opacity 1`
  - `name === selected` → **accent orange** (`#EE7F00` token), `opacity 1`
  - else → grey, `opacity 0.12`, `transparent`
- **Pick in 3D (your choice — patch-level):** a `Raycaster` on pointer-down intersects
  the patch meshes; the hit object's `.name` sets `selected` (the same state the table
  drives). Clicking empty space clears the selection; the cursor becomes a pointer when
  hovering a patch. (Individual-face picking is explicitly **out of scope** for v1.)
- **Camera fit (F7):** compute the scene bounding sphere on load, frame it; expose a
  "Reset view" control. `OrbitControls` gives rotate/zoom/pan.
- **Resize:** `ResizeObserver` on the container → update camera aspect + renderer size.
- **Cleanup:** dispose geometries/materials/renderer and remove the canvas on unmount
  (avoid WebGL context leaks).
- **States:** loading (building/parsing), empty (no patches), error (build/parse failed,
  WebGL unavailable) — all using existing UI primitives + tokens.

### 5.5 `PatchTable.tsx` — preserves F4, F5, F6
- Renders `manifest.patches` with columns **Name / Type / nFaces** using the existing
  `components/ui/table.tsx` primitive (right-align nFaces; locale-format the count).
- Row click → `onSelect(name)`; selected row gets an accent **tint** background (same idea
  as the original orange row highlight) and `aria-selected`.
- **"Show all"** button (`Button variant="secondary"`, full width) clears selection (F6).
- Keyboard: rows are focusable/activatable (Enter/Space), full a11y.

### 5.6 `ProjectDetailPage.tsx` integration — the Visualize tab
- Add page-level state: `const [view, setView] = useState<'detail' | 'visualize'>('detail')`.
- Compute the gate from the already-fetched file list:
  ```ts
  const { data: entries } = useCaseFilesQuery(project.id);
  const hasPolyMesh = !!entries?.some(e => e.path.startsWith('constant/polyMesh/'));
  ```
- Insert a **`<Tabs>` strip** (existing `@/components/ui/tabs`, the same primitive
  `CaseFilesSection` uses) **between `PageHeader` and the detail container** (≈ lines
  113–115):
  - `TabsTrigger "Detail"` (always enabled).
  - `TabsTrigger "Visualize"` — **`disabled={!hasPolyMesh}`**, with a tooltip explaining
    "Import a polyMesh to enable 3D" when disabled.
- Body:
  - `view === 'detail'` → the **existing** detail container (Details card +
    `CaseFilesSection`), unchanged.
  - `view === 'visualize'` → **hide the detail** and render
    `<Suspense><MeshViewer projectId={project.id} /></Suspense>` filling `lg:flex-1`
    (left: `PatchTable`, right: 3D canvas — same split as the original, ~1/4 + ~3/4).
- The `AppShell` already pins `projects/:id` to the viewport at `lg`+, so the canvas gets
  full height for free. **No routing change** and **no `AppShell` regex change** (we stay
  on the bare `projects/:id` path — an in-page tab, not a sub-route).
  - *Optional nicety:* reflect the tab in a `?tab=visualize` search param for
    shareable/deep links while keeping the same path (documented, not required for v1).

### 5.7 Function-parity check (original → web)
| Original | Web implementation | ✔ |
|----------|--------------------|---|
| F1 read boundary patches | `extractPatches.py` (PyVista) | ✅ |
| F2 patch types from `boundary` | parsed in script → manifest | ✅ |
| F3 surfaces **with edges** | `MeshStandardMaterial` + `EdgesGeometry` overlay | ✅ |
| F4 Name/Type/nFaces table | `PatchTable.tsx` from manifest | ✅ |
| F5 click → highlight orange, dim rest | `selected` state → material swap | ✅ |
| F6 "Show all" | "Show all" button clears selection | ✅ |
| F7 orbit/zoom/pan + reset | `OrbitControls` + fit-to-bounds | ✅ |
| F8 client-side WebGL | three.js in the browser | ✅ |
| F9 layout normalization | already done by backend storage | ✅ (n/a) |
| **+ Pick in 3D** (new) | click a patch surface → selects that patch (raycaster) | ✅ |

---

## 6. Step-by-step implementation checklist

### Phase 0 — design (mandatory, before any UI code)
- [ ] `ui-ux-pro-max` — frame the viewer + tab layout, states, palette usage.
- [ ] `frontend-design` — production-grade, distinctive (not a generic 3D widget).
- [ ] `design-taste-frontend` — anti-slop pass.
- [ ] (later) `web-design-guidelines` — conformance review before "done".

### Phase 1 — backend (decision-stable, no UI skills needed)
- [ ] Add `extractPatches.py` to `apps/api/scripts/` (+ `requirements.txt`).
- [ ] Add the CI **fixture stub** `apps/api/tests/fixtures/extractPatches.py`.
- [ ] Add env vars (`MESH_PYTHON_BIN`, `EXTRACT_PATCHES_SCRIPT`, `MESH_BUILD_TIMEOUT_MS`)
      to `config/env.ts` + `.env.example` + `vitest.config.ts` test env.
- [ ] Storage helpers (`viz` dir, read GLB, staleness) in `caseStorage.ts`/`vizStorage.ts`.
- [ ] `mesh.service.ts` (build-on-demand, visibility, `hasPolyMesh` gate).
- [ ] `mesh.controller.ts` + register 2–3 routes in `projects.routes.ts`.
- [ ] Shared types in `packages/shared`.
- [ ] **API tests** (`apps/api/tests/mesh.test.ts`) — see §7.

### Phase 2 — frontend
- [ ] Add `three` + `@types/three`; `manualChunks` split; confirm lazy-load.
- [ ] API client fns + types.
- [ ] `useMesh.ts` hook.
- [ ] `MeshViewer.tsx` (three.js) — **after** Phase 0 skills.
- [ ] `PatchTable.tsx`.
- [ ] Wire the `<Tabs>` strip + gating into `ProjectDetailPage.tsx`.
- [ ] **Web tests** — see §7.

### Phase 3 — verify & document
- [ ] `web-design-guidelines` review pass.
- [ ] Run API + web test suites; typecheck/lint.
- [ ] Manual verify with the sample `pipe` case (807k pts / 3 patches).
- [ ] Log every change at the bottom of `PLAN.md`.

---

## 7. Testing strategy

**API (`vitest`, `apps/api`).** Follow `conversion.test.ts`:
- Isolated `STORAGE_DIR=./test-storage`; reset per test.
- `setCommandRunner(fakeRunner)` where the fake **writes a tiny valid GLB + manifest**
  to the expected paths (so the post-build existence check passes), then assert
  `GET /:id/mesh/manifest` returns the patches and `GET /:id/mesh/geometry` returns the
  bytes with `Content-Type: model/gltf-binary`. Restore with `setCommandRunner(null)`.
- Cover: no-polyMesh → `409 NO_MESH`; build failure (`failFirstRunner`-style) →
  `502 MESH_BUILD_FAILED`; not-visible project → `404` (no existence leak); cache reuse
  (second call does not re-run the script when not stale).

**Web (`vitest` + Testing Library, jsdom).** Follow `ProjectEditPage.test.tsx`:
- jsdom has **no WebGL** → **mock `MeshViewer`** to a stub (exactly as CodeMirror is
  mocked to a `<textarea>`), so tests assert the tab/gating/table logic, not WebGL.
- Mock `@/lib/api/projects`; wrap in a fresh `QueryClient` + router.
- Cover: Visualize tab **disabled** when no polyMesh; **enabled** when
  `entries` include `constant/polyMesh/*`; clicking it **hides the detail** and shows the
  viewer stub; `PatchTable` renders rows and selection highlights a row; "Show all"
  clears selection.

---

## 8. Error & edge states (must all be handled)
- No `constant/polyMesh` → Visualize tab **disabled** (client) + `409` (server).
- polyMesh present but **corrupt/unreadable** → build fails → friendly error panel
  ("Could not build the 3D preview", with the stderr summary), retry button.
- **Large mesh** → only boundary surfaces are transported (small); show a build spinner
  on first load; geometry is cached afterwards.
- **WebGL unavailable** in the browser → detect and show a graceful message instead of a
  blank canvas.
- Patch with **0 faces** → skipped in the script (matches original `n_cells > 0`).
- Empty patch list → empty-state in the viewer + table.
- Concurrent requests while building → build is idempotent; later callers read the cache.

---

## 9. Performance
- Transport = boundary surfaces only (sample: ~78k tris) → small GLB, fast WebGL.
- Build is **cached** on disk; rebuilt only when `boundary`/`points` change (mtime check).
- three.js is **code-split** and **lazy-loaded** (no impact on initial bundle).
- Edges overlay can be heavy on the 65k-face wall patch → use an angle-thresholded
  `EdgesGeometry` (or a toggle) to keep it smooth; decide exact threshold during skills/QA.
- react-query caches the manifest + GLB; no refetch on tab toggles.

## 10. Security
- Both endpoints are behind `requireAuth` and `assertProjectVisible` (strangers get 404,
  never 403 — no existence leak), consistent with the rest of the projects module.
- The GLB is served from the project's storage via a **Buffer + `res.send`** (no
  `express.static`, no path exposure) — same posture as the case-zip download.
- `runCommand` uses `execFile` (no shell); the script receives real argv (no injection).

## 11. Risks & future work
- **Python/PyVista on the deploy target.** Mitigation: env-configurable interpreter
  (`MESH_PYTHON_BIN`), fail-fast actionable error if the script/interpreter is missing,
  CI never needs PyVista (fixture stub + mocked runner). Same operational footprint as the
  already-shipped `pvpython` conversion.
- **GLB named-node export via `trimesh`.** Mitigation: documented raw-binary fallback
  (§2.2) keeps geometry independent of the patch table.
- **Synchronous build blocks the request** for very large meshes. Mitigation: bounded by
  timeout for v1; **future**: a background-job abstraction + `POST /mesh/rebuild` +
  polling (no queue exists yet).
- **Future enhancements:** field coloring (pressure/velocity) once the solver phase lands;
  per-patch visibility toggles; screenshot/export; deep-link `?tab=visualize`.

## 12. File-by-file change list

**New**
- `apps/api/scripts/extractPatches.py`
- `apps/api/scripts/requirements.txt`
- `apps/api/tests/fixtures/extractPatches.py` (stub)
- `apps/api/src/modules/projects/mesh.service.ts`
- `apps/api/src/modules/projects/mesh.controller.ts`
- `apps/api/src/modules/projects/mesh.schemas.ts` *(or reuse `projectIdParamSchema`)*
- `apps/api/tests/mesh.test.ts`
- `apps/web/src/features/visualize/MeshViewer.tsx`
- `apps/web/src/features/visualize/PatchTable.tsx`
- `apps/web/src/features/visualize/useMesh.ts`
- `apps/web/src/features/visualize/MeshViewer.test.tsx` *(or `ProjectDetailPage.test.tsx`)*

**Modified**
- `apps/api/src/lib/caseStorage.ts` *(or new `vizStorage.ts`)* — viz dir + read/staleness
- `apps/api/src/modules/projects/projects.routes.ts` — register mesh routes
- `apps/api/src/config/env.ts` + `apps/api/.env.example` + `apps/api/vitest.config.ts`
- `packages/shared/src/index.ts` — `MeshPatch` / `MeshManifest`
- `apps/web/package.json` — `three`, `@types/three`
- `apps/web/vite.config.ts` — `manualChunks` `'three'` split
- `apps/web/src/lib/api/projects.ts` + `apps/web/src/lib/api/types.ts` — mesh fns/types
- `apps/web/src/pages/ProjectDetailPage.tsx` — Tabs strip + gating + conditional viewer
- `PLAN.md` — append change-log entries per change (project rule)

---

*End of 3D_PLAN.md — review this before implementation begins.*

# Guide-vane throat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `guideVanes` toggle that replaces the chamber's plain middle-cylinder throat with a scaled ring of 16 guide vanes (from `GuideVanes50DegOpen.stl`), on both the `stepped` and `hollow` variants.

**Architecture:** The empirical model is untouched. A one-time offline script decimates and re-centres the source STL into small committed assets (one blade + the contoured passage wall shell + a metadata JSON). At build time `buildChamber.py` keeps carving the same middle-cylinder void (its radius already equals the scaled vane outer radius, `0.80·d_last`), and *adds the vane geometry as separate mesh patches* inside that void — no fragile OCC mesh-boolean. The vanes therefore appear as CFD wall/outlet patches and as nodes in the preview GLB.

**Tech Stack:** Python 3 + CadQuery/OCP + trimesh + numpy (geometry builder); TypeScript + Zod (API); React + react-hook-form + Zod (web); Vitest (JS tests). Monorepo workspaces `@dive/shared`, `@dive/api`, `@dive/web`.

## Global Constraints

- Node/npm run **only in WSL**: prefix gate commands with `wsl.exe -e bash -lc '...'`.
- CadQuery Python: Windows `C:\Users\Hristo.Dimitrov\cadquery-env\Scripts\python.exe`; WSL `/home/hristo/cadquery-env/bin/python`. The API resolves it via `CHAMBER_PYTHON_BIN` in the gitignored `apps/api/.env`.
- Lengths in the model/params are **millimetres**; the builder works in **metres** (`MM_TO_M = 1/1000`). The committed vane assets are in **metres**.
- The build cache is keyed by a hash of the **params only** (not Python constants or asset bytes). After any builder or asset change, purge `apps/api/storage/chamber`.
- Geometry correctness is **verified in `cadquery-env`** (CadQuery is absent in CI); JS tests use the faked command runner. This mirrors every prior chamber change.
- Brand/model rules from `CLAUDE.md` apply to any UI copy. No hard-coded colours/spacing; use existing components (`Field`, `Input`, checkbox pattern already in `ChamberInputsForm`).
- Append a French change note to the bottom of `PLAN.md` for every code change (project rule in `CLAUDE.md`).
- Source STL lives outside the repo at `C:\Users\Hristo.Dimitrov\Desktop\Empirical Relation\guide vanes\GuideVanes50DegOpen.stl` (86 MB, metres, axis centred at XY≈(1.0882,1.0882), z∈[0.4251,1.0708]).

---

### Task 1: Offline asset preprocessing → committed vane assets

Produce three small committed files the builder loads. Runs once by a developer; **not** on the build path.

**Files:**
- Create: `apps/api/scripts/preprocessVanes.py` (the one-time preprocessor)
- Create (generated, committed): `apps/api/scripts/assets/guideVanes_blade.stl`
- Create (generated, committed): `apps/api/scripts/assets/guideVanes_walls.stl`
- Create (generated, committed): `apps/api/scripts/assets/guideVanes.json`

**Interfaces:**
- Produces `guideVanes.json` with exactly these keys (metres / degrees), consumed by the builder in Task 3:
  ```json
  {
    "outerDiameter": 2.1696,
    "pivotRadius": 0.86732,
    "hubRadius": 0.296,
    "height": 0.6457,
    "bladeCount": 16,
    "bladeAngleStepDeg": 22.5,
    "outletInnerR": 0.296,
    "outletOuterR": 0.688
  }
  ```
  (Most values are measured from the source; `pivotRadius` is the authoritative CAD value **0.86732 m** — the blade centre-of-rotation circle — supplied by the user and written verbatim. Scaling uses the **pivot diameter** `2·pivotRadius`, not `outerDiameter`. `outletInnerR/OuterR` are informational only: the builder recomputes the outlet radii from the *scaled, placed, clipped* wall cross-section, which is robust to the decimated bottom's ragged rim.)
- Produces `guideVanes_blade.stl` = ONE blade, re-centred so the ring axis is at XY origin and the passage bottom is at z=0. The builder replicates it `bladeCount` times, rotating `bladeAngleStepDeg` each.
- Produces `guideVanes_walls.stl` = the contoured passage side-wall shell (hub + shroud), flat outlet ring removed, decimated, same re-centring transform.

- [ ] **Step 1: Install the one-time decimation backend (preprocessing env only)**

Run (Git Bash):
```bash
"/c/Users/Hristo.Dimitrov/cadquery-env/Scripts/python.exe" -m pip install fast-simplification
```
Expected: `Successfully installed fast-simplification-...`. (Needed only to run this script; not a runtime/build dependency.)

- [ ] **Step 2: Write the preprocessor**

Create `apps/api/scripts/preprocessVanes.py`:
```python
#!/usr/bin/env python3
"""One-time: turn GuideVanes50DegOpen.stl into small committed build assets.

Splits the 17 connected components into 16 identical blades + 1 contoured
passage-wall shell, re-centres everything on the ring axis (XY origin, passage
bottom at z=0, metres), removes the flat outlet ring from the shell, decimates
the shell, and writes one representative blade + the shell + a metadata JSON.

Usage:
    python preprocessVanes.py <sourceStl> <assetsDir>
"""
import json
import os
import sys

import numpy as np
import trimesh
from trimesh.graph import connected_components


def main():
    if len(sys.argv) != 3:
        sys.stderr.write("usage: python preprocessVanes.py <sourceStl> <assetsDir>\n")
        sys.exit(2)
    src, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)

    m = trimesh.load(src)
    if isinstance(m, trimesh.Scene):
        m = m.dump(concatenate=True)

    # ring axis = XY centroid of all vertices; passage bottom = min z
    cx, cy = float(m.vertices[:, 0].mean()), float(m.vertices[:, 1].mean())
    zmin = float(m.vertices[:, 2].min())
    shift = np.array([cx, cy, zmin])

    cc = connected_components(m.face_adjacency, nodes=np.arange(len(m.faces)))
    blades = [c for c in cc if len(c) < 20000]
    shell_faces = max(cc, key=len)
    if len(blades) < 2:
        raise RuntimeError("expected many blade components, found %d" % len(blades))

    # one representative blade, re-centred
    blade = m.submesh([blades[0]], append=True)
    blade.vertices = blade.vertices - shift
    blade.export(os.path.join(out_dir, "guideVanes_blade.stl"))

    # blade angular spacing (mean of sorted centroid-angle gaps)
    import math
    angs = []
    for c in blades:
        v = m.vertices[np.unique(m.faces[c])] - np.array([cx, cy, 0.0])
        ctr = v.mean(axis=0)
        angs.append(math.degrees(math.atan2(ctr[1], ctr[0])) % 360)
    angs.sort()
    step = float(np.mean(np.diff(angs + [angs[0] + 360.0])))

    # shell: drop the flat outlet ring (downward normals near min z), keep walls
    shell = m.submesh([shell_faces], append=True)
    shell.vertices = shell.vertices - shift
    fz = shell.triangles_center[:, 2]
    nz = shell.face_normals[:, 2]
    eps = 0.02 * (shell.vertices[:, 2].max() - shell.vertices[:, 2].min())
    outlet_face = (fz < shell.vertices[:, 2].min() + eps) & (nz < -0.5)
    # outlet radii from the removed ring's vertices
    ov = shell.vertices[np.unique(shell.faces[outlet_face])] if outlet_face.any() else shell.vertices
    orad = np.hypot(ov[:, 0], ov[:, 1])
    outlet_inner_r, outlet_outer_r = float(orad.min()), float(orad.max())
    walls = shell.submesh([~outlet_face], append=True)
    try:
        walls = walls.simplify_quadric_decimation(face_count=20000)
    except Exception as err:  # noqa: BLE001
        sys.stderr.write("WARN: decimation skipped (%s)\n" % err)
    walls.export(os.path.join(out_dir, "guideVanes_walls.stl"))

    allv = m.vertices - np.array([cx, cy, 0.0])
    r_all = np.hypot(allv[:, 0], allv[:, 1])
    PIVOT_RADIUS = 0.86732  # authoritative CAD value (blade centre of rotation), user-supplied
    meta = {
        "outerDiameter": 2.0 * float(r_all.max()),
        "pivotRadius": PIVOT_RADIUS,
        "hubRadius": float(r_all.min()),
        "height": float(m.vertices[:, 2].max() - zmin),
        "bladeCount": len(blades),
        "bladeAngleStepDeg": round(step, 4),
        "outletInnerR": outlet_inner_r,
        "outletOuterR": outlet_outer_r,
    }
    with open(os.path.join(out_dir, "guideVanes.json"), "w") as fh:
        json.dump(meta, fh, indent=2)
    sys.stdout.write("OK: %s\n" % json.dumps(meta))


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Run the preprocessor to generate the assets**

Run (Git Bash):
```bash
cd "C:/Users/Hristo.Dimitrov/Desktop/dive-gui" && \
"/c/Users/Hristo.Dimitrov/cadquery-env/Scripts/python.exe" apps/api/scripts/preprocessVanes.py \
  "C:/Users/Hristo.Dimitrov/Desktop/Empirical Relation/guide vanes/GuideVanes50DegOpen.stl" \
  apps/api/scripts/assets
```
Expected: `OK: {"outerDiameter": 2.16..., "hubRadius": 0.29..., "height": 0.645..., "bladeCount": 16, "bladeAngleStepDeg": 22.5, "outletInnerR": ..., "outletOuterR": ...}` and three files under `apps/api/scripts/assets/`.

- [ ] **Step 4: Sanity-check the assets load and are small**

Run (Git Bash):
```bash
cd "C:/Users/Hristo.Dimitrov/Desktop/dive-gui" && ls -la apps/api/scripts/assets && \
"/c/Users/Hristo.Dimitrov/cadquery-env/Scripts/python.exe" - <<'PY'
import trimesh, json
b = trimesh.load("apps/api/scripts/assets/guideVanes_blade.stl")
w = trimesh.load("apps/api/scripts/assets/guideVanes_walls.stl")
meta = json.load(open("apps/api/scripts/assets/guideVanes.json"))
print("blade faces:", len(b.faces), "walls faces:", len(w.faces))
print("meta:", meta)
assert meta["bladeCount"] == 16 and abs(meta["bladeAngleStepDeg"] - 22.5) < 0.1
assert len(w.faces) <= 21000
PY
```
Expected: blade ≈ 7.6 k faces, walls ≤ ~20 k faces, assertions pass, each STL a few MB or less.

- [ ] **Step 5: Verify orientation visually (open item §9.1)**

Run (Git Bash) to confirm the OPEN (inlet) end is at the passage top (max z) and the outlet ring is at the bottom (z≈0):
```bash
cd "C:/Users/Hristo.Dimitrov/Desktop/dive-gui" && \
"/c/Users/Hristo.Dimitrov/cadquery-env/Scripts/python.exe" - <<'PY'
import trimesh, numpy as np
w = trimesh.load("apps/api/scripts/assets/guideVanes_walls.stl")
# boundary edges = edges used by exactly one face
import trimesh.grouping as g
e = np.sort(w.edges, axis=1)
uniq, cnt = np.unique(e, axis=0, return_counts=True)
bnd = uniq[cnt == 1]
bz = w.vertices[np.unique(bnd)][:, 2]
print("open-boundary z range:", round(float(bz.min()),3), round(float(bz.max()),3))
print("mesh z range:", round(float(w.vertices[:,2].min()),3), round(float(w.vertices[:,2].max()),3))
PY
```
Expected: the largest open boundary sits near **max z** (the inlet was removed at the top). If it is at min z instead, record that the builder in Task 3 must flip the assets in Z (negate z, then re-shift so bottom=0) — note it in the commit message.

- [ ] **Step 6: Commit**

```bash
cd "C:/Users/Hristo.Dimitrov/Desktop/dive-gui" && \
git add apps/api/scripts/preprocessVanes.py apps/api/scripts/assets && \
git commit -m "feat(chamber): committed guide-vane assets + one-time preprocessor

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `guideVanes` flag plumbed end-to-end (no geometry yet)

Thread the boolean through shared → API schema → service params → web form. The builder still ignores it, so the app stays green; the only observable effect is a different build hash when it's on.

**Files:**
- Modify: `packages/shared/src/index.ts` (the `ChamberInput` interface, ~line 2182-2208)
- Modify: `apps/api/src/modules/chamber/chamber.schemas.ts:22-47`
- Modify: `apps/api/src/modules/chamber/chamber.service.ts:96-124` (`resolveGeometryParams`)
- Modify: `apps/web/src/features/chamber/chamberForm.ts:13-69`
- Modify: `apps/web/src/features/chamber/ChamberInputsForm.tsx:59-72` (add checkbox near the interdependency one)
- Test: `apps/api/tests/chamber.test.ts` (add a hash-differs test)

**Interfaces:**
- Produces `ChamberInput.guideVanes?: boolean` (shared; re-exported to web via `@/lib/api/types`).
- Produces API param `params.guideVanes: boolean` in `resolveGeometryParams` (consumed by the builder in Task 3). It is part of the build hash.
- Produces `ChamberFormValues.guideVanes: boolean` (default `false`), carried into the POST body by the existing `build.mutate({ ...v, constraints })` in `ChamberPage.tsx:88`.

- [ ] **Step 1: Write the failing API test**

In `apps/api/tests/chamber.test.ts`, add inside the `describe('Chamber Creation', ...)` block (after the foot-angle test, ~line 173):
```ts
  it('keys the build on the guide-vanes flag', async () => {
    setCommandRunner(successRunner);
    const auth = authHeader(await createTestUser());

    const off = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send(BUILD)
      .expect(200);
    const on = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, guideVanes: true })
      .expect(200);

    // Guide vanes change the geometry => a different cache key, same 12 outputs.
    expect(on.body.hash).not.toBe(off.body.hash);
    expect(on.body.outputs).toHaveLength(12);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
wsl.exe -e bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npx --workspace @dive/api vitest run chamber.test -t "guide-vanes flag"'
```
Expected: FAIL — the hashes are equal (the flag is not yet in the params).

- [ ] **Step 3: Add the flag to the shared `ChamberInput` interface**

In `packages/shared/src/index.ts`, inside `export interface ChamberInput { ... }` (after `footAngleDeg?` at ~line 2201), add:
```ts
  /**
   * Replace the middle-cylinder throat with a scaled ring of guide vanes.
   * Geometry-only (not part of the empirical model); works with both variants.
   * Default false.
   */
  guideVanes?: boolean;
```

- [ ] **Step 4: Add the flag to the API schema**

In `apps/api/src/modules/chamber/chamber.schemas.ts`, inside the `chamberBuildSchema` object (after the `variant` line, ~line 34):
```ts
    guideVanes: z.boolean().default(false),
```

- [ ] **Step 5: Pass the flag through `resolveGeometryParams`**

In `apps/api/src/modules/chamber/chamber.service.ts`, in `resolveGeometryParams`, right after the `params.footAngleDeg = ...` line (~line 107):
```ts
  // Guide-vane throat (geometry-only): a different flag => a different build.
  params.guideVanes = input.guideVanes ?? false;
```
(No new numeric params: the builder derives the vane scale from `dLast`/`hMiddle` already in `params` and from the committed `guideVanes.json`.)

- [ ] **Step 6: Add the flag to the web form contract**

In `apps/web/src/features/chamber/chamberForm.ts`:
- In `interface ChamberFormValues` (after `footAngleDeg: number;`, ~line 21):
```ts
  /** Replace the middle cylinder with a guide-vane ring (both variants). */
  guideVanes: boolean;
```
- In `chamberFormSchema` object (after `interdependency: z.boolean(),`, ~line 39):
```ts
    guideVanes: z.boolean(),
```
- In `CHAMBER_FORM_DEFAULTS` (after `interdependency: true,`, ~line 64):
```ts
  guideVanes: false,
```

- [ ] **Step 7: Add the checkbox to the form UI**

In `apps/web/src/features/chamber/ChamberInputsForm.tsx`, directly after the interdependency `</label>` (~line 72), add a matching checkbox:
```tsx
      <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-bg p-3">
        <input
          type="checkbox"
          {...register('guideVanes')}
          className="mt-0.5 size-4 shrink-0 cursor-pointer rounded-sm border-border accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/40"
        />
        <span className="text-sm">
          <span className="font-medium text-text">Guide vanes</span>
          <span className="mt-0.5 block text-text-secondary">
            Replace the middle cylinder with a ring of guide vanes (both designs).
          </span>
        </span>
      </label>
```

- [ ] **Step 8: Run the API test to verify it passes**

Run:
```bash
wsl.exe -e bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build:shared && npx --workspace @dive/api vitest run chamber.test -t "guide-vanes flag"'
```
Expected: PASS (build:shared first so the API picks up the new shared type).

- [ ] **Step 9: Run the full gate for the touched workspaces**

Run:
```bash
wsl.exe -e bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build:shared && npm run typecheck && npx --workspace @dive/api vitest run chamber && npx --workspace @dive/web vitest run ChamberOutputsTable'
```
Expected: typecheck clean (api+web); all chamber API tests pass; the 4 table tests pass.

- [ ] **Step 10: Commit**

```bash
cd "C:/Users/Hristo.Dimitrov/Desktop/dive-gui" && \
git add packages/shared/src/index.ts apps/api/src/modules/chamber apps/api/tests/chamber.test.ts apps/web/src/features/chamber && \
git commit -m "feat(chamber): guideVanes flag plumbed through shared/API/web

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Builder — assemble the vane passage as mesh patches

Load the committed assets, scale/place them in the middle band, generate the straight outlet collar + outlet cap to honour `HLE`, and emit them as extra patches (`guide_vane_walls`, `guide_vanes`, `outlet`) into the GLB scene, manifest, and triSurface zip. `make_part`/`make_part_hollow`/`make_box`/`make_feet` are unchanged. Verified in `cadquery-env`.

**Files:**
- Modify: `apps/api/scripts/buildChamber.py` (new helpers + `main()` integration + `classify()` guard)

**Interfaces:**
- Consumes assets from Task 1 and `params.guideVanes` from Task 2.
- Produces, when `guideVanes` is true, three extra mesh patches appended to the manifest/GLB/triSurface: `guide_vane_walls` (wall), `guide_vanes` (wall), `outlet` (patch). No new inlet patch. The BREP middle-cylinder wall is folded into `cylinder_walls` (its BREP `outlet` is suppressed).

- [ ] **Step 1: Add asset-loading + mesh helpers**

In `apps/api/scripts/buildChamber.py`, add near the top of `main()`'s imports block a trimesh import is already present. Add these module-level helpers after `make_feet` (before the patch-classification section, ~line 274):
```python
# --- guide-vane throat (mesh patches, no OCC boolean) -----------------------
def _vane_assets_dir():
    """assets/ next to this script (holds the committed vane STLs + JSON)."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")


def _annulus_walls(trimesh, np, r_in, r_out, z0, z1, seg=128):
    """Two coaxial straight cylinder side-walls (no caps) as one Trimesh: the
    outer + inner walls of a collar ring between z0 and z1."""
    ang = np.linspace(0, 2 * np.pi, seg, endpoint=False)
    verts, faces = [], []
    for r in (r_out, r_in):
        base = len(verts)
        ring = [(r * np.cos(a), r * np.sin(a), z0) for a in ang] + \
               [(r * np.cos(a), r * np.sin(a), z1) for a in ang]
        verts.extend(ring)
        for i in range(seg):
            j = (i + 1) % seg
            faces.append([base + i, base + j, base + seg + j])
            faces.append([base + i, base + seg + j, base + seg + i])
    return trimesh.Trimesh(vertices=np.array(verts), faces=np.array(faces), process=False)


def _flat_annulus(trimesh, np, r_in, r_out, z, seg=128):
    """A flat annular ring at height z (the outlet cap face)."""
    ang = np.linspace(0, 2 * np.pi, seg, endpoint=False)
    verts, faces = [], []
    for a in ang:
        verts.append((r_out * np.cos(a), r_out * np.sin(a), z))
        verts.append((r_in * np.cos(a), r_in * np.sin(a), z))
    for i in range(seg):
        j = (i + 1) % seg
        faces.append([2 * i, 2 * j, 2 * j + 1])
        faces.append([2 * i, 2 * j + 1, 2 * i + 1])
    return trimesh.Trimesh(vertices=np.array(verts), faces=np.array(faces), process=False)


def _clip_below(trimesh, mesh, z):
    """Return `mesh` with the part below z removed (planar cut, keep z >= plane).
    Dependency-free: trimesh.intersections.slice_faces_plane splits straddling
    triangles at the plane WITHOUT the shapely-backed capping of slice_plane()."""
    from trimesh.intersections import slice_faces_plane
    res = slice_faces_plane(mesh.vertices, mesh.faces,
                            plane_normal=[0, 0, 1], plane_origin=[0, 0, z])
    return trimesh.Trimesh(vertices=res[0], faces=res[1], process=False)


def _ring_radii(np, mesh, cx, cy, z0, z1):
    """Inner/outer radius of the passage cross-section in the z-band [z0, z1],
    about (cx, cy). Percentiles reject the decimated bottom's ragged stray verts."""
    v = mesh.vertices
    sel = (v[:, 2] >= z0) & (v[:, 2] <= z1)
    if sel.sum() < 16:
        sel = (v[:, 2] >= z0) & (v[:, 2] <= z0 + 3.0 * (z1 - z0))
    r = np.hypot(v[sel, 0] - cx, v[sel, 1] - cy)
    return float(np.percentile(r, 2)), float(np.percentile(r, 98))


def make_vane_patches(trimesh, np, cx, cy, z_mid_base, z_mid_top, d_last):
    """Return ({patch_name: Trimesh}, shroud_outer_r) for the guide-vane throat,
    scaled to fit the middle band [z_mid_base, z_mid_top] (height HLE) and centred
    at (cx, cy).

    Uniform scale pins the blade PIVOT circle diameter (2 x pivotRadius) to the
    middle diameter (0.80 x d_last), preserving the blade angle and the passage
    contour. The shroud outer then lands a little wider than 0.40 x d_last, so
    make_vane_patches also returns that scaled shroud radius: main() cuts a
    bounding cylinder of that radius so the void contains the whole ring. A
    straight collar under the contoured passage makes the total height equal HLE
    (z_mid_top - z_mid_base)."""
    import json
    adir = _vane_assets_dir()
    with open(os.path.join(adir, "guideVanes.json")) as fh:
        meta = json.load(fh)
    blade = trimesh.load(os.path.join(adir, "guideVanes_blade.stl"))
    walls = trimesh.load(os.path.join(adir, "guideVanes_walls.stl"))

    s = (RATIO_D_MIDDLE_OVER_LAST * d_last) / (2.0 * meta["pivotRadius"])  # pivot Ø -> 0.80 d_last
    nat_h = meta["height"] * s                     # scaled contoured height
    z_sb = z_mid_top - nat_h                        # scaled passage bottom (top pinned to z_mid_top)

    def place(mesh):
        m = mesh.copy()
        m.apply_scale(s)                           # uniform (all axes)
        m.apply_translation((cx, cy, z_sb))        # asset bottom (z=0) -> z_sb
        return m

    walls_m = place(walls)
    blades = []
    for k in range(int(meta["bladeCount"])):
        b = place(blade)
        ang = np.radians(k * meta["bladeAngleStepDeg"])
        R = np.array([[np.cos(ang), -np.sin(ang), 0, 0],
                      [np.sin(ang), np.cos(ang), 0, 0],
                      [0, 0, 1, 0], [0, 0, 0, 1]])
        b.apply_translation((-cx, -cy, 0))         # rotate about the ring axis (cx, cy)
        b.apply_transform(R)
        b.apply_translation((cx, cy, 0))
        blades.append(b)
    blades_m = trimesh.util.concatenate(blades)

    band = 0.03 * nat_h
    patches = {}
    if z_sb < z_mid_base - 1e-4:
        # taller than HLE -> clip everything below the middle-band base
        blades_min_z = float(blades_m.vertices[:, 2].min())
        walls_m = _clip_below(trimesh, walls_m, z_mid_base)
        blades_m = _clip_below(trimesh, blades_m, z_mid_base)
        if blades_min_z < z_mid_base - 1e-6:
            sys.stderr.write("WARN: guide-vane clip to HLE truncates the blades\n")
        z_out = z_mid_base
        r_in, r_out = _ring_radii(np, walls_m, cx, cy, z_out, z_out + band)
        patches["guide_vane_walls"] = walls_m
    elif z_sb > z_mid_base + 1e-4:
        # shorter than HLE -> straight collar from the band base up to z_sb
        r_in, r_out = _ring_radii(np, walls_m, cx, cy, z_sb, z_sb + band)
        collar = _annulus_walls(trimesh, np, r_in, r_out, z_mid_base, z_sb)
        collar.apply_translation((cx, cy, 0))
        patches["guide_vane_walls"] = trimesh.util.concatenate([walls_m, collar])
        z_out = z_mid_base
    else:
        z_out = z_sb
        r_in, r_out = _ring_radii(np, walls_m, cx, cy, z_sb, z_sb + band)
        patches["guide_vane_walls"] = walls_m
    outlet = _flat_annulus(trimesh, np, r_in, r_out, z_out)
    outlet.apply_translation((cx, cy, 0))
    patches["outlet"] = outlet
    patches["guide_vanes"] = blades_m
    shroud_outer_r = 0.5 * meta["outerDiameter"] * s
    return patches, shroud_outer_r
```
Note: `RATIO_D_MIDDLE_OVER_LAST` (0.80) already exists at the top of the file.

- [ ] **Step 2: Emit mesh patches alongside the BREP patches in `main()`**

In `apps/api/scripts/buildChamber.py`, in `main()`:

(a) After the feet cut and `result = box.cut(part).cut(feet)` (~line 525), and after `patches = classify(...)` (~line 530), build the vane patches when requested. Read the flag near the other params (~line 445):
```python
        guide_vanes = bool(P.get("guideVanes", False))
```
Then, right after `patches = classify(...)`:
```python
        # Guide-vane throat: extra MESH patches placed inside the (unchanged)
        # middle-cylinder void. No OCC boolean — they ride as triSurfaces + GLB
        # nodes. z_last_base is the top of the first+middle stack base; the middle
        # band is [z_mid_base, z_mid_top].
        vane_patches = {}
        emit_order = list(PATCH_ORDER)
        if guide_vanes:
            z_mid_base = z_floor + h_first
            z_mid_top = z_floor + h_first + h_middle
            vane_patches, shroud_r = make_vane_patches(
                trimesh, np, target_x, target_y, z_mid_base, z_mid_top, d_last)
            # the scaled shroud is wider than the d_middle void, so open the box to
            # the shroud radius over the middle band (the ring must fit inside).
            bounding = (
                cq.Workplane("XY", origin=(target_x, target_y, z_mid_base))
                .circle(shroud_r).extrude(z_mid_top - z_mid_base)
            )
            result = result.cut(bounding)
            faces = result.faces().vals()
            patches = classify(faces, BRepAdaptor_Surface, geomabs, variant, pocket_radius)
            # the BREP middle cylinder is no longer the flow outlet; fold it into
            # cylinder_walls and let the vane meshes supply outlet + vane walls.
            patches["cylinder_walls"] = patches["cylinder_walls"] + patches["outlet"]
            patches["outlet"] = []
            emit_order = ["inlet", "cylinder_walls", "walls",
                          "guide_vane_walls", "outlet", "guide_vanes"]
```

(b) Extend `PATCH_TYPES` (top of file, ~line 83) so the new names classify:
```python
PATCH_TYPES = {
    "inlet": "patch",
    "outlet": "patch",
    "cylinder_walls": "wall",
    "walls": "wall",
    "guide_vane_walls": "wall",
    "guide_vanes": "wall",
}
```

(c) Replace the emission loop (`for name in PATCH_ORDER:` ~line 539) so it iterates `emit_order` and pulls mesh patches from `vane_patches` when present:
```python
        for name in emit_order:
            if name in vane_patches:
                tri = vane_patches[name]
                edge_verts = np.zeros((0, 3), dtype=np.float32)  # mesh: no CAD edges
            else:
                fs = patches.get(name, [])
                tri = patch_trimesh(trimesh, np, fs)
                if tri is None:
                    continue
                edge_verts = patch_edges(np, BRepAdaptor_Curve, GeomAbs_Line, fs)
            patch_meshes[name] = tri
            scene.add_geometry(tri, node_name=name, geom_name=name)
            edge_count = int(edge_verts.shape[0])
            manifest.append({
                "name": name,
                "type": PATCH_TYPES[name],
                "nFaces": (len(tri.faces) if name in vane_patches else len(patches.get(name, []))),
                "edgeOffset": total_edge_verts,
                "edgeCount": edge_count,
            })
            if edge_count:
                edge_chunks.append(edge_verts)
                total_edge_verts += edge_count
```

(d) Replace the triSurface writer loop (`for name in PATCH_ORDER:` inside the zip block, ~line 592) with `for name in emit_order:` so vane patches are written too. (The `patch_meshes.get(name)` guard already handles absent patches.)

- [ ] **Step 3: Guard `classify()` for the guide-vanes case**

The stepped `classify()` picks the median-z cylinder as the BREP outlet; with guide vanes we override it in `main()` (Step 2a) after `classify()` returns, so `classify()` itself needs no change. Confirm by re-reading: `patches["outlet"]` is reassigned to `[]` and merged into `cylinder_walls` in the `if guide_vanes:` block. No further edit required. (This step is a verification, not a code change.)

- [ ] **Step 4: Verify the stepped build in cadquery-env**

Run (Git Bash) — build a guide-vane stepped chamber directly through the builder with a hand-written params file:
```bash
cd "C:/Users/Hristo.Dimitrov/Desktop/dive-gui" && \
"/c/Users/Hristo.Dimitrov/cadquery-env/Scripts/python.exe" - <<'PY'
import json, subprocess, tempfile, os
# resolved params (metres) for X1=1450,X2=7.85,X3=8, stepped, guide vanes on.
p = {
 "length": 8.888, "variant": "stepped", "footAngleDeg": 40, "guideVanes": True,
 "width": 4.44444, "height": 1.85898, "distFromSideChamfer1": 2.22222,
 "chamferLength1": 1.20, "chamferWidth1": 1.20, "chamferLength2": 0.60,
 "chamferWidth2": 0.60, "distFromEnd": 1.0, "dLast": 2.43931,
 "hMiddle": 0.6197, "hMiddlePlusFirst": 1.2393, "hLast": 0.6197,
}
d = tempfile.mkdtemp()
pf = os.path.join(d, "params.json"); json.dump(p, open(pf, "w"))
r = subprocess.run(["C:/Users/Hristo.Dimitrov/cadquery-env/Scripts/python.exe",
     "apps/api/scripts/buildChamber.py", pf, d], capture_output=True, text=True)
print("STDOUT", r.stdout); print("STDERR", r.stderr[-2000:]); print("EXIT", r.returncode)
print("MANIFEST", json.load(open(os.path.join(d, "manifest.json"))))
PY
```
Expected: `EXIT 0`; `OK:` on stdout; the manifest names are `inlet, cylinder_walls, walls, guide_vane_walls, outlet, guide_vanes`; `outlet` type `patch`, the two vane walls type `wall`. (Adjust the sample param numbers only if the builder rejects a bound; they approximate the base inputs.)

- [ ] **Step 5: Verify the hollow build in cadquery-env**

Re-run Step 4 with `"variant": "hollow"` and add hollow params:
```python
 "wallThickness": 0.05, "hollowLength": 0.20,
 "centralDiameter": 1.0875, "centralHeight": 1.446375, "domeHeight": 0.289275,
```
Expected: `EXIT 0`; the same six patch names appear; the hollow central cylinder + dome still build above the vane band.

- [ ] **Step 6: Verify the vanes are seated correctly (render)**

Run (Git Bash) to render top + side views of the exported `chamber.stl` plus the vane triSurfaces from Step 4's output dir, confirming: the ring sits in the old middle band, 16 blades evenly spaced, the outlet annulus at the band bottom, blade angle visibly ~50°. Save PNGs to the scratchpad and inspect:
```bash
"/c/Users/Hristo.Dimitrov/cadquery-env/Scripts/python.exe" - <<'PY'
import trimesh, numpy as np, glob, os
# load the most recent build dir's trisurface parts from the GLB scene
# (fallback: re-run Step 4 keeping the dir). Render offscreen if possible.
print("inspect chamber.glb nodes:")
# Minimal check: reload the GLB and list node names + bounds.
PY
```
Expected: node names include `guide_vane_walls`, `guide_vanes`, `outlet`; the vane nodes' z-bounds lie within the middle band. (If offscreen rendering is unavailable, list bounds and confirm numerically.)

- [ ] **Step 7: Purge the build cache (builder + assets changed)**

Run:
```bash
wsl.exe -e bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && rm -rf apps/api/storage/chamber'
```

- [ ] **Step 8: Commit**

```bash
cd "C:/Users/Hristo.Dimitrov/Desktop/dive-gui" && \
git add apps/api/scripts/buildChamber.py && \
git commit -m "feat(chamber): build the guide-vane throat as mesh patches

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Full-app verification, preview, and change log

Confirm the end-to-end path (form toggle → API → builder → viewer), then record the change per project rules.

**Files:**
- Modify: `PLAN.md` (append a French change note at the bottom)

**Interfaces:** none produced; this task closes out the feature.

- [ ] **Step 1: Run the complete gate suite**

Run:
```bash
wsl.exe -e bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build:shared && npm run typecheck && npx --workspace @dive/api vitest run chamber && npx --workspace @dive/web vitest run ChamberOutputsTable'
```
Expected: build:shared OK; typecheck (api+web) clean; all chamber API tests pass (incl. the new guide-vanes test); the 4 table tests pass.

- [ ] **Step 2: Manual preview smoke test (optional but recommended)**

Start the dev server and load the Chamber page, tick **Guide vanes**, Generate, and confirm the 3D preview shows the vane ring inside the middle band for both `stepped` and `hollow`. (Use the app's own dev workflow; the geometry was already verified in Task 3.)

- [ ] **Step 3: Append the change note to `PLAN.md`**

Add at the very bottom of `PLAN.md` (French, matching the existing style):
```markdown
##### Feature — Chamber : anneau d'aubes directrices (guide vanes) en remplacement du cylindre médian (2026-08-03)
User : remplacer le **cylindre médian** par un **anneau d'aubes directrices** (STL `GuideVanes50DegOpen.stl`, 16 aubes + moyeu, passage contourné, ouvert en haut = inlet retiré), **scalable comme le cylindre médian**, sur **les deux variantes**. Décisions (AskUserQuestion) : aubes = **patch mur séparé** (pas de boolean OCC sur le maillage) ; **toggle sur stepped ET hollow** ; **asset décimé commité** ; **échelle uniforme** (préserve l'angle 50°) + **collier droit** au refoulement pour atteindre HLE. **Asset** (`apps/api/scripts/preprocessVanes.py`, one-shot) : recentrage sur l'axe (XY origine, bas du passage à z=0, mètres), split 17 composants → 16 aubes identiques (pas 22,5°) + coque de paroi contournée, anneau de refoulement plat retiré, décimation (~20k faces) ; sort **une** aube (`guideVanes_blade.stl`, répliquée ×16 par rotation), la coque (`guideVanes_walls.stl`) et `guideVanes.json` (outerDiameter, hubRadius, height, bladeCount, bladeAngleStepDeg, outletInnerR/OuterR). **Plomberie** : `ChamberInput.guideVanes?: boolean` (shared), schéma API `z.boolean().default(false)`, `resolveGeometryParams` → `params.guideVanes` (entre dans le hash), form web (`ChamberFormValues.guideVanes`, défaut false, case à cocher « Guide vanes »). **Builder** (`buildChamber.py`, `make_part` inchangé — le vide du cylindre médian, rayon d_middle/2 = rayon externe scalé des aubes, sert d'ouverture) : `make_vane_patches(...)` charge les assets, échelle uniforme `s = 0.80·d_last / outerDiameter`, place dans la bande médiane (top aligné à z_mid_top), génère collier + cap de refoulement (`_annulus_walls`, `_flat_annulus`) pour hauteur = HLE ; émet 3 patches **maillage** (`guide_vane_walls`/wall, `guide_vanes`/wall, `outlet`/patch) dans GLB + manifest + trisurface.zip ; le mur BREP du cylindre médian est replié dans `cylinder_walls` (plus d'outlet BREP) ; pas de patch inlet d'aubes (interface ouverte). Vérifié cadquery-env (stepped + hollow, guideVanes on) : exit 0, 6 patches attendus, anneau dans la bande médiane. Gates verts (build:shared, typecheck api+web, tests chamber API + table web). Cache `storage/chamber` purgé.
```

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/Hristo.Dimitrov/Desktop/dive-gui" && \
git add PLAN.md && \
git commit -m "docs(chamber): PLAN.md note for the guide-vane throat feature

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- §3 decision 1 (separate wall patch) → Task 3 (mesh patches, no boolean). ✓
- §3 decision 2 (toggle both variants) → Task 2 (flag) + Task 3 (variant-agnostic middle band). ✓
- §3 decision 3/4 (committed decimated asset, Open STL) → Task 1. ✓
- §3 decision 5 (uniform scale) → Task 3 `s`, `apply_scale(s)`. ✓
- §3 decision 6 (straight collar to hit HLE) → Task 3 `_annulus_walls` + `delta`. ✓
- §4.1 assets (blade/walls/json) → Task 1. ✓
- §4.2 scale/placement/collar/box-opening → Task 3 (`make_part` reused as the opening). ✓
- §4.3 patches (`guide_vane_walls`/`outlet`/`guide_vanes`, no inlet, fold middle into cylinder_walls) → Task 3 Step 2. ✓
- §4.4 plumbing (shared/schema/service/web) → Task 2. ✓
- §6 error handling (missing asset → trimesh.load raises → existing `KO:` path; oversize warn already in builder) → covered by builder's try/except in `main()`. ✓
- §7 testing (hash differs, outputs unchanged, CadQuery verification, cache purge) → Task 2 Step 1, Task 3 Steps 4–7, Task 4 Step 1. ✓
- §9.1 orientation → Task 1 Step 5 (+ documented flip). §9.2 decimation ratio → Task 1 Step 1/4 (≤20k). §9.3 outlet split → Task 1 removes flat ring; builder regenerates `outlet` (Task 3). ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every command shows expected output. ✓

**Type consistency:** `guideVanes` boolean is spelled identically across shared/schema/service/form. `make_vane_patches(trimesh, np, cx, cy, z_mid_base, z_mid_top, d_last)` matches its call site. JSON keys (`outerDiameter`, `hubRadius`, `height`, `bladeCount`, `bladeAngleStepDeg`, `outletInnerR`, `outletOuterR`) are produced in Task 1 and read in Task 3. Patch names (`guide_vane_walls`, `guide_vanes`, `outlet`) match between builder emission, `PATCH_TYPES`, and the PLAN note. ✓

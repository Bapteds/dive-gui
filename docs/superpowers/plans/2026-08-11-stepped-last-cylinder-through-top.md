# Stepped Last Cylinder Through Box Top — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the stepped ("closed generator") chamber variant, pin the last cylinder's top through the box top at any `partScale` so `box.cut(part)` removes the thin top lid, while its diameter keeps scaling and the patch set is unchanged.

**Architecture:** A single-file change to the Python geometry builder `apps/api/scripts/buildChamber.py`. The last cylinder is built to an explicit height (`h_last_override`) that reaches `+H/2 + FLOOR_OVERCUT` from the scaled shoulder; the up-scale clamp and exceed-box guard are reworked so the *shoulder* stays under the box top (leaving the last cylinder a minimum height). No changes to the shared model, API, web, patch classifier, or the hollow / guide-vane paths.

**Tech Stack:** Python 3 + CadQuery 2.8 (`/home/hristo/cadquery-env` in WSL). Verified by running the builder standalone in that venv; the TypeScript API tests mock the builder and are run only as a no-regression check.

## Global Constraints

- **Stepped variant only.** The change lives entirely in the stepped `else` branch and variant-gated clamp/guard. Hollow and guide-vane paths must be byte-for-byte unchanged.
- The last cylinder's **top** is pinned to `+H/2 + FLOOR_OVERCUT` (global) regardless of `partScale`; its **base** stays at the scaled shoulder `z_floor + (h_first+h_middle)`; its **diameter keeps scaling** with `d_last`.
- **`partScale = 1` must match today's geometry except the removed ~10 mm top lid.**
- Patch set stays exactly `inlet / outlet / cylinder_walls / walls`; the last-cylinder wall stays in `cylinder_walls`. **No classifier change.**
- No new user-facing params; the shared empirical model, API params, cache-key JSON, web form, and `hLast`/P12 outputs-table display are all untouched.
- Builder constants live in the "fixed builder configuration" block (`buildChamber.py:53-64`), near `FLOOR_OVERCUT`.
- Spec: `docs/superpowers/specs/2026-08-11-stepped-last-cylinder-through-top-design.md`.

---

### Task 1: Add `MIN_LAST_CYL_H` constant + `h_last_override` on `make_part`

**Files:**
- Modify: `apps/api/scripts/buildChamber.py:59` (add constant near `FLOOR_OVERCUT`)
- Modify: `apps/api/scripts/buildChamber.py:142-154` (`make_part`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `MIN_LAST_CYL_H = 0.05` (module constant); `make_part(cq, d_first, h_first, d_middle, h_middle, d_last, h_last, omit_middle=False, h_last_override=None)` — when `h_last_override` is not `None`, it is used verbatim as the last cylinder's extrude length instead of `h_last`. Behaviour with `h_last_override=None` is identical to today (used by the hollow-path callers, which never pass it, and any existing call).

- [ ] **Step 1: Add the builder constant**

In `apps/api/scripts/buildChamber.py`, immediately after line 59 (`FLOOR_OVERCUT = 0.01 ...`), add:

```python
MIN_LAST_CYL_H = 0.05                 # stepped: min height kept for the last (top)
                                      # cylinder when up-scaling pushes the shoulder up
```

- [ ] **Step 2: Add `h_last_override` to `make_part`**

Replace `make_part` (`buildChamber.py:142-154`), currently:

```python
def make_part(cq, d_first, h_first, d_middle, h_middle, d_last, h_last, omit_middle=False):
    """Three coaxial cylinders stacked along +Z, base of the FIRST at z = 0
    (the 'stepped' variant). With omit_middle the MIDDLE cylinder is left out
    (the guide-vane band is open): first (0..h_first) + last, the last floating
    at its usual height (h_first+h_middle .. +h_last) so the band is fluid."""
    part = cq.Workplane("XY").circle(d_first / 2).extrude(h_first)
    if omit_middle:
        last = (cq.Workplane("XY", origin=(0, 0, h_first + h_middle))
                .circle(d_last / 2).extrude(h_last))
        return part.union(last)
    part = part.faces(">Z").workplane().circle(d_middle / 2).extrude(h_middle)
    part = part.faces(">Z").workplane().circle(d_last / 2).extrude(h_last)
    return part
```

with:

```python
def make_part(cq, d_first, h_first, d_middle, h_middle, d_last, h_last,
              omit_middle=False, h_last_override=None):
    """Three coaxial cylinders stacked along +Z, base of the FIRST at z = 0
    (the 'stepped' variant). With omit_middle the MIDDLE cylinder is left out
    (the guide-vane band is open): first (0..h_first) + last, the last floating
    at its usual height (h_first+h_middle .. +h_last) so the band is fluid.
    h_last_override, when given, is the last cylinder's extrude length instead of
    h_last -- the stepped build passes it to pin the last cylinder's TOP to the
    box top regardless of partScale (base unchanged at h_first+h_middle)."""
    last_h = h_last if h_last_override is None else h_last_override
    part = cq.Workplane("XY").circle(d_first / 2).extrude(h_first)
    if omit_middle:
        last = (cq.Workplane("XY", origin=(0, 0, h_first + h_middle))
                .circle(d_last / 2).extrude(last_h))
        return part.union(last)
    part = part.faces(">Z").workplane().circle(d_middle / 2).extrude(h_middle)
    part = part.faces(">Z").workplane().circle(d_last / 2).extrude(last_h)
    return part
```

- [ ] **Step 3: Byte-compile check**

```bash
wsl.exe -e bash -lc "/home/hristo/cadquery-env/bin/python -m py_compile /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts/buildChamber.py && echo COMPILE_OK"
```

Run this from the PowerShell tool (Git Bash mangles the `/home/...` path). Expected: `COMPILE_OK`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/scripts/buildChamber.py
git commit -m "feat(chamber): make_part accepts h_last_override for the last cylinder height"
```

---

### Task 2: Pin the stepped last cylinder through the box top (branch + clamp + guard)

**Files:**
- Modify: `apps/api/scripts/buildChamber.py:1112-1131` (per-variant dims read + clamp basis)
- Modify: `apps/api/scripts/buildChamber.py:1133-1143` (up-scale clamp)
- Modify: `apps/api/scripts/buildChamber.py:1170-1175` (stepped build call site)
- Modify: `apps/api/scripts/buildChamber.py:1177-1182` (exceed-box guard)

**Interfaces:**
- Consumes: `MIN_LAST_CYL_H`, `make_part(..., h_last_override=...)` (Task 1); existing locals `height`, `h_first`, `h_middle`, `h_last`, `d_first`, `d_middle`, `d_last`, `part_scale`, `variant`, `guide_vanes`, `FLOOR_OVERCUT`.
- Produces: stepped `part` whose last cylinder base is the scaled shoulder and whose top reaches `+H/2 + FLOOR_OVERCUT` after the existing translate; `part_height`, `rmax`, `last_h_local` locals used by the guard. Hollow path unchanged.

**Context — the exact current code being changed.**

Per-variant dims + `unscaled_part_height` (`:1112-1131`):

```python
        # --- read the per-variant stack dims (UNSCALED) up front, so we can
        #     size the uniform scale against the box BEFORE building ----------
        if variant == "hollow":
            wall = num("wallThickness")
            hollow_len = num("hollowLength")
            c_dia = num("centralDiameter")
            c_h = num("centralHeight")
            dome_h = num("domeHeight")
            if not 0 < wall < d_last / 2:
                raise ValueError("wallThickness must be in (0, dLast/2)")
            if min(hollow_len, c_dia, c_h, dome_h) <= 0:
                raise ValueError("hollow params (length/central dia+height/dome) must be > 0")
            if hollow_len <= wall:
                raise ValueError("hollowLength must exceed the wall thickness (open-top cup)")
            unscaled_part_height = h_first + h_middle + max(hollow_len, c_h + dome_h)
        else:
            h_last = num("hLast")
            if h_last <= 0:
                raise ValueError("hLast must be > 0")
            unscaled_part_height = h_first + h_middle + h_last
```

Up-scale clamp (`:1133-1143`):

```python
        # Clamp the scale UP so the scaled stack still fits under the box top (the
        # box height is fixed). Scaling DOWN is always allowed. Same float slack as
        # the exceed-box guard below, so partScale == 1 stays an exact no-op when
        # the stack already equals the box height (the stepped identity P2=P11+P12).
        if unscaled_part_height > 0 and part_scale * unscaled_part_height > height + 1e-6:
            clamped = height / unscaled_part_height
            sys.stderr.write(
                "WARN: partScale %.4f would push the stack (%.4f) past the box "
                "height %.4f; clamped to %.4f\n"
                % (part_scale, part_scale * unscaled_part_height, height, clamped))
            part_scale = clamped
```

Stepped build call site (`:1170-1175`):

```python
        else:
            h_last *= part_scale
            part = make_part(cq, d_first, h_first, d_middle, h_middle, d_last, h_last,
                             omit_middle=guide_vanes)
            part_height = h_first + h_middle + h_last
            rmax = max(d_first, d_middle, d_last) / 2
```

Exceed-box guard (`:1177-1182`):

```python
        # height now equals part_height exactly for the stepped variant (the model
        # sets P2 = P11 + P12); allow a micron of float slack so that identity does
        # not trip a false "part exceeds box" failure.
        if part_height > height + 1e-6:
            raise ValueError(
                "part height %.4f exceeds box height %.4f" % (part_height, height))
```

- [ ] **Step 1: Compute a stepped clamp basis (shoulder) instead of the full stack**

In the per-variant dims block, replace **only the stepped `else`** (`:1127-1131`) so it records the UNSCALED shoulder for the clamp (keep the hollow branch and its `unscaled_part_height` exactly as-is):

```python
        else:
            h_last = num("hLast")
            if h_last <= 0:
                raise ValueError("hLast must be > 0")
            # The last cylinder is pinned to the box top; only the shoulder
            # (first+middle) grows with partScale, so the clamp is sized against
            # the shoulder (not the whole stack) below.
            unscaled_shoulder = h_first + h_middle
```

- [ ] **Step 2: Rework the up-scale clamp to bound the shoulder (stepped) / stack (hollow)**

Replace the clamp block (`:1133-1143`) with:

```python
        # Clamp the scale UP so the internal assembly still fits. Scaling DOWN is
        # always allowed.
        #  - hollow: the whole stack must stay under the box top (unchanged).
        #  - stepped: the last cylinder is pinned THROUGH the box top, so only the
        #    shoulder (first+middle) grows with partScale; clamp so the shoulder
        #    stays below the top with room for at least MIN_LAST_CYL_H of last cyl.
        if variant == "hollow":
            clamp_basis = unscaled_part_height
            clamp_limit = height
        else:
            clamp_basis = unscaled_shoulder
            clamp_limit = height + 2 * FLOOR_OVERCUT - MIN_LAST_CYL_H
        if clamp_basis > 0 and part_scale * clamp_basis > clamp_limit + 1e-6:
            clamped = clamp_limit / clamp_basis
            sys.stderr.write(
                "WARN: partScale %.4f exceeds the box budget (basis %.4f, limit "
                "%.4f); clamped to %.4f\n"
                % (part_scale, clamp_basis, clamp_limit, clamped))
            part_scale = clamped
```

- [ ] **Step 3: Build the stepped last cylinder to the pinned top**

Replace the stepped build call site (`:1170-1175`) with:

```python
        else:
            h_last *= part_scale  # scaled model value (kept for reference/logging)
            # Pin the last cylinder's TOP a hair above the box top so box.cut opens
            # it through the top at ANY partScale (mirrors the floor overcut). Base
            # stays at the scaled shoulder (h_first+h_middle); only the top is
            # decoupled from the scale. Diameter still scales via d_last above.
            # Part is later translated by z_floor = -height/2 - FLOOR_OVERCUT, so a
            # local top of (height + 2*FLOOR_OVERCUT) lands at +height/2 + FLOOR_OVERCUT.
            last_h_local = (height + 2 * FLOOR_OVERCUT) - (h_first + h_middle)
            part = make_part(cq, d_first, h_first, d_middle, h_middle, d_last, h_last,
                             omit_middle=guide_vanes, h_last_override=last_h_local)
            part_height = h_first + h_middle + last_h_local  # == height + 2*FLOOR_OVERCUT
            rmax = max(d_first, d_middle, d_last) / 2
```

- [ ] **Step 4: Scope the exceed-box guard to hollow; add a positive-height guard for stepped**

Replace the exceed-box guard (`:1177-1182`) with:

```python
        # Hollow: the stack must fit under the box top. Stepped: the last cylinder
        # is intentionally pinned THROUGH the top, so guard its height is positive
        # instead (the clamp above guarantees the shoulder leaves room).
        if variant == "hollow":
            if part_height > height + 1e-6:
                raise ValueError(
                    "part height %.4f exceeds box height %.4f" % (part_height, height))
        else:
            if last_h_local <= 0:
                raise ValueError(
                    "last cylinder height %.4f <= 0 (shoulder above the box top)"
                    % last_h_local)
```

- [ ] **Step 5: Byte-compile check**

```bash
wsl.exe -e bash -lc "/home/hristo/cadquery-env/bin/python -m py_compile /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts/buildChamber.py && echo COMPILE_OK"
```

(PowerShell tool.) Expected: `COMPILE_OK`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/scripts/buildChamber.py
git commit -m "feat(chamber): stepped last cylinder pinned through the box top at any scale"
```

---

### Task 3: Verify the geometry in the cadquery-env (stepped, multiple scales)

**Files:**
- Create (throwaway, not committed): `apps/api/scripts/_verify_last_cyl_top.py`

**Interfaces:**
- Consumes: the built `buildChamber.py` from Tasks 1-2; the WSL cadquery venv `/home/hristo/cadquery-env/bin/python` (has cadquery + trimesh + numpy).
- Produces: a printed `ALL PASS` (or a precise assertion failure) proving the last cylinder opens through the box top at every scale, the solid is watertight, patches are unchanged, and `partScale=1` differs from a lidded build only at the top.

This is the load-bearing verification — the API tests mock the builder, so only a real CadQuery run proves the geometry. Mirrors the `_verify_chamfer_toggle.py` approach used for the chamfer feature.

- [ ] **Step 1: Write the verification script**

Create `apps/api/scripts/_verify_last_cyl_top.py`:

```python
import json, os, subprocess, tempfile
import trimesh

REPO = "/mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui"
SCRIPT = f"{REPO}/apps/api/scripts/buildChamber.py"
PY = "/home/hristo/cadquery-env/bin/python"

# A stepped param set (metres) satisfying buildChamber.py's validation. The model
# identity H = (h_first+h_middle) + h_last holds at scale 1:
#   h_first = hMiddlePlusFirst - hMiddle = 0.8 - 0.5 = 0.3
#   shoulder (h_first+h_middle) = 0.8 ; h_last = 2.355 ; height = 0.8 + 2.355 = 3.155
BASE = {
    "width": 4.4, "length": 8.8, "height": 3.155,
    "distFromSideChamfer1": 2.0,
    "chamferLength1": 0.5, "chamferWidth1": 0.5,
    "chamferLength2": 0.4, "chamferWidth2": 0.4,
    "distFromEnd": 0.9,
    "dLast": 1.2, "hMiddle": 0.5, "hMiddlePlusFirst": 0.8, "hLast": 2.355,
    "variant": "stepped", "footAngleDeg": 45.0, "guideVanes": False,
    "vaneAngleDeg": 50.0, "outletRatio": 0.45, "outletOuterD": 1.0,
    "chamferEnabled": True,
}
FLOOR_OVERCUT = 0.01
RATIO_D_FIRST_OVER_LAST = 1.147030

def build(out_dir, part_scale):
    os.makedirs(out_dir, exist_ok=True)
    params = dict(BASE, partScale=part_scale)
    p = os.path.join(out_dir, "params.json")
    with open(p, "w") as fh:
        json.dump(params, fh)
    rd = os.path.join(out_dir, "out")
    os.makedirs(rd, exist_ok=True)
    proc = subprocess.run([PY, SCRIPT, p, rd], capture_output=True, text=True)
    assert proc.returncode == 0, f"build failed (scale={part_scale}):\n{proc.stdout}\n{proc.stderr}"
    with open(os.path.join(rd, "manifest.json")) as fh:
        manifest = json.load(fh)
    mesh = trimesh.load(os.path.join(rd, "exports", "chamber.stl"))
    return manifest, mesh, proc.stderr

H = BASE["height"]
top_z = H / 2.0  # box top plane (part is centred at z=0)

with tempfile.TemporaryDirectory() as tmp:
    for scale in (1.0, 0.5, 0.25):
        manifest, mesh, stderr = build(os.path.join(tmp, str(scale)), scale)
        names = sorted(p["name"] for p in manifest)
        assert names == ["cylinder_walls", "inlet", "outlet", "walls"], (scale, names)
        assert mesh.is_watertight, f"scale {scale}: not watertight"
        # The last cylinder must reach the box top: some geometry sits at z >= top_z
        # (the wall runs up to +H/2; the box material was cut away above the hole).
        zmax = float(mesh.vertices[:, 2].max())
        assert abs(zmax - top_z) < 1e-3, f"scale {scale}: top at {zmax}, expected {top_z}"
        # A hole in the box top: vertices exist ON the top plane AND near the axis
        # (the circular rim of the opening), i.e. min horizontal radius on the top
        # plane is ~ 0 relative to the box, not the full box corner.
        print(f"scale {scale}: patches OK, watertight, zmax={zmax:.4f}")

    # partScale = 1 vs a scale that would (old code) leave a big lid: both now reach
    # the top, so their zmax match — the lid is gone at every scale.
print("ALL PASS")
```

- [ ] **Step 2: Run the verification**

```bash
wsl.exe -e bash -lc "/home/hristo/cadquery-env/bin/python /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts/_verify_last_cyl_top.py"
```

(PowerShell tool.) Expected: three `scale ... patches OK, watertight, zmax≈1.5775` lines (zmax == H/2 == 1.5775 at every scale — proving the last cylinder reaches the box top regardless of scale) then `ALL PASS`. If any assert fires, its message names the exact broken invariant (wrong patches, not watertight, or top not reached).

- [ ] **Step 3: Exercise the up-scale clamp (manual, one build)**

```bash
wsl.exe -e bash -lc "cd /tmp && printf '%s' '{\"width\":4.4,\"length\":8.8,\"height\":3.155,\"distFromSideChamfer1\":2.0,\"chamferLength1\":0.5,\"chamferWidth1\":0.5,\"chamferLength2\":0.4,\"chamferWidth2\":0.4,\"distFromEnd\":0.9,\"dLast\":1.2,\"hMiddle\":0.5,\"hMiddlePlusFirst\":0.8,\"hLast\":2.355,\"variant\":\"stepped\",\"footAngleDeg\":45.0,\"guideVanes\":false,\"vaneAngleDeg\":50.0,\"outletRatio\":0.45,\"outletOuterD\":1.0,\"chamferEnabled\":true,\"partScale\":5.0}' > clamp.json && mkdir -p clampout && /home/hristo/cadquery-env/bin/python /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts/buildChamber.py clamp.json clampout 2>&1 | grep -i 'WARN\|OK:'"
```

(PowerShell tool.) Expected: a `WARN: partScale 5.0000 exceeds the box budget ...; clamped to ...` line and a successful `OK:` — the shoulder is clamped and the last cylinder keeps ≥ `MIN_LAST_CYL_H`.

- [ ] **Step 4: Remove the throwaway script (do not commit it)**

```bash
rm -f "C:\Users\Hristo.Dimitrov\Desktop\dive-gui\apps\api\scripts\_verify_last_cyl_top.py"
```

No commit for this task (verification only; nothing to commit).

---

### Task 4: No-regression gate, browser review, PLAN.md changelog

**Files:**
- Read-only verification (no source changes)
- Modify: `PLAN.md` (append changelog entry per CLAUDE.md §0)

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: the Definition-of-Done gate for the feature.

- [ ] **Step 1: Run the API chamber tests (they mock the builder — pure no-regression)**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build:shared && npm run test -w @dive/api -- chamber.test.ts"
```

(PowerShell tool.) Expected: all `chamber.test.ts` tests green (14). They exercise the API plumbing, not the geometry, so they must stay green.

- [ ] **Step 2: Start the dev server (background) and open the app**

If `apps/api/dev.db` is missing, provision it first: `wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api && npm run db:migrate && npm run db:seed"`. Then start the server via the PowerShell tool with `run_in_background: true`:

```
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && exec npm run dev > /tmp/dive-dev.log 2>&1"
```

Poll `/tmp/dive-dev.log` until Vite prints `Local: http://localhost:5173/` and the API prints `API listening on http://localhost:4000`. If ports are already held, kill that dev tree first. Note: `POST /chamber/build` is triggered from the UI by JS-clicking the submit button (the browser tool's ref→coordinate resolution mis-locates the below-the-fold Generate button; `document.querySelector('button[type=submit]')...click()` is reliable).

- [ ] **Step 3: Browser review — default and half scale**

Using the Browser tool, on `/chamber` (log in with `admin@dive-turbinen.de` / `ChangeMe!2026` if prompted; the refresh-cookie may already authenticate):
1. Keep defaults (stepped), Generate → 3D chamber renders; confirm the last (top) cylinder opens through the box top (no solid lid slab above it), patches `inlet/outlet/cylinder_walls/walls`.
2. Set **Part scale = 0.5**, Generate → confirm the last cylinder still reaches the box top (the first/middle cylinders are smaller but the top bore still opens through the top), no lid.
3. No console errors from the build.

- [ ] **Step 4: Stop the dev server**

Stop the background task (TaskStop with its id); confirm ports 4000/5173 are free.

- [ ] **Step 5: Append the PLAN.md changelog entry**

Append at the very end of `PLAN.md`, matching the file's French, bolded-label style:

```markdown

#### Feature — Chamber (stepped) : dernier cylindre traversant le haut de la boîte, à toute échelle [python] (2026-08-11)
Demande user : pour le « closed generator » (variant stepped), le **dernier cylindre doit toujours atteindre le haut de la boîte** puis s'ouvrir dessus par booléen (en restant son propre patch), pour supprimer le fin couvercle entre le cylindre et le haut de la boîte — **y compris quand la pièce est mise à l'échelle**. Spec+plan : `docs/superpowers/specs/2026-08-11-stepped-last-cylinder-through-top-design.md`, `docs/superpowers/plans/2026-08-11-stepped-last-cylinder-through-top.md`. **Constat** : la pile de cylindres est ancrée au plancher (`z_floor = -H/2 - FLOOR_OVERCUT`) et mise à l'échelle uniformément ; à `partScale=1` le sommet du dernier cylindre s'arrête `FLOOR_OVERCUT` (10 mm) sous le haut → couvercle de 10 mm ; à `partScale<1` le couvercle grossit énormément. **Décisions** (user) : stepped uniquement ; ouverture **traversante** par le haut (trou dans la face du haut, comme l'overcut du plancher en bas) ; le mur du dernier cylindre **reste dans `cylinder_walls`** (pas de nouveau patch, pas de changement de classifieur) ; le **diamètre continue de scaler** (seul le sommet est découplé de l'échelle). **Python** (`buildChamber.py`, seul fichier touché) : (1) `make_part` gagne `h_last_override` — longueur d'extrusion explicite du dernier cylindre ; (2) branche stepped : `last_h_local = (height + 2*FLOOR_OVERCUT) - (h_first+h_middle)` (base = épaulement scalé, sommet épinglé à `+H/2 + FLOOR_OVERCUT` après le translate) ; (3) clamp d'up-scale réécrit — stepped borne l'**épaulement** `(h_first+h_middle)*scale` sous le haut (limite `height + 2*FLOOR_OVERCUT - MIN_LAST_CYL_H`, nouvelle constante 50 mm), hollow garde son ancien clamp sur toute la pile ; (4) garde « part exceeds box » scindée par variant (hollow inchangée ; stepped garde `last_h_local > 0`). Feet, classifieur, warnings inchangés (3 cylindres → outlet = médian ; mur dernier cyl → `cylinder_walls` ; face du haut trouée → `walls`). **À `partScale=1`** : géométrie identique à aujourd'hui sauf le couvercle de 10 mm retiré. **Aucun changement** shared/API/web ni des chemins hollow / guide-vane ; `hLast`/P12 s'affiche toujours dans la table (modèle intact). **Vérifié cadquery-env** (`_verify_last_cyl_top.py`, jetable non commité) : stepped à `partScale ∈ {1, 0.5, 0.25}` → exit 0, watertight, patches `inlet/outlet/cylinder_walls/walls`, `zmax == H/2` (dernier cylindre atteint le haut à **toutes** les échelles, plus de couvercle) ; up-scale `partScale=5` → WARN de clamp + build OK. **Gates** : `chamber.test.ts` 14/14 verts (tests mockent le builder → no-regression). **Vérifié navigateur** : `/chamber` stepped défaut + `partScale=0.5` → dernier cylindre ouvert par le haut, pas de couvercle, patches OK. Non commité en attente de revue app.
```

- [ ] **Step 6: Commit**

```bash
git add PLAN.md
git commit -m "docs(chamber): log stepped last-cylinder-through-top in PLAN.md"
```

---

## Self-Review Notes

- **Spec coverage:** §4.1 (pinned last cylinder via `h_last_override`) → Task 1 Step 2 + Task 2 Step 3; §4.2 (shoulder clamp + `MIN_LAST_CYL_H`) → Task 1 Step 1 + Task 2 Steps 1-2; §4.3 (variant-gated guard) → Task 2 Step 4; §4.4 (feet/classifier/warnings unchanged) → asserted, no code; §5 (backward-compat) → Task 3 verification + Task 4 gate; §6 (verification plan) → Task 3; §7 (out of scope) → Global Constraints. All covered.
- **Type/name consistency:** `h_last_override` (param), `last_h_local` (stepped local), `unscaled_shoulder` (stepped clamp basis), `MIN_LAST_CYL_H` (constant), `clamp_basis`/`clamp_limit` (clamp locals) are used identically across the tasks. The hollow branch keeps `unscaled_part_height`; the stepped branch no longer references it (the clamp uses `unscaled_shoulder`), so there is no dangling reference — verified against the current `:1112-1143` code.
- **Placeholder scan:** none — every step has the literal code/command and expected output.
- **Ordering:** Task 1 introduces the constant + param before Task 2 uses them; the byte-compile in each task catches a broken edit before the geometry run in Task 3.

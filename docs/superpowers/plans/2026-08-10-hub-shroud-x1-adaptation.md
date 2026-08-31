# Hub & Shroud X1-Driven Parametric Reshaping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mesh-remap hub/shroud construction in the guide-vane distributor with analytic meridional profiles: a 3-point hub polyline and an ellipse shroud fillet, both driven by X1 and `outletRatio`.

**Architecture:** Two pure-numeric functions compute the hub point radii and the shroud floor profile from the resolved rims; `make_vane_patches` builds surface-of-revolution meshes from them and returns the meridional profiles; `main()` revolves those profiles into the hub-core and shroud-casing solids for the boolean. The existing rims, clamp, parameter plumbing, blade prisms, boolean, and classification are unchanged. The old mesh-based path stays as the backward-compat fallback.

**Tech Stack:** Python (numpy, trimesh, scipy), run through the WSL venv `/home/hristo/cadquery-env/bin/python`. No JS/TS changes.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-10-hub-shroud-x1-adaptation-design.md` — every task implements part of it; re-read the relevant section before each task.
- **Toolchain is WSL-only.** All builds/tests run via `wsl -e bash -lc '... /home/hristo/cadquery-env/bin/python ...'`. WSL prints harmless `Failed to translate 'H:\bin'` lines — ignore. `npm`/`node` are WSL-only too.
- **Purge the build cache after every `buildChamber.py` change:** `rm -rf apps/api/storage/chamber/*` (builds are hashed on params; a stale hash masks a broken change).
- **`CHAMBER_DEBUG_DUMP=1`** makes `buildChamber.py` dump `_debug/` (`core.stl`, `casing.stl`, `F.stl`, `meta.json`, …) — the diagnostic surface the verify script reads.
- **Commit convention (per `HANDOVER.md`):** this repo does **NOT** commit per task. Each task ends at a verified **checkpoint** (run the test, confirm green). The whole feature is committed as **one batch after live app review + the user's explicit go-ahead**. Do not `git commit` builder changes mid-plan.
- **Baseline constants (asset space = absolute metres), measured from `guideVanes_walls.stl`** (spec §3): `R_hub0 = outletInnerR = 0.29573`, `R_shroud0 = outletOuterR = 0.65500`, `P1₀=(0.29548, 0.22608)`, `P2₀=(0.39274, 0.51575)`, `P3₀=(0.61465, 0.64565)`, `P3_ratio=0.93840`, ellipse `a/R=0.160`, `b/R=0.119`.
- **Rims unchanged:** `R_shroud_new = ro_target = X1/2` and `R_hub_new = ri_target = outletRatio·R_shroud_new`, both already resolved (and clamped) in `make_vane_patches` today.
- **Fallback:** the analytic path runs only when `outlet_outer_d is not None and outlet_ratio is not None`; otherwise the existing mesh path runs unchanged (byte-identical old geometry).

---

### Task 1: Pure hub-point radial function

**Files:**
- Modify: `apps/api/scripts/buildChamber.py` (add module constants near `VANE_OUTLET_SAFE_MARGIN`; add `_hub_point_radii` above `make_vane_patches` at line 369)
- Test: `apps/api/scripts/_test_hub_shroud_math.py` (create — standalone assert script, repo `_diag`/`_verify` idiom, exits 0/1)

**Interfaces:**
- Produces: `_hub_point_radii(R_hub_new, R_shroud_new, meta) -> (r_rim, r_p1, r_p2, r_p3)` — pure floats, radial only (z applied by the caller). Module constants `VANE_HUB_P1/P2/P3` (tuples `(r, z_asset)`), `VANE_P3_RATIO`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/scripts/_test_hub_shroud_math.py`:

```python
"""Standalone unit tests for the pure hub/shroud profile math in buildChamber.py.
Run: /home/hristo/cadquery-env/bin/python _test_hub_shroud_math.py  (exits 0/1)."""
import sys, json, os
import numpy as np
import buildChamber as B

meta = {"outletInnerR": 0.29573, "outletOuterR": 0.65500}
ok = True
def check(c, m):
    global ok; print(("OK  : " if c else "FAIL: ") + m); ok = ok and c

# 1) At baseline rims, the 3 points reproduce the measured baseline radii.
r_rim, p1, p2, p3 = B._hub_point_radii(0.29573, 0.65500, meta)
check(abs(r_rim - 0.29573) < 1e-9, "baseline rim == R_hub0")
check(abs(p1 - 0.29548) < 1e-9, "baseline P1 == 0.29548")
check(abs(p2 - 0.39274) < 1e-9, "baseline P2 == 0.39274")
check(abs(p3 - 0.61465) < 1e-6, "baseline P3 == 0.61465 (= 0.9384*R_shroud0)")

# 2) Move rule at X1=1800 (R_shroud=0.900), ratio 0.45 -> R_hub=0.405, dr=+0.10927.
r_rim, p1, p2, p3 = B._hub_point_radii(0.405, 0.900, meta)
dr = 0.405 - 0.29573
check(abs(r_rim - 0.405) < 1e-9, "rim tracks R_hub_new")
check(abs(p1 - (0.29548 + dr)) < 1e-9, "P1 moves full dr")
check(abs(p2 - (0.39274 + dr/2)) < 1e-9, "P2 moves half dr")
check(abs(p3 - 0.9384*0.900) < 1e-9, "P3 = P3_ratio * R_shroud_new (X1 only)")
check(p3 > p2 > p1, "monotonic at X1=1800")

print("ALL PASS" if ok else "SOME FAILED"); sys.exit(0 if ok else 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `wsl -e bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts && /home/hristo/cadquery-env/bin/python _test_hub_shroud_math.py'`
Expected: FAIL — `AttributeError: module 'buildChamber' has no attribute '_hub_point_radii'`.

- [ ] **Step 3: Add the constants + function**

In `buildChamber.py`, near the other `VANE_*` constants, add:

```python
# --- parametric hub/shroud baseline (spec 2026-08-10) ------------------------
# Hub meridional interior points (asset space = absolute metres), measured from
# guideVanes_walls.stl by RDP reduction (_diag_rdp.py). Each is (r, z_asset);
# z_asset maps to build z via the existing HLE map z = z_sb + z_asset*sz.
VANE_HUB_P1 = (0.29548, 0.22608)     # duct-top -> shoulder (tracks rim: duct vertical)
VANE_HUB_P2 = (0.39274, 0.51575)     # shoulder knee (half-rate)
VANE_HUB_P3 = (0.61465, 0.64565)     # roof break; z_asset == asset height -> lands at z_mid_top
VANE_P3_RATIO = 0.93840              # P3 r / outletOuterR: P3 tracks R_shroud (X1), ratio-independent
# Shroud floor fillet = axis-aligned ellipse; semi-axes as fractions of R_shroud
# (fit in _diag_shroudcurve.py). a = radial, b = vertical.
VANE_SHROUD_ELL_A = 0.160
VANE_SHROUD_ELL_B = 0.119
```

Above `make_vane_patches` (line 369), add:

```python
def _hub_point_radii(R_hub_new, R_shroud_new, meta):
    """Radial positions of the hub shoulder points under the X1/ratio rule
    (spec 2026-08-10 §4). Radial only; the caller applies z via the HLE map.
    P1 tracks the rim (full delta), P2 half, P3 proportional to R_shroud."""
    dr_hub = R_hub_new - meta["outletInnerR"]      # R_hub0 = asset inner rim (absolute)
    r_rim = R_hub_new
    r_p1 = VANE_HUB_P1[0] + dr_hub
    r_p2 = VANE_HUB_P2[0] + dr_hub / 2.0
    r_p3 = VANE_P3_RATIO * R_shroud_new
    return r_rim, r_p1, r_p2, r_p3
```

- [ ] **Step 4: Run test to verify it passes**

Run: `wsl -e bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts && /home/hristo/cadquery-env/bin/python _test_hub_shroud_math.py'`
Expected: `ALL PASS`, exit 0.

- [ ] **Step 5: Checkpoint** — test green; no commit (batch convention).

---

### Task 2: Pure shroud-ellipse floor profile

**Files:**
- Modify: `apps/api/scripts/buildChamber.py` (add `_shroud_fillet_profile` above `make_vane_patches`)
- Test: `apps/api/scripts/_test_hub_shroud_math.py` (extend)

**Interfaces:**
- Produces: `_shroud_fillet_profile(np, R_shroud_new, z_brim, r_wall, n=48) -> np.ndarray` of shape (n+2, 2) — meridional `(r, z)` from the inner rim up the quarter-ellipse to the brim, then one point out to `r_wall` at `z_brim`. The fillet bottom sits at `z_brim - b`.

- [ ] **Step 1: Write the failing test** (append before the final `print` in `_test_hub_shroud_math.py`)

```python
# --- shroud fillet ---
for Rs in (0.65500, 0.900, 1.10):
    prof = B._shroud_fillet_profile(np, Rs, z_brim=0.10, r_wall=1.6)
    r, z = prof[:, 0], prof[:, 1]
    a = r.max() - Rs                      # radial extent of the fillet (excl. brim run)
    # last point is the brim run to the wall; fillet top is the point before it
    r_fil, z_fil = r[:-1], z[:-1]
    a_fit = r_fil.max() - Rs
    b_fit = z_fil.max() - z_fil.min()
    check(abs(a_fit / Rs - 0.160) < 1e-6, "a/R_shroud == 0.160 (Rs=%.3f)" % Rs)
    check(abs(b_fit / Rs - 0.119) < 1e-6, "b/R_shroud == 0.119 (Rs=%.3f)" % Rs)
    check(r_fil[0] <= Rs + 1e-9 and abs(r_fil[0] - Rs) < 1e-9, "fillet starts at inner rim (Rs=%.3f)" % Rs)
    check(np.all(np.diff(z_fil) >= -1e-9), "fillet z monotone non-decreasing (Rs=%.3f)" % Rs)
    check(abs(z_fil[-1] - 0.10) < 1e-9, "fillet top at z_brim (Rs=%.3f)" % Rs)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `wsl -e bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts && /home/hristo/cadquery-env/bin/python _test_hub_shroud_math.py'`
Expected: FAIL — `_shroud_fillet_profile` undefined.

- [ ] **Step 3: Add the function**

```python
def _shroud_fillet_profile(np, R_shroud_new, z_brim, r_wall, n=48):
    """Shroud floor meridional (r, z): a quarter-ellipse fillet seated at the inner
    rim r=R_shroud_new (vertical tangent) rising to a horizontal tangent at the brim
    z=z_brim, then flat out to r_wall (spec 2026-08-10 §5). Semi-axes scale with
    R_shroud so R_curve/R_shroud is constant. Fillet bottom is at z_brim - b."""
    a = VANE_SHROUD_ELL_A * R_shroud_new     # radial
    b = VANE_SHROUD_ELL_B * R_shroud_new     # vertical
    cr, cz = R_shroud_new + a, z_brim - b     # ellipse centre: leftmost@rim, top@brim
    th = np.linspace(np.pi, np.pi / 2.0, n)   # pi -> leftmost (rim); pi/2 -> top (brim)
    r = cr + a * np.cos(th)                   # rim -> cr
    z = cz + b * np.sin(th)                   # (z_brim-b) -> z_brim
    prof = np.column_stack([r, z])
    return np.vstack([prof, [r_wall, z_brim]])   # flat brim run to the wall
```

- [ ] **Step 4: Run test to verify it passes**

Run: `wsl -e bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts && /home/hristo/cadquery-env/bin/python _test_hub_shroud_math.py'`
Expected: `ALL PASS`, exit 0.

- [ ] **Step 5: Checkpoint** — test green.

---

### Task 3: Wire the analytic hub into `make_vane_patches` + core solid

**Files:**
- Modify: `apps/api/scripts/buildChamber.py` — `make_vane_patches` (369–613): add the analytic hub branch; return the hub meridional profile. `main()` (1172–1175): revolve the analytic hub profile for `_core` when present.
- Test: build + `_verify_outlet_ratio.py` (extended in Task 5; for this task use the existing checks + a temporary radius print).

**Interfaces:**
- Consumes: `_hub_point_radii` (Task 1), rims `ri_target`/`ro_target`, `z_sb`, `sz` (all already in `make_vane_patches`).
- Produces: new return keys `"hub_profile"` (np.ndarray (r,z), the throat polyline rim→P1→P2→P3, **no** flat roof) and the existing `"hub"`/`"hub_throat"` now built analytically. `main()` revolves `"hub_profile"` into the core.

- [ ] **Step 1: Add a temporary radius assertion to the test harness**

In `_verify_outlet_ratio.py`, after the rim checks (line 40), add (reads meta fields Task 5 will emit; guard on presence so it's a no-op until then):

```python
if "hub_pts" in meta:
    hp = meta["hub_pts"]         # [r_rim, r_p1, r_p2, r_p3]
    mono = hp[0] <= hp[1] <= hp[2] <= hp[3]
    print("INFO: hub_pts=%s monotone=%s" % (["%.4f" % x for x in hp], mono))
```

- [ ] **Step 2: Build the analytic hub in `make_vane_patches`**

Replace the hub construction (currently lines ~523–532, the `place_throat(hub_walls)` + roof synthesis) with, guarded on the analytic path (`outlet_outer_d is not None and outlet_ratio is not None`):

```python
        analytic = outlet_outer_d is not None and outlet_ratio is not None
        if analytic:
            r_rim, r_p1, r_p2, r_p3 = _hub_point_radii(ri_target, ro_target, meta)
            if not (r_rim <= r_p1 <= r_p2 <= r_p3):
                print("WARNING: hub shoulder non-monotonic (X1 too large): "
                      "rim=%.4f P1=%.4f P2=%.4f P3=%.4f" % (r_rim, r_p1, r_p2, r_p3))
            def _z(z_asset):                       # HLE vertical map (z unchanged by X1)
                return z_sb + z_asset * sz
            z_rim = _z(0.05288)                    # asset inner-rim bottom
            hub_profile = np.array([
                [r_rim, z_rim],
                [r_p1, _z(VANE_HUB_P1[1])],
                [r_p2, _z(VANE_HUB_P2[1])],
                [r_p3, _z(VANE_HUB_P3[1])],
            ], dtype=float)
            _throat_top_r = r_p3
            # hub PATCH surface = throat polyline + flat roof out to the wall
            _hub_surface_prof = np.vstack([hub_profile, [d_last / 2.0, _z(VANE_HUB_P3[1])]])
            hub_mesh = _revolve_surface(np, trimesh, _hub_surface_prof, cx, cy)
            _throat = _revolve_surface(np, trimesh, hub_profile, cx, cy)
        else:
            # ---- existing mesh path (unchanged fallback) ----
            <existing lines 523-532 verbatim>
```

Add a small surface-of-revolution helper near `_revolve_profile` (636):

```python
def _revolve_surface(np, trimesh, profile_rz, cx, cy, sections=128):
    """Revolve an OPEN (r, z) polyline into a surface of revolution (not a solid),
    for use as a refinement/classification patch. Centred at (cx, cy)."""
    m = trimesh.creation.revolve(np.asarray(profile_rz, dtype=float),
                                 sections=sections, cap=False) \
        if False else _revolve_open(np, trimesh, profile_rz, cx, cy, sections)
    return m
```

(If `trimesh.creation.revolve` won't produce an open band cleanly, implement `_revolve_open` by lofting rings — mirror `_open_cylinder`'s triangation across consecutive profile points. Prefer whichever yields a watertight-when-ducted surface; verify in Step 4.)

- [ ] **Step 3: Return the profile + revolve the core analytically**

At the return dict (598–613) add `"hub_profile": hub_profile if analytic else None`.

In `main()` (1172–1175), when `vane_patches.get("hub_profile") is not None`, revolve the analytic closed profile for the core instead of `_hub_core_solid`:

```python
            if vane_patches.get("hub_profile") is not None:
                _hp = vane_patches["hub_profile"]
                _core_prof = ([(0.0, _hp[0, 1])] + [(r, z) for r, z in _hp]
                              + [(float(_hp[-1, 0]), z_mid_top), (0.0, z_mid_top)])
                _core = _revolve_profile(np, trimesh, _core_prof, target_x, target_y)
            else:
                _core = _hub_core_solid(np, trimesh, _hub_throat, target_x, target_y,
                                        z_top=z_mid_top)
```

- [ ] **Step 4: Build and verify**

```bash
wsl -e bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && rm -rf apps/api/storage/chamber/* && cd apps/api/scripts && printf "{\"guideVanes\":true,\"outletOuterD\":0.9,\"outletRatio\":0.45,\"x1\":1800}" > _p3.json && CHAMBER_DEBUG_DUMP=1 /home/hristo/cadquery-env/bin/python buildChamber.py _p3.json _t3 && /home/hristo/cadquery-env/bin/python _verify_outlet_ratio.py _t3 0.9 0.45'
```
Expected: `F watertight` OK, `F single connected component` OK, rim checks OK. (A real params JSON needs the full geometry inputs — use a known-good test JSON from the existing suite and add `outletOuterD`/`outletRatio`; the printf above is illustrative of the two new keys.)

- [ ] **Step 5: Checkpoint** — F watertight/1-component with the analytic hub; hub points land at Task-1 radii (INFO line). No commit.

---

### Task 4: Wire the analytic shroud + outlet cap + blade drape

**Files:**
- Modify: `apps/api/scripts/buildChamber.py` — `make_vane_patches`: analytic shroud floor (replace `place_throat(shroud_walls)` ~541, and the `shroud_floor_z` derivation 542–554); `main()`: revolve analytic shroud for `_casing` (1176–1177); outlet cap already a `_flat_annulus` between rims (1154–1155, unchanged).
- Test: build + `_verify_outlet_ratio.py`.

**Interfaces:**
- Consumes: `_shroud_fillet_profile` (Task 2), `ro_target`, `d_last`, `sz`, `z_sb`.
- Produces: return key `"shroud_profile"` (np.ndarray (r,z)); `"shroud"` mesh built analytically; `shroud_floor_z(r)` reads the analytic profile.

- [ ] **Step 1: Build the analytic shroud floor**

In the analytic branch, replace the shroud construction:

```python
            z_brim = z_sb + 0.09850 * sz                 # existing brim height (asset z)
            shroud_profile = _shroud_fillet_profile(np, ro_target, z_brim,
                                                     d_last / 2.0 + FLOOR_OVERCUT)
            shroud_placed = _revolve_surface(np, trimesh, shroud_profile, cx, cy)
            _rc_v = shroud_profile[:, 0]
            _zf_v = shroud_profile[:, 1]
            def shroud_floor_z(r):
                return np.interp(r, _rc_v, _zf_v)         # clamps outside the range
```

Leave the blade-drape block (556–577) unchanged — it already consumes `shroud_floor_z`.

- [ ] **Step 2: Return the profile + revolve the casing analytically**

Add `"shroud_profile": shroud_profile if analytic else None` to the return dict.

In `main()` (1176–1177):

```python
            if vane_patches.get("shroud_profile") is not None:
                _sp = vane_patches["shroud_profile"]
                z0c = z_duct_bottom
                _cas_prof = ([(float(_sp[0, 0]), z0c)]
                             + [(r, z) for r, z in _sp]
                             + [(float(_sp[-1, 0]), z0c)])
                _casing = _revolve_profile(np, trimesh, _cas_prof, target_x, target_y)
            else:
                _casing = _shroud_casing_solid(np, trimesh, vane_patches["shroud"],
                                               target_x, target_y, d_last)
```

- [ ] **Step 3: Build and verify (default + a high X1)**

```bash
wsl -e bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && rm -rf apps/api/storage/chamber/* && cd apps/api/scripts && CHAMBER_DEBUG_DUMP=1 /home/hristo/cadquery-env/bin/python buildChamber.py <good_tall_params_with_outletOuterD_0.9_ratio_0.45>.json _t4 && /home/hristo/cadquery-env/bin/python _verify_outlet_ratio.py _t4 0.9 0.45'
```
Expected: F watertight/1-component; shroud casing top contour monotone; no non-wetted cylinder_walls ring; hub owns inner duct wall.

- [ ] **Step 4: Eyeball the debug STLs**

Load `_t4/_debug/core.stl`, `casing.stl`, `F.stl` (reuse a `_diag_*` plot or `trimesh` show) — confirm the hub shoulder has the 3-point shape and the shroud fillet reads as an ellipse. Confirm no fold at default.

- [ ] **Step 5: Checkpoint** — analytic hub+shroud build clean at default and high X1.

---

### Task 5: Emit meta fields, extend the verification sweep, confirm fallback

**Files:**
- Modify: `apps/api/scripts/buildChamber.py` meta dump (1285–1290): add `hub_pts` and ellipse semi-axes.
- Modify: `apps/api/scripts/_verify_outlet_ratio.py`: assert `a/R_shroud`, `b/R_shroud` constant; hub points; fold WARNING where expected.
- Test: full sweep script `apps/api/scripts/_verify_hub_shroud_sweep.sh` (create) or extend `_verify_outlet_ratio.py` invocation across cases.

**Interfaces:**
- Consumes: everything above.
- Produces: `meta["hub_pts"] = [r_rim, r_p1, r_p2, r_p3]`, `meta["shroud_ell"] = [a, b]`.

- [ ] **Step 1: Emit the new meta fields**

In the `CHAMBER_DEBUG_DUMP` block (1285–1290), add to the dumped dict (compute `a`/`b` from `ro` and the ratios; `hub_pts` from `_hub_point_radii` or carry them out of `make_vane_patches` via return keys):

```python
                               "hub_pts": list(vane_patches.get("hub_pts", [])),
                               "shroud_ell": [VANE_SHROUD_ELL_A * vane_outlet_ro,
                                              VANE_SHROUD_ELL_B * vane_outlet_ro],
```

Add `"hub_pts": [r_rim, r_p1, r_p2, r_p3] if analytic else []` to the `make_vane_patches` return.

- [ ] **Step 2: Add the invariant checks to `_verify_outlet_ratio.py`**

```python
if "shroud_ell" in meta and expected_outer_d is not None:
    a, b = meta["shroud_ell"]
    check(abs(a / ro - 0.160) < 1e-6, "shroud a/R_shroud == 0.160 (got %.5f)" % (a / ro))
    check(abs(b / ro - 0.119) < 1e-6, "shroud b/R_shroud == 0.119 (got %.5f)" % (b / ro))
if "hub_pts" in meta and meta["hub_pts"]:
    hp = meta["hub_pts"]
    check(abs(hp[3] - 0.93840 * ro) < 1e-6, "P3 == 0.9384*R_shroud (got %.5f)" % hp[3])
```

- [ ] **Step 3: Run the sweep**

For each of tall/short/cone base params × ratio ∈ {0.35, 0.45, 0.50} × X1 ∈ {low, 1450, high}: build with `CHAMBER_DEBUG_DUMP=1` and run `_verify_outlet_ratio.py <dir> <X1/1000> <ratio>`. Assert every case prints `ALL PASS` **except** the deliberately-oversized X1 cases, which must print the fold `WARNING` (grep the build stdout).

Run (template — fill base params from the existing test JSONs):
```bash
wsl -e bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts && for r in 0.35 0.45 0.50; do for x1 in 0.9 1.45 2.3; do rm -rf ../storage/chamber/*; CHAMBER_DEBUG_DUMP=1 /home/hristo/cadquery-env/bin/python buildChamber.py <tall+outletOuterD=$x1+ratio=$r>.json _sw && /home/hristo/cadquery-env/bin/python _verify_outlet_ratio.py _sw $x1 $r; done; done'
```

- [ ] **Step 4: Confirm the fallback reproduces pre-feature geometry**

Build a tall case with **no** `outletOuterD`/`outletRatio` keys; assert `F.volume` matches the pre-feature value (≈88.79, per the 2026-08-06 verification) to within 0.01.

```bash
wsl -e bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts && rm -rf ../storage/chamber/*; CHAMBER_DEBUG_DUMP=1 /home/hristo/cadquery-env/bin/python buildChamber.py <tall_no_outlet_keys>.json _fb && /home/hristo/cadquery-env/bin/python -c "import trimesh; print(trimesh.load(\"_fb/_debug/F.stl\").volume)"'
```
Expected: ≈88.79.

- [ ] **Step 5: Run the JS gate + PLAN.md note**

```bash
wsl -e bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npx --workspace @dive/api vitest run chamber'
```
Expected: 31/31 chamber tests pass (they mock the builder; this confirms the plumbing still typechecks/runs).

Append a **French** note to the bottom of `PLAN.md` describing the change (repo convention, per `HANDOVER.md` §6), matching the existing entries' style.

- [ ] **Step 6: Checkpoint + handoff for live review**

Report the sweep results. **Do not commit** — surface to the user for live app review of the rendered GLB at default + extremes; batch-commit only on their explicit go-ahead.

---

## Self-Review

**Spec coverage:** §3 baseline constants → Task 1/2 constants. §4 hub rule → Task 1 (math) + Task 3 (wiring). §5 shroud ellipse → Task 2 + Task 4. §5.1 outlet cap/ducts → Task 4 (cap already `_flat_annulus`; ducts unchanged). §6 basis decisions → encoded in Task 1/2 formulas + z map. §7 backward-compat → Task 3/4 `analytic` guard + Task 5 Step 4. §8 verification → Task 5. §9 out-of-scope → no plumbing/model tasks. ✓ All sections covered.

**Placeholder scan:** The `<good_..._params>.json` / `<tall+...>` tokens are deliberate — the executor substitutes a real test-input JSON from the existing suite (the two new keys are the only additions); the pure-function code and the wiring code are complete. `_revolve_open` in Task 3 Step 2 is flagged as "implement if `trimesh.creation.revolve` won't cap-false cleanly" — the executor must verify the surface builder against a real build in Step 4 rather than assume.

**Type consistency:** `_hub_point_radii(R_hub_new, R_shroud_new, meta) -> (r_rim,r_p1,r_p2,r_p3)` used identically in Task 1 test, Task 3 wiring, Task 5 meta. `_shroud_fillet_profile(np, R_shroud_new, z_brim, r_wall, n)` used identically in Task 2 and Task 4. Return keys `hub_profile`/`shroud_profile`/`hub_pts` consumed in `main()` and the meta dump as defined. ✓

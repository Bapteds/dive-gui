# LID ITERATION KIT — free surface for rigid-lid simpleFoam chamber models by remeshing the lid

Extracted 2026-09-29 from the lid iterations of September 2026 (bigger spiral flooded cone, 2 iterations 34 → 5.2 → 2.6 mm;
solid cone, 1 iteration 32 → 2.0 mm; VIE validation chamber, 1 iteration 42 → 4.5 mm) and made geometry-agnostic: every
step works on the multi-solid ASCII STL and the OpenFOAM case, no parametric builder is needed.

## Method (fixed-point iteration on the lid shape, REMESH each time)
1. **Surface estimate** from a converged run with a rigid lid (`atmosphere` patch, slip):
   `z_s(x,y) = Z_LID + (p_lid − p0_inlet) / g`, p kinematic, p0_inlet = area mean of (p + |U|²/2) on the inlet = the
   head-water total head. Exact for any lid shape (p on the lid is piezometric, the velocity head cancels, no anchor
   point). Works for the flowRate-inlet family and the totalPressure family (there p0_inlet ≈ 0).
2. **Fit the lid**: the flat base STL is rebuilt with the `atmosphere` patch as the height field z_s (Gaussian-smoothed,
   radius `smooth`), boundary edges ≤ `sub`, interior points at `steiner` spacing, conformal Delaunay. Every other vertex
   on the lid plane follows z_s (wall tops, shell/cone top rings), roofs stay and get a vertical **upstand**; submerged
   horizontal tops (a cap 61 mm under the lid) are kept under ≥ `tmin` of water (the lid is clamped there — the exposed-cap
   shoreline treatment of the 2026-09-09 bigger-spiral builder is NOT generic and is not in the kit, see Limitations).
3. **Mesh** the new STL with the unchanged meshDict of the parent mesh (cfMesh: surfaceFeatureEdges 45°, cartesianMesh,
   checkMesh). Gate: no negative volumes; on failure `improveMeshQuality` is tried once (that fixed the 2026-09-23 case).
4. **Run** a clone of the parent case (same BCs, numerics, function objects) on the new mesh, then export the lid
   (`postProcess -func lidSurfaces`).
5. Back to 1. **Converged** when the lid residual RMS |z_s(new) − z_lid(mesh)| < `tol_rms_mm` (a few mm). Δp₀ typically
   changes < 1 %; the point of the exercise is the surface shape (drawdown next to the machine, exposure of a cap).

## Files
| file | what |
|---|---|
| `lidkit.py` | driver: `init / check / surface / fit / mesh / case / run / next / loop / status / post` (see `--help` text at the top) |
| `lidkit_surface.py` | step 1: lidSurfaces export → `zs_iter<k>.npy` (x, y, z_s, area) + `.json` (statistics, ring sectors, lid residual) |
| `lidkit_fitlid.py` | step 2: base flat STL + zs.npy → fitted STL (+ report json + check figure); `--flat` = regression test |
| `lidkit_post.py` | figure per iteration: mesh lid, new z_s, residual map, history, ring sector profiles |
| `templates/lidSurfaces` | the `surfaces` function object that exports lid + inlet (patch names substituted from the config) |
| `templates/Allrun.sh` | one-iteration case run (MESHSRC env → renumber, potentialFoam, decompose, simpleFoam, reconstruct, lidSurfaces) |
| `templates/config_template.json` | config skeleton (`lidkit.py init my.json`) |
| `examples/Version4_lidIter_config.json` | ready config for the final design Version 4 (reference run @983) |
| `vtk_reader.py` | legacy-VTK reader (copy of tools/inflowQuality/vtk_reader.py) — the kit is self-contained |

## How to apply it to a geometry
Prerequisites: a converged rigid-lid simpleFoam case (0.orig, system, constant, a written time dir), its flat-lid
domain STL (multi-solid ASCII; the lid solid = `atmosphere_patch`, the inlet solid = `inlet_patch`, lid plane at
`z_lid`), and the cfMesh mesh directory that produced its mesh (`system/meshDict` etc. are reused unchanged).
```bash
K=/home/hristo/GreenPowerDesign/Chamber/tools/lidIterationKit
python3 $K/lidkit.py init  my_lidIter.json         # edit the paths / z_lid / patch names / axis+rings (optional)
python3 $K/lidkit.py check my_lidIter.json         # validates everything, tells you if the parent needs a lid export
python3 $K/lidkit.py surface my_lidIter.json 0     # z_s from the parent (exports the lid if needed) -> work_dir/zs_iter0.{npy,json}
python3 $K/lidkit.py fit     my_lidIter.json 0     # -> work_dir/geometry/domain_lidIter1.{stl,json,png}  (inspect the png!)
python3 $K/lidkit.py mesh    my_lidIter.json 1     # blocking, minutes; prints cells / skew / negative-volume gate
python3 $K/lidkit.py case    my_lidIter.json 1     # work_dir/iter1 (clone of the parent, kit Allrun, lidSurfaces FO)
python3 $K/lidkit.py run     my_lidIter.json 1     # detached; when log.Allrun says Done.:
python3 $K/lidkit.py surface my_lidIter.json 1     # residual after iteration 1 -> repeat fit/mesh/case/run with k = 1
python3 $K/lidkit.py post    my_lidIter.json 1     # figure + json
python3 $K/lidkit.py status  my_lidIter.json       # table: state, last time, dp0, cells, z_s, residual per iteration
```
`lidkit.py next <cfg> <k>` does surface → fit → mesh → case → run for one step; `lidkit.py loop <cfg> [k0]` runs the
whole iteration detached until `tol_rms_mm` or `max_iter` (log `work_dir/log.lidkit_loop`). Do not start a loop while
another simulation uses the machine (rule of 2026-09-23). Each iteration costs one mesh (5–10 min) + one solve (~1 h).

## Config keys
`z_lid` lid plane height of the base STL; `atmosphere_patch`, `inlet_patch`; `base_stl` ALWAYS the flat original (the
fit is a height field over the unchanged planform, never fit a fitted STL); `parent_case`; `mesh_template` (dir with
`system/{controlDict,fvSchemes,fvSolution,meshDict}`); `work_dir` (iter<k>/, zs files, geometry/, figures) and
`mesh_root` (mesh dirs `<mesh_root><k>`); `smooth` 0.10 m Gaussian radius (0.05 keeps sharper dips, VIE note);
`tmin` 0.02 m minimum water over submerged tops (≈ one cell of the cap-gap refinement; 15 mm gave feather-edge skew);
`sub`/`steiner`/`clear` lid triangulation (8 / 7 / 8 cm; clear > sub/2 keeps the Delaunay conformal); `upstand_patch`
(atmosphere = the surface falling off the roof edge is a free surface); `tol_rms_mm`, `max_iter`; `improve_mesh_on_fail`;
`axis` [x,y] + `rings` [[r0,r1],…] for sector statistics; `datum_y` (mean z_s over y < datum_y as the level datum, VIE
style); `openfoam_bashrc`.

## Validation against the bespoke lid iteration — SOLID CONE (2026-09-29, one iteration, NOT solved by user decision)
Same parent run (`case/10_BiggerSpiral_CorrectHLE/BiggerSpiralSolidCone_fine_lidIter_CorrectHLE/iter0` @237), same meshDict;
kit output in `case/10_BiggerSpiral_CorrectHLE/BiggerSpiralSolidCone_KIT_lidIter/` + `mesh/10_BiggerSpiral_CorrectHLE/BiggerSpiralSolidCone_KIT_lidIter1`,
config `examples/SolidCone_lidIter_KIT_config.json`.
| item | bespoke builder (2026-09-10) | kit |
|---|---|---|
| z_s from the parent | zs_iter0 | identical (max diff 0.000 mm) |
| fitted lid | 13 573 faces, z −71…−4 mm | 13 575 faces, same range, RMS difference 0.17 mm (max 1.5 mm) on matched faces |
| cone top ring (391 vertices) | 1.4129…1.4806 | 1.4130…1.4806 |
| STL audit open / non-manifold | 42 / 0 | 42 / 0 |
| mesh | 4 866 866 cells, 1 region, skew 4.66 on 1 face, non-ortho max 87.5°, Failed 1 (skewness) | **4 866 865 cells, 1 region, skew 4.10 on 1 face, non-ortho max 86.4°, Failed 1 (skewness)**; every patch has the identical face count |
→ on a geometry the bespoke script handled completely, the kit reproduces lid, topology and mesh quality. The solve (bespoke:
residual 32 → 2.0 mm, Δp₀ 2842 Pa) was not repeated (user: "do not solve anything").

## Version 4 (2026-09-29): correct surface, mesh NOT usable — the two non-generic treatments matter here
`examples/Version4_lidIter_config.json`, work dirs `case/05_BigSpiral_CorrectHLE/BigSpiralHandoff160_lidIter/` +
`mesh/05_BigSpiral_CorrectHLE/BigSpiralHandoff160_lidIter1/` (README_STATUS.md there). Fit OK (0 open edges, cap clamped),
but cartesianMesh took 25 min (flat parent 6.5) and FAILED 6 checks: 6.98 M cells, 10 open cells, 5 negative volumes, 181 non-ortho
errors, 59 inverted pyramids, 1159 skew faces; `improveMeshQuality` did not converge (killed after 14 min). Located with `checkMesh -writeSets vtk`:
99 % of the skew / zero-area / inverted faces sit in the cap ring r 1.39–1.54, z 1.42–1.44 (the 20 mm clamp film and its edge step), ALL
open cells sit at the plank/lid corners (az 204–211°). Same failure classes the
bespoke bigger-spiral iteration met before it (a) CUT THE PLANK at the lid (open cells at the plank/wall lid corners) and (b) held
the lid at cap + T_MIN on the whole shoreline with rim cliffs (skew on the cap shoreline). Version 4 has both features (plank to
z 1.55 through the lid, cap 61 mm under a −95…−111 mm dip) → the kit needs those two generalisations before it can do Version 4.

## Verified on Version 4 geometry construction (2026-09-29, first pass in scratch)
- `--flat` regression on the Version 4 domain: lid reproduced flat, 0 upstands, 0 clamped points, audit identical to the
  base (0 open / 252 non-manifold = the delivered casing's conformal triple junction).
- Fit from the reference run @983: lid 14 498 faces, z −102…−1 mm, 372 lid points clamped over the cap (−41 mm =
  1.424 + 20 mm; the rigid-lid dip of −95…−111 mm would expose ~9 % of the cap), 162 upstand facets along the roof edge
  y = −1.75, audit 0 open edges. **Meshability NOT yet verified**: the cfMesh test with the unchanged Version 4 meshDict
  was stopped by the user (machine needed elsewhere, 2026-09-29) while cartesianMesh was untangling the surface (13–17 bad
  faces per iteration, the reference mesh log shows the same class of warnings: 15 → 0). First thing to do when the machine
  is free and the user agrees: `lidkit.py mesh examples/Version4_lidIter_config.json 1` (after `surface 0` + `fit 0`),
  read cells / skew / negative volumes, then decide on the run.
- Driver chain check → surface 0 → fit 0 → case 1 → post 0 → status works; `examples/Version4_lidIter_config.json`.

## Limitations / next steps
- **Exposed tops (shoreline) are not modelled**: where z_s < z_top + tmin over a submerged horizontal top the lid is held
  at z_top + tmin (a thin water layer stays over the cap) and the count is reported (`clamped_lid_points`). The
  2026-09-09 bigger-spiral builder removed the cap facets there, lowered the shell tops to z_s and added cliffs — that
  needs knowledge of the casing rings (126 delivered stations) and is left geometry-specific
  (`Geometry/Correct HLE/Bigger spiral/semi_spiral_enclosed_freesurface_2026-09-09/build_bigger_enclosed_freesurface.py`).
- The flat regression test must be run with `--no-cut` when the domain has protruding solids (with the cut, a flat lid
  still cuts the plank at Z_LID, which is a different, valid geometry).
- Facets sharing a subdivided lid edge are split as fans (long slivers on tall walls / a wide roof); cfMesh only uses the
  surface for octree refinement, projection and feature edges, so they are harmless, but the STL looks ugly.
- **Plank cut = generic (added 2026-09-29):** every vertical-walled solid poking through the lid plane is cut at the fitted
  surface (`cut_component`): its footprint (plane section at Z_LID, corner-simplified) becomes a hole in the lid whose
  stations (corners, planform crossings, facet-edge crossings, fill ≤ `sub`) are SHARED with the new top edge of the
  vertical faces; facets above the surface are dropped, no roof is added (the interior above the cut is outside the
  fluid), footprint parts outside the planform are cut at the extrapolated surface. `"cut": false` / `--no-cut` = old
  behaviour. Non-vertical protruding facets abort with a message (a sloped protrusion needs a true surface/surface cut).
  Verified on Version 4: plank (28 facets) → 47, hole of 25 stations, lid conformal; the 11 extra open edges are the
  slab's cut top inside the nose wall and the nose-wall top segment buried in the slab (both outside the fluid, as the
  bespoke build's verified leftovers). If open cells still appear at plank/wall corners, add the 6 mm boxes described in
  the 2026-09-09 builder's README to the meshDict.
- Only `atmosphere`-type flat lids at one height are supported (no sloped or stepped lids as input).

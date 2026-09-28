# Playbook: Change the chamber geometry (`buildChamber.py`)

> When to use: any edit to `apps/api/scripts/buildChamber.py`, its constants or its assets (`apps/api/scripts/assets/`), or `mirrorStep.py`: shapes, patch classification, refusals, warnings, exports · Related: `brain/features/chamber-creation.md` (§3.7 to §3.9, §4.3 to §4.5, §5.1, §10), `brain/codemap/api-scripts.md`, `brain/conventions/vocabulary.md` §1 and §3, `apps/api/scripts/AGENTS.md`, `brain/conventions/testing.md` §2 and §3, `add-chamber-input-or-parameter.md` (when the change needs a new input) · Updated: 2026-09-28

## Before you start
- Read `brain/features/chamber-creation.md` §3.8 (refusals vs warnings), §3.9 (patches) and §4.3 (build sequence), then the `buildChamber.py` section of `brain/codemap/api-scripts.md`.
- **Spec first**: every geometry change since 2026-08 has one. Write `brain/specs/YYYY-MM-DD-<topic>-design.md` (goal, changes, out of scope, tests, status `approved` once the user validates), plus a plan in `brain/plans/` for a large change.
- Settle with the user (one question at a time):
  - refusal (`KO:`, build blocked) or warning (build delivered with a note)? House rule: **refuse rather than shrink**; borderline but valid cases are warnings;
  - does the patch list change? Patch names are an OpenFOAM and Meshing contract (`inlet`, `outlet`, `cylinder_walls`, `walls`, `hub`, `shroud`, `guide_vanes`);
  - is a change of existing geometry intended (then GOLDEN volumes move on purpose)?
- Find a CadQuery interpreter. Baptiste's Windows Python has no CadQuery; the co-developer's WSL venv is `/home/hristo/cadquery-env` (check the path on the machine, `brain/STATUS.md` §3); the CI job `geometry` is the authority.

## Steps
1. **Failing test first** in `apps/api/scripts/tests/test_build_chamber.py`, through the session fixture `build(name, params_override={...}, step=False)` (`conftest.py`, one real build per combination). Models to copy:
   - refusal: `test_part_wider_than_box_is_refused` (exit 1, `KO:` in stderr, the lever named in the message);
   - geometry effect: `test_feet_toggle_carves_the_foot_voids` (volume delta), `test_simplify_generator_pierces_the_box_top_without_a_dome` (`_section_loop_count` at a height);
   - patch assignment: `test_vane_skin_stays_on_the_guide_vanes_patch`.
2. **Edit `buildChamber.py`** following its own patterns:
   - **Reading params** (metres): a new key is read with `P.get("key", default)` or `num_opt("key")`, the default reproducing the previous behaviour. Never `num("key")` for a new key: the API re-feeds the cached `params.json` of existing builds to the builder on the first STEP download (`generateStep` in `apps/api/src/modules/chamber/chamber.service.ts` passes `paths.params` with `--step`), so a mandatory new key crashes old vane builds.
   - **Constants** live in the "fixed builder configuration" block at the top. `RATIO_D_FIRST_OVER_LAST` / `RATIO_D_MIDDLE_OVER_LAST` duplicate `CHAMBER_D_FIRST_OVER_LAST` / `CHAMBER_D_MIDDLE_OVER_LAST` of `@dive/shared`: change both or neither.
   - **Refusal**: `raise ValueError("<what is wrong> ... <the lever to change>")`, validated before the expensive booleans (see the common validation block in `main()`). `main()` turns any exception into `KO: <message>` on stderr + exit 1; the API answers 502 `CHAMBER_BUILD_FAILED` and the page shows the text verbatim in "Build errors".
   - **Warning**: `print("WARNING: ...")` on stdout or `sys.stderr.write("WARN: ...\n")`. The API collects lines matching `^WARN(?:ING)?:\s*(.+)$` (`extractBuilderWarnings`), persists them in `warnings.json` and replays them on cache hits.
   - **Patches**: BREP builds are split by `classify()` (inlet = min-Y plane, stepped `outlet` = median-z cylinder, pocket faces = `cylinder_walls`, the rest = `walls`); vane builds label `fluid_F` triangles with `_label_by_nearest_source`, then deterministic overrides, and `_blade_skin_mask` runs **last** (fix of 2026-09-04). A new patch needs an entry in `PATCH_TYPES` (and `PATCH_ORDER` for the BREP path); it then flows into `manifest.json`, the GLB nodes and `trisurface.zip` (`<patch>.stl`). Never rename an existing patch.
   - **Artifacts**: write `<final>.tmp` then `os.replace()`; `chamber.glb` is promoted **last**, just before `OK:` (it marks the cache entry complete). Vane builds write `exports/chamber.step` only with `--step`; vane-less builds always write it.
   - **Heavy imports** (`cadquery`, `trimesh`, `OCP`, `scipy`, `manifold3d`) stay inside `main()`; a new dependency goes into `requirements-geometry.txt` (and `requirements.txt`, which already misses `scipy`, K8).
   - **Debug**: `CHAMBER_DEBUG_DUMP=1` (vane builds) dumps `<outDir>/_debug/` (`core.stl`, `casing.stl`, `F.stl`, `hub_source.stl`, `meta.json`...), read by `_verify_outlet_ratio.py`; `CHAMBER_STEP_DEBUG=1` prints `STEPDBG` traces of the STEP pass.
3. **Message texts are locked in three places**: `test_build_chamber.py` assertions, the fake runners of `apps/api/tests/chamber.test.ts` (`warningRunner`) and `apps/web/src/features/chamber/ChamberBuildWarnings.test.tsx`. Reword all three together. The builder still says "box" and "cylinder shoulder": do not sweep the vocabulary unasked.
4. **GOLDEN volumes** (`GOLDEN` in `test_build_chamber.py`, `VOL_RTOL = 5e-3`): if the geometry change is intended, run the suite, take the new `stl.volume`, update the value in the same commit and state it in the changelog. An unexpected drift is a bug, not a golden to refresh. A bump of `requirements-geometry.txt` may also shift them (refresh in the bump commit). Patch lists: `STEPPED_PATCHES`, `VANE_PATCHES`.
5. **New fixture** (optional): `apps/api/scripts/tests/params/<name>.json` is a copy of a real cached `apps/api/storage/chamber/<hash>/params.json` (metres, all keys), added to `GOLDEN`. Known gap: no With cone fixture without vanes.
6. **API side**: nothing to do unless the artifact contract changes. `chamber.test.ts` never runs Python: its fakes (`successRunner`, `vaneRunner`, `warningRunner`, `MANIFEST`) write the files the real builder would. Update them only if file names, manifest shape, `build-meta.json` or the `--step` policy change. A new builder param is an input change: follow `add-chamber-input-or-parameter.md`.
7. **Purge the dev cache (MANDATORY)**: the hash covers parameters, not code, so an old geometry would be served under the same hash (K29). Bash: `rm -rf apps/api/storage/chamber/*`; PowerShell: `Remove-Item -Recurse -Force apps/api/storage/chamber/*`. After deployment, purge `<STORAGE_DIR>/chamber/` on the server too. Record the purge in the changelog.

## Verify
- Geometry suite with the CadQuery interpreter: `pytest apps/api/scripts/tests -q` (29 tests, about 5 min on WSL; each build has a 600 s timeout). WSL example: `wsl bash -lc 'cd /mnt/c/<path>/dive-gui/apps/api/scripts && /home/hristo/cadquery-env/bin/python -m pytest tests -q'`. One case: `-k <test_name>`. Green = all passed; "skipped" means CadQuery was not importable and proves nothing.
- CI job `geometry` (`.github/workflows/ci.yml`: Python 3.12, `pip install -r apps/api/scripts/requirements-geometry.txt`, `pytest apps/api/scripts/tests -v`) must pass on the PR.
- API side touched: `npm run build:shared && cd apps/api && npx vitest run tests/chamber.test.ts tests/meshing.test.ts`. Warning texts touched: `cd apps/web && npx vitest run src/features/chamber`.
- Manual, after the purge: `npm run dev`, Generate in `/chamber` for both designs with and without guide vanes, check the viewer patch table, download STL / STEP / triSurface, and "Send to Meshing".

## Update the brain
- [ ] Changelog entry: spec reference, pytest result (or "not run: no CadQuery on this machine, CI authoritative"), GOLDEN changes, cache purge done.
- [ ] `brain/features/chamber-creation.md`: §3.8 refusals/warnings, §3.9 patches, §4.3 to §4.5 build and artifacts, §7 tests.
- [ ] `brain/codemap/api-scripts.md` (`buildChamber.py`, tests) and `brain/codemap/api-tests.md` if fakes changed, then `python brain/codemap/build-index.py`.
- [ ] `brain/known-issues.md` §6 / §7 (K8, K11, K13, the "outlet" question) when addressed; spec status set to implemented.

## Pitfalls
- Forgetting the purge: the UI keeps showing the old geometry and you debug a change that is not running.
- `num("newKey")`: old cached builds fail on their first STEP download.
- **"outlet" = the fluid exit**, never the middle cylinder (`vocabulary.md` §1). Yet stepped builds without vanes label the middle cylinder wall `outlet`, and With cone builds without vanes have no `outlet` at all: an open question with the user (`known-issues.md` §6). Do not "fix" it inside an unrelated change.
- Renaming a patch breaks meshing sessions: `addStlFiles` overwrites surfaces by name and keeps the old ones, and per-patch meshing settings are keyed by name.
- Stale docs in the code: the docstring of `buildChamber.py` (CLI usage without `[--step]`, four patches only) and of `test_build_chamber.py` ("hollow fit-to-box clamp"), plus the `partScale` comments in `chamber.schemas.ts` / `resolveGeometryParams`, still describe shrinking. Refusal is the rule since 2026-08-31.
- Vane builds: `edges.bin` is empty and `nFaces` counts triangles (K13); the viewer computes edges itself.
- **K11**: `--step` without `outletOuterD` / `outletRatio` (very old params) always yields a vane-less STEP.
- A STEP must never fail a build: the vane STEP falls back to the vane-less solid with a `WARN:` and `stepHasVanes: false`.
- Anything the Windows workstation cannot run (CadQuery) is written "to validate" in the changelog, never reported as passed.

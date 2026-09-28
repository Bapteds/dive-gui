# Zone rules: `apps/api/scripts` (Python tools)

> Loaded automatically when working in `apps/api/scripts/`. Complements the root and `apps/api` rules.
> Deep references: `brain/codemap/api-scripts.md`, `brain/features/chamber-creation.md`, `brain/conventions/vocabulary.md`.

## Contract of every script
- Standalone CLI invoked by the API with a real argv (`execFile` / `spawn`), never through a shell.
- Success: a line starting with `OK:` on stdout, exit 0. Failure: `KO:` on stderr, exit 1. Usage error: exit 2. Warnings: `WARNING:` (stdout) / `WARN:` (stderr) lines, collected by the API.
- Heavy imports (`vtk`, `pyvista`, `trimesh`, `cadquery`, `h5py`) go INSIDE `main()`, after argument parsing. Full header docstring: purpose, CLI usage, dependencies, contract.
- Write outputs atomically (`.tmp` then `os.replace`); for chamber builds `chamber.glb` is promoted last because it marks the cache entry as complete.
- Interpreters are separate on purpose: `CGNS_PYTHON_BIN` (python3 + `vtk` wheel, never `pvpython`), `MESH_PYTHON_BIN` (pyvista/trimesh/numpy/h5py), `CHAMBER_PYTHON_BIN` (CadQuery), `PVBATCH_BIN` (export, under `xvfb-run`). Add new dependencies to the right `requirements*.txt` (`scipy` is missing from `requirements.txt`, K8).

## `buildChamber.py` (chamber geometry)
- **After ANY change: purge `apps/api/storage/chamber/*`**. The cache is keyed on parameters, not on code.
- Run the real geometry suite with the CadQuery interpreter: `pytest apps/api/scripts/tests -q` (several minutes; CI job `geometry` is the authority). GOLDEN volumes change only on purpose: say so in the changelog.
- Refuse rather than shrink: a part that does not fit is a refusal (`KO:`), never a silent resize. Borderline cases are warnings.
- Patch names are an OpenFOAM contract (`inlet`, `outlet`, `hub`, `shroud`, `guide_vanes`, `cylinder_walls`, `walls`…): renaming one breaks meshing setups. Visible renames are display-only (`brain/conventions/vocabulary.md`); "outlet" means the flow outlet.
- Debug: `CHAMBER_DEBUG_DUMP=1` writes `core.stl`, `casing.stl`, `meta.json`… into `<outDir>/_debug/`.
- Anything that needs the real OpenFOAM, ParaView or h5py stack and cannot run locally is flagged "to validate on the Debian server" in the changelog.

## Playbooks
`brain/playbooks/change-chamber-geometry.md`, `add-chamber-input-or-parameter.md`, `integrate-external-tool.md`.

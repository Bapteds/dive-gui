#!/usr/bin/env pvbatch
"""OpenFOAM (solved case) -> CGNS for Ansys CFD-Post. Run with ParaView pvbatch.
Usage: pvbatch FoamToCgns.py <case.foam> <out.cgns> [time|all] [field1,field2,...]

  time = a number pins that time; "all" writes the WHOLE time series (one CGNS
  per step, <out>_<i>.cgns); omitted/empty = the latest time only.

Why pvbatch (and NOT python3 + the standalone VTK wheel):
  Writing CGNS is a ParaView-only capability. Core VTK ships a CGNS *reader*
  (vtkCGNSReader) but NO CGNS writer, so the conversion must go through ParaView
  (pvbatch / paraview.simple). The reverse direction (CGNS -> VTK) uses raw VTK
  precisely because it has no writer dependency; this direction cannot.

Headless note:
  Importing paraview.simple instantiates a rendering pipeline controller that
  SEGFAULTS on a server with no GL context (a ParaView build without OSMesa) —
  even before this script runs, and even with --force-offscreen-rendering. The
  backend therefore launches this under `xvfb-run -a` (a virtual X display) by
  default; install it with `apt install xvfb`. If your pvbatch has working
  offscreen GL (OSMesa), set PVBATCH_XVFB=false to use --force-offscreen-rendering
  instead. This script itself creates NO view.

What it does, per the CFD-Post pipeline spec:
  * reads the OpenFOAM case at its LATEST time directory (the solved results);
  * keeps data at CELL CENTRES (no cell->point interpolation/smoothing);
  * keeps polyhedra un-tessellated when possible;
  * writes CGNS in ADF encoding (UseHDF5=0), the most CFD-Post-friendly.

Success/failure contract (mirrors CgnsToVtk.py / extractPatches.py):
  * On success: print a line starting with "OK:" to stdout and exit 0.
  * On failure: print a line starting with "KO:" to stderr and exit 1.
  * On a usage error (wrong argc): print usage to stderr and exit 2.
"""

import os
import sys


def _set_if_present(proxy, names, value):
    """Set the first existing property among `names` to `value` (best-effort).

    ParaView reader property names drift between versions (e.g. the cell->point
    toggle has been `Createcelltopointfiltereddata`), so we try a few and ignore
    the ones this build does not expose. Returns the name that was set, or None.
    """
    available = set()
    try:
        available = {p.GetXMLName() for p in proxy.ListProperties()} if hasattr(
            proxy, "ListProperties"
        ) else set(proxy.ListProperties())
    except Exception:  # noqa: BLE001 - introspection is best-effort.
        available = set()
    for name in names:
        if name in available or hasattr(proxy, name):
            try:
                setattr(proxy, name, value)
                return name
            except Exception:  # noqa: BLE001 - try the next candidate.
                continue
    return None


def main():
    if len(sys.argv) < 3:
        sys.stderr.write(
            "usage: pvbatch FoamToCgns.py <case.foam> <out.cgns> [time] [fields]\n"
        )
        sys.exit(2)

    foam = os.path.abspath(sys.argv[1])
    out = os.path.abspath(sys.argv[2])
    want_time = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
    want_fields = (
        [f for f in sys.argv[4].split(",") if f] if len(sys.argv) > 4 and sys.argv[4] else None
    )

    if not os.path.isfile(foam):
        sys.stderr.write("KO: .foam pointer file not found: %s\n" % foam)
        sys.exit(1)

    try:
        from paraview.simple import OpenFOAMReader, SaveData, Delete
    except ImportError as exc:
        sys.stderr.write(
            "KO: run this with ParaView pvbatch (paraview.simple unavailable): %s\n" % exc
        )
        sys.exit(1)

    try:
        reader = OpenFOAMReader(FileName=foam)

        # Keep the data at cell centres: do NOT create interpolated point data.
        _set_if_present(reader, ["Createcelltopointfiltereddata", "CreateCellToPoint"], 0)
        # Keep arbitrary polyhedra whole (CFD-Post handles them; tessellation loses
        # the original topology). Best-effort: the toggle name varies / may absent.
        _set_if_present(reader, ["Decomposepolyhedra", "DecomposePolyhedra"], 0)

        # First pass: this populates TimestepValues AND the reader's list of
        # AVAILABLE cell/point arrays.
        reader.UpdatePipeline()

        # Enable ALL available cell arrays so the solution fields are written.
        # CRITICAL: only set the selection when the available list is NON-EMPTY.
        # Setting `reader.CellArrays = []` DISABLES every array — that is what
        # produced mesh-only CGNS files. When the list comes back empty, leave the
        # reader's defaults untouched (they read all arrays).
        try:
            avail_cells = list(reader.CellArrays.Available)
        except Exception:  # noqa: BLE001
            avail_cells = []
        try:
            avail_points = list(reader.PointArrays.Available)
        except Exception:  # noqa: BLE001
            avail_points = []
        if avail_cells:
            reader.CellArrays = avail_cells
        sys.stderr.write(
            "[diag] available cell arrays: %s\n[diag] available point arrays: %s\n"
            % (",".join(avail_cells) or "(none)", ",".join(avail_points) or "(none)")
        )

        # Time selection. `want_time == "all"` writes the WHOLE series (one CGNS
        # per time step, FileName_<i>.cgns — ParaView's CGNS writer cannot put a
        # transient series in one file); a number pins that time; otherwise the
        # latest. We always read the latest once first to validate the fields.
        times = list(getattr(reader, "TimestepValues", []) or [])
        all_times = want_time is not None and want_time.strip().lower() == "all"
        if all_times:
            target = times[-1] if times else 0.0
        elif want_time is not None:
            try:
                target = float(want_time)
            except ValueError:
                target = times[-1] if times else 0.0
        else:
            target = times[-1] if times else 0.0
        reader.UpdatePipeline(target)

        # Guard + diagnostics: report exactly what landed in the output, and fail
        # loudly on a mesh-only result instead of writing a useless CGNS.
        try:
            cell_names = [a.Name for a in reader.CellData]
            point_names = [a.Name for a in reader.PointData]
        except Exception:  # noqa: BLE001 - introspection is best-effort.
            cell_names, point_names = [], []
        sys.stderr.write(
            "[diag] OUTPUT cell data: %s\n[diag] OUTPUT point data: %s\n"
            % (",".join(cell_names) or "(none)", ",".join(point_names) or "(none)")
        )
        if not cell_names and not point_names:
            sys.stderr.write(
                "KO: the OpenFOAM reader loaded no solution fields at time %s "
                "(mesh-only CGNS). The [diag] lines above show what the reader "
                "exposed; check the time directory has fields.\n" % target
            )
            sys.exit(1)

        # Write CGNS in HDF5 (UseHDF5=1). HDF5 is required so the per-timestep
        # files can be merged into one TRANSIENT CGNS afterwards (via h5py); CFD-Post
        # reads HDF5 CGNS fine. Cell data is preserved (we never interpolated).
        if all_times:
            # WriteAllTimeSteps runs the writer once per time, suffixing the name
            # with the 0-based timestep INDEX: out_<i>.cgns holds times[i].
            try:
                SaveData(out, proxy=reader, UseHDF5=1, WriteAllTimeSteps=1, FileNameSuffix="_%d")
            except Exception:  # noqa: BLE001 - fall back to the writer's default suffix.
                SaveData(out, proxy=reader, UseHDF5=1, WriteAllTimeSteps=1)
            # Sidecar mapping index -> real time, in the SAME order as the _<i>
            # suffix, so the backend merge stamps each frame with its true time
            # instead of re-deriving times from the case dir (which disagrees on
            # t=0 and scientific-notation dirs). Best-effort: never fail on it.
            try:
                with open(out + ".times", "w") as fh:
                    fh.write(",".join("%.17g" % float(t) for t in times))
            except Exception:  # noqa: BLE001 - sidecar is an optimisation, not a requirement.
                pass
        else:
            SaveData(out, proxy=reader, UseHDF5=1)
        Delete(reader)
    except Exception as exc:  # noqa: BLE001 - one-shot CLI: report and fail.
        import traceback

        sys.stderr.write("KO: CGNS export failed: %s\n%s\n" % (exc, traceback.format_exc()))
        sys.exit(1)

    # Verify output exists. The series writes <base>_<i>.cgns, the single writes
    # <base>.cgns; glob the base prefix to cover both.
    import glob

    base = out[:-5] if out.endswith(".cgns") else out  # strip ".cgns"
    produced = sorted(glob.glob(base + "*.cgns"))
    produced = [p for p in produced if os.path.getsize(p) > 0]
    if not produced:
        sys.stderr.write("KO: CGNS not created (or empty): %s*.cgns\n" % base)
        sys.exit(1)

    sys.stdout.write(
        "OK: CGNS written (%d file(s), time=%s, fields=%s) -> %s\n"
        % (len(produced), "all" if all_times else target, ",".join(cell_names) or "(none)", out)
    )
    sys.exit(0)


if __name__ == "__main__":
    main()

#!/usr/bin/env pvbatch
"""OpenFOAM (solved case) -> CGNS for Ansys CFD-Post. Run with ParaView pvbatch.
Usage: pvbatch FoamToCgns.py <case.foam> <out.cgns> [time] [field1,field2,...]

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

        # Restrict to the requested fields when given (else export everything CGNS
        # can carry). The cell-array selection property is exposed as `CellArrays`.
        if want_fields:
            try:
                reader.CellArrays = want_fields
            except Exception:  # noqa: BLE001 - keep all arrays if selection fails.
                pass

        # Resolve and read the LATEST time directory (the solved results).
        reader.UpdatePipeline()
        times = list(getattr(reader, "TimestepValues", []) or [])
        if want_time is not None:
            try:
                target = float(want_time)
            except ValueError:
                target = times[-1] if times else 0.0
        else:
            target = times[-1] if times else 0.0
        reader.UpdatePipeline(target)

        # Write CGNS in ADF (UseHDF5=0). SaveData picks the CGNS writer from the
        # .cgns extension; cell data is preserved (we never interpolated to points).
        SaveData(out, proxy=reader, UseHDF5=0)
        Delete(reader)
    except Exception as exc:  # noqa: BLE001 - one-shot CLI: report and fail.
        import traceback

        sys.stderr.write("KO: CGNS export failed: %s\n%s\n" % (exc, traceback.format_exc()))
        sys.exit(1)

    if not os.path.isfile(out) or os.path.getsize(out) == 0:
        sys.stderr.write("KO: CGNS not created (or empty): %s\n" % out)
        sys.exit(1)

    sys.stdout.write("OK: CGNS written (time=%s) -> %s\n" % (target, out))
    sys.exit(0)


if __name__ == "__main__":
    main()

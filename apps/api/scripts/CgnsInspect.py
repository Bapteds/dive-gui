#!/usr/bin/env python3
"""Inspect a CGNS file for export validation. Run with python3 + the VTK wheel.
Usage: python3 CgnsInspect.py <in.cgns>

Reads the CGNS produced by FoamToCgns.py and reports, as a single JSON object on
stdout, what is needed to validate the conversion fidelity:
  * cellArrays / pointArrays : the data arrays, by location (cell-centred check);
  * nZones / nCells / nPoints : sizes (a non-empty mesh);
  * emptyZones               : zones with zero cells (would be empty in CFD-Post);
  * velocityMax              : max |U| over cell data, when a velocity-like vector
                               field is present (for the physical cross-check).

This uses ONLY the standalone VTK wheel (`pip install vtk`) under a plain python3
— NOT pvbatch — because core VTK has a CGNS reader and reading needs no ParaView.

Contract:
  * On success: print one JSON line to stdout and exit 0.
  * On failure: print a line starting with "KO:" to stderr and exit 1.
"""

import json
import math
import os
import sys


# Cell-data array names that represent a velocity vector, in priority order.
_VELOCITY_NAMES = ("U", "Velocity", "Momentum", "UMean")


def _iter_leaves(dobj):
    """Yield every leaf vtkDataSet inside a (possibly composite) data object."""
    if dobj is None:
        return
    if dobj.IsA("vtkDataSet"):
        yield dobj
        return
    if not dobj.IsA("vtkCompositeDataSet"):
        return
    it = dobj.NewIterator()
    it.VisitOnlyLeavesOn()
    it.InitTraversal()
    while not it.IsDoneWithTraversal():
        leaf = it.GetCurrentDataObject()
        if leaf is not None and leaf.IsA("vtkDataSet"):
            yield leaf
        it.GoToNextItem()


def _array_names(attrs):
    """Names of the data arrays on a vtkDataSetAttributes (cell or point data)."""
    names = []
    for i in range(attrs.GetNumberOfArrays()):
        arr = attrs.GetArray(i)
        if arr is not None and arr.GetName():
            names.append(arr.GetName())
    return names


def _velocity_max(leaf):
    """Max magnitude of a velocity-like 3-component cell array, or None."""
    cd = leaf.GetCellData()
    for name in _VELOCITY_NAMES:
        arr = cd.GetArray(name)
        if arr is None or arr.GetNumberOfComponents() < 3:
            continue
        best = 0.0
        for t in range(arr.GetNumberOfTuples()):
            x, y, z = arr.GetComponent(t, 0), arr.GetComponent(t, 1), arr.GetComponent(t, 2)
            mag = math.sqrt(x * x + y * y + z * z)
            if mag > best:
                best = mag
        return best
    return None


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: python3 CgnsInspect.py <in.cgns>\n")
        sys.exit(2)

    cgns = os.path.abspath(sys.argv[1])
    if not os.path.isfile(cgns):
        sys.stderr.write("KO: CGNS file not found: %s\n" % cgns)
        sys.exit(1)

    try:
        from vtkmodules.vtkIOCGNSReader import vtkCGNSReader
    except ImportError as exc:
        sys.stderr.write(
            "KO: VTK modules unavailable - run with a python3 that has "
            "`pip install vtk`: %s\n" % exc
        )
        sys.exit(1)

    reader = vtkCGNSReader()
    reader.SetFileName(cgns)
    # Load every base / cell array so the report sees the full content.
    try:
        reader.EnableAllBases()
        reader.EnableAllCellArrays()
        reader.EnableAllPointArrays()
    except Exception:  # noqa: BLE001 - older readers expose fewer toggles.
        pass
    reader.Update()

    output = reader.GetOutput()
    if output is None:
        sys.stderr.write("KO: CGNS read returned no output (unreadable file).\n")
        sys.exit(1)

    cell_arrays, point_arrays, empty_zones = set(), set(), 0
    n_zones = n_cells = n_points = 0
    velocity_max = None
    for leaf in _iter_leaves(output):
        n_zones += 1
        n_cells += leaf.GetNumberOfCells()
        n_points += leaf.GetNumberOfPoints()
        if leaf.GetNumberOfCells() == 0:
            empty_zones += 1
        cell_arrays.update(_array_names(leaf.GetCellData()))
        point_arrays.update(_array_names(leaf.GetPointData()))
        if velocity_max is None:
            velocity_max = _velocity_max(leaf)

    report = {
        "cellArrays": sorted(cell_arrays),
        "pointArrays": sorted(point_arrays),
        "nZones": n_zones,
        "nCells": n_cells,
        "nPoints": n_points,
        "emptyZones": empty_zones,
        "velocityMax": velocity_max,
    }
    sys.stdout.write(json.dumps(report) + "\n")
    sys.exit(0)


if __name__ == "__main__":
    main()

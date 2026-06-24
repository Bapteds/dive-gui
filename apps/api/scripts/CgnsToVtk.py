#!/usr/bin/env pvpython
"""CGNS (ADF/HDF5) -> legacy VTK (ASCII) via VTK (bundled with ParaView).
Run with pvpython.
Usage: pvpython CgnsToVtk.py input.cgns [out.vtk]

Why raw VTK and NOT paraview.simple:
  paraview.simple's reader/SaveData go through the ParaView *server manager*
  and, for SaveData, a *rendering* pipeline controller
  (vtkSMParaViewPipelineControllerWithRendering). On a headless server with no
  display / OpenGL context that controller segfaults (SIGSEGV) before anything
  is written. The vtkmodules below are the same VTK classes underneath, but with
  no server-manager and no rendering, so the conversion is purely data-side and
  cannot hit that crash.

Success/failure contract (mirrors extractPatches.py):
  * On success: print a line starting with "OK:" to stdout and exit 0.
  * On failure: print a line starting with "KO:" to stderr and exit 1.
  * On a usage error (wrong argc): print usage to stderr and exit 2.
"""

import os
import sys


def iter_leaf_datasets(dobj):
    """Yield every leaf vtkDataSet inside a (possibly composite) data object.

    vtkCGNSReader produces a composite output (vtkMultiBlockDataSet /
    vtkPartitionedDataSetCollection); we walk it down to the concrete grid
    blocks so they can be appended into one unstructured grid.
    """
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


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: pvpython CgnsToVtk.py input.cgns [out.vtk]\n")
        sys.exit(2)

    infile = os.path.abspath(sys.argv[1])
    if not os.path.isfile(infile):
        sys.stderr.write("KO: file not found: %s\n" % infile)
        sys.exit(1)

    out = (
        os.path.abspath(sys.argv[2])
        if len(sys.argv) > 2
        else os.path.splitext(infile)[0] + ".vtk"
    )

    try:
        from vtkmodules.vtkIOCGNSReader import vtkCGNSReader
        from vtkmodules.vtkFiltersCore import vtkAppendFilter
        from vtkmodules.vtkIOLegacy import vtkUnstructuredGridWriter
    except ImportError as exc:
        sys.stderr.write(
            "KO: run this with pvpython (VTK modules unavailable): %s\n" % exc
        )
        sys.exit(1)

    # 1. Read the whole CGNS file (all bases / zones). No rendering, no SM.
    reader = vtkCGNSReader()
    reader.SetFileName(infile)
    reader.Update()

    output = reader.GetOutput()
    if output is None:
        sys.stderr.write("KO: CGNS read returned no output (unreadable file).\n")
        sys.exit(1)

    # 2. Merge every grid block into a single unstructured grid. vtkAppendFilter
    #    takes plain datasets, so we feed it each composite leaf. MergePoints
    #    welds coincident points shared across zones.
    append = vtkAppendFilter()
    append.MergePointsOn()
    n_blocks = 0
    for leaf in iter_leaf_datasets(output):
        if leaf.GetNumberOfPoints() > 0:
            append.AddInputData(leaf)
            n_blocks += 1

    if n_blocks == 0:
        sys.stderr.write("KO: CGNS contained no non-empty grid blocks (empty mesh).\n")
        sys.exit(1)

    append.Update()
    merged = append.GetOutput()
    if merged is None or merged.GetNumberOfCells() == 0:
        sys.stderr.write("KO: merged mesh is empty (no cells).\n")
        sys.exit(1)

    # 3. Write legacy VTK in ASCII: plain text, robust for meshio / gmshToFoam.
    writer = vtkUnstructuredGridWriter()
    writer.SetFileName(out)
    writer.SetInputData(merged)
    writer.SetFileTypeToASCII()
    writer.Write()

    if not os.path.isfile(out):
        sys.stderr.write("KO: VTK not created (write failed).\n")
        sys.exit(1)

    sys.stdout.write("OK: VTK written -> %s\n" % out)
    sys.exit(0)


if __name__ == "__main__":
    main()

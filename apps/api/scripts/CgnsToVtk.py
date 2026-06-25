#!/usr/bin/env python3
"""CGNS (ADF/HDF5) -> legacy VTK (ASCII) via the standalone VTK wheel.
Run with a plain python3 that has `pip install vtk`.
Usage: python3 CgnsToVtk.py input.cgns [out.vtk]

Run with python3, NOT pvpython:
  This script imports only raw vtkmodules (the standalone `pip install vtk`
  wheel) — never paraview.simple — so it does not need ParaView at all. Running
  it under `pvpython` is actively harmful: pvpython preloads ParaView's OWN
  bundled VTK, and importing a different pip-installed VTK on top of that mixes
  two incompatible VTK builds in one process. The symptoms are exactly what we
  hit: vtkCGNSReader.SetFileName silently no-ops (GetFileName stays empty ->
  RequestInformation reports "File name not set") and the process segfaults
  inside vtkPythonUtil. A single, consistent VTK under python3 avoids all of it.

Why raw VTK and NOT paraview.simple (kept for the record):
  paraview.simple's reader/SaveData go through the ParaView *server manager*
  and, for SaveData, a *rendering* pipeline controller
  (vtkSMParaViewPipelineControllerWithRendering). On a headless server with no
  display / OpenGL context that controller segfaults (SIGSEGV) before anything
  is written. The vtkmodules used here are the same VTK classes underneath, but
  with no server-manager and no rendering, so the conversion is purely
  data-side and cannot hit that crash.

Why we never touch reader.GetOutput() until the read is confirmed good:
  vtkCGNSReader::RequestInformation emits "File name not set" and returns
  failure when its FileName is empty at Update() time. Crucially, a reader whose
  pipeline FAILED still returns a non-None (empty / half-initialized) composite
  from GetOutput(). Walking that object with NewIterator()/GetCurrentDataObject()
  hands Python a dangling pointer and SIGSEGVs inside vtkPythonUtil
  (BuildVTKObject -> GetObjectFromPointer -> GetClassName). So we install a
  vtkErrorObserver, run UpdateInformation() first, and bail with a clean "KO:"
  the moment the reader reports an error - before any GetOutput() access.

Success/failure contract (mirrors extractPatches.py):
  * On success: print a line starting with "OK:" to stdout and exit 0.
  * On failure: print a line starting with "KO:" to stderr and exit 1.
  * On a usage error (wrong argc): print usage to stderr and exit 2.
"""

import os
import sys


# CGNS files are either HDF5-backed (the modern default) or ADF-backed (legacy).
# A quick header sniff turns "not a CGNS file at all" (truncated upload, wrong
# file, HTML error page, etc.) into a precise message instead of a deep VTK error.
_HDF5_MAGIC = b"\x89HDF\r\n\x1a\n"
_ADF_MAGIC = b"ADF Database Version"  # appears near the start of ADF/native CGNS


def sniff_cgns(path):
    """Return (looks_like_cgns: bool, detail: str) from the file's first bytes."""
    try:
        size = os.path.getsize(path)
    except OSError as exc:
        return False, "cannot stat file: %s" % exc
    if size == 0:
        return False, "file is empty (0 bytes) - upload likely incomplete"
    try:
        with open(path, "rb") as fh:
            head = fh.read(64)
    except OSError as exc:
        return False, "cannot read file: %s" % exc
    if head.startswith(_HDF5_MAGIC):
        return True, "HDF5-backed CGNS"
    if _ADF_MAGIC in head:
        return True, "ADF-backed CGNS"
    # Not a hard failure on its own (some valid files vary), but worth reporting.
    preview = head[:16]
    return False, "header is neither HDF5 nor ADF (first bytes: %r)" % preview


def vtk_versions():
    """Best-effort '(VTK x.y.z / ParaView a.b.c)' string for diagnostics."""
    bits = []
    try:
        from vtkmodules.vtkCommonCore import vtkVersion

        bits.append("VTK %s" % vtkVersion.GetVTKVersion())
    except Exception:  # noqa: BLE001 - diagnostics only, never fatal.
        pass
    try:
        import paraview

        bits.append("ParaView %s" % paraview.__version__)
    except Exception:  # noqa: BLE001 - diagnostics only, never fatal.
        pass
    return " / ".join(bits) if bits else "version unknown"


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
        sys.stderr.write("usage: python3 CgnsToVtk.py input.cgns [out.vtk]\n")
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

    # Fail fast on a file that is plainly not a CGNS container, with a precise
    # reason, before VTK ever opens it.
    ok, detail = sniff_cgns(infile)
    if not ok:
        sys.stderr.write("KO: %s is not a readable CGNS file: %s\n" % (infile, detail))
        sys.exit(1)

    try:
        from vtkmodules.vtkIOCGNSReader import vtkCGNSReader
        from vtkmodules.vtkFiltersCore import vtkAppendFilter
        from vtkmodules.vtkIOLegacy import vtkUnstructuredGridWriter
        from vtkmodules.vtkCommonCore import vtkCommand
    except ImportError as exc:
        sys.stderr.write(
            "KO: VTK modules unavailable - run with a python3 that has "
            "`pip install vtk`: %s\n" % exc
        )
        sys.exit(1)

    # Error observer: VTK errors are non-fatal by default (they print and the
    # pipeline keeps a failed state), so we capture them to (a) report the real
    # reason and (b) STOP before reading a failed reader's output, which would
    # segfault. See the module docstring.
    errors = []

    def on_error(_obj, _evt, msg):
        errors.append(msg)

    # 1. Read the whole CGNS file (all bases / zones). No rendering, no SM.
    reader = vtkCGNSReader()
    reader.AddObserver(vtkCommand.ErrorEvent, on_error)
    reader.SetFileName(infile)

    # Confirm the filename actually propagated. vtkCGNSReader stores FileName as
    # a std::string via vtkSetStdStringFromCharMacro; if a ParaView build wraps
    # that setter incorrectly the value silently stays empty and the reader
    # later reports "File name not set". Catch that here with a clear message
    # instead of a downstream crash. Best-effort: only an empty getter result is
    # treated as a hard failure, so a build that doesn't expose GetFileName can
    # never turn an otherwise-working conversion into an error.
    try:
        set_name = reader.GetFileName()
        getter_ok = True
    except Exception:  # noqa: BLE001 - getter is a diagnostic, never fatal here.
        set_name = None
        getter_ok = False
    if getter_ok and not (set_name or "").strip():
        sys.stderr.write(
            "KO: reader did not accept the file name "
            "(SetFileName(%r) -> GetFileName()=%r) [%s]. "
            "This is a ParaView/VTK build issue with the CGNS reader's "
            "string setter, not a problem with the file.\n"
            % (infile, set_name, vtk_versions())
        )
        sys.exit(1)

    # RequestInformation runs here; if FileName were empty or the file
    # unreadable, the error observer captures it and we never touch GetOutput().
    reader.UpdateInformation()
    if errors:
        sys.stderr.write(
            "KO: CGNS read failed during UpdateInformation [%s]: %s\n"
            % (vtk_versions(), " | ".join(m.strip() for m in errors))
        )
        sys.exit(1)

    reader.Update()
    if errors:
        sys.stderr.write(
            "KO: CGNS read failed during Update [%s]: %s\n"
            % (vtk_versions(), " | ".join(m.strip() for m in errors))
        )
        sys.exit(1)

    output = reader.GetOutput()
    if output is None or not output.IsA("vtkDataObject"):
        sys.stderr.write("KO: CGNS read returned no usable output.\n")
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

    # The consumer (OpenFOAM's vtkUnstructuredToFoam) only needs mesh topology -
    # points and cells. Strip every data array so the file is pure geometry:
    #   * field data is otherwise emitted as a top-of-file FIELD block that
    #     OpenFOAM's legacy reader rejects ("Wrong token type - expected label");
    #   * point/cell arrays are unused for mesh conversion and only add parser
    #     surface (and size).
    merged.GetFieldData().Initialize()
    merged.GetPointData().Initialize()
    merged.GetCellData().Initialize()

    # 3. Write legacy VTK in ASCII: plain text, robust for meshio / gmshToFoam.
    writer = vtkUnstructuredGridWriter()
    writer.SetFileName(out)
    writer.SetInputData(merged)
    writer.SetFileTypeToASCII()

    # Pin the CLASSIC (4.2) legacy layout. VTK >= 9.1 defaults its legacy writer
    # to "DataFile Version 5.1", which writes CELLS as separate OFFSETS /
    # CONNECTIVITY arrays. OpenFOAM's vtkUnstructuredToFoam is a hand-rolled
    # legacy parser that only understands the classic "CELLS n size / <count> ..."
    # layout, so 5.1 breaks it. Guarded: older VTK has no SetFileVersion and
    # already writes the classic layout.
    try:
        writer.SetFileVersion(writer.VTK_LEGACY_READER_VERSION_4_2)
    except AttributeError:
        pass

    writer.Write()

    if not os.path.isfile(out):
        sys.stderr.write("KO: VTK not created (write failed).\n")
        sys.exit(1)

    sys.stdout.write("OK: VTK written -> %s\n" % out)
    sys.exit(0)


if __name__ == "__main__":
    main()

#!/usr/bin/env pvpython
"""CGNS (ADF/HDF5) -> legacy VTK (ASCII) via ParaView.
Run with pvpython.
Usage: pvpython cgns_to_vtk.py input.cgns [out.vtk]
"""

import os
import sys

try:
    from paraview.simple import CGNSSeriesReader, MergeBlocks, SaveData
except ImportError:
    sys.exit("KO: run this with pvpython (from ParaView), not standard python.")


def main():
    if len(sys.argv) < 2:
        sys.exit("KO: usage: pvpython cgns_to_vtk.py input.cgns [out.vtk]")

    infile = os.path.abspath(sys.argv[1])
    if not os.path.isfile(infile):
        sys.exit(f"KO: file not found: {infile}")

    out = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else os.path.splitext(infile)[0] + ".vtk"

    reader = CGNSSeriesReader(FileNames=[infile])
    try:
        reader.Bases = reader.GetProperty("BaseStatus") and ["Base"] or reader.Bases
    except Exception:
        pass
    reader.UpdatePipeline()

    merged = MergeBlocks(Input=reader)
    merged.UpdatePipeline()

    # FileType='Ascii': legacy VTK in plain text, robust for meshio/gmshToFoam.
    try:
        SaveData(out, proxy=merged, FileType="Ascii")
    except Exception:
        SaveData(out, proxy=merged)  # fallback if this ParaView build ignores FileType

    if not os.path.isfile(out):
        sys.exit("KO: VTK not created. CGNS read likely failed (empty mesh / unreadable file).")

    print("OK: VTK written ->", out)


if __name__ == "__main__":
    main()
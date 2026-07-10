#!/usr/bin/env python3
"""
csv_to_boundaryData.py
Convert a CSV with a spatial velocity profile (e.g. exported from
ParaView / CFX-Post at the runner exit) into OpenFOAM boundaryData
format for timeVaryingMappedFixedValue.

Expected CSV columns (header names are matched case-insensitively,
common ParaView names handled): x, y, z, Ux, Uy, Uz [, k, omega]

Usage:
    python3 csv_to_boundaryData.py profile.csv <caseDir> inlet
Writes:
    <caseDir>/constant/boundaryData/inlet/points
    <caseDir>/constant/boundaryData/inlet/0/U
    <caseDir>/constant/boundaryData/inlet/0/k      (if column present)
    <caseDir>/constant/boundaryData/inlet/0/omega  (if column present)
"""
import csv
import sys
from pathlib import Path

ALIASES = {
    "x": ["x", "points:0", "points_0", "coordinatesx", "x [ m ]"],
    "y": ["y", "points:1", "points_1", "coordinatesy", "y [ m ]"],
    "z": ["z", "points:2", "points_2", "coordinatesz", "z [ m ]"],
    "ux": ["ux", "u:0", "u_0", "velocityx", "velocity u [ m s^-1 ]", "u x"],
    "uy": ["uy", "u:1", "u_1", "velocityy", "velocity v [ m s^-1 ]", "u y"],
    "uz": ["uz", "u:2", "u_2", "velocityz", "velocity w [ m s^-1 ]", "u z"],
    "k": ["k", "turbulentkineticenergy",
          "turbulence kinetic energy [ m^2 s^-2 ]"],
    "omega": ["omega", "turbulenteddyfrequency",
              "turbulence eddy frequency [ s^-1 ]"],
}


def find_col(fieldnames, key):
    norm = {f.strip().lower(): f for f in fieldnames}
    for alias in ALIASES[key]:
        if alias in norm:
            return norm[alias]
    return None


def num(row, col, rownum):
    """Parse one cell as a float, or fail with a precise message. Guards against a
    short row (DictReader fills the missing cell with None -> the old code wrote a
    literal 'None' into 0/U, corrupting the field) and any non-numeric value."""
    raw = row.get(col)
    if raw is None or str(raw).strip() == "":
        sys.exit(f"Row {rownum}: missing value for column '{col}'. "
                 f"Every row must have all of x, y, z, Ux, Uy, Uz.")
    try:
        return float(str(raw).strip())
    except ValueError:
        sys.exit(f"Row {rownum}: '{raw}' in column '{col}' is not a number.")


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    csv_file, case_dir, patch = sys.argv[1:4]

    # utf-8-sig strips an Excel byte-order mark that would otherwise glue itself to
    # the first header ("﻿x"), breaking the 'x' column match.
    with open(csv_file, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            sys.exit("The CSV is empty (no header row).")
        cols = {k: find_col(reader.fieldnames, k)
                for k in ("x", "y", "z", "ux", "uy", "uz", "k", "omega")}
        missing = [k for k in ("x", "y", "z", "ux", "uy", "uz")
                   if cols[k] is None]
        if missing:
            sys.exit(f"Missing required columns: {missing}\n"
                     f"Found headers: {reader.fieldnames}")
        rows = list(reader)

    if not rows:
        sys.exit("The CSV has a header but no data rows.")

    # Validate + parse EVERY cell up front, so we never write a partly-corrupt
    # boundaryData set (points written, then U aborts) and never emit 'None'.
    points, vels = [], []
    scal_vals = {s: [] for s in ("k", "omega") if cols[s]}
    for i, r in enumerate(rows, start=1):
        points.append(tuple(num(r, cols[c], i) for c in ("x", "y", "z")))
        vels.append(tuple(num(r, cols[c], i) for c in ("ux", "uy", "uz")))
        for s in scal_vals:
            scal_vals[s].append(num(r, cols[s], i))

    out = Path(case_dir) / "constant" / "boundaryData" / patch
    (out / "0").mkdir(parents=True, exist_ok=True)

    def flist(path, values, fmt, header_note):
        with open(path, "w") as f:
            f.write(f"// {header_note}\n{len(values)}\n(\n")
            for v in values:
                f.write(fmt(v) + "\n")
            f.write(")\n")

    flist(out / "points", points, lambda p: f"({p[0]} {p[1]} {p[2]})",
          f"points for patch '{patch}'")
    flist(out / "0" / "U", vels, lambda u: f"({u[0]} {u[1]} {u[2]})", "velocity")
    for scal, vals in scal_vals.items():
        flist(out / "0" / scal, vals, lambda v: f"{v}", scal)

    print(f"Wrote {len(rows)} points to {out}")
    print("BC: type timeVaryingMappedFixedValue; mapMethod planarInterpolation;")


if __name__ == "__main__":
    main()

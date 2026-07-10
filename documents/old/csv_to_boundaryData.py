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


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    csv_file, case_dir, patch = sys.argv[1:4]

    with open(csv_file, newline="") as f:
        reader = csv.DictReader(f)
        cols = {k: find_col(reader.fieldnames, k)
                for k in ("x", "y", "z", "ux", "uy", "uz", "k", "omega")}
        missing = [k for k in ("x", "y", "z", "ux", "uy", "uz")
                   if cols[k] is None]
        if missing:
            sys.exit(f"Missing required columns: {missing}\n"
                     f"Found headers: {reader.fieldnames}")
        rows = list(reader)

    out = Path(case_dir) / "constant" / "boundaryData" / patch
    (out / "0").mkdir(parents=True, exist_ok=True)

    def flist(path, fmt_row, header_note):
        with open(path, "w") as f:
            f.write(f"// {header_note}\n{len(rows)}\n(\n")
            for r in rows:
                f.write(fmt_row(r) + "\n")
            f.write(")\n")

    flist(out / "points",
          lambda r: f"({r[cols['x']]} {r[cols['y']]} {r[cols['z']]})",
          f"points for patch '{patch}'")
    flist(out / "0" / "U",
          lambda r: f"({r[cols['ux']]} {r[cols['uy']]} {r[cols['uz']]})",
          "velocity")
    for scal in ("k", "omega"):
        if cols[scal]:
            flist(out / "0" / scal, lambda r, c=cols[scal]: r[c], scal)

    print(f"Wrote {len(rows)} points to {out}")
    print("BC: type timeVaryingMappedFixedValue; mapMethod planarInterpolation;")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Convert OpenFOAM's volume-mean |vorticity|^2 result to RMS vorticity.

No third-party Python modules are required.
"""

from __future__ import annotations

import argparse
import csv
import math
import sys
from pathlib import Path


FUNCTION_OBJECT = "vorticityMeanSquareQcore"


def data_files(case: Path) -> list[Path]:
    root = case / "postProcessing" / FUNCTION_OBJECT
    preferred = list(root.glob("*/volFieldValue.dat"))
    return sorted(preferred or root.glob("*/*.dat"))


def numeric_rows(path: Path) -> list[tuple[float, float]]:
    rows: list[tuple[float, float]] = []
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue

        values: list[float] = []
        for token in line.replace("(", " ").replace(")", " ").split():
            try:
                values.append(float(token))
            except ValueError:
                pass

        # Time is the first number. The operated field value is the final
        # number, after optional nCells/volume columns.
        if len(values) >= 2:
            rows.append((values[0], values[-1]))
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Calculate RMS vorticity from vorticityMeanSquareQcore output."
    )
    parser.add_argument("case", nargs="?", type=Path, default=Path("."))
    args = parser.parse_args()
    case = args.case.resolve()

    files = data_files(case)
    if not files:
        print(
            f"No {FUNCTION_OBJECT} output found under {case / 'postProcessing'}",
            file=sys.stderr,
        )
        return 2

    # A restarted run may contain overlapping times. The newest occurrence of
    # a time replaces the older one.
    samples: dict[float, float] = {}
    for path in files:
        for time_value, mean_square in numeric_rows(path):
            samples[time_value] = mean_square

    if not samples:
        print("No numeric mean-square samples were found.", file=sys.stderr)
        return 2

    output_dir = case / "postProcessing" / "vorticityRMS_Qcore"
    output_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / "vorticityRMS_Qcore.csv"

    with output.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(
            [
                "time",
                "rms_vorticity_1_per_s",
                "mean_square_vorticity_1_per_s2",
            ]
        )
        for time_value in sorted(samples):
            mean_square = samples[time_value]
            if mean_square < -1e-12:
                print(
                    f"Negative mean-square value {mean_square} at time {time_value}",
                    file=sys.stderr,
                )
                return 2
            rms = math.sqrt(max(0.0, mean_square))
            writer.writerow([f"{time_value:.16g}", f"{rms:.16g}", f"{mean_square:.16g}"])

    final_time = max(samples)
    final_mean_square = samples[final_time]
    final_rms = math.sqrt(max(0.0, final_mean_square))
    print(f"RMS vorticity at time {final_time:g}: {final_rms:.12g} 1/s")
    print(f"Wrote {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


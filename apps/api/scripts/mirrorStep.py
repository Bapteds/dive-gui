#!/usr/bin/env python3
"""Mirror a chamber STEP export on the z-y plane, reversing the machine's
rotational direction (the guide vanes curve the other way, the runner turns the
other way).

Usage: mirrorStep.py <input.step> <output.step>

The mirrored model keeps the ORIGINAL bounding box: after the YZ mirror
(x -> -x) it is translated in x by (xmin + xmax) of the input, so only the
handedness flips — nothing moves.

Contract (mirrors buildChamber.py): prints "OK: mirrored" to stdout and exits 0
on success; prints "KO: <reason>" to stderr and exits 1 on any failure. The
output is written to a UNIQUE temp file in the destination directory (mkstemp)
then os.replace()d onto the final name, so a concurrent reader never sees a
half-written file, a failure leaves nothing behind, and two concurrent
invocations cannot cross-promote or delete each other's temp files (the API
also serializes them per build, this is defense in depth).
"""

import os
import sys
import tempfile


def mirror_step(src: str, dst: str) -> None:
    import cadquery as cq

    imported = cq.importers.importStep(src)
    shapes = imported.vals()
    if not shapes:
        raise ValueError("no solids found in %s" % src)
    xmin = min(s.BoundingBox().xmin for s in shapes)
    xmax = max(s.BoundingBox().xmax for s in shapes)
    mirrored = imported.mirror("YZ").translate((xmin + xmax, 0, 0))

    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(dst) or ".", suffix=".step.tmp")
    os.close(fd)
    try:
        cq.exporters.export(mirrored, tmp, exportType="STEP")
        os.replace(tmp, dst)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def main(argv) -> int:
    if len(argv) != 3:
        sys.stderr.write("KO: usage: mirrorStep.py <input.step> <output.step>\n")
        return 1
    src, dst = argv[1], argv[2]
    try:
        mirror_step(src, dst)
    except Exception as exc:  # noqa: BLE001 - the exit contract wraps everything
        sys.stderr.write("KO: %s\n" % exc)
        return 1
    sys.stdout.write("OK: mirrored\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

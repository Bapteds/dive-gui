#!/usr/bin/env python3
"""One-time: turn GuideVanes50DegOpen.stl into small committed build assets.

Splits the 17 connected components into 16 identical blades + 1 contoured
passage-wall shell, re-centres everything on the ring axis (XY origin, passage
bottom at z=0, metres), removes the flat outlet ring from the shell, decimates
the shell, and writes one representative blade + the shell + a metadata JSON.

Usage:
    python preprocessVanes.py <sourceStl> <assetsDir>
"""
import json
import math
import os
import sys

import numpy as np
import trimesh
from trimesh.graph import connected_components


def main():
    if len(sys.argv) not in (3, 4):
        sys.stderr.write(
            "usage: python preprocessVanes.py <sourceStl> <assetsDir> [outletStl]\n")
        sys.exit(2)
    src, out_dir = sys.argv[1], sys.argv[2]
    # The outlet cap is a separate CAD export (the passage's bottom annular face,
    # hub -> shroud). Defaults to outlet.stl beside the source.
    outlet_src = sys.argv[3] if len(sys.argv) == 4 \
        else os.path.join(os.path.dirname(src), "outlet.stl")
    os.makedirs(out_dir, exist_ok=True)

    m = trimesh.load(src)
    if isinstance(m, trimesh.Scene):
        m = m.dump(concatenate=True)

    # ring axis = XY centroid of all vertices; passage bottom = min z
    cx, cy = float(m.vertices[:, 0].mean()), float(m.vertices[:, 1].mean())
    zmin = float(m.vertices[:, 2].min())
    shift = np.array([cx, cy, zmin])

    cc = connected_components(m.face_adjacency, nodes=np.arange(len(m.faces)))
    blades = [c for c in cc if len(c) < 20000]
    shell_faces = max(cc, key=len)
    if len(blades) < 2:
        raise RuntimeError("expected many blade components, found %d" % len(blades))

    # one representative blade, re-centred
    blade = m.submesh([blades[0]], append=True)
    blade.vertices = blade.vertices - shift
    blade.export(os.path.join(out_dir, "guideVanes_blade.stl"))

    # blade angular spacing (mean of sorted centroid-angle gaps)
    angs = []
    for c in blades:
        v = m.vertices[np.unique(m.faces[c])] - np.array([cx, cy, 0.0])
        ctr = v.mean(axis=0)
        angs.append(math.degrees(math.atan2(ctr[1], ctr[0])) % 360)
    angs.sort()
    step = float(np.mean(np.diff(angs + [angs[0] + 360.0])))

    # shell = the full contoured passage wall (hub + shroud). Re-centre it on the
    # ring axis / passage bottom. The source shell is CLOSED at the bottom by a
    # horizontal annular cap over the outlet opening — that cap must be removed so
    # the walls are open at the bottom and the fluid exits through the outlet
    # patch (see below), otherwise the wall face seals the outlet.
    shell = m.submesh([shell_faces], append=True)
    shell.vertices = shell.vertices - shift

    # outlet cap = the passage's whole bottom annular face (hub -> shroud), a
    # slightly conical ring exported separately. Re-centre it on ITS OWN xy axis
    # (a full ring -> centroid = axis) so it is concentric with the vanes, and
    # shift z by the SAME passage-bottom zmin as the walls so it lands exactly at
    # the passage bottom. This is the real outlet — not a flat synthesised ring.
    o = trimesh.load(outlet_src)
    if isinstance(o, trimesh.Scene):
        o = o.dump(concatenate=True)
    ocx, ocy = float(o.vertices[:, 0].mean()), float(o.vertices[:, 1].mean())
    o.vertices = o.vertices - np.array([ocx, ocy, zmin])
    o.merge_vertices()
    o.export(os.path.join(out_dir, "guideVanes_outlet.stl"))
    orr = np.hypot(o.vertices[:, 0], o.vertices[:, 1])
    outlet_inner_r, outlet_outer_r = float(orr.min()), float(orr.max())
    outlet_z_top = float(o.vertices[:, 2].max())

    # Remove the shell's outlet cap: horizontal faces (|nz| > 0.5) whose centroid
    # falls inside the outlet's (r, z) footprint. This deletes only the flat cap
    # spanning the opening; the hub and shroud side walls (near-vertical) and the
    # outboard floor (r beyond the outlet) are kept. Box derived from the outlet
    # envelope, so it scales with the assets.
    sv = shell.vertices
    sr = np.hypot(sv[:, 0], sv[:, 1])
    sz = sv[:, 2]
    fr = sr[shell.faces].mean(axis=1)
    fz = sz[shell.faces].mean(axis=1)
    fnz = np.abs(shell.face_normals[:, 2])
    cap = ((fnz > 0.5)
           & (fr >= outlet_inner_r - 0.01) & (fr <= outlet_outer_r + 0.01)
           & (fz <= outlet_z_top + 0.02))
    walls = shell.submesh([np.where(~cap)[0]], append=True)
    # Keep the walls at FULL resolution (no decimation — decimation enlarged the
    # source's tessellation cracks into visible holes). Weld coincident vertices
    # to close what seams the source left as exact duplicates.
    walls.merge_vertices()
    walls.export(os.path.join(out_dir, "guideVanes_walls.stl"))
    sys.stderr.write("outlet cap removed from walls: %d faces\n" % int(cap.sum()))

    allv = m.vertices - np.array([cx, cy, 0.0])
    r_all = np.hypot(allv[:, 0], allv[:, 1])
    PIVOT_RADIUS = 0.86732  # authoritative CAD value (blade centre of rotation), user-supplied
    meta = {
        "outerDiameter": 2.0 * float(r_all.max()),
        "pivotRadius": PIVOT_RADIUS,
        "hubRadius": float(r_all.min()),
        "height": float(m.vertices[:, 2].max() - zmin),
        "bladeCount": len(blades),
        "bladeAngleStepDeg": round(step, 4),
        "outletInnerR": outlet_inner_r,
        "outletOuterR": outlet_outer_r,
    }
    with open(os.path.join(out_dir, "guideVanes.json"), "w") as fh:
        json.dump(meta, fh, indent=2)
    sys.stdout.write("OK: %s\n" % json.dumps(meta))


if __name__ == "__main__":
    main()

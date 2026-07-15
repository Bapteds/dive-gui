#!/usr/bin/env python3
"""Extract a pipe centerline (+ radius profile) from an OpenFOAM wall patch.

Used by the diameter-optimization "Optimisation" tab: given a wall patch and the
two endpoints the user clicked, this recovers the polyline running along the pipe
axis and the mean wall radius at each point along it. The polyline is FROZEN into
the study's MorphDefinition so the browser preview and the server-side morph both
measure the radial scale from the identical axis.

Algorithm (pure numpy, so it is unit-testable on synthetic tubes without OpenFOAM):
  * Parametrize the wall point cloud by projection onto the A->B chord, bin it into
    cross-sectional slabs, and take each populated slab's centroid as a centerline
    point (ordered along the pipe). This recovers straight and gently-to-moderately
    curved runs (up to roughly a right-angle bend) well. A segment that folds back
    on the chord (a hairpin / >90 degrees within one segment) is a known limitation
    — keep the picked segment to a single, not-too-sharp run.
  * The wall radius at each centerline point is the mean distance of the nearby wall
    points to the polyline (nearest-point projection, the SAME math the shared
    morphPoint uses); the diameter there is 2*radius.

CLI usage:
    python extractCenterline.py <caseDirOrFoamFile> <wallPatch> \
        <ax> <ay> <az> <bx> <by> <bz> <out_centerline.json>

Success/failure contract (mirrors extractPatches.py):
  * On success: print "OK: ..." to stdout, write the JSON, exit 0.
  * On failure: print "KO: ..." to stderr, exit 1.
  * On a usage error (wrong argc): print usage to stderr, exit 2.

Output JSON: { "centerline": [[x,y,z], ...], "radii": [r0, r1, ...],
               "length": <polyline arc-length> } — radii[i] is the mean wall radius
at centerline[i]; the diameter there is 2*radii[i].
"""

import json
import os
import sys

import numpy as np

# Slabs sampled along the pipe. Empty / sparse slabs are skipped, so this is an
# upper bound on the centerline resolution, not a fixed count.
DEFAULT_SAMPLES = 40
# A slab needs at least this many wall points for a trustworthy centroid.
MIN_SLAB_POINTS = 3


def _project_to_polyline(points, centers, cum):
    """Nearest-point projection of every point onto a polyline.

    Returns (s, r): arc-length of the foot along the polyline and the radial
    distance to it, per point. Vectorized over points, looping the (few) segments —
    the same nearest-segment math the shared morphPoint uses, kept in sync.
    """
    n = points.shape[0]
    best_d2 = np.full(n, np.inf)
    best_s = np.zeros(n)
    best_r = np.zeros(n)
    for i in range(len(centers) - 1):
        a = centers[i]
        d = centers[i + 1] - a
        seg2 = float(d @ d)
        if seg2 <= 0.0:
            continue
        t = np.clip(((points - a) @ d) / seg2, 0.0, 1.0)
        foot = a + t[:, None] * d
        off = points - foot
        d2 = np.einsum("ij,ij->i", off, off)
        closer = d2 < best_d2
        best_d2[closer] = d2[closer]
        best_s[closer] = cum[i] + t[closer] * np.sqrt(seg2)
        best_r[closer] = np.sqrt(d2[closer])
    return best_s, best_r


def _bin_centroids(points, param, lo, hi, n_bins):
    """Centroid of the points in each of n_bins slabs spanning [lo, hi] of the
    scalar `param`. Skips slabs with too few points; returns an (M,3) array."""
    edges = np.linspace(lo, hi, n_bins + 1)
    centers = []
    for k in range(n_bins):
        upper = param <= edges[k + 1] if k == n_bins - 1 else param < edges[k + 1]
        mask = (param >= edges[k]) & upper
        if int(mask.sum()) >= MIN_SLAB_POINTS:
            centers.append(points[mask].mean(axis=0))
    return np.asarray(centers, dtype=float)


def extract_centerline(points, a, b, n_samples=DEFAULT_SAMPLES):
    """Recover the centerline polyline + per-point radius from a wall point cloud.

    points: (N,3) wall vertices. a, b: the endpoints (3,) bounding the segment.
    Returns (centers (M,3), radii (M,), length) or raises ValueError when the input
    is too sparse / degenerate to fit a centerline.
    """
    points = np.asarray(points, dtype=float)
    a = np.asarray(a, dtype=float)
    b = np.asarray(b, dtype=float)
    if points.ndim != 2 or points.shape[1] != 3 or points.shape[0] < MIN_SLAB_POINTS:
        raise ValueError("need at least a few 3D wall points")

    axis = b - a
    chord = float(np.linalg.norm(axis))
    if chord <= 0.0:
        raise ValueError("the two endpoints coincide")

    # 1) Ordered centerline points from chord-projection slabs.
    proj = (points - a) @ (axis / chord)
    centers = _bin_centroids(points, proj, 0.0, chord, n_samples)
    if centers.shape[0] < 2:
        raise ValueError("too few populated slabs to fit a centerline")

    # 2) Radius profile: project every wall point onto the polyline, then average the
    #    projection distance of the points nearest each centerline point (by arc-length).
    seglens = np.linalg.norm(np.diff(centers, axis=0), axis=1)
    cum = np.concatenate([[0.0], np.cumsum(seglens)])
    length = float(cum[-1])
    s, r = _project_to_polyline(points, centers, cum)
    nearest = np.abs(s[:, None] - cum[None, :]).argmin(axis=1)
    radii = np.full(centers.shape[0], np.nan)
    for i in range(centers.shape[0]):
        m = nearest == i
        if bool(m.any()):
            radii[i] = float(r[m].mean())
    # Fill any center that attracted no points (interpolate along the profile).
    if np.isnan(radii).any():
        good = ~np.isnan(radii)
        if not good.any():
            radii[:] = float(r.mean())
        else:
            radii = np.interp(np.arange(centers.shape[0]), np.flatnonzero(good), radii[good])
    return centers, radii, length


def _read_wall_points(case_dir, patch):
    """Read a wall patch's surface point cloud from an OpenFOAM case via PyVista
    (same reader path as extractPatches.py)."""
    import pyvista as pv

    foam = os.path.join(case_dir, "case.foam")
    if not os.path.exists(foam):
        open(foam, "a").close()
    reader = pv.OpenFOAMReader(foam)
    reader.enable_all_patch_arrays()
    try:  # skip the internal volume mesh — we only need the wall surface
        raw = reader.reader
        for i in range(raw.GetNumberOfPatchArrays()):
            if raw.GetPatchArrayName(i) == "internalMesh":
                raw.SetPatchArrayStatus("internalMesh", 0)
        raw.Modified()
    except Exception as exc:  # noqa: BLE001 - best-effort optimisation only
        sys.stderr.write(f"[extractCenterline] could not disable internalMesh: {exc}\n")
    mesh = reader.read()

    keys = list(mesh.keys()) if mesh is not None else []
    block = None
    if "boundary" in keys and patch in list(mesh["boundary"].keys()):
        block = mesh["boundary"][patch]
    elif patch in keys:
        block = mesh[patch]
    if block is None or block.n_cells <= 0:
        raise ValueError(f'wall patch "{patch}" not found or empty')
    return np.asarray(block.extract_surface(algorithm="dataset_surface").points, dtype=float)


def main():
    if len(sys.argv) != 10:
        sys.stderr.write(
            "usage: python extractCenterline.py <caseDirOrFoamFile> <wallPatch> "
            "<ax> <ay> <az> <bx> <by> <bz> <out_centerline.json>\n"
        )
        sys.exit(2)

    arg_case = sys.argv[1]
    patch = sys.argv[2]
    try:
        a = [float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5])]
        b = [float(sys.argv[6]), float(sys.argv[7]), float(sys.argv[8])]
    except ValueError:
        sys.stderr.write("KO: endpoint coordinates must be numbers\n")
        sys.exit(1)
    out_json = sys.argv[9]

    try:
        if os.path.isfile(arg_case) and arg_case.lower().endswith(".foam"):
            case_dir = os.path.dirname(os.path.abspath(arg_case)) or "."
        else:
            case_dir = os.path.abspath(arg_case)

        points = _read_wall_points(case_dir, patch)
        centers, radii, length = extract_centerline(points, a, b)
        with open(out_json, "w") as fh:
            json.dump(
                {
                    "centerline": centers.tolist(),
                    "radii": radii.tolist(),
                    "length": length,
                },
                fh,
            )
        sys.stdout.write("OK: %d centerline points -> %s\n" % (centers.shape[0], out_json))
        sys.exit(0)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - one-shot CLI, report and fail.
        sys.stderr.write("KO: %s\n" % exc)
        sys.exit(1)


if __name__ == "__main__":
    main()

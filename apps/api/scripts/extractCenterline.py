#!/usr/bin/env python3
"""Extract a channel centerline (+ radius profile) from an OpenFOAM wall patch by
fitting a KNOWN SHAPE to the wall point cloud.

Used by the diameter-optimization "Optimisation" tab. Earlier versions traced a
path point-by-point (chord slabs, then a Dijkstra wall walk); both were fragile on
real machine meshes - the chord zigzagged on a volute, and a shortest wall path can
only cover half of a CLOSED ring. This version instead fits a parametric shape,
which is robust and needs no point placement:

  * "straight": principal-axis (PCA) line through the wall centroid. The axis is the
    centre line of the channel, spanning its full extent (or the region between two
    optional hint points A/B).
  * "ring": least-squares circle in the wall's best-fit plane -> the FULL loop of an
    annular / circular channel in one shot (no half-loop problem, no via points).
  * "auto": one dominant PCA axis => straight; a planar cloud => ring.

Optional hint points A/B do NOT become the axis (they sit on the wall, not the
centre); for "straight" they clip the axis to their projected region, so moving them
repositions the whole axis along the channel.

The wall radius at each station is the mean distance of the nearby wall points to the
fitted centerline (nearest-point projection); diameter there is 2*radius.

CLI usage:
    python extractCenterline.py <caseDirOrFoamFile> <wallPatch> <shape> \
        <out_centerline.json> [<ax> <ay> <az> <bx> <by> <bz>]
  shape in {auto, straight, ring}. The 6 hint coordinates are optional.

Success/failure contract (mirrors extractPatches.py):
  * On success: print "OK: ..." to stdout, write the JSON, exit 0.
  * On failure: print "KO: ..." to stderr, exit 1.
  * On a usage error: print usage to stderr, exit 2.

Output JSON: { "centerline": [[x,y,z], ...], "radii": [...], "length": <arc length>,
               "shape": "straight"|"ring", "closed": <bool> }.
"""

import json
import os
import sys

import numpy as np

DEFAULT_SAMPLES = 48
MIN_POINTS = 8
SHAPES = ("auto", "straight", "ring")


def _radii_along(points, centers):
    """Mean wall radius at each centerline station (nearest-point projection onto
    the polyline). Returns (radii (M,), arc_length)."""
    seg = np.linalg.norm(np.diff(centers, axis=0), axis=1)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    n = points.shape[0]
    best_d2 = np.full(n, np.inf)
    best_s = np.zeros(n)
    for i in range(centers.shape[0] - 1):
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
    r = np.sqrt(best_d2)
    nearest = np.abs(best_s[:, None] - cum[None, :]).argmin(axis=1)
    radii = np.full(centers.shape[0], np.nan)
    for i in range(centers.shape[0]):
        m = nearest == i
        if bool(m.any()):
            radii[i] = float(r[m].mean())
    if np.isnan(radii).any():
        good = ~np.isnan(radii)
        if good.any():
            radii = np.interp(np.arange(centers.shape[0]), np.flatnonzero(good), radii[good])
        else:
            radii[:] = float(r.mean())
    return radii, float(cum[-1])


def _pca(points):
    """Centroid + right singular vectors (rows = axes, descending) + singular values."""
    c = points.mean(axis=0)
    _, s, vt = np.linalg.svd(points - c, full_matrices=False)
    return c, vt, s


def _fit_straight(points, a, b, n_samples):
    """PCA line through the centroid; extent = full patch, or the A/B region."""
    c, vt, _ = _pca(points)
    d = vt[0]
    proj = (points - c) @ d
    lo, hi = float(proj.min()), float(proj.max())
    if a is not None and b is not None:
        sa = float((a - c) @ d)
        sb = float((b - c) @ d)
        rlo, rhi = min(sa, sb), max(sa, sb)
        # Only honour the hint region when it is a meaningful slice of the channel.
        if rhi - rlo >= 0.1 * (hi - lo):
            lo, hi = rlo, rhi
    p0 = c + lo * d
    p1 = c + hi * d
    ts = np.linspace(0.0, 1.0, n_samples)
    centers = p0[None, :] + ts[:, None] * (p1 - p0)[None, :]
    radii, _ = _radii_along(points, centers)
    length = float(np.linalg.norm(p1 - p0))
    return centers, radii, length, False


def _fit_ring(points, a, b, n_samples):
    """Least-squares circle in the wall's best-fit plane -> the full loop."""
    c, vt, _ = _pca(points)
    e1, e2 = vt[0], vt[1]  # in-plane basis (largest spread); vt[2] = plane normal
    x = (points - c) @ e1
    y = (points - c) @ e2
    # Kasa algebraic circle fit: minimise |x^2 + y^2 - (2*cx*x + 2*cy*y + k)|.
    amat = np.column_stack([2 * x, 2 * y, np.ones_like(x)])
    bvec = x * x + y * y
    sol, *_ = np.linalg.lstsq(amat, bvec, rcond=None)
    cx, cy, k = sol
    radius_ring = float(np.sqrt(max(k + cx * cx + cy * cy, 0.0)))
    center3 = c + cx * e1 + cy * e2

    theta0 = 0.0
    theta1 = 2.0 * np.pi
    closed = True
    if a is not None and b is not None:
        # An A/B hint selects the arc A->B (the longer way, so it still covers most
        # of the channel); moving A/B slides the arc around the ring.
        ta = float(np.arctan2((a - center3) @ e2, (a - center3) @ e1))
        tb = float(np.arctan2((b - center3) @ e2, (b - center3) @ e1))
        span = (tb - ta) % (2.0 * np.pi)
        if span < np.pi:  # take the major arc
            ta, tb = tb, ta
            span = 2.0 * np.pi - span
        theta0, theta1, closed = ta, ta + span, False

    thetas = np.linspace(theta0, theta1, n_samples, endpoint=not closed)
    centers = center3[None, :] + radius_ring * (
        np.cos(thetas)[:, None] * e1[None, :] + np.sin(thetas)[:, None] * e2[None, :]
    )
    # For radius measurement + arc length, walk the loop closing back to the start.
    loop = np.vstack([centers, centers[:1]]) if closed else centers
    radii, length = _radii_along(points, loop)
    return centers, radii[: centers.shape[0]], length, closed


def _looks_straight(points):
    """One dominant PCA axis (elongated tube) vs a planar cloud (ring)."""
    _, _, s = _pca(points)
    if s[0] <= 0:
        return True
    # s[1]/s[0] small => a single long axis (straight); comparable => planar (ring).
    return (s[1] / s[0]) < 0.35


def extract_centerline(points, shape="auto", a=None, b=None, n_samples=DEFAULT_SAMPLES):
    """Fit `shape` to the wall cloud and return (centers (M,3), radii (M,), length,
    fitted_shape, closed). a/b are optional hint points (may be None)."""
    points = np.asarray(points, dtype=float)
    if points.ndim != 2 or points.shape[1] != 3 or points.shape[0] < MIN_POINTS:
        raise ValueError("need at least a few 3D wall points")
    a = None if a is None else np.asarray(a, dtype=float)
    b = None if b is None else np.asarray(b, dtype=float)
    if shape not in SHAPES:
        raise ValueError(f"shape must be one of {SHAPES}")

    resolved = shape
    if resolved == "auto":
        resolved = "straight" if _looks_straight(points) else "ring"

    if resolved == "straight":
        centers, radii, length, closed = _fit_straight(points, a, b, n_samples)
    else:
        centers, radii, length, closed = _fit_ring(points, a, b, n_samples)
    if centers.shape[0] < 2:
        raise ValueError("could not fit a centerline to this patch")
    return centers, radii, length, resolved, closed


def _read_wall_points(case_dir, patch):
    """Read a wall patch's surface point cloud from an OpenFOAM case via PyVista
    (same reader path as extractPatches.py)."""
    import pyvista as pv

    foam = os.path.join(case_dir, "case.foam")
    if not os.path.exists(foam):
        open(foam, "a").close()
    reader = pv.OpenFOAMReader(foam)
    reader.enable_all_patch_arrays()
    try:  # skip the internal volume mesh - we only need the wall surface
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
    argv = sys.argv
    # <case> <patch> <shape> <out.json> [ax ay az bx by bz]
    if len(argv) not in (5, 11) or argv[3] not in SHAPES:
        sys.stderr.write(
            "usage: python extractCenterline.py <caseDirOrFoamFile> <wallPatch> "
            "<auto|straight|ring> <out.json> [<ax> <ay> <az> <bx> <by> <bz>]\n"
        )
        sys.exit(2)

    arg_case, patch, shape, out_json = argv[1], argv[2], argv[3], argv[4]
    a = b = None
    if len(argv) == 11:
        try:
            a = [float(argv[5]), float(argv[6]), float(argv[7])]
            b = [float(argv[8]), float(argv[9]), float(argv[10])]
        except ValueError:
            sys.stderr.write("KO: hint coordinates must be numbers\n")
            sys.exit(1)

    try:
        if os.path.isfile(arg_case) and arg_case.lower().endswith(".foam"):
            case_dir = os.path.dirname(os.path.abspath(arg_case)) or "."
        else:
            case_dir = os.path.abspath(arg_case)

        points = _read_wall_points(case_dir, patch)
        centers, radii, length, resolved, closed = extract_centerline(points, shape, a, b)
        with open(out_json, "w") as fh:
            json.dump(
                {
                    "centerline": centers.tolist(),
                    "radii": radii.tolist(),
                    "length": length,
                    "shape": resolved,
                    "closed": bool(closed),
                },
                fh,
            )
        sys.stdout.write(
            "OK: %s centerline, %d points -> %s\n" % (resolved, centers.shape[0], out_json)
        )
        sys.exit(0)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - one-shot CLI, report and fail.
        sys.stderr.write("KO: %s\n" % exc)
        sys.exit(1)


if __name__ == "__main__":
    main()

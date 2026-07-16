#!/usr/bin/env python3
"""Extract a pipe/channel centerline (+ radius profile) from an OpenFOAM wall patch.

Used by the diameter-optimization "Optimisation" tab: given a wall patch and the
two endpoints the user clicked, this recovers the polyline running along the
channel axis and the mean wall radius at each point along it. The polyline is
FROZEN into the study's MorphDefinition so the browser preview and the
server-side morph both measure the radial scale from the identical axis.

Algorithm (pure numpy, unit-testable on synthetic tubes without OpenFOAM). The
first version binned points along the straight A->B CHORD, which zigzagged badly
on anything that curls back on itself (a turbine volute / spiral casing: each
chord slab catches points from several limbs of the spiral). The current
algorithm follows the WALL instead:

  1. Subsample the wall point cloud and build a k-NN graph on it, then walk the
     SHORTEST PATH along the wall from A to B (Dijkstra). This path follows the
     channel around bends and spirals - it can never jump across the void
     between two limbs, because the graph only connects nearby wall points.
  2. Smooth + arc-length-resample that wall path into stations. At each station,
     cut a thin slab perpendicular to the LOCAL path tangent, keep only the near
     ring of wall points (a distance-gap cut drops other limbs of a spiral, and
     an iterative median rejection drops stragglers), and take the ring's
     centroid as the centerline point and its mean perpendicular distance as the
     local radius.
  3. Smooth the resulting centerline.

If A and B are not connected along the wall (degenerate patch), it falls back to
the original chord binning.

CLI usage (two or more waypoints, in order; intermediate ones are via points that
disambiguate the route - e.g. the far side of a closed ring for a full tour):
    python extractCenterline.py <caseDirOrFoamFile> <wallPatch> \
        <out_centerline.json> <ax> <ay> <az> [<vx> <vy> <vz> ...] <bx> <by> <bz>

Success/failure contract (mirrors extractPatches.py):
  * On success: print "OK: ..." to stdout, write the JSON, exit 0.
  * On failure: print "KO: ..." to stderr, exit 1.
  * On a usage error (wrong argc): print usage to stderr, exit 2.

Output JSON: { "centerline": [[x,y,z], ...], "radii": [r0, r1, ...],
               "length": <polyline arc-length> } - radii[i] is the mean wall
radius at centerline[i]; the diameter there is 2*radii[i].
"""

import heapq
import json
import os
import sys

import numpy as np

# Stations sampled along the channel. Sparse/invalid stations are skipped, so this
# is an upper bound on the centerline resolution, not a fixed count.
DEFAULT_SAMPLES = 40
# A station's ring needs at least this many wall points for a trustworthy center.
MIN_RING_POINTS = 6
# Wall-graph size cap (Dijkstra runs on a subsample; the slabs use ALL points).
MAX_GRAPH_POINTS = 3000
KNN = 12


# --------------------------------------------------------------------------
# Wall-path (Dijkstra) machinery
# --------------------------------------------------------------------------

def _subsample(points, cap):
    """Deterministically subsample the cloud for the graph (slabs use all points)."""
    n = points.shape[0]
    if n <= cap:
        return points
    idx = np.random.default_rng(0).choice(n, cap, replace=False)
    return points[idx]


def _knn(Q, k):
    """Brute-force k nearest neighbours (indices + distances), chunked for memory."""
    m = Q.shape[0]
    k = min(k, m - 1)
    nbrs = np.empty((m, k), dtype=np.int64)
    nbrd = np.empty((m, k))
    chunk = 512
    for s in range(0, m, chunk):
        e = min(m, s + chunk)
        d2 = ((Q[s:e, None, :] - Q[None, :, :]) ** 2).sum(-1)
        for row in range(e - s):
            d2[row, s + row] = np.inf  # no self-edges
        idx = np.argpartition(d2, k - 1, axis=1)[:, :k]
        nbrs[s:e] = idx
        nbrd[s:e] = np.sqrt(np.take_along_axis(d2, idx, axis=1))
    return nbrs, nbrd


def _dijkstra_path(Q, start, goal, nbrs, nbrd):
    """Shortest path start->goal on the symmetrized k-NN graph, or None."""
    m = Q.shape[0]
    adj = [[] for _ in range(m)]
    for i in range(m):
        for jj in range(nbrs.shape[1]):
            j = int(nbrs[i, jj])
            w = float(nbrd[i, jj])
            adj[i].append((j, w))
            adj[j].append((i, w))
    dist = np.full(m, np.inf)
    parent = np.full(m, -1, dtype=np.int64)
    done = np.zeros(m, dtype=bool)
    dist[start] = 0.0
    heap = [(0.0, int(start))]
    while heap:
        d, u = heapq.heappop(heap)
        if done[u]:
            continue
        done[u] = True
        if u == goal:
            break
        for v, w in adj[u]:
            nd = d + w
            if nd < dist[v]:
                dist[v] = nd
                parent[v] = u
                heapq.heappush(heap, (nd, v))
    if not done[goal]:
        return None
    path = [int(goal)]
    while path[-1] != start:
        path.append(int(parent[path[-1]]))
    return Q[np.array(path[::-1], dtype=np.int64)]


def _smooth(W, win):
    """Moving-average smooth a polyline (endpoints pinned)."""
    n = W.shape[0]
    if n < 3:
        return W
    win = min(win, n if n % 2 == 1 else n - 1)
    if win < 3:
        return W
    if win % 2 == 0:
        win += 1
    half = win // 2
    pad = np.vstack([np.repeat(W[:1], half, axis=0), W, np.repeat(W[-1:], half, axis=0)])
    kern = np.ones(win) / win
    out = np.stack([np.convolve(pad[:, i], kern, mode="valid") for i in range(3)], axis=1)
    out[0] = W[0]
    out[-1] = W[-1]
    return out


def _resample(W, n):
    """Arc-length resample a polyline to n points. Returns (points, total_length)."""
    seg = np.linalg.norm(np.diff(W, axis=0), axis=1)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    total = float(cum[-1])
    if total <= 0.0:
        return W[:1].repeat(n, axis=0), 0.0
    s = np.linspace(0.0, total, n)
    out = np.stack([np.interp(s, cum, W[:, i]) for i in range(3)], axis=1)
    return out, total


def _ring_center(P, w, t, h):
    """Center + radius of the wall ring at station (w, tangent t), slab half-width h.

    Keeps the NEAR ring only: a distance-gap cut drops other limbs of a spiral
    (their distances from w jump by at least a wall thickness), then an iterative
    median rejection drops stragglers. Returns (center, radius) or None.
    """
    axial = (P - w) @ t
    sel = P[np.abs(axial) <= h]
    if sel.shape[0] < MIN_RING_POINTS:
        return None
    # Gap cut on distance from the station's wall point. A neighbouring limb of a
    # spiral sits at least a wall thickness beyond the local ring, so its sorted
    # distances jump by a large RELATIVE step; the small steps of a discretized
    # ring must never trigger the cut (that chopped the far side of the ring and
    # biased the center off-axis).
    d = np.linalg.norm(sel - w, axis=1)
    order = np.argsort(d)
    ds = d[order]
    j0 = max(MIN_RING_POINTS, int(0.2 * ds.size))
    if ds.size > j0 + 1:
        seg = ds[j0:]
        jumps = seg[1:] - seg[:-1]
        rel = jumps / np.maximum(seg[:-1], 1e-30)
        big = np.flatnonzero((rel > 0.9) & (jumps > 0.3 * ds[j0]))
        if big.size:
            sel = sel[order[: j0 + int(big[0]) + 1]]
    if sel.shape[0] < MIN_RING_POINTS:
        return None
    # Iterative centroid with median rejection (perpendicular to the tangent).
    c = sel.mean(axis=0)
    for _ in range(3):
        rel_p = sel - c
        perp = rel_p - np.outer(rel_p @ t, t)
        r = np.linalg.norm(perp, axis=1)
        med = float(np.median(r))
        keep = r <= 1.8 * med + 1e-30
        if int(keep.sum()) < MIN_RING_POINTS:
            break
        sel = sel[keep]
        c = sel.mean(axis=0)
    rel_p = sel - c
    perp = rel_p - np.outer(rel_p @ t, t)
    radius = float(np.linalg.norm(perp, axis=1).mean())
    return c, radius


def _ring_pass(points, guide, n_samples, spacing):
    """One slicing pass: resample the guide polyline into stations, take the wall
    ring at each station (slab perpendicular to the local tangent), and return
    (centers, radii) - or None when too few stations produce a valid ring."""
    dense, total = _resample(_smooth(guide, 5), max(2 * n_samples, 24))
    if total <= 0.0:
        return None
    dense = _smooth(dense, 5)
    stations, total = _resample(dense, n_samples)
    tangents = np.gradient(stations, axis=0)
    norms = np.linalg.norm(tangents, axis=1, keepdims=True)
    tangents = tangents / np.maximum(norms, 1e-30)
    ds = total / max(n_samples - 1, 1)
    h = max(0.75 * ds, 2.0 * spacing)

    centers = []
    radii = []
    for i in range(stations.shape[0]):
        ring = _ring_center(points, stations[i], tangents[i], h)
        if ring is not None:
            centers.append(ring[0])
            radii.append(ring[1])
    if len(centers) < 2:
        return None
    return np.asarray(centers), np.asarray(radii, dtype=float)


# --------------------------------------------------------------------------
# Chord fallback (the original algorithm; only for a degenerate wall graph)
# --------------------------------------------------------------------------

def _chord_centerline(points, a, b, n_samples):
    axis = b - a
    chord = float(np.linalg.norm(axis))
    if chord <= 0.0:
        raise ValueError("the two endpoints coincide")
    proj = (points - a) @ (axis / chord)
    edges = np.linspace(0.0, chord, n_samples + 1)
    centers = []
    for k in range(n_samples):
        upper = proj <= edges[k + 1] if k == n_samples - 1 else proj < edges[k + 1]
        mask = (proj >= edges[k]) & upper
        if int(mask.sum()) >= MIN_RING_POINTS:
            centers.append(points[mask].mean(axis=0))
    if len(centers) < 2:
        raise ValueError("too few populated slabs to fit a centerline")
    centers = np.asarray(centers)
    seg = np.linalg.norm(np.diff(centers, axis=0), axis=1)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    length = float(cum[-1])
    # Radii by nearest-point projection onto the polyline.
    n = points.shape[0]
    best_d2 = np.full(n, np.inf)
    best_s = np.zeros(n)
    for i in range(centers.shape[0] - 1):
        aa = centers[i]
        d = centers[i + 1] - aa
        seg2 = float(d @ d)
        if seg2 <= 0.0:
            continue
        t = np.clip(((points - aa) @ d) / seg2, 0.0, 1.0)
        foot = aa + t[:, None] * d
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
        radii = np.interp(np.arange(centers.shape[0]), np.flatnonzero(good), radii[good])
    return centers, radii, length


# --------------------------------------------------------------------------
# Public entry point
# --------------------------------------------------------------------------

def extract_centerline(points, waypoints, n_samples=DEFAULT_SAMPLES):
    """Recover the centerline polyline + per-point radius from a wall point cloud.

    points: (N,3) wall vertices. waypoints: (K>=2, 3) clicked points, in order -
    the wall path is walked leg by leg (A -> via1 -> ... -> B). Intermediate via
    points disambiguate the route: a shortest path between just two points on a
    CLOSED channel (a ring) can never cover more than half the loop, so a full
    tour needs A and B side by side plus a via on the far side. Returns
    (centers (M,3), radii (M,), length) or raises ValueError on degenerate input.
    """
    points = np.asarray(points, dtype=float)
    waypoints = np.asarray(waypoints, dtype=float)
    if points.ndim != 2 or points.shape[1] != 3 or points.shape[0] < MIN_RING_POINTS:
        raise ValueError("need at least a few 3D wall points")
    if waypoints.ndim != 2 or waypoints.shape[1] != 3 or waypoints.shape[0] < 2:
        raise ValueError("need at least two waypoints")
    a = waypoints[0]
    b = waypoints[-1]
    if float(np.linalg.norm(b - a)) <= 0.0 and waypoints.shape[0] == 2:
        raise ValueError("the two endpoints coincide")

    # 1) Walk the wall leg by leg through the waypoints.
    Q = _subsample(points, MAX_GRAPH_POINTS)
    nbrs, nbrd = _knn(Q, KNN)
    stops = [int(np.linalg.norm(Q - w, axis=1).argmin()) for w in waypoints]
    legs = []
    for i in range(len(stops) - 1):
        if stops[i] == stops[i + 1]:
            continue  # two clicks snapped to the same wall point: skip the empty leg
        leg = _dijkstra_path(Q, stops[i], stops[i + 1], nbrs, nbrd)
        if leg is None:
            legs = None
            break
        legs.append(leg if not legs else leg[1:])  # drop the duplicated joint node
    wall_path = np.vstack(legs) if legs else None
    if wall_path is None or wall_path.shape[0] < 3:
        return _chord_centerline(points, a, b, n_samples)

    # 2) Ring pass along the wall path, then REFINE: the Dijkstra path wiggles
    #    around the wall (its k-NN steps hop between neighbouring surface points),
    #    so slabs cut along its tangents are slightly oblique and their partial
    #    rings bias the centers toward the path's side. Re-slicing perpendicular
    #    to the AXIS just extracted (which is smooth) removes that bias; two
    #    refinement passes converge.
    spacing = float(np.median(nbrd[:, 0]))
    guide = wall_path
    centers = None
    radii = None
    for _ in range(3):  # 1 wall-path pass + 2 axis refinements
        result = _ring_pass(points, guide, n_samples, spacing)
        if result is None:
            break
        centers, radii = result
        guide = centers
    if centers is None or centers.shape[0] < 2:
        return _chord_centerline(points, a, b, n_samples)

    # 3) Drop the extreme stations (one-sided tangents + half-clipped slabs make
    #    them the only biased ones), then smooth the axis. The morph's blended
    #    zone starts inside the segment anyway (stationA/stationB fractions).
    if centers.shape[0] >= 6:
        centers = centers[1:-1]
        radii = radii[1:-1]
    centers = _smooth(centers, 3)
    seg = np.linalg.norm(np.diff(centers, axis=0), axis=1)
    length = float(seg.sum())
    return centers, np.asarray(radii, dtype=float), length


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
    # argv: <caseDirOrFoamFile> <wallPatch> <out_centerline.json> <x y z> <x y z> [...]
    # At least two waypoints (A and B); intermediate ones are via points, in order.
    if len(sys.argv) < 4 + 6 or (len(sys.argv) - 4) % 3 != 0:
        sys.stderr.write(
            "usage: python extractCenterline.py <caseDirOrFoamFile> <wallPatch> "
            "<out_centerline.json> <ax> <ay> <az> [<vx> <vy> <vz> ...] <bx> <by> <bz>\n"
        )
        sys.exit(2)

    arg_case = sys.argv[1]
    patch = sys.argv[2]
    out_json = sys.argv[3]
    try:
        flat = [float(v) for v in sys.argv[4:]]
    except ValueError:
        sys.stderr.write("KO: waypoint coordinates must be numbers\n")
        sys.exit(1)
    waypoints = [flat[i : i + 3] for i in range(0, len(flat), 3)]

    try:
        if os.path.isfile(arg_case) and arg_case.lower().endswith(".foam"):
            case_dir = os.path.dirname(os.path.abspath(arg_case)) or "."
        else:
            case_dir = os.path.abspath(arg_case)

        points = _read_wall_points(case_dir, patch)
        centers, radii, length = extract_centerline(points, waypoints)
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

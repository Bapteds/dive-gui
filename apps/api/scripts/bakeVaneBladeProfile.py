#!/usr/bin/env python3
"""One-time offline bake: extract the clean guide-vane blade airfoil from the
SolidWorks STEP and commit it as an asset-frame profile the builder turns into
smooth BREP blades for the STEP export.

Why: the baked `guideVanes_blade.stl` is a triangle mesh, so blades cut from it
land in `chamber.step` as faceted prisms. The SolidWorks STEP holds the blade as
NURBS surfaces; its mid-height section is a clean airfoil curve (the vane is
prismatic, so one section defines the whole blade). This script isolates that
blade (the STEP also carries hub+shroud, which the builder regenerates
parametrically and ignores), takes its mid-height airfoil, VERIFIES it is the same
shape as the baked STL blade's airfoil via a 2D similarity fit (guarding against a
stale/edited STEP), and writes the clean airfoil placed in the asset frame at the
reference blade's mid-height section.

The builder (buildChamber.py) later fits this airfoil onto each placed mesh blade
section and lofts a spline through it -> smooth, editable vane faces whose volume
matches the trusted mesh fluid body.

Usage:
    python bakeVaneBladeProfile.py <stepPath> <bladeStl> <outJson>

Success -> prints the fit residual and writes <outJson>. Failure (no matching
blade shell, or airfoils disagree beyond tolerance) -> exits non-zero.
"""
import json
import sys

MAX_DEV_M = 2e-3        # airfoil-overlay tolerance vs the baked STL (2 mm)
FINE_TESS_MM = 0.3      # STEP shell tessellation deflection (mm) for a smooth section
N_AIRFOIL = 160         # resampled airfoil loop point count


def _shell_metrics(np, P):
    r = np.hypot(P[:, 0], P[:, 1])
    z = P[:, 2]
    th = np.sort(np.degrees(np.arctan2(P[:, 1], P[:, 0])))
    gaps = np.diff(np.concatenate([th, [th[0] + 360.0]]))
    return float(r.min()), float(r.max()), float(z.max() - z.min()), float(360.0 - gaps.max())


def _mid_section_loop(np, trimesh, Polygon, tm):
    """Closed mid-height airfoil ring (M,2) of a blade trimesh."""
    z = tm.vertices[:, 2]
    zc = 0.5 * (float(z.min()) + float(z.max()))
    sec = tm.section(plane_origin=[0.0, 0.0, zc], plane_normal=[0.0, 0.0, 1.0])
    if sec is None:
        raise RuntimeError("empty mid-height section")
    loop = max(sec.discrete, key=len)
    poly = Polygon(loop[:, :2])
    if not poly.is_valid:
        poly = poly.buffer(0.0)
    return np.asarray(poly.exterior.coords, dtype=float)[:-1], zc


def _resample_closed(np, ring, n):
    """Uniform arc-length resample of a closed ring to n points."""
    closed = np.vstack([ring, ring[:1]])
    seg = np.diff(closed, axis=0)
    cum = np.concatenate([[0.0], np.cumsum(np.hypot(seg[:, 0], seg[:, 1]))])
    t = np.linspace(0.0, cum[-1], n, endpoint=False)
    return np.column_stack([np.interp(t, cum, closed[:, 0]), np.interp(t, cum, closed[:, 1])])


def _similarity(np, X, Y):
    """Best 2D similarity (scale c, rot R, trans t) mapping X->Y (Umeyama); returns
    (c, R, t, maxdev)."""
    muX, muY = X.mean(0), Y.mean(0)
    Xc, Yc = X - muX, Y - muY
    varX = (Xc ** 2).sum() / len(X)
    Sigma = (Yc.T @ Xc) / len(X)
    U, D, Vt = np.linalg.svd(Sigma)
    S = np.eye(2)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        S[-1, -1] = -1.0
    R = U @ S @ Vt
    c = float((D * np.diag(S)).sum() / varX)
    t = muY - c * (R @ muX)
    XT = (c * (R @ X.T).T) + t
    dev = float(np.hypot(*(XT - Y).T).max())
    return c, R, t, dev


def _best_fit(np, src, tgt):
    """Fit closed loop `src` onto `tgt` over all cyclic shifts + reversal. Both are
    (n,2) arc-length-resampled. Returns (c, R, t, maxdev)."""
    n = len(src)
    best = None
    for rev in (src, src[::-1]):
        for sh in range(n):
            X = np.roll(rev, sh, axis=0)
            c, R, t, dev = _similarity(np, X, tgt)
            if best is None or dev < best[3]:
                best = (c, R, t, dev)
    return best


def main():
    if len(sys.argv) != 4:
        sys.stderr.write("usage: python bakeVaneBladeProfile.py <stepPath> <bladeStl> <outJson>\n")
        sys.exit(2)
    step_path, blade_stl, out_json = sys.argv[1], sys.argv[2], sys.argv[3]

    import numpy as np
    import trimesh
    import cadquery as cq
    from shapely.geometry import Polygon

    # --- reference blade airfoil (asset frame) ---
    stl = trimesh.load(blade_stl)
    S = np.asarray(stl.vertices, dtype=float)
    s_rmin, s_rmax, s_zH, s_az = _shell_metrics(np, S)
    stl_ring, _ = _mid_section_loop(np, trimesh, Polygon, stl)
    stl_af = _resample_closed(np, stl_ring, N_AIRFOIL)

    # --- STEP: pick the blade shell (radial span/height/azimuth match the STL) ---
    imp = cq.importers.importStep(step_path)
    shells = imp.shells().vals()
    if not shells:
        sys.stderr.write("KO: STEP has no shells\n")
        sys.exit(1)
    best = None
    for sh in shells:
        v, f = sh.tessellate(FINE_TESS_MM)
        V = np.array([[p.x, p.y, p.z] for p in v], dtype=float) / 1000.0
        F = np.array(f, dtype=np.int64)
        rmin, rmax, zH, az = _shell_metrics(np, V)
        score = abs(rmin - s_rmin) + abs(rmax - s_rmax) + abs(zH - s_zH) + abs(az - s_az) / 100.0
        if best is None or score < best[0]:
            best = (score, V, F, (rmin, rmax, zH, az))
    _sc, V, F, bm = best
    sys.stderr.write("blade shell r[%.3f,%.3f] zH=%.3f az=%.1f (STL r[%.3f,%.3f] zH=%.3f az=%.1f)\n"
                     % (bm[0], bm[1], bm[2], bm[3], s_rmin, s_rmax, s_zH, s_az))
    if abs(bm[0] - s_rmin) > 0.05 or abs(bm[2] - s_zH) > 0.05:
        sys.stderr.write("KO: no STEP shell matches the baked blade (wrong STEP?)\n")
        sys.exit(1)

    step_tm = trimesh.Trimesh(vertices=V, faces=F, process=False)
    step_ring, step_zc = _mid_section_loop(np, trimesh, Polygon, step_tm)
    step_af = _resample_closed(np, step_ring, N_AIRFOIL)

    # --- verify same airfoil + align STEP airfoil onto the STL asset-frame section ---
    c, R, t, dev = _best_fit(np, step_af, stl_af)
    sys.stderr.write("airfoil fit: scale=%.5f maxDev=%.5f m (npts step=%d stl=%d)\n"
                     % (c, dev, len(step_ring), len(stl_ring)))
    if dev > MAX_DEV_M:
        sys.stderr.write("KO: airfoil overlay dev %.5f m exceeds %.5f m tolerance\n" % (dev, MAX_DEV_M))
        sys.exit(1)

    # Place the CLEAN STEP airfoil into the STL asset-frame section (apply the fit but
    # drop the ~1.0 scale so we keep the STEP's true asset-scale geometry, only rotate
    # + translate onto the reference section).
    Rn = R  # rotation only (scale≈1); translation re-derived without scaling
    src_c = step_af.mean(0)
    tgt_c = stl_af.mean(0)
    aligned = (Rn @ (step_af - src_c).T).T + tgt_c

    out = {
        "airfoil": [[round(float(x), 6), round(float(y), 6)] for x, y in aligned],
        "sectionZAsset": round(float(step_zc), 6),
        "frame": "asset (metres); STEP airfoil rotated/translated onto guideVanes_blade.stl mid-section",
        "provenance": "%s -> 2D airfoil fit scale=%.5f maxDevM=%.5f" % (
            step_path.replace("\\", "/").split("/")[-1], c, dev),
        "maxDevM": round(float(dev), 6),
        "fitScale": round(float(c), 6),
    }
    with open(out_json, "w") as fh:
        json.dump(out, fh, indent=2)
    sys.stderr.write("OK: wrote %d airfoil points to %s\n" % (len(aligned), out_json))


if __name__ == "__main__":
    main()

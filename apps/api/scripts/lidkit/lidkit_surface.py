#!/usr/bin/env python3
"""
lidkit_surface.py — LID ITERATION KIT, step 1: free-surface estimate from a converged rigid-lid simpleFoam run.

    z_s(x,y) = Z_LID + (p_lid - p0_ref) / g          (p kinematic [m^2/s^2], g = 9.81)

p0_ref = area mean of (p + |U|^2/2) over the inlet patch = the total head of the head water, so the surface is
referenced to the reservoir level Z_LID with NO anchor point (p on the lid is piezometric, the velocity head cancels).
Exact for any lid shape, so the same tool serves iteration 0 (flat lid) and every fitted lid.  For the totalPressure
inlet family p0_ref comes out ~0 automatically; --p0 overrides it.

Input: the `lidSurfaces` export of the run (postProcessing/lidSurfaces/<t>/{lid,inlet}.vtk, legacy ASCII VTK with cell
data p and U — see lidkit_case_templates/lidSurfaces).  Output: <out>.npy with columns x, y, z_s, area (face centres of
the CURRENT lid) + <out>.json with statistics and the LID RESIDUAL |z_s - z_lid(current mesh)| (RMS, max): the
convergence measure of the iteration (converged when the RMS is a few mm).
Optional ring statistics about a machine axis (--axis x,y --rings r0:r1,...) and a datum relative to an undisturbed
region (--datum-y y0: mean z_s over y < y0), as used in the VIE validation.

usage: lidkit_surface.py <postProcessing/lidSurfaces/<t>> <out.npy> --z-lid 1.485 [--lid lid.vtk] [--inlet inlet.vtk]
                         [--p0 <m2/s2>] [--axis x,y] [--rings 1.394:1.537,1.537:1.75] [--datum-y -2.5]
"""
import os, sys, json, argparse
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from vtk_reader import read_vtk_polydata, face_geometry
G = 9.81

def load_patch(path):
    m = read_vtk_polydata(path); P = np.asarray(m["points"]); F = m["faces"]; C, A, _ = face_geometry(P, F)
    return C, A, np.asarray(m["cell_data"]["p"], float), np.asarray(m["cell_data"]["U"], float)

def run(d, out, Z_LID, lid="lid.vtk", inlet="inlet.vtk", p0=None, axis=None, rings=(), datum_y=None):
    d = d.rstrip("/")
    if p0 is None:
        Ci, Ai, pi, Ui = load_patch(os.path.join(d, inlet)); p0 = float(np.sum(Ai * (pi + 0.5 * (Ui ** 2).sum(1))) / Ai.sum())
    C, A, p, U = load_patch(os.path.join(d, lid))
    zs = Z_LID + (p - p0) / G; resid = (zs - C[:, 2]) * 1000
    wm = lambda s, v: float(np.sum(A[s] * v[s]) / A[s].sum()) if s.any() else None
    rep = {"source": os.path.abspath(d), "z_lid": Z_LID, "p0_ref_m2s2": p0, "n_lid_faces": int(len(zs)), "lid_area_m2": float(A.sum()),
           "zs_vs_Z_LID_mm": {"mean": wm(np.ones(len(zs), bool), (zs - Z_LID) * 1000), "min": float((zs.min() - Z_LID) * 1000), "max": float((zs.max() - Z_LID) * 1000),
                              "min_xy": C[np.argmin(zs), :2].round(3).tolist()},
           "lid_residual_mm": {"rms": float(np.sqrt(np.sum(A * resid ** 2) / A.sum())), "max_abs": float(np.abs(resid).max()), "mean": float(np.sum(A * resid) / A.sum())}}
    if datum_y is not None:
        ref = C[:, 1] < datum_y; zref = wm(ref, zs); rel = (zs - zref) * 1000
        rep["datum"] = {"region": f"y < {datum_y}", "level_vs_Z_LID_mm": (zref - Z_LID) * 1000, "lid_mean_vs_datum_mm": wm(np.ones(len(zs), bool), rel), "min_vs_datum_mm": float(rel.min())}
    else: rel = (zs - Z_LID) * 1000
    if axis is not None:
        r = np.hypot(C[:, 0] - axis[0], C[:, 1] - axis[1]); th = np.degrees(np.arctan2(C[:, 1] - axis[1], C[:, 0] - axis[0])) % 360
        rep["axis"] = list(axis); rep["rings"] = {}
        for r0, r1 in rings:
            s = (r >= r0) & (r < r1)
            if not s.any(): rep["rings"][f"{r0}:{r1}"] = None; continue
            sec = [wm(s & (th >= a) & (th < a + 10), rel) for a in range(0, 360, 10)]
            i = int(np.argmin(np.where(s, rel, np.inf)))
            rep["rings"][f"{r0}:{r1}"] = {"mean_mm": wm(s, rel), "min_mm": float(rel[i]), "min_theta_deg": float(th[i]),
                                          "sector10_mean_mm": [None if v is None else round(v, 1) for v in sec],
                                          "deepest_sector": [int(10 * int(np.nanargmin([np.nan if v is None else v for v in sec]))), round(float(np.nanmin([np.nan if v is None else v for v in sec])), 1)]}
    np.save(out, np.c_[C[:, 0], C[:, 1], zs, A]); json.dump(rep, open(os.path.splitext(out)[0] + ".json", "w"), indent=1)
    print(json.dumps(rep, indent=1)); return rep

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("lidSurfaces_dir"); ap.add_argument("out_npy"); ap.add_argument("--z-lid", type=float, required=True)
    ap.add_argument("--lid", default="lid.vtk"); ap.add_argument("--inlet", default="inlet.vtk"); ap.add_argument("--p0", type=float, default=None)
    ap.add_argument("--axis", default=None); ap.add_argument("--rings", default=""); ap.add_argument("--datum-y", type=float, default=None)
    a = ap.parse_args()
    axis = tuple(map(float, a.axis.split(","))) if a.axis else None
    rings = [tuple(map(float, r.split(":"))) for r in a.rings.split(",") if r]
    run(a.lidSurfaces_dir, a.out_npy, a.z_lid, a.lid, a.inlet, a.p0, axis, rings, a.datum_y)

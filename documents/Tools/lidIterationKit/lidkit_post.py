#!/usr/bin/env python3
"""lidkit_post.py <config.json> <k> — post-processing of lid iteration k: (a) the lid of the iteration-k mesh (= the fitted
surface, or the flat lid for k = 0), (b) the new surface estimate z_s, (c) the residual z_s - z_lid (what the next iteration
would change), (d) history of the residual RMS and dp0 over the iterations, (e) 10-deg sector profiles of the rings about
the machine axis (if `axis` / `rings` are set in the config) for every iteration so far.
Writes <work_dir>/lidIter<k>_summary.png and lidIter<k>_summary.json."""
import os, sys, json, glob, numpy as np
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
from matplotlib.collections import PolyCollection
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from vtk_reader import read_vtk_polydata, face_geometry
import lidkit as K

cfg, k = sys.argv[1], int(sys.argv[2]); c = K.load(cfg); ZW = c["z_lid"]; W = c["work_dir"]
C = K.case_dir(c, k); lidvtk = max(glob.glob(os.path.join(C, "postProcessing", "lidSurfaces", "*", "lid.vtk")), key=lambda p: float(p.split("/")[-2]))
m = read_vtk_polydata(lidvtk); P = np.asarray(m["points"]); F = m["faces"]; Cc, A, _ = face_geometry(P, F)
z = np.load(os.path.join(W, f"zs_iter{k}.npy")); assert len(z) == len(Cc), "zs_iter{k}.npy does not match the lid export — rerun 'surface k'"
zs_new, zlid = z[:, 2], Cc[:, 2]; res = (zs_new - zlid) * 1000
nz = np.array([np.cross(P[f][1] - P[f][0], P[f][2] - P[f][0]) for f in F]); horiz = np.abs(nz[:, 2]) / np.maximum(np.linalg.norm(nz, axis=1), 1e-30) > 0.5   # drop upstands / cliffs
polys = [P[f][:, :2] for i, f in enumerate(F) if horiz[i]]
hist = []
for j in range(0, k + 1):
    fj = os.path.join(W, f"zs_iter{j}.json")
    if os.path.isfile(fj): jj = json.load(open(fj)); hist.append((j, jj["lid_residual_mm"]["rms"], jj["zs_vs_Z_LID_mm"]["min"], jj["zs_vs_Z_LID_mm"]["mean"], K.dp0(K.case_dir(c, j))))
axis = c.get("axis"); rings = c.get("rings", [])
fig = plt.figure(figsize=(22, 13 if axis else 8)); gs = fig.add_gridspec(2 if axis else 1, 3, height_ratios=[1.3, 1] if axis else [1])
def panel(ax, val, label, cmap, clim, title):
    pc = PolyCollection(polys, array=val[horiz], cmap=cmap, edgecolors="none"); pc.set_clim(*clim); ax.add_collection(pc); ax.autoscale(); ax.set_aspect("equal")
    fig.colorbar(pc, ax=ax, label=label, shrink=0.85); ax.set_title(title, fontsize=10)
    if axis:
        t = np.linspace(0, 2 * np.pi, 300)
        for r0, r1 in rings:
            for R in (r0, r1): ax.plot(axis[0] + R * np.cos(t), axis[1] + R * np.sin(t), "k-", lw=0.6)
lo = min((zlid.min() - ZW) * 1000, (zs_new.min() - ZW) * 1000)
panel(fig.add_subplot(gs[0, 0]), (zlid - ZW) * 1000, "mm vs Z_LID", "viridis", (lo, 0), f"iter {k}: lid of THIS mesh ({'flat parent lid' if k == 0 else 'fitted to z_s of iter ' + str(k-1)})")
panel(fig.add_subplot(gs[0, 1]), (zs_new - ZW) * 1000, "mm vs Z_LID", "viridis", (lo, 0), f"iter {k}: NEW surface estimate z_s = Z_LID + (p_lid - p0_inlet)/g")
rms = float(np.sqrt(np.sum(A[horiz] * res[horiz] ** 2) / A[horiz].sum()))
panel(fig.add_subplot(gs[0, 2]), res, "z_s(new) - z_lid [mm]  (+ = surface wants to rise)", "RdBu_r", (-20, 20), f"lid residual after iter {k}: RMS {rms:.1f} mm, max |{np.abs(res[horiz]).max():.0f}| mm  (tol {c['tol_rms_mm']} mm)")
out = {"iteration": k, "lid_vtk": lidvtk, "residual_rms_mm": rms, "residual_max_mm": float(np.abs(res[horiz]).max()), "history": [{"iter": h[0], "residual_rms_mm": h[1], "zs_min_mm": h[2], "zs_mean_mm": h[3], "dp0": h[4]} for h in hist]}
if axis:
    r = np.hypot(Cc[:, 0] - axis[0], Cc[:, 1] - axis[1]); th = np.degrees(np.arctan2(Cc[:, 1] - axis[1], Cc[:, 0] - axis[0])) % 360
    tb = np.arange(0, 361, 10); tc = 0.5 * (tb[1:] + tb[:-1]); out["sectors"] = {}
    axs = [fig.add_subplot(gs[1, 0:2]), fig.add_subplot(gs[1, 2])] if len(rings) >= 2 else [fig.add_subplot(gs[1, :])]
    for ax, (r0, r1) in zip(axs, rings[:2]):
        out["sectors"][f"{r0}:{r1}"] = {}
        for j in range(0, k + 1):
            zj = os.path.join(W, f"zs_iter{j}.npy")
            if not os.path.isfile(zj): continue
            d = np.load(zj); rj = np.hypot(d[:, 0] - axis[0], d[:, 1] - axis[1]); tj = np.degrees(np.arctan2(d[:, 1] - axis[1], d[:, 0] - axis[0])) % 360; hj = (d[:, 2] - ZW) * 1000
            prof = np.array([np.sum(d[s, 3] * hj[s]) / d[s, 3].sum() if (s := (rj >= r0) & (rj < r1) & (tj >= tb[i]) & (tj < tb[i + 1])).any() else np.nan for i in range(36)])
            ax.plot(tc, prof, "o-" if j == k else "s--", ms=3, label=f"z_s of iter {j}  (ring mean {np.nanmean(prof):.0f}, min {np.nanmin(prof):.0f} @ {tc[np.nanargmin(prof)]:.0f} deg)")
            out["sectors"][f"{r0}:{r1}"][f"iter{j}"] = [None if np.isnan(v) else round(float(v), 1) for v in prof]
        ax.axhline(0, color="k", lw=1, label="Z_LID"); ax.set_xlim(0, 360); ax.set_xticks(range(0, 361, 30)); ax.grid(alpha=.3); ax.legend(fontsize=8); ax.set_xlabel("azimuth about the axis [deg]"); ax.set_ylabel("mm vs Z_LID")
        ax.set_title(f"ring r {r0}..{r1} m: 10 deg sector means of z_s per iteration", fontsize=10)
fig.suptitle(f"{c['name']} — lid iteration {k}    history (iter: residual RMS mm | dp0 Pa): " + "  ".join(f"{h[0]}: {h[1]:.1f} | {h[4]}" for h in hist), fontsize=11)
plt.tight_layout(); png = os.path.join(W, f"lidIter{k}_summary.png"); plt.savefig(png, dpi=110); json.dump(out, open(png.replace(".png", ".json"), "w"), indent=1); print("wrote", png)

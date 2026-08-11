"""Verify outlet sizing + hub/shroud profile preservation for a guide-vane build.
Usage: python _verify_outlet_ratio.py <out_dir> [<expected_outer_d_m> <expected_ratio>]
Reuses the debug dump written by buildChamber.py when CHAMBER_DEBUG_DUMP=1 (core.stl,
casing.stl, F.stl, meta.json) plus the emitted exports/trisurface.zip patches.
Exits 0 if all checks pass, 1 otherwise."""
import io, json, os, sys, zipfile
import numpy as np, trimesh

out_dir = sys.argv[1]
expected_outer_d = float(sys.argv[2]) if len(sys.argv) > 2 else None
expected_ratio = float(sys.argv[3]) if len(sys.argv) > 3 else None

DD = os.path.join(out_dir, "_debug")
meta = json.load(open(os.path.join(DD, "meta.json")))
F = trimesh.load(os.path.join(DD, "F.stl"), file_type="stl")
casing = trimesh.load(os.path.join(DD, "casing.stl"), file_type="stl")
cx, cy = meta["target_x"], meta["target_y"]
z_mid_base, z_mid_top, z_box_floor = meta["z_mid_base"], meta["z_mid_top"], meta["z_box_floor"]
ro = meta["vane_outlet_ro"]
ri = meta["vane_outlet_ri"]

ok = True


def check(cond, msg):
    global ok
    print(("OK  : " if cond else "FAIL: ") + msg)
    if not cond:
        ok = False


check(F.is_watertight, "F watertight")
check(len(F.split(only_watertight=False)) == 1, "F single connected component")

if expected_outer_d is not None:
    check(ro <= expected_outer_d / 2.0 + 1e-6,
          "outlet outer radius %.5f <= X1/2=%.5f (equal unless clamped)" % (ro, expected_outer_d / 2.0))
if expected_ratio is not None:
    check(abs(ri / ro - expected_ratio) < 1e-6,
          "inner/outer ratio %.5f matches expected %.5f" % (ri / ro, expected_ratio))

# Analytic hub/shroud invariants (spec 2026-08-10) — only when the analytic path ran.
if meta.get("shroud_ell"):
    a, b = meta["shroud_ell"]
    check(abs(a / ro - 0.160) < 1e-6, "shroud a/R_shroud == 0.160 (got %.5f)" % (a / ro))
    check(abs(b / ro - 0.119) < 1e-6, "shroud b/R_shroud == 0.119 (got %.5f)" % (b / ro))
if meta.get("hub_pts"):
    hp = meta["hub_pts"]     # [r_rim, r_p1, r_p2, r_p3]
    check(abs(hp[3] - 0.93840 * ro) < 1e-4, "P3 == 0.9384*R_shroud (got %.5f)" % hp[3])
    check(hp[1] <= hp[2] <= hp[3], "hub shoulder monotone P1<=P2<=P3 (%.4f,%.4f,%.4f)"
          % (hp[1], hp[2], hp[3]))

# casing top contour must stay monotone (no up/down wobble) -- proves the shroud
# above the vane root was not disturbed by the new remap.
v = np.asarray(casing.vertices, float)
r = np.hypot(v[:, 0] - cx, v[:, 1] - cy)
z = v[:, 2]
nb = 120
edges = np.linspace(r.min(), r.max(), nb + 1)
rc = 0.5 * (edges[:-1] + edges[1:])
idx = np.clip(np.searchsorted(edges, r) - 1, 0, nb - 1)
ztop = np.full(nb, -np.inf)
np.maximum.at(ztop, idx, z)
good = np.isfinite(ztop)
zc = ztop[good]
dz = np.diff(zc)
sign_changes = int(np.sum(np.diff(np.sign(dz[np.abs(dz) > 1e-6])) != 0))
check(sign_changes == 0, "shroud casing top contour monotone (0 sign changes, got %d)" % sign_changes)

# No stray/misclassified faces at the outlet corner or under the vanes: the two
# regressions this feature could reintroduce, since it changes what feeds the
# EXISTING classification rules (vane_outlet_ri/ro) without changing those rules.
Z = zipfile.ZipFile(os.path.join(out_dir, "exports", "trisurface.zip"))


def load_patch(name):
    m = trimesh.load(io.BytesIO(Z.read(name + ".stl")), file_type="stl")
    return m if hasattr(m, "faces") else None


def wall_faces(mesh, target_r, z_lo, z_hi):
    """Count mesh faces that are a vertical wall (|nz|<0.4) at radius ~target_r,
    within [z_lo, z_hi]. Used below to check ownership at the two duct walls."""
    if mesh is None:
        return 0
    fc = mesh.vertices[mesh.faces].mean(axis=1)
    r = np.hypot(fc[:, 0] - cx, fc[:, 1] - cy)
    nz = np.abs(mesh.face_normals[:, 2])
    sel = (nz < 0.4) & (np.abs(r - target_r) < 0.02) & (fc[:, 2] >= z_lo) & (fc[:, 2] <= z_hi)
    return int(sel.sum())


cw = load_patch("cylinder_walls")
hub = load_patch("hub")

# The sub-brim non-wetted ring regression: cylinder_walls should own NO vertical
# wall at r~ro below the shroud brim (z_mid_base).
ring = wall_faces(cw, ro, -1e9, z_mid_base)
check(ring == 0, "no non-wetted cylinder_walls ring under the vanes (found %d faces)" % ring)

# The hub-hole-above-the-outlet regression: hub should own its FULL inner duct
# wall (r~ri) just above the outlet floor, none stolen by cylinder_walls. Anchored
# at the floor (not z_mid_base): this is exactly where the historical bug band sat
# (a short/wide passage's duct wall can extend well above z_mid_base, but the
# corner theft always happened right at the floor).
band_lo, band_hi = z_box_floor, z_box_floor + 0.15
hub_wall = wall_faces(hub, ri, band_lo, band_hi)
cw_wall = wall_faces(cw, ri, band_lo, band_hi)
check(hub_wall > 0 and cw_wall == 0,
      "hub owns the inner duct wall near the outlet (hub=%d, stolen-by-cylinder_walls=%d)"
      % (hub_wall, cw_wall))

# No stray hub faces above the roof (they would belong to cylinder_walls instead).
if hub is not None:
    fc = hub.vertices[hub.faces].mean(axis=1)
    stray_hi = int((fc[:, 2] > z_mid_top + 0.02).sum())
    check(stray_hi == 0, "no stray hub faces above the roof (found %d faces)" % stray_hi)

print("ALL PASS" if ok else "SOME CHECKS FAILED")
sys.exit(0 if ok else 1)

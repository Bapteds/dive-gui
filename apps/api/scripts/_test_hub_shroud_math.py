"""Standalone unit tests for the pure hub/shroud profile math in buildChamber.py.
Run: /home/hristo/cadquery-env/bin/python _test_hub_shroud_math.py  (exits 0/1)."""
import sys
import numpy as np
import buildChamber as B

meta = {"outletInnerR": 0.29573, "outletOuterR": 0.65500}
ok = True


def check(c, m):
    global ok
    print(("OK  : " if c else "FAIL: ") + m)
    ok = ok and c


# 1) At baseline rims, the 3 points reproduce the measured baseline radii.
r_rim, p1, p2, p3 = B._hub_point_radii(0.29573, 0.65500, meta)
check(abs(r_rim - 0.29573) < 1e-9, "baseline rim == R_hub0")
check(abs(p1 - 0.29548) < 1e-9, "baseline P1 == 0.29548")
check(abs(p2 - 0.39274) < 1e-9, "baseline P2 == 0.39274")
check(abs(p3 - 0.61465) < 1e-4, "baseline P3 == 0.61465 (= 0.9384*R_shroud0, to ratio precision)")

# 2) Move rule at X1=1800 (R_shroud=0.900), ratio 0.45 -> R_hub=0.405, dr=+0.10927.
r_rim, p1, p2, p3 = B._hub_point_radii(0.405, 0.900, meta)
dr = 0.405 - 0.29573
check(abs(r_rim - 0.405) < 1e-9, "rim tracks R_hub_new")
check(abs(p1 - (0.29548 + dr)) < 1e-9, "P1 moves full dr")
check(abs(p2 - (0.39274 + dr / 2)) < 1e-9, "P2 moves half dr")
check(abs(p3 - 0.9384 * 0.900) < 1e-9, "P3 = P3_ratio * R_shroud_new (X1 only)")
check(p3 > p2 > p1, "monotonic at X1=1800")

# --- shroud fillet ---
for Rs in (0.65500, 0.900, 1.10):
    prof = B._shroud_fillet_profile(np, Rs, z_brim=0.10, r_wall=1.6)
    r, z = prof[:, 0], prof[:, 1]
    # last point is the brim run to the wall; the fillet is everything before it
    r_fil, z_fil = r[:-1], z[:-1]
    a_fit = r_fil.max() - Rs
    b_fit = z_fil.max() - z_fil.min()
    check(abs(a_fit / Rs - 0.160) < 1e-6, "a/R_shroud == 0.160 (Rs=%.3f)" % Rs)
    check(abs(b_fit / Rs - 0.119) < 1e-6, "b/R_shroud == 0.119 (Rs=%.3f)" % Rs)
    check(abs(r_fil[0] - Rs) < 1e-9, "fillet starts at inner rim (Rs=%.3f)" % Rs)
    check(np.all(np.diff(z_fil) >= -1e-9), "fillet z monotone non-decreasing (Rs=%.3f)" % Rs)
    check(np.all(np.diff(r_fil) >= -1e-9), "fillet r monotone non-decreasing (Rs=%.3f)" % Rs)
    check(abs(z_fil[-1] - 0.10) < 1e-9, "fillet top at z_brim (Rs=%.3f)" % Rs)

print("ALL PASS" if ok else "SOME FAILED")
sys.exit(0 if ok else 1)

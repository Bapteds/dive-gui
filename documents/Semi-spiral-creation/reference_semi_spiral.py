"""
reference_semi_spiral.py — REFERENCE IMPLEMENTATION of SEMI_SPIRAL_TOOL_SPEC.md

Inputs (7 numbers) -> one geometry data object (6-line spiral + 3-line tongue/nose), mirrored frame.
This is the method that produced every approved design. It is a reference for the tool builder,
not the final tool: it is deliberately compact and has no packaging. Section numbers refer to the spec.

Usage:   python reference_semi_spiral.py            (runs acceptance case A and writes case_A.json)
         from reference_semi_spiral import design_semi_spiral
Deps:    numpy, scipy
"""
import json, math
import numpy as np
from scipy.optimize import differential_evolution, minimize

GRID = 0.05          # §4.6  rounding grid [m]
STUB = 0.45          # §4.7  tongue/nose vertical stubs [m]
N_SAMPLE = 321       # §6.2  angular samples


# ----------------------------------------------------------------------------- §2 validation
def _validate(Q, c_flow, H_ch, D_LE, clearance, max_width, phi_start):
    for name, v, cond in [("Q", Q, Q > 0), ("c_flow", c_flow, c_flow > 0), ("H_ch", H_ch, H_ch > 0),
                          ("D_LE", D_LE, D_LE > 0), ("clearance", clearance, clearance >= 0),
                          ("max_width", max_width, max_width > 0),
                          ("phi_start", phi_start, 0 < phi_start < 360)]:
        if not cond:
            raise ValueError(f"invalid input {name}={v}")


# ----------------------------------------------------------------------------- §3 derived quantities
def derived(Q, c_flow, H_ch, D_LE, clearance, phi):
    """A(phi), R_cl(phi) exactly as the design spreadsheet."""
    r_turb = D_LE / 2.0
    A = Q * (1 - phi / 360.0) / c_flow
    R_cl = r_turb + A / H_ch + clearance
    return A, R_cl


# ----------------------------------------------------------------------------- §5 mirrored frame
def to_frame(r, phi_deg, phi_start):
    """physical polar (r, phi) -> mirrored-view (x, y)."""
    a = np.deg2rad(np.asarray(phi_deg, float) - phi_start)
    return np.column_stack([-r * np.cos(a), r * np.sin(a)])


# ----------------------------------------------------------------------------- §6.2 ray / polyline
def ray_distances(V, U):
    """distance from origin along each unit ray in U to the open polyline V (farthest hit; nan = miss)."""
    r = np.full(len(U), np.nan)
    for k in range(len(V) - 1):
        a, b = V[k], V[k + 1]; d = b - a
        det = d[0] * U[:, 1] - d[1] * U[:, 0]; ok = np.abs(det) > 1e-12
        safe = np.where(ok, det, 1.0)
        t = np.where(ok, (d[0] * a[1] - d[1] * a[0]) / safe, -1)
        s = np.where(ok, (U[:, 0] * a[1] - U[:, 1] * a[0]) / safe, -1)
        hit = ok & (t > 0) & (s >= -1e-9) & (s <= 1 + 1e-9)
        r = np.where(hit & (np.isnan(r) | (t > np.nan_to_num(r))), t, r)
    return r


def design_semi_spiral(Q, c_flow, H_ch, D_LE, clearance, max_width, phi_start, seed=5):
    _validate(Q, c_flow, H_ch, D_LE, clearance, max_width, phi_start)
    r_turb = D_LE / 2.0; r_in = r_turb + clearance

    # sampling of the spiral span; exclude exactly 360 in the objective (pinned tongue) -> drop last sample
    phd = np.linspace(phi_start, 360.0, N_SAMPLE)
    Ad, Rd = derived(Q, c_flow, H_ch, D_LE, clearance, phd)
    if Rd[0] <= r_in:
        raise ValueError("degenerate geometry: outer wall at the inlet is not outside the inner wall")
    U = to_frame(1.0, phd, phi_start)                       # unit ray directions
    V6 = to_frame(r_in, 360.0, phi_start)[0]                # §4.2 pinned tongue terminus
    true_wall = to_frame(Rd, phd, phi_start)
    obj_mask = np.ones(N_SAMPLE, bool); obj_mask[-1] = False

    def verts(p):                                           # §6.1
        x_in, y0, y1, x2, yt, x3, x4, y4, y5 = p
        return np.array([[x_in, y0], [x_in, y1], [x2, yt], [x3, yt], [x4, y4], [x4, y5], V6])

    def area_err(V):                                        # §6.2
        r = ray_distances(V, U)[obj_mask]
        if np.any(np.isnan(r)): return 1e3 + np.sum(np.isnan(r))
        return np.max(np.abs(H_ch * (r - r_in) - Ad[obj_mask]))

    def shape_ok(x_in, y1, x2, yt, x3, x4, y4, y5, y0=None, wmax=max_width):
        c = [x2 - x_in, x3 - x2, x4 - x3, yt - y4, y4 - y5, y5 - V6[1], y1 - y5, x4 - V6[0], wmax - (x4 - x_in)]
        if y0 is not None: c.append(y1 - y0)
        return c

    def penalty(p):
        x_in, y0, y1, x2, yt, x3, x4, y4, y5 = p
        return sum(max(0.0, -g) for g in shape_ok(x_in, y1, x2, yt, x3, x4, y4, y5, y0)) * 120.0

    def obj(p): return area_err(verts(p)) + penalty(p)

    def solve(wmax):
        nonlocal max_width
        saved, max_width = max_width, wmax
        try:
            lo_x = true_wall[:, 0].min(); top = true_wall[:, 1].max()
            bounds = [(lo_x - 0.15, lo_x + 0.6), (-3.0, -0.3), (0.2, 2.0), (lo_x + 0.6, -1.0), (top - 0.6, top + 0.5),
                      (-0.3, 1.8), (max(V6[0] + 0.05, 1.2), true_wall[:, 0].max() + 0.3), (1.0, top), (V6[1] + 0.05, 0.8)]
            res = differential_evolution(obj, bounds, seed=seed, maxiter=900, popsize=45, tol=1e-11,
                                         mutation=(0.4, 1.3), recombination=0.85, polish=False)
            p = res.x
            for s in range(12):                              # §6.3 step 2: bounded polish restarts
                rng = np.random.default_rng(s)
                q = np.clip(p + rng.normal(0, 0.04, len(p)), [b[0] for b in bounds], [b[1] for b in bounds])
                rr = minimize(obj, q, method="L-BFGS-B", bounds=bounds, options=dict(maxiter=30000, ftol=1e-13))
                if obj(rr.x) < obj(p): p = rr.x
            # §6.3 step 3: grid refinement on 8 DOF (y0 is a placeholder)
            def make(d):
                x_in, y1, x2, yt, x3, x4, y4, y5 = d
                return np.array([[x_in, y5 - 1.0], [x_in, y1], [x2, yt], [x3, yt], [x4, y4], [x4, y5], V6])
            def score(d):
                if min(shape_ok(*d)) < -1e-9: return 9e9
                return area_err(make(d))
            d = np.array([round(v / GRID) * GRID for v in [p[0], p[2], p[3], p[4], p[5], p[6], p[7], p[8]]])
            best, bs = d.copy(), score(d)
            for _ in range(60):
                improved = False
                for i in range(8):
                    for st in range(-3, 4):
                        if st == 0: continue
                        c = best.copy(); c[i] = round((c[i] + st * GRID) / GRID) * GRID; sc = score(c)
                        if sc < bs - 1e-9: bs, best, improved = sc, c, True
                if not improved: break
            return make(best), bs
        finally:
            max_width = saved

    V, err = solve(max_width)
    if err > 100:                                           # §8 infeasible: report natural width
        Vf, _ = solve(1e9)
        raise ValueError(f"max_width {max_width} m is infeasible; smallest achievable width for these "
                         f"inputs is {Vf[:, 0].max() - Vf[:, 0].min():.2f} m")

    # §6.4 tongue / nose + foot
    V5 = V[5]; V6 = V[6]
    V7 = V6 + np.array([0.0, -STUB])
    V8 = V7 + np.array([-(V6[0] - V5[0]), V6[1] - V5[1]])
    V9 = V8 + np.array([0.0, -STUB])
    V[0, 1] = V9[1]

    # §6.5 quality on the final vertices
    r = ray_distances(V, U); e = H_ch * (r - r_in) - Ad; e[-1] = 0.0
    k = int(np.nanargmax(np.abs(e)))
    width = V[:, 0].max() - V[:, 0].min()

    # §7 output object
    P = {f"V{i}": V[i] for i in range(7)}; P.update(V7=V7, V8=V8, V9=V9)
    roles = {"V0": "inlet foot (y = V9.y)", "V1": "corner", "V2": "corner", "V3": "corner", "V4": "corner",
             "V5": "corner", "V6": "tongue (on inner wall)", "V7": "end of L7", "V8": "end of L8", "V9": "end of L9 (foot, y = V0.y)"}
    segs = [("L1", "V0", "V1", "vertical"), ("L2", "V1", "V2", "free"), ("L3", "V2", "V3", "horizontal"),
            ("L4", "V3", "V4", "free"), ("L5", "V4", "V5", "vertical"), ("L6", "V5", "V6", "free"),
            ("L7", "V6", "V7", f"vertical, {STUB} m"), ("L8", "V7", "V8", "mirror of L6"), ("L9", "V8", "V9", f"vertical, {STUB} m")]
    grp = lambda vid: "spiral" if int(vid[1]) <= 6 else "tongue_nose"
    return {
        "inputs": dict(Q=Q, c_flow=c_flow, H_ch=H_ch, D_LE=D_LE, clearance=clearance, max_width=max_width, phi_start=phi_start),
        "frame": "mirrored view: x=-r*cos(phi-phi_start), y=r*sin(phi-phi_start); origin = turbine axis; metres",
        "units": "m",
        "reference": {"turbine_center": [0.0, 0.0], "turbine_radius": r_turb, "inner_wall_radius": r_in, "clearance": clearance},
        "vertices": [{"id": k_, "group": grp(k_), "x": round(float(P[k_][0]), 6), "y": round(float(P[k_][1]), 6), "role": roles[k_]} for k_ in P],
        "segments": [{"id": s, "group": "spiral" if s <= "L6" else "tongue_nose", "from": a, "to": b,
                      "length": round(float(np.hypot(*(P[b] - P[a]))), 3), "constraint": c} for s, a, b, c in segs],
        "dimensions": {"width": round(float(width), 6), "height": H_ch, "min_x": round(float(V[:, 0].min()), 6),
                       "max_x": round(float(V[:, 0].max()), 6), "foot_y": round(float(V9[1]), 6)},
        "quality": {"worst_area_error_m2": round(float(abs(e[k])), 4), "at_phi_deg": round(float(phd[k]), 1),
                    "width_binding": bool(width >= max_width - 1e-6)},
    }


if __name__ == "__main__":
    # Acceptance case A (§9.3): expect width 6.05, worst area error ~0.46 m2
    g = design_semi_spiral(Q=12, c_flow=0.922, H_ch=2.97, D_LE=3.074, clearance=0.20, max_width=6.15, phi_start=160)
    print(json.dumps(g["dimensions"] | g["quality"], indent=1))
    for v in g["vertices"]: print(f'{v["id"]:3s} ({v["x"]:9.6f}, {v["y"]:9.6f})  {v["role"]}')
    with open("case_A.json", "w") as f: json.dump(g, f, indent=2)
    print("wrote case_A.json")

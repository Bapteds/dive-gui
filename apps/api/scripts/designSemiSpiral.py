#!/usr/bin/env python3
"""Design the semi-spiral casing outline of a chamber (6 spiral lines + the
3-line tongue/nose) from 7 numbers. Port of the approved reference tool
(documents/Semi-spiral-creation/reference_semi_spiral.py, tool spec
SEMI_SPIRAL_TOOL_SPEC.md) with numpy and scipy only (no CadQuery).

The chamber runs this ONCE per set of spiral inputs, in its own cached step
(spec brain/specs/2026-09-29-semi-spiral-casing-design.md, section 8): the
optimisation takes 30 to 90 s, so buildChamber.py never re-optimises; it
consumes the frozen vertices this script writes.

Library use:
    from designSemiSpiral import design_semi_spiral
    geom = design_semi_spiral(Q, c_flow, H_ch, D_LE, clearance, max_width, phi_start)

The pieces are separate, individually testable functions (tool spec section 10):
    derived()          A(phi) and R_cl(phi), exactly as the design spreadsheet
    to_frame()         physical polar -> mirrored-view (x, y)
    ray_distances()    ray / open-polyline distances
    area_error()       worst cross-section area error of a candidate wall
    optimise_wall()    differential evolution + bounded polish + 0.05 m grid
    build_nose()       the tongue/nose V7..V9 and the foot level

CLI usage:
    python designSemiSpiral.py <in.json> <out.json>

    in.json holds {"Q", "c_flow", "H_ch", "D_LE", "clearance", "max_width",
    "phi_start"} (m, m3/s, m/s, deg). out.json receives the geometry object of
    tool spec section 7 plus a "warnings" list; it is written atomically
    (<out>.tmp then os.replace).

Dependencies: numpy, scipy (scipy imported inside the optimiser, so a usage
error stays cheap).

Contract (as every apps/api/scripts tool):
  * success -> "OK: ..." on stdout, exit 0; each warning also as "WARN: ..." on
    stderr (the API passes them through to the build's warnings);
  * failure -> "KO: <message worded for the Chamber Creation page>" on stderr,
    exit 1;
  * usage error (wrong argc) -> usage on stderr, exit 2.

Determinism: fixed seeds, so the same inputs give byte-identical output on one
scipy version. Not across scipy versions (the objective has plateaus): the API
caches the result and the builder only reads frozen vertices. Purge
<STORAGE_DIR>/chamber-spiral/ whenever this file or scipy changes.
"""

import json
import math
import os
import sys

import numpy as np

# --- fixed design rules (tool spec section 4; NOT user inputs) --------------
GRID = 0.05          # rounding grid of the free corners (m)
STUB = 0.45          # tongue/nose vertical stubs L7 and L9 (m)
N_SAMPLE = 321       # angular samples of the spiral span
SEED = 5             # differential-evolution seed (determinism)
# Tag of the method + settings. The API folds it into the spiral cache key, so
# a change of the algorithm must change this tag.
ALGORITHM = "ref-2026-09-22-seed5"
INFEASIBLE_ERR = 100.0   # a best wall scoring above this violates a constraint

FRAME = ("mirrored view: x=-r*cos(phi-phi_start), y=r*sin(phi-phi_start); "
         "origin = turbine axis; metres")


class SpiralInputError(ValueError):
    """An input is out of its domain (the message names it)."""


class SpiralDegenerateError(ValueError):
    """The outer wall at the spiral start is not outside the inner wall."""


class SpiralInfeasibleError(ValueError):
    """No valid wall satisfies max_width; carries the natural width (m)."""

    def __init__(self, max_width, natural_width):
        self.max_width = max_width
        self.natural_width = natural_width
        super().__init__(
            "max_width %g m is infeasible; the smallest achievable width for these "
            "inputs is %.2f m" % (max_width, natural_width))


# --- section 2: validation ---------------------------------------------------
def validate(Q, c_flow, H_ch, D_LE, clearance, max_width, phi_start):
    for name, v, cond in [("Q", Q, Q > 0), ("c_flow", c_flow, c_flow > 0), ("H_ch", H_ch, H_ch > 0),
                          ("D_LE", D_LE, D_LE > 0), ("clearance", clearance, clearance >= 0),
                          ("max_width", max_width, max_width > 0),
                          ("phi_start", phi_start, 0 < phi_start < 360)]:
        if not (isinstance(v, (int, float)) and math.isfinite(v)) or not cond:
            raise SpiralInputError("invalid input %s=%s" % (name, v))


# --- section 3: derived quantities --------------------------------------------
def derived(Q, c_flow, H_ch, D_LE, clearance, phi):
    """A(phi) and R_cl(phi), exactly as the design spreadsheet."""
    r_turb = D_LE / 2.0
    A = Q * (1 - phi / 360.0) / c_flow
    R_cl = r_turb + A / H_ch + clearance
    return A, R_cl


# --- section 5: mirrored frame -----------------------------------------------
def to_frame(r, phi_deg, phi_start):
    """Physical polar (r, phi) -> mirrored-view (x, y), one row per angle."""
    a = np.deg2rad(np.asarray(phi_deg, float) - phi_start)
    return np.column_stack([-r * np.cos(a), r * np.sin(a)])


# --- section 6.2: ray / polyline ----------------------------------------------
def ray_distances(V, U):
    """Distance from the origin along each unit ray in U to the open polyline V
    (the farthest hit; nan = miss)."""
    r = np.full(len(U), np.nan)
    for k in range(len(V) - 1):
        a, b = V[k], V[k + 1]
        d = b - a
        det = d[0] * U[:, 1] - d[1] * U[:, 0]
        ok = np.abs(det) > 1e-12
        safe = np.where(ok, det, 1.0)
        t = np.where(ok, (d[0] * a[1] - d[1] * a[0]) / safe, -1)
        s = np.where(ok, (U[:, 0] * a[1] - U[:, 1] * a[0]) / safe, -1)
        hit = ok & (t > 0) & (s >= -1e-9) & (s <= 1 + 1e-9)
        r = np.where(hit & (np.isnan(r) | (t > np.nan_to_num(r))), t, r)
    return r


def area_error(V, U, target_area, H_ch, r_in):
    """Worst |H_ch * (r_facet - r_in) - A| over the rays U (the objective). A
    missed ray makes the candidate invalid (a large penalty)."""
    r = ray_distances(V, U)
    if np.any(np.isnan(r)):
        return 1e3 + np.sum(np.isnan(r))
    return np.max(np.abs(H_ch * (r - r_in) - target_area))


class _Problem:
    """The sampled spiral span and the pinned tongue for one set of inputs."""

    def __init__(self, Q, c_flow, H_ch, D_LE, clearance, phi_start):
        self.H_ch = H_ch
        self.r_turb = D_LE / 2.0
        self.r_in = self.r_turb + clearance
        self.phd = np.linspace(phi_start, 360.0, N_SAMPLE)
        self.Ad, self.Rd = derived(Q, c_flow, H_ch, D_LE, clearance, self.phd)
        if self.Rd[0] <= self.r_in:
            raise SpiralDegenerateError(
                "degenerate geometry: outer wall at the inlet is not outside the inner wall")
        self.U = to_frame(1.0, self.phd, phi_start)               # unit ray directions
        self.V6 = to_frame(self.r_in, 360.0, phi_start)[0]        # pinned tongue terminus
        self.true_wall = to_frame(self.Rd, self.phd, phi_start)
        # exclude exactly 360 (the pinned tongue) from the objective
        self.obj_mask = np.ones(N_SAMPLE, bool)
        self.obj_mask[-1] = False

    def err(self, V):
        return area_error(V, self.U[self.obj_mask], self.Ad[self.obj_mask], self.H_ch, self.r_in)


def _shape_ok(V6, wmax, x_in, y1, x2, yt, x3, x4, y4, y5, y0=None):
    """Section 6.1 ordering constraints as a list of values that must be >= 0."""
    c = [x2 - x_in, x3 - x2, x4 - x3, yt - y4, y4 - y5, y5 - V6[1], y1 - y5, x4 - V6[0],
         wmax - (x4 - x_in)]
    if y0 is not None:
        c.append(y1 - y0)
    return c


# --- section 6.3: optimisation -------------------------------------------------
def optimise_wall(prob, wmax, seed=SEED):
    """Global search + bounded polish + 0.05 m grid refinement of the 6-line
    wall V0..V6 under the width limit wmax. Returns (V (7x2), worst error);
    V0.y is a placeholder (set by build_nose)."""
    from scipy.optimize import differential_evolution, minimize

    V6 = prob.V6

    def verts(p):
        x_in, y0, y1, x2, yt, x3, x4, y4, y5 = p
        return np.array([[x_in, y0], [x_in, y1], [x2, yt], [x3, yt], [x4, y4], [x4, y5], V6])

    def penalty(p):
        x_in, y0, y1, x2, yt, x3, x4, y4, y5 = p
        return sum(max(0.0, -g) for g in _shape_ok(V6, wmax, x_in, y1, x2, yt, x3, x4, y4, y5, y0)) * 120.0

    def obj(p):
        return prob.err(verts(p)) + penalty(p)

    tw = prob.true_wall
    lo_x = tw[:, 0].min()
    top = tw[:, 1].max()
    bounds = [(lo_x - 0.15, lo_x + 0.6), (-3.0, -0.3), (0.2, 2.0), (lo_x + 0.6, -1.0), (top - 0.6, top + 0.5),
              (-0.3, 1.8), (max(V6[0] + 0.05, 1.2), tw[:, 0].max() + 0.3), (1.0, top), (V6[1] + 0.05, 0.8)]
    res = differential_evolution(obj, bounds, seed=seed, maxiter=900, popsize=45, tol=1e-11,
                                 mutation=(0.4, 1.3), recombination=0.85, polish=False)
    p = res.x
    lo = [b[0] for b in bounds]
    hi = [b[1] for b in bounds]
    for s in range(12):                                # bounded polish restarts
        rng = np.random.default_rng(s)
        q = np.clip(p + rng.normal(0, 0.04, len(p)), lo, hi)
        rr = minimize(obj, q, method="L-BFGS-B", bounds=bounds, options=dict(maxiter=30000, ftol=1e-13))
        if obj(rr.x) < obj(p):
            p = rr.x

    # grid refinement on the 8 shape DOF (y0 is a placeholder)
    def make(d):
        x_in, y1, x2, yt, x3, x4, y4, y5 = d
        return np.array([[x_in, y5 - 1.0], [x_in, y1], [x2, yt], [x3, yt], [x4, y4], [x4, y5], V6])

    def score(d):
        if min(_shape_ok(V6, wmax, *d)) < -1e-9:
            return 9e9
        return prob.err(make(d))

    d = np.array([round(v / GRID) * GRID for v in [p[0], p[2], p[3], p[4], p[5], p[6], p[7], p[8]]])
    best, bs = d.copy(), score(d)
    for _ in range(60):
        improved = False
        for i in range(8):
            for st in range(-3, 4):
                if st == 0:
                    continue
                c = best.copy()
                c[i] = round((c[i] + st * GRID) / GRID) * GRID
                sc = score(c)
                if sc < bs - 1e-9:
                    bs, best, improved = sc, c, True
        if not improved:
            break
    return make(best), bs


# --- section 6.4: tongue / nose + foot ------------------------------------------
def build_nose(V5, V6):
    """V7..V9 from the last spiral line L6 (V5 -> V6): L7 = STUB straight down,
    L8 = L6 mirrored about the vertical, L9 = STUB straight down. Returns
    (V7, V8, V9); the caller sets V0.y = V9.y."""
    V5 = np.asarray(V5, float)
    V6 = np.asarray(V6, float)
    V7 = V6 + np.array([0.0, -STUB])
    V8 = V7 + np.array([-(V6[0] - V5[0]), V6[1] - V5[1]])
    V9 = V8 + np.array([0.0, -STUB])
    return V7, V8, V9


# --- the entry point --------------------------------------------------------------
_ROLES = {"V0": "inlet foot (y = V9.y)", "V1": "corner", "V2": "corner", "V3": "corner", "V4": "corner",
          "V5": "corner", "V6": "tongue (on inner wall)", "V7": "end of L7", "V8": "end of L8",
          "V9": "end of L9 (foot, y = V0.y)"}
_SEGMENTS = [("L1", "V0", "V1", "vertical"), ("L2", "V1", "V2", "free"), ("L3", "V2", "V3", "horizontal"),
             ("L4", "V3", "V4", "free"), ("L5", "V4", "V5", "vertical"), ("L6", "V5", "V6", "free"),
             ("L7", "V6", "V7", "vertical, %s m" % STUB), ("L8", "V7", "V8", "mirror of L6"),
             ("L9", "V8", "V9", "vertical, %s m" % STUB)]


def width_warning(geom):
    """The chamber warning for a wall held back by the width limit, else None."""
    q = geom["quality"]
    if not q["width_binding"]:
        return None
    return ("The semi-spiral casing is limited by B Kammer (%d mm): worst cross-section "
            "error %.2f m² at %.0f°. Raise B Kammer to reduce it."
            % (round(geom["inputs"]["max_width"] * 1000.0), q["worst_area_error_m2"], q["at_phi_deg"]))


def design_semi_spiral(Q, c_flow, H_ch, D_LE, clearance, max_width, phi_start, seed=SEED):
    """7 inputs -> the geometry object of tool spec section 7 (plus "warnings").

    Raises SpiralInputError (bad input), SpiralDegenerateError (r_inner >=
    R_cl(phi_start)) or SpiralInfeasibleError (no valid wall under max_width;
    carries the natural width)."""
    validate(Q, c_flow, H_ch, D_LE, clearance, max_width, phi_start)
    prob = _Problem(Q, c_flow, H_ch, D_LE, clearance, phi_start)

    V, err = optimise_wall(prob, max_width, seed=seed)
    if err > INFEASIBLE_ERR:
        # Report the natural width (no width limit) so the caller can name the
        # lever. (The reference re-ran with its closure still bound to the old
        # limit, so it reported the same width; the limit is passed here.)
        Vf, _ = optimise_wall(prob, 1e9, seed=seed)
        raise SpiralInfeasibleError(max_width, float(Vf[:, 0].max() - Vf[:, 0].min()))

    V = V.copy()
    V7, V8, V9 = build_nose(V[5], V[6])
    V[0, 1] = V9[1]

    # section 6.5: quality on the final vertices
    r = ray_distances(V, prob.U)
    e = H_ch * (r - prob.r_in) - prob.Ad
    e[-1] = 0.0
    k = int(np.nanargmax(np.abs(e)))
    width = V[:, 0].max() - V[:, 0].min()

    P = {"V%d" % i: V[i] for i in range(7)}
    P.update(V7=V7, V8=V8, V9=V9)

    def grp(vid):
        return "spiral" if int(vid[1]) <= 6 else "tongue_nose"

    geom = {
        "inputs": dict(Q=Q, c_flow=c_flow, H_ch=H_ch, D_LE=D_LE, clearance=clearance,
                       max_width=max_width, phi_start=phi_start),
        "frame": FRAME,
        "units": "m",
        "reference": {"turbine_center": [0.0, 0.0], "turbine_radius": prob.r_turb,
                      "inner_wall_radius": prob.r_in, "clearance": clearance},
        "vertices": [{"id": vid, "group": grp(vid), "x": round(float(P[vid][0]), 6),
                      "y": round(float(P[vid][1]), 6), "role": _ROLES[vid]} for vid in P],
        "segments": [{"id": s, "group": "spiral" if s <= "L6" else "tongue_nose", "from": a, "to": b,
                      "length": round(float(np.hypot(*(P[b] - P[a]))), 3), "constraint": c}
                     for s, a, b, c in _SEGMENTS],
        "dimensions": {"width": round(float(width), 6), "height": H_ch,
                       "min_x": round(float(V[:, 0].min()), 6),
                       "max_x": round(float(V[:, 0].max()), 6), "foot_y": round(float(V9[1]), 6)},
        "quality": {"worst_area_error_m2": round(float(abs(e[k])), 4), "at_phi_deg": round(float(prob.phd[k]), 1),
                    "width_binding": bool(width >= max_width - 1e-6)},
        "algorithm": ALGORITHM,
    }
    warning = width_warning(geom)
    geom["warnings"] = [warning] if warning else []
    return geom


def to_json(geom):
    """The canonical JSON text of a geometry object (sorted keys)."""
    return json.dumps(geom, indent=1, sort_keys=True)


# --- chamber wording of the refusals (shown alone on the Chamber Creation page) --
def degenerate_message():
    return ("Q_max is too small for this H Kammer and runner case: the spiral would be "
            "narrower than the 200 mm gap around the turbine.")


def infeasible_message(max_width, natural_width):
    natural_mm = int(math.ceil(natural_width * 1000.0 - 1e-6))
    return ("The semi-spiral casing does not fit in B Kammer (%d mm): the narrowest valid "
            "spiral for these inputs is %d mm wide. Raise B Kammer to at least %d mm."
            % (round(max_width * 1000.0), natural_mm, natural_mm))


_INPUT_KEYS = ("Q", "c_flow", "H_ch", "D_LE", "clearance", "max_width", "phi_start")


def main(argv):
    for _stream in (sys.stdout, sys.stderr):
        if hasattr(_stream, "reconfigure"):
            _stream.reconfigure(encoding="utf-8")
    if len(argv) != 3:
        sys.stderr.write("usage: python designSemiSpiral.py <in.json> <out.json>\n")
        return 2
    in_path, out_path = argv[1], argv[2]
    try:
        with open(in_path, encoding="utf-8") as fh:
            raw = json.load(fh)
        missing = [k for k in _INPUT_KEYS if k not in raw]
        if missing:
            raise SpiralInputError("missing input %s" % ", ".join(missing))
        geom = design_semi_spiral(**{k: raw[k] for k in _INPUT_KEYS})
        tmp = out_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(to_json(geom))
        os.replace(tmp, out_path)
    except SpiralDegenerateError:
        sys.stderr.write("KO: %s\n" % degenerate_message())
        return 1
    except SpiralInfeasibleError as exc:
        sys.stderr.write("KO: %s\n" % infeasible_message(exc.max_width, exc.natural_width))
        return 1
    except Exception as exc:  # noqa: BLE001 - one-shot CLI, report and fail
        sys.stderr.write("KO: The semi-spiral casing could not be designed (%s: %s).\n"
                         % (type(exc).__name__, exc))
        return 1
    for w in geom["warnings"]:
        sys.stderr.write("WARN: %s\n" % w)
    sys.stdout.write("OK: semi-spiral width %.2f m, worst area error %.4f m2 -> %s\n"
                     % (geom["dimensions"]["width"], geom["quality"]["worst_area_error_m2"], out_path))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

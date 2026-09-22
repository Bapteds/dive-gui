# Semi-Spiral Casing Tool — Specification

**Status:** approved design, ready to implement.
**Audience:** the agent/developer building the tool. This document is self-contained; no prior
conversation is needed. Reference implementations of every step exist in the `spiral_handoff_*/build_handoff.py`
scripts next to this file (they hard-code vertices; this tool must *compute* them).

---

## 1. Purpose and scope

A deterministic function: **7 numeric inputs → one geometry data object** describing the outer wall of a
semi-spiral hydro-turbine casing as **6 straight lines (the spiral) + 3 straight lines (the tongue/nose)**.

The tool will later be embedded in a chamber-creation tool, so it must be an importable library
function with a plain data output. It produces **geometry data only** — no STL, DXF or drawings.

Out of scope (explicitly): file exports, plotting, the straight inlet approach channel (Φ = 0 → `phi_start`),
any adjustable design rules. The design rules in §4 are **fixed and not user-configurable**.

---

## 2. Inputs

All inputs are numbers. Units: metres, m³/s, m/s, degrees.

| name | meaning | unit | validation | example (current design) |
|------|---------|------|------------|--------------------------|
| `Q` | design flow | m³/s | > 0 | 12 |
| `c_flow` | design flow velocity in the casing | m/s | > 0 | 0.922 |
| `H_ch` | chamber (casing) height | m | > 0 | 2.97 |
| `D_LE` | turbine outer diameter | m | > 0 | 3.074 |
| `clearance` | radial gap turbine → inner casing wall | m | ≥ 0 | 0.20 |
| `max_width` | maximum allowed chamber width in x (mirrored frame) | m | > 0 | 6.15 |
| `phi_start` | angle where the spiral starts | ° | 0 < value < 360 | 160 |

Invalid input → raise an error naming the offending input. Do not clamp or guess.

---

## 3. Derived quantities (must match the design spreadsheet exactly)

```
r_turb   = D_LE / 2
r_inner  = r_turb + clearance                      # inner casing wall radius

for any angle Φ (degrees) in [phi_start, 360]:
    Q_res(Φ) = Q * (1 - Φ/360)                      # residual flow still to be delivered
    A(Φ)     = Q_res(Φ) / c_flow                    # design cross-section area
    B(Φ)     = A(Φ) / H_ch                          # radial width of the flow passage
    R(Φ)     = r_turb + B(Φ)                        # ideal outer wall radius (no clearance)
    R_cl(Φ)  = R(Φ) + clearance                     # actual outer wall radius (with clearance)
```

Notes:
- `A(Φ) = H_ch · (R_cl(Φ) − r_inner)` holds identically — moving both walls out by `clearance` preserves the area.
- At Φ = 360: `A = 0`, `R_cl = r_inner`. The outer wall meets the inner wall there (the tongue).
- Verified against the spreadsheet: for `Q=12, c_flow=0.922, H_ch=2.97, D_LE=3.074, clearance=0.2`
  → `A(160)=7.230658`, `R_cl(160)=4.171565`, `R_cl(360)=1.737`.

---

## 4. Fixed design rules (baked in)

1. **Spiral span:** Φ from `phi_start` to 360°.
2. **Tongue is pinned:** vertex `V6` is the spiral terminus at Φ = 360°, lying on the inner wall (`|V6| = r_inner`).
3. **Six spiral lines** L1…L6 through vertices `V0…V6`:
   - L1 (V0–V1) **vertical**, L3 (V2–V3) **horizontal**, L5 (V4–V5) **vertical**; L2, L4, L6 free.
4. **Objective:** minimise the **worst-case (max-abs) cross-section-area error** over all angles
   (see §6.2). The inlet position is **free** (not pinned to the true inlet radius).
5. **Hard constraint:** chamber width `max(x) − min(x) ≤ max_width` (over the spiral vertices V0–V6).
6. **Rounding:** all free corner coordinates snapped to a **0.05 m grid**, then re-optimised on that grid.
   `V6` is *never* rounded (it stays exactly on the inner wall).
7. **Tongue/nose — three lines** L7…L9 through `V6…V9`:
   - L7: 0.45 m straight down from V6.
   - L8: a copy of L6 (V5→V6) **mirrored about the vertical** (x-direction flipped), starting at V7.
   - L9: 0.45 m straight down from V8.
8. **Bottom opening:** V0's y is set equal to V9's y (both feet on the same level). L1 stays vertical.
9. **Frame:** all output in the **mirrored view** (§5).

---

## 5. Coordinate frame ("mirrored view")

Origin = machine / turbine axis. A physical polar point at radius `r`, angle Φ maps to:

```
x = -r · cos(Φ − phi_start)
y =  r · sin(Φ − phi_start)
```

(Equivalent to: rotate by `−phi_start` about the origin, then mirror about the y-axis.)

Consequences the implementer can use as checks:
- The inlet point (Φ = `phi_start`) lands at `(−R_cl(phi_start), 0)` and the inlet ray direction is `(−1, 0)`
  — i.e. the inlet is horizontal, hence L1 vertical.
- The unit ray direction for angle Φ is `u(Φ) = (−cos(Φ−phi_start), sin(Φ−phi_start))`.
- With `phi_start=160, r_inner=1.737`: `V6 = (1.632200, −0.594072)`.
- With `phi_start=150, r_inner=1.737`: `V6 = (1.504286, −0.868500)`.

---

## 6. Algorithm

### 6.1 Parametrisation of the spiral wall
Nine continuous degrees of freedom, honouring the vertical/horizontal constraints by construction:

```
p = (x_in, y0, y1, x2, y_top, x3, x4, y4, y5)

V0 = (x_in, y0)      V1 = (x_in, y1)          # L1 vertical
V2 = (x2, y_top)     V3 = (x3, y_top)         # L3 horizontal
V4 = (x4, y4)        V5 = (x4, y5)            # L5 vertical
V6 = fixed terminus (§4 rule 2, §5)
```

Shape-ordering constraints (violations penalised, must be satisfied at the end):
```
x_in < x2 < x3 < x4          y_top > y4 > y5 > V6.y          y1 > y5          y1 > y0          x4 > V6.x
x4 − x_in ≤ max_width
```

### 6.2 Area-error evaluation (the objective)
1. Sample Φ finely over `[phi_start, 360]` (reference implementation: 321 evenly spaced points).
2. For each Φ, cast a ray from the origin along `u(Φ)` (§5) and intersect it with the open polyline
   V0→V1→…→V6. Its distance is `r_facet(Φ)`. A valid (star-shaped) wall is hit **exactly once** per ray;
   if a candidate wall is hit more than once, take the **farthest** hit (this matches the reference
   implementation and makes folded candidates score badly rather than falsely well).
3. `A_fit(Φ) = H_ch · (r_facet(Φ) − r_inner)`; `err(Φ) = A_fit(Φ) − A(Φ)`.
4. Objective = `max |err(Φ)|`. **Exclude Φ = 360 exactly** (the pinned tongue; a ray to a polyline
   endpoint can miss by rounding, and its target area is 0 anyway).
5. If any other ray misses the polyline (no intersection), the candidate is invalid → large penalty.

Ray–segment intersection is the standard 2-D parametric test; treat `|det| < 1e-12` as parallel, and accept
segment parameter `s ∈ [−1e-9, 1+1e-9]`, ray parameter `t > 0`.

### 6.3 Optimisation — reproduce the validated method
The objective is **non-smooth** (ray–polyline intersection); gradient-only optimisers fail. Use:

1. **Global search:** differential evolution over the 9 DOF with a fixed seed (determinism), penalty
   = objective + large weight × constraint violations. Reference settings: `popsize≈45`, `maxiter≈900`,
   `mutation=(0.4,1.3)`, `recombination=0.85`, `polish=False`.
   Bounds: derive from the true wall's mirrored extents (`x_in` around `−R_cl(phi_start)`, top around
   `max y` of the true wall, etc.) with generous margins.
2. **Bounded local polish:** several L-BFGS-B restarts from small random perturbations of the best point,
   **respecting the bounds** (an unbounded polish will violate `max_width`). Keep the best.
3. **Grid refinement (rounding):** snap the 8 shape DOF `(x_in, y1, x2, y_top, x3, x4, y4, y5)` to the
   0.05 m grid (`y0` is a placeholder, overwritten in 6.4). Then coordinate descent: for each DOF try
   ±1…±3 grid steps, accept any improvement, repeat sweeps until none. Constraints (§6.1) enforced
   during the search. This is where the final vertices come from.

### 6.4 Tongue/nose and foot (deterministic, after 6.3)
```
V7 = V6 + (0, −0.45)
d  = (−(V6.x − V5.x), (V6.y − V5.y))         # L6 direction with x flipped
V8 = V7 + d
V9 = V8 + (0, −0.45)
V0.y = V9.y                                   # feet on the same level
```

### 6.5 Quality report
Recompute §6.2 on the final rounded vertices and report `worst_area_error` and the angle at which it
occurs; report `width_binding = (x4 − x_in ≥ max_width − 1e-6)`.

---

## 7. Output — one geometry data object (JSON-serialisable)

Example for acceptance case A (§9.3). Vertices and lengths are the validated values; the `quality.at_phi_deg`
value is illustrative — the tool computes it.

```json
{
  "inputs": { "Q": 12, "c_flow": 0.922, "H_ch": 2.97, "D_LE": 3.074, "clearance": 0.2, "max_width": 6.15, "phi_start": 160 },
  "frame": "mirrored view: x=-r*cos(phi-phi_start), y=r*sin(phi-phi_start); origin = turbine axis; metres",
  "units": "m",
  "reference": { "turbine_center": [0.0, 0.0], "turbine_radius": 1.537, "inner_wall_radius": 1.737, "clearance": 0.2 },
  "vertices": [
    { "id": "V0", "group": "spiral",      "x": -4.05,    "y": -1.988144, "role": "inlet foot (y = V9.y)" },
    { "id": "V1", "group": "spiral",      "x": -4.05,    "y": 0.95,      "role": "corner" },
    { "id": "V2", "group": "spiral",      "x": -2.05,    "y": 3.00,      "role": "corner" },
    { "id": "V3", "group": "spiral",      "x": 0.60,     "y": 3.00,      "role": "corner" },
    { "id": "V4", "group": "spiral",      "x": 2.00,     "y": 1.70,      "role": "corner" },
    { "id": "V5", "group": "spiral",      "x": 2.00,     "y": -0.10,     "role": "corner" },
    { "id": "V6", "group": "spiral",      "x": 1.632200, "y": -0.594072, "role": "tongue (on inner wall)" },
    { "id": "V7", "group": "tongue_nose", "x": 1.632200, "y": -1.044072, "role": "end of L7" },
    { "id": "V8", "group": "tongue_nose", "x": 2.00,     "y": -1.538144, "role": "end of L8" },
    { "id": "V9", "group": "tongue_nose", "x": 2.00,     "y": -1.988144, "role": "end of L9 (foot, y = V0.y)" }
  ],
  "segments": [
    { "id": "L1", "group": "spiral", "from": "V0", "to": "V1", "length": 2.938, "constraint": "vertical" },
    { "id": "L2", "group": "spiral", "from": "V1", "to": "V2", "length": 2.864, "constraint": "free" },
    { "id": "L3", "group": "spiral", "from": "V2", "to": "V3", "length": 2.650, "constraint": "horizontal" },
    { "id": "L4", "group": "spiral", "from": "V3", "to": "V4", "length": 1.910, "constraint": "free" },
    { "id": "L5", "group": "spiral", "from": "V4", "to": "V5", "length": 1.800, "constraint": "vertical" },
    { "id": "L6", "group": "spiral", "from": "V5", "to": "V6", "length": 0.616, "constraint": "free" },
    { "id": "L7", "group": "tongue_nose", "from": "V6", "to": "V7", "length": 0.450, "constraint": "vertical, 0.45 m" },
    { "id": "L8", "group": "tongue_nose", "from": "V7", "to": "V8", "length": 0.616, "constraint": "mirror of L6" },
    { "id": "L9", "group": "tongue_nose", "from": "V8", "to": "V9", "length": 0.450, "constraint": "vertical, 0.45 m" }
  ],
  "dimensions": { "width": 6.05, "height": 2.97, "min_x": -4.05, "max_x": 2.00, "foot_y": -1.988144 },
  "quality": { "worst_area_error_m2": 0.46, "at_phi_deg": 213, "width_binding": false }
}
```

Rules for the object:
- Vertex coordinates: free corners are exact multiples of 0.05; `V6` (and hence `V7.x`) and the foot level
  carry full precision.
- `height` is simply `H_ch` — the caller extrudes the profile along +z from 0 to `height`. The area
  preservation `A = H_ch·(r_outer − r_inner)` relies on constant height.
- Provide the object as a native structure (e.g. a dataclass/dict) **and** a `to_json()`; a flat CSV of the
  vertex table is a trivial extra.

---

## 8. Behaviour at the edges

- **Width infeasible.** If no valid wall satisfies `max_width`, **fail with a clear error** — never silently
  relax the limit. To make the error useful, run the fit once *without* the width constraint and report the
  resulting natural width: *"max_width 5.5 m is infeasible; the smallest achievable width for these inputs
  is 6.05 m."*
- **Width binding but feasible.** Succeed, and set `quality.width_binding = true`. The tool never decides to
  loosen the limit; it only reports, so the caller can choose (e.g. in earlier designs, widening 6.75 → 6.90 m
  cut the area error from 0.81 to 0.63 m²).
- **Degenerate geometry** (e.g. `clearance` so large that `r_inner ≥ R_cl(phi_start)`): reject with an error.
- **Determinism:** the same inputs must always produce the same output (fixed random seeds). Note the
  objective has flat "plateaus" — several vertex sets can share the identical minimum area error — so the
  exact vertices are only reproducible with the fixed seed; the *area error* and constraints are the
  stable quantities (see §9).

---

## 9. Acceptance tests

### 9.1 Derived-quantity check (exact)
For the inputs of §3, `R_cl(Φ)` and `A(Φ)` must equal the spreadsheet `Semi-spiral calculator.xlsx`
(columns *R_clearance*, *A_CS*) row-for-row for Φ = 160…360, to 1e-6.

### 9.2 Frame check (exact)
`V6` for `phi_start=160` must be `(1.632200, −0.594072)` and for `phi_start=150` `(1.504286, −0.868500)`
(with `r_inner = 1.737`), to 1e-5.

### 9.3 Regression against the three approved designs
Run the full tool and assert: all constraints hold, free corners are on the 0.05 grid, `width ≤ max_width`,
and the worst-case area error is **≤ the value below + 0.02 m²**. (Vertices listed are the validated
reference solution; matching them exactly is expected with the reference seed, but is not required
because of the plateaus in §8.)

| case | Q | c_flow | H_ch | D_LE | clearance | max_width | phi_start | → width | → area err |
|------|---|--------|------|------|-----------|-----------|-----------|---------|------------|
| A — big chamber 160° | 12 | 0.922 | 2.97 | 3.074 | 0.20 | 6.15 | 160 | 6.05 | **0.46** |
| B — big chamber 150° | 12 | 0.922 | 2.97 | 3.074 | 0.20 | 6.15 | 150 | 6.15 (binding) | **0.57** |
| C — Ø2.92 chamber | 12 | 0.66 | 2.97 | 2.92 | 0.20 | 6.90 | 160 | 6.90 (binding) | **0.63** |

Reference vertices (mirrored frame, V0 y = foot level):

- **A:** V0(−4.05, −1.988144) V1(−4.05, 0.95) V2(−2.05, 3.00) V3(0.60, 3.00) V4(2.00, 1.70) V5(2.00, −0.10)
  V6(1.632200, −0.594072) | V7(1.632200, −1.044072) V8(2.00, −1.538144) V9(2.00, −1.988144)
- **B:** V0(−4.10, −2.587000) V1(−4.10, 1.20) V2(−2.05, 3.10) V3(0.75, 3.10) V4(2.05, 1.50) V5(2.05, −0.05)
  V6(1.504286, −0.868500) | V7(1.504286, −1.318500) V8(2.05, −2.137000) V9(2.05, −2.587000)
- **C:** V0(−4.85, −1.885506) V1(−4.85, 1.10) V2(−2.55, 3.50) V3(0.50, 3.50) V4(2.05, 1.85) V5(2.05, −0.15)
  V6(1.559890, −0.567753) | V7(1.559890, −1.017753) V8(2.05, −1.435506) V9(2.05, −1.885506)

### 9.4 Edge cases
- `max_width = 5.5` with case A inputs → error message stating the smallest feasible width (≈ 6.05 m).
- Any non-positive input, or `phi_start` outside (0, 360) → validation error naming the input.
- Same inputs run twice → byte-identical output.

---

## 10. Implementation notes for the builder

- Language: Python (the reference scripts are Python; `numpy` + `scipy.optimize.differential_evolution`
  / `minimize(method="L-BFGS-B")` cover everything). No other dependencies are needed for the core.
- Expose one entry point, e.g. `design_semi_spiral(Q, c_flow, H_ch, D_LE, clearance, max_width, phi_start) -> SpiralGeometry`,
  with `SpiralGeometry.to_json()`. Keep the area evaluator, the optimiser, and the tongue builder as
  separate, individually testable functions.
- Runtime of a few seconds to ~1 minute per call is acceptable.
- The `spiral_handoff_*/build_handoff.py` scripts beside this spec show the exact ray-intersection code,
  the tongue construction and the frame transform that produced the reference results — reuse them.

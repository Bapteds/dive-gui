#!/usr/bin/env python3
"""Build a chamber solid from resolved geometry params and emit a compact GLB +
JSON manifest (+ edges.bin) and OpenFOAM export artifacts.

This is the one-shot builder behind the "Chamber Creation" feature. It is the
geometry sibling of extractPatches.py: where that script READS an existing
OpenFOAM mesh, this one CREATES a CadQuery solid, splits it into named surface
patches, and emits the exact same GLB + manifest + edges.bin transport that the
three.js MeshViewer already consumes.

The empirical model (X1/X2/X3 -> 12 parameters) lives in the Node/TS layer; this
script is a PURE geometry builder that receives the already-resolved parameters
(in metres) as a JSON file, so there is no model logic to keep in sync here.

Geometry (originally prototyped standalone, since folded in here):
  * a rectangular box (WIDTH x LENGTH x HEIGHT),
  * two asymmetric chamfers on the two vertical corners of ONE end (the +Y end),
  * a stepped stack of three coaxial cylinders (first/middle/last) subtracted
    from the box, its flat first face resting on the floor (a small overcut so
    the pocket opens cleanly through the floor),
  * the result split into four named patches: inlet (far -Y end plane), outlet
    (middle cylinder wall), cylinder_walls (first+last walls, shoulders, cap),
    walls (the box's own faces).

CLI usage:
    python buildChamber.py <paramsJson> <outDir>

Outputs written under <outDir>:
    chamber.glb            binary glTF, one named node per patch
    manifest.json          bare MeshPatch[]  ({name,type,nFaces,edgeOffset,edgeCount})
    edges.bin              raw little-endian float32 line-segment endpoints
    exports/chamber.stl    the whole solid (single watertight mesh)
    exports/chamber.step   the whole solid (BREP). Guide-vane builds write it
                           only with --step (the carve + gate is ~2/3 of the
                           build); the API re-runs the builder with the flag
                           on the first STEP download.
    exports/trisurface.zip inlet/outlet/cylinder_walls/walls.stl + domain.stl

Dependencies (runtime): cadquery, trimesh, numpy. Imported INSIDE main() (after
argc validation) so a usage error is cheap.

Success/failure contract (mirrors extractPatches.py / CgnsToVtk.py):
  * success -> print "OK:" to stdout, exit 0
  * failure -> print "KO:" to stderr, exit 1
  * usage error (wrong argc) -> usage to stderr, exit 2
"""

import io
import json
import math
import os
import sys
import tempfile
import zipfile

# --- fixed builder configuration (NOT user inputs) --------------------------
# The LAST cylinder's diameter comes from the model (P9 / D_LAST); the first and
# middle diameters are ratios OF it. First is from the original Part.stl; middle
# is 0.80 x D_LAST (both variants) so it reads clearly narrower than the last.
RATIO_D_FIRST_OVER_LAST = 1.147030    # from the original Part.stl (2.81550/2.45460)
RATIO_D_MIDDLE_OVER_LAST = 0.80       # middle = 0.80 x D_LAST (both variants)
FLOOR_OVERCUT = 0.01                  # push the part below the floor so it opens
MIN_LAST_CYL_H = 0.05                 # stepped: min height kept for the last (top)
                                      # cylinder when up-scaling pushes the shoulder up
CHAMFER_END = ">Y"                    # the chamfered end (a width-side)
BIG_CORNER_SIDE = ">X"                # X-wall whose +Y corner gets the big chamfer
TESS_TOL = 0.01                       # tessellation tolerance (m)
STL_TOLERANCE = 0.01                  # STL export tolerance (m)
PLANE_TOL = 1e-4                      # "face lies in a plane" tolerance

# --- torque feet (4 pointed-hexagon voids, both variants) -------------------
# Each foot is a vertical pointed-hexagon LEG (floor -> base of the last/hollow
# cylinder) plus a horizontal PLANK sitting on top of the leg and reaching the
# cylinder wall. FOOT_ANGLE_DEG orients the leg: 0/180 = tangential (either way),
# 90 = radial.
FOOT_WIDTH = 0.14            # max width of the pointed-hexagon leg (140 mm)
FOOT_LENGTH = 0.45           # length of the leg along its axis (sharp tip -> blunt end)
FOOT_TAPER = 0.07            # run from the sharp inner tip to full width
FOOT_CHAMFER = 0.04          # 45 deg chamfer at the blunt outer end
FOOT_PLANK_THICK = 0.05      # vertical thickness of the horizontal plank (50 mm)
FOOT_PLANK_OVERLAP = 0.02    # plank radial overlap into the last-cyl wall
FOOT_GUSSET_MIN_BASE = 0.05  # min triangular-plank base; below it (near 0/90/180) the build refuses
FOOT_CLEARANCE = 0.02        # radial gap the leg keeps from the first cylinder (any angle)
FOOT_ANGLE_DEG = 40.0        # default leg orientation; the gusset needs an intermediate angle
                             # (0/180 = tangential and 90 = radial both degenerate the gusset)
FOOT_ANGLES_DEG = (0, 90, 180, 270)     # azimuth positions (aligned with the inlet axes)
VANE_BASE_ANGLE_DEG = 50.0   # the guide-vane open angle baked into the asset. The
                             # vaneAngleDeg param is this ABSOLUTE angle; the pitch
                             # actually applied is (vaneAngleDeg - VANE_BASE_ANGLE_DEG).
VANE_OUTLET_SAFE_MARGIN = 0.97   # outlet outer radius clamp: stay this fraction inside
                                 # the vane's own inner working radius (R_anchor in
                                 # make_vane_patches) so the blade always has shroud/hub
                                 # material to seat on and never overhangs the hole.

# --- parametric hub/shroud baseline (spec 2026-08-10) ------------------------
# Hub meridional interior points (asset space = absolute metres), measured from
# guideVanes_walls.stl by RDP reduction (_diag_rdp.py). Each is (r, z_asset);
# z_asset maps to build z via the existing HLE map z = z_sb + z_asset*sz.
VANE_HUB_P1 = (0.29548, 0.22608)     # duct-top -> shoulder (tracks rim: duct vertical)
VANE_HUB_P2 = (0.39274, 0.51575)     # shoulder knee (half-rate)
VANE_HUB_P3 = (0.61465, 0.64565)     # roof break; z_asset == asset height -> lands at z_mid_top
VANE_P3_RATIO = 0.93840              # P3 r / outletOuterR: P3 tracks R_shroud (X1), ratio-independent
# Shroud floor fillet = axis-aligned ellipse; semi-axes as fractions of R_shroud
# (fit in _diag_shroudcurve.py). a = radial, b = vertical.
VANE_SHROUD_ELL_A = 0.160
VANE_SHROUD_ELL_B = 0.119

PATCH_ORDER = ("inlet", "outlet", "cylinder_walls", "walls")
PATCH_TYPES = {
    "inlet": "patch",
    "outlet": "patch",
    "cylinder_walls": "wall",
    "walls": "wall",
    "hub": "wall",
    "shroud": "wall",
    "guide_vanes": "wall",
}


# --- geometry ----------------------------------------------------------------
def _corner_prism(cq, width, length, height, sx, sy, len_set, wid_set):
    """Full-height triangular prism trimming one vertical corner: cuts WID_SET
    along X and LEN_SET along Y away from corner (sx*W/2, sy*L/2)."""
    P = (sx * width / 2, sy * length / 2)
    A = (sx * (width / 2 - wid_set), sy * length / 2)
    B = (sx * width / 2, sy * (length / 2 - len_set))
    return (
        cq.Workplane("XY", origin=(0, 0, -height / 2))
        .polyline([P, A, B]).close()
        .extrude(height)
    )


def make_box(cq, width, length, height, end, big_side, ch_big, ch_small, enabled=True):
    """Box with two asymmetric chamfers on the two vertical corners of ONE end
    (when enabled). ch = (length_setback, width_setback): cut along Y (length)
    and X (width). When enabled=False the box is returned untouched -- ch_big/
    ch_small are ignored entirely, never coerced to a zero-size cut (which
    would be a degenerate zero-area wire)."""
    b = cq.Workplane("XY").box(width, length, height)
    if not enabled:
        return b
    end_sy = 1.0 if end.startswith(">") else -1.0
    big_sx = 1.0 if big_side.startswith(">") else -1.0
    b = b.cut(_corner_prism(cq, width, length, height, big_sx, end_sy,
                            ch_big[0], ch_big[1]))
    b = b.cut(_corner_prism(cq, width, length, height, -big_sx, end_sy,
                            ch_small[0], ch_small[1]))
    return b


def make_part(cq, d_first, h_first, d_middle, h_middle, d_last, h_last,
              omit_middle=False, h_last_override=None):
    """Three coaxial cylinders stacked along +Z, base of the FIRST at z = 0
    (the 'stepped' variant). With omit_middle the MIDDLE cylinder is left out
    (the guide-vane band is open): first (0..h_first) + last, the last floating
    at its usual height (h_first+h_middle .. +h_last) so the band is fluid.
    h_last_override, when given, is the last cylinder's extrude length instead of
    h_last -- the stepped build passes it to pin the last cylinder's TOP to the
    box top regardless of partScale (base unchanged at h_first+h_middle)."""
    last_h = h_last if h_last_override is None else h_last_override
    part = cq.Workplane("XY").circle(d_first / 2).extrude(h_first)
    if omit_middle:
        last = (cq.Workplane("XY", origin=(0, 0, h_first + h_middle))
                .circle(d_last / 2).extrude(last_h))
        return part.union(last)
    part = part.faces(">Z").workplane().circle(d_middle / 2).extrude(h_middle)
    part = part.faces(">Z").workplane().circle(d_last / 2).extrude(last_h)
    return part


def make_dome(cq, radius, height, z_apex_base):
    """A half-ellipsoid dome (an oval top): a sphere of `radius` scaled in Z to a
    vertical semi-axis of `height`, centred at z = z_apex_base so its top half
    (apex at z_apex_base + height) forms the dome. The lower half sits inside the
    cylinder it caps (radii match), so a union yields a domed top."""
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeSphere
    from OCP.BRepBuilderAPI import BRepBuilderAPI_GTransform
    from OCP.gp import gp_GTrsf, gp_Mat

    sphere = BRepPrimAPI_MakeSphere(radius).Solid()
    gt = gp_GTrsf()
    gt.SetVectorialPart(gp_Mat(1, 0, 0, 0, 1, 0, 0, 0, height / radius))
    ellipsoid = BRepBuilderAPI_GTransform(sphere, gt, True).Shape()
    return cq.Solid(ellipsoid).translate((0, 0, z_apex_base))


def make_part_hollow(cq, d_first, h_first, d_middle, h_middle, d_last,
                     wall, hollow_len, c_dia, c_h, dome_h, omit_middle=False):
    """The 'hollow' variant (base of the FIRST at z = 0), a union of:
      * first + middle SOLID cylinders (as in 'stepped'),
      * the LAST cylinder as an open-top hollow shell (outer d_last, wall
        thickness `wall`) of height `hollow_len`,
      * a central cylinder (dia c_dia, height c_h) rising coaxially from the top
        of the middle cylinder, capped by an oval dome of height dome_h.
    The whole union is later SUBTRACTED from the block, so every surface here is
    carved out (walls included). With omit_middle the MIDDLE cylinder is left out
    (the guide-vane band is open fluid); the cup/central/dome still start at
    z_mid_top so the stack above the band is unchanged."""
    z_mid_top = h_first + h_middle
    part = cq.Workplane("XY").circle(d_first / 2).extrude(h_first)
    if not omit_middle:
        part = part.faces(">Z").workplane().circle(d_middle / 2).extrude(h_middle)

    # the hollow last cylinder as an open-top CUP (diameter d_last = P9): 5 cm
    # walls + a thin bottom of the same thickness, open at the top. Built as the
    # outer cylinder minus a bore that stops `wall` above the base.
    outer = (
        cq.Workplane("XY", origin=(0, 0, z_mid_top))
        .circle(d_last / 2)
        .extrude(hollow_len)
    )
    bore = (
        cq.Workplane("XY", origin=(0, 0, z_mid_top + wall))
        .circle(d_last / 2 - wall)
        .extrude(hollow_len - wall)
    )
    tube = outer.cut(bore)
    # central cylinder rising from the middle's top, with an oval dome on top
    central = (
        cq.Workplane("XY", origin=(0, 0, z_mid_top))
        .circle(c_dia / 2)
        .extrude(c_h)
    )
    dome = make_dome(cq, c_dia / 2, dome_h, z_mid_top + c_h)

    return part.union(tube).union(central).union(dome)


def make_feet(cq, cx, cy, z0, z_top, r_cyl, d_first, foot_angle_deg=FOOT_ANGLE_DEG,
              width=FOOT_WIDTH, length=FOOT_LENGTH, taper=FOOT_TAPER,
              chamfer=FOOT_CHAMFER, plank_thick=FOOT_PLANK_THICK,
              plank_overlap=FOOT_PLANK_OVERLAP,
              gusset_min_base=FOOT_GUSSET_MIN_BASE, clear=FOOT_CLEARANCE,
              angles=FOOT_ANGLES_DEG):
    """Four torque-foot VOIDS spaced at `angles` (0/90/180/270). Each LEG is a
    pointed-hexagon TOP-DOWN footprint (max width `width`, a sharp tip and a blunt
    45 deg-chamfered end) extruded VERTICALLY from the floor (z0) up to the BASE of
    the last/hollow cylinder (z_top). Its inner tip anchors just outside the first
    cylinder (radial gap `clear`). `foot_angle_deg` swings the leg about the
    vertical line through that tip: 0 deg = TANGENTIAL one way, 90 deg = RADIAL
    (tip pointing at the axis), 180 deg = TANGENTIAL the other way. A horizontal
    TRIANGULAR PLANK (gusset) then sits ON TOP of the leg with vertices: the leg's
    FAR tip (apex), the point where the tip-to-tip line extended hits the cylinder
    (through the inner tip), and the perpendicular (radial) foot of the FAR tip on
    the cylinder. Its bottom is flush on the cylinder base z_top (no thin ledge
    under the cylinder); the two base vertices are pushed `plank_overlap` inside the
    wall for a solid weld. The leg is extruded up to the plank's TOP so both share
    one flat top face (no step where they meet). The gusset CANNOT form near
    tangential (0/180, the tip line misses the
    cylinder) or near radial (90, the base collapses); within `gusset_min_base` of
    degenerate the build is REFUSED (raises). Returns (feet_union, r_outer) centred
    at the part axis (cx, cy); r_outer bounds the footprint for the classifier."""
    hw = width / 2
    # Anchor the inner tip so the WHOLE footprint clears the first cylinder at ANY
    # angle: when the leg swings tangential its half-width `hw` reaches inward past
    # the tip, so fold hw into the radial gap (radial: hw points sideways, no dip).
    r_in = d_first / 2 + clear + hw      # inner tip (clears first cyl by `clear` at all angles)
    r_outer = r_in + length             # blunt end (radial baseline; bounds all angles)
    # pointed-hexagon plan profile (x = along the leg from the tip, y = across it)
    plan = [
        (r_in, 0.0), (r_in + taper, hw), (r_outer - chamfer, hw),
        (r_outer, hw - chamfer), (r_outer, -(hw - chamfer)),
        (r_outer - chamfer, -hw), (r_in + taper, -hw),
    ]
    # Extrude the leg up to the plank's TOP (z_top + plank_thick) so the leg and
    # plank share ONE flat top surface -> no step/edge where they meet (the plank
    # still starts at z_top, flush with the cylinder base). CFD-friendly.
    leg = cq.Workplane("XY", origin=(0, 0, z0)).polyline(plan).close().extrude((z_top + plank_thick) - z0)
    # The unrotated plan lies RADIAL (long axis along +X). Swing it (angle - 90)
    # about the vertical axis through the inner tip: 0 deg -> tangential one way,
    # 90 deg -> radial, 180 deg -> tangential the other way.
    leg = leg.rotate((r_in, 0, 0), (r_in, 0, 1), foot_angle_deg - 90.0)
    # horizontal TRIANGULAR plank (gusset) ON TOP of the leg. Apex at the leg's far
    # tip; base is a chord on the last cylinder. One edge is the perpendicular
    # (radial) line from the far tip to the cylinder, the other runs from the far
    # tip back to the cylinder near the inner tip. Its bottom sits exactly on the
    # cylinder base z_top (no sub-shoulder ledge -> CFD-friendly); the leg overlaps
    # it from below for a clean union. Base vertices are pushed `plank_overlap`
    # inside the wall so the gusset welds solidly to the cylinder along the chord.
    lean = math.radians(foot_angle_deg - 90.0)
    t_in = (r_in, 0.0)                                 # inner tip (pivot)
    t_out = (r_in + length * math.cos(lean), length * math.sin(lean))  # far (rotating) tip
    r_base = r_cyl - plank_overlap                     # base vertices sit just inside the wall
    t_out_len = math.hypot(*t_out)
    c_out = (r_base * t_out[0] / t_out_len, r_base * t_out[1] / t_out_len)  # far-tip perpendicular foot
    # C_axis: extend the tip-to-tip line (through the inner + far tips) INWARD to
    # the cylinder. This misses the cylinder near tangential (0/180), where the
    # line runs parallel to the wall -> then the gusset cannot be formed.
    dx, dy = t_in[0] - t_out[0], t_in[1] - t_out[1]
    dnorm = math.hypot(dx, dy)
    dx, dy = dx / dnorm, dy / dnorm
    bq = 2.0 * (t_in[0] * dx + t_in[1] * dy)
    cq_ = t_in[0] ** 2 + t_in[1] ** 2 - r_base ** 2
    disc = bq * bq - 4.0 * cq_
    c_axis = None
    if disc >= 0.0:
        sq = math.sqrt(disc)
        pos = [s for s in ((-bq - sq) / 2.0, (-bq + sq) / 2.0) if s > 1e-9]
        if pos:
            s = min(pos)                               # nearest crossing going inward
            c_axis = (t_in[0] + s * dx, t_in[1] + s * dy)
    if c_axis is None or math.hypot(c_axis[0] - c_out[0], c_axis[1] - c_out[1]) < gusset_min_base:
        raise ValueError(
            "footAngleDeg %.1f cannot form the triangular gusset (near tangential "
            "0/180 the tip line misses the cylinder; near radial 90 the base "
            "collapses). Use an intermediate angle." % foot_angle_deg)
    # gusset: apex at the far tip; one edge is the tip-to-tip line extended to the
    # cylinder (c_axis, through the inner tip), the other the far tip's
    # perpendicular foot (c_out); base is the chord c_axis..c_out on the cylinder.
    plank = (
        cq.Workplane("XY", origin=(0, 0, z_top))
        .polyline([t_out, c_axis, c_out]).close()
        .extrude(plank_thick)
    )
    foot0 = leg.union(plank)
    feet = None
    for a in angles:
        f = foot0.rotate((0, 0, 0), (0, 0, 1), a)
        feet = f if feet is None else feet.union(f)
    return feet.translate((cx, cy, 0)), r_outer


# --- guide-vane throat (mesh patches, no OCC boolean) -----------------------
def _vane_assets_dir():
    """assets/ next to this script (holds the committed vane STLs + JSON)."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")


def _load_vane_meta():
    """The committed guide-vane metadata (pivotRadius, contour height, radii …)."""
    with open(os.path.join(_vane_assets_dir(), "guideVanes.json")) as fh:
        return json.load(fh)


def vane_scale_and_height(meta, d_ring):
    """The uniform vane scale and scaled contour height for a given guide-vanes RING
    diameter `d_ring` (the middle-cylinder diameter: 0.80 x d_last by default, or a
    manual override). `s` pins the blade pivot-circle Ø to d_ring; `nat_h` is the
    scaled top-to-outlet contour height (the vane passage's full height)."""
    s = d_ring / (2.0 * meta["pivotRadius"])
    return s, meta["height"] * s


def _open_cylinder(np, trimesh, cx, cy, r, z0, z1, n=128):
    """A vertical open cylinder WALL (side faces only) of radius r about (cx, cy),
    from z0 to z1 — the hub / shroud straight DUCT from the passage bottom to the
    box floor, extending the mesh down to the outlet."""
    th = np.linspace(0.0, 2.0 * np.pi, n, endpoint=False)
    xs, ys = cx + r * np.cos(th), cy + r * np.sin(th)
    verts = np.vstack([np.column_stack([xs, ys, np.full(n, z0)]),
                       np.column_stack([xs, ys, np.full(n, z1)])])
    faces = []
    for i in range(n):
        j = (i + 1) % n
        faces.append([i, n + i, n + j])
        faces.append([i, n + j, j])
    return trimesh.Trimesh(vertices=verts, faces=np.array(faces, dtype=np.int64), process=False)


def _flat_annulus(np, trimesh, cx, cy, z, r_in, r_out, n=128):
    """A flat annular ring (a disk with a central hole) at height z about (cx, cy)
    — the outlet face between the hub (inner) and shroud (outer) at the floor."""
    th = np.linspace(0.0, 2.0 * np.pi, n, endpoint=False)
    inner = np.column_stack([cx + r_in * np.cos(th), cy + r_in * np.sin(th), np.full(n, z)])
    outer = np.column_stack([cx + r_out * np.cos(th), cy + r_out * np.sin(th), np.full(n, z)])
    verts = np.vstack([inner, outer])
    faces = []
    for i in range(n):
        j = (i + 1) % n
        faces.append([i, n + i, n + j])
        faces.append([i, n + j, j])
    return trimesh.Trimesh(vertices=verts, faces=np.array(faces, dtype=np.int64), process=False)


def _split_hub_shroud(np, walls):
    """Split the passage-wall shell into (hub_mesh, shroud_mesh) by which surface
    each face lies on. The two walls meet only at the outer rim and both bend down
    to the outlet, so they cannot be told apart by height; instead use the face
    normal about the ring axis (asset origin): the HUB (top + inner wall) points UP
    or INWARD, the SHROUD (bottom + outer wall) points DOWN or OUTWARD. The scalar
    score = n.z - n.r_hat (r_hat = outward radial unit vector) is > 0 on the hub and
    <= 0 on the shroud, and stays correct through the 90 deg bend to the outlet."""
    fc = walls.vertices[walls.faces].mean(axis=1)      # face centroids (about axis 0,0)
    frad = np.hypot(fc[:, 0], fc[:, 1])
    nrm = walls.face_normals
    n_r = np.where(frad > 1e-9,
                   (nrm[:, 0] * fc[:, 0] + nrm[:, 1] * fc[:, 1]) / np.maximum(frad, 1e-9),
                   0.0)
    hub_mask = (nrm[:, 2] - n_r) > 0.0
    hub = walls.submesh([np.where(hub_mask)[0]], append=True)
    shroud = walls.submesh([np.where(~hub_mask)[0]], append=True)
    return hub, shroud


def _hub_point_radii(R_hub_new, R_shroud_new, meta):
    """Radial positions of the hub shoulder points under the X1/ratio rule
    (spec 2026-08-10 §4). Radial only; the caller applies z via the HLE map.
    P1 tracks the rim (full delta), P2 half, P3 proportional to R_shroud."""
    dr_hub = R_hub_new - meta["outletInnerR"]      # R_hub0 = asset inner rim (absolute)
    r_rim = R_hub_new
    r_p1 = VANE_HUB_P1[0] + dr_hub
    r_p2 = VANE_HUB_P2[0] + dr_hub / 2.0
    r_p3 = VANE_P3_RATIO * R_shroud_new
    return r_rim, r_p1, r_p2, r_p3


def _shroud_fillet_profile(np, R_shroud_new, z_brim, r_wall, n=48):
    """Shroud floor meridional (r, z): a quarter-ellipse fillet seated at the inner
    rim r=R_shroud_new (vertical tangent) rising to a horizontal tangent at the brim
    z=z_brim, then flat out to r_wall (spec 2026-08-10 §5). Semi-axes scale with
    R_shroud so R_curve/R_shroud is constant. Fillet bottom is at z_brim - b."""
    a = VANE_SHROUD_ELL_A * R_shroud_new     # radial
    b = VANE_SHROUD_ELL_B * R_shroud_new     # vertical
    cr, cz = R_shroud_new + a, z_brim - b     # ellipse centre: leftmost@rim, top@brim
    th = np.linspace(np.pi, np.pi / 2.0, n)   # pi -> leftmost (rim); pi/2 -> top (brim)
    r = cr + a * np.cos(th)                   # rim -> cr
    z = cz + b * np.sin(th)                   # (z_brim-b) -> z_brim
    prof = np.column_stack([r, z])
    return np.vstack([prof, [r_wall, z_brim]])   # flat brim run to the wall


def _densify(np, profile_rz, step=0.003):
    """Insert intermediate points so no meridional segment exceeds `step`, giving a
    finely tessellated surface/solid of revolution (the analytic corner polylines are
    otherwise 4-5 points -> one coarse quad-row per segment). `step` is kept below the
    verification's r-bin width (~0.004) so every bin gets a top-surface sample.
    Corners are preserved."""
    prof = np.asarray(profile_rz, dtype=float)
    out = [prof[0]]
    for i in range(1, len(prof)):
        a, b = prof[i - 1], prof[i]
        d = float(np.hypot(b[0] - a[0], b[1] - a[1]))
        n = max(1, int(np.ceil(d / step)))
        for k in range(1, n + 1):
            out.append(a + (b - a) * (k / n))
    return np.array(out, dtype=float)


def _revolve_open(np, trimesh, profile_rz, cx, cy, sections=128):
    """Revolve an OPEN (r, z) polyline about the vertical axis at (cx, cy) into an
    open surface of revolution (a lofted band, no end caps) — the analytic hub/shroud
    refinement + classification patch. Each profile point becomes a ring of `sections`
    vertices; consecutive rings are joined by quads (two triangles)."""
    prof = np.asarray(profile_rz, dtype=float)
    th = np.linspace(0.0, 2.0 * np.pi, sections, endpoint=False)
    ct, st = np.cos(th), np.sin(th)
    rings = [np.column_stack([cx + r * ct, cy + r * st, np.full(sections, z)])
             for r, z in prof]
    verts = np.vstack(rings)
    faces = []
    for i in range(len(prof) - 1):
        a0, b0 = i * sections, (i + 1) * sections
        for j in range(sections):
            j1 = (j + 1) % sections
            faces.append([a0 + j, b0 + j, b0 + j1])
            faces.append([a0 + j, b0 + j1, a0 + j1])
    return trimesh.Trimesh(vertices=verts, faces=np.array(faces, dtype=np.int64), process=False)


def make_vane_patches(trimesh, np, cx, cy, z_mid_base, z_mid_top, d_last, vane_angle_deg=0.0,
                       outlet_outer_d=None, outlet_ratio=None, d_ring=None):
    """Return {patch_name: Trimesh} for the guide-vane throat: the SOLID vane
    surfaces (blades + contoured hub/shroud walls + the outlet annulus) that sit
    as obstacles in the fluid box, centred at (cx, cy).

    Uniform scale pins the blade PIVOT circle diameter (2 x pivotRadius) to the
    middle diameter (0.80 x d_last), preserving the blade angle and all radii. The
    band is then stretched/clipped VERTICALLY (a separate z scale) so the vane
    channel fills the HLE band exactly: the vane bottom lays on the first-cylinder
    top and the hub roof meets the upper-cylinder base. The curved throat keeps its
    shape (scaled in z, never flattened) and continues down to the outlet. No
    bounding cylinder is used — the vanes are obstacles in the open box cavity, so
    the fluid flows directly around them.

    `outlet_outer_d` (metres, the resolved X1) and `outlet_ratio` (0.35..0.50) size
    the OUTLET: outer radius = outlet_outer_d/2 (clamped, see VANE_OUTLET_SAFE_MARGIN
    below), inner radius = outlet_ratio * outer. Both None (old cached builds that
    predate this feature) reproduces the exact historical asset-derived rims. The
    hub throat, shroud and outlet asset are all remapped by a single monotonic
    piecewise-linear radius function pinned at the two outlet rims and fading to
    IDENTITY at the vane's own inner working radius (R_anchor) — so the vane band,
    hub roof and shroud brim/wall never move; only the outlet throat/fillet reshapes.
    Returns two extra float keys, "outlet_ri"/"outlet_ro", the resolved (possibly
    clamped) rims — main() uses these downstream instead of recomputing them."""
    adir = _vane_assets_dir()
    meta = _load_vane_meta()
    blade = trimesh.load(os.path.join(adir, "guideVanes_blade.stl"))
    walls = trimesh.load(os.path.join(adir, "guideVanes_walls.stl"))
    outlet_asset = trimesh.load(os.path.join(adir, "guideVanes_outlet.stl"))

    # RADIAL scale keys off the guide-vanes ring diameter d_ring (the middle-cylinder
    # Ø: 0.80 d_last by default, or a manual override); d_last still sets the shroud
    # OUTER radius (d_last/2, the upper-cylinder wall) below, so a vane-Ø override
    # resizes the blade ring without moving the shroud rim.
    s, _ = vane_scale_and_height(meta, d_ring if d_ring is not None else RATIO_D_MIDDLE_OVER_LAST * d_last)
    # Scale RADIALLY by s (fixes the blade pivot circle to 0.80 d_last, so the blade
    # ANGLE and all radii are preserved), then adapt VERTICALLY to the HLE band
    # [z_mid_base, z_mid_top] via the z scale sz = band / channel-height, anchored so
    # the BOTTOM stays fixed on the first-cylinder top and any change happens from the
    # top: the vane bottom (blade body bottom, asset z=blade_z0) lays on z_mid_base and
    # the hub roof (asset z=height) meets the upper-cylinder base z_mid_top. The vanes
    # ELONGATE or CLIP to fill the band; because the blade is prismatic, a pure z scale
    # never distorts its cross-section (same airfoil, taller/shorter). The hub adjusts
    # to the height (roof at z_mid_top, throat scaled in z, never flattened).
    # Anchor on the blade BODY bottom AT THE PIVOT RADIUS (the vane rotation axis),
    # NOT the global minimum: the blade has a small stub/pin at its inner edge that
    # dips ~0.0099 below the airfoil body. Seating that stub floats the whole blade
    # above the first-cylinder top; anchoring at the pivot bottom seats the body and
    # lets the stub embed into the seat. The fallback stays the global min for old
    # assets that predate the baked-in value.
    blade_z0 = float(meta.get("bladeBottomZ", blade.vertices[:, 2].min()))  # vane bottom at pivot (asset z)
    band = z_mid_top - z_mid_base                    # HLE band (first-cyl top -> upper-cyl base)
    sz = band / (meta["height"] - blade_z0)          # vertical scale: channel height -> HLE band
    z_sb = z_mid_base - blade_z0 * sz                 # asset z=0 offset; blade bottom -> z_mid_base

    def place(mesh):
        m = mesh.copy()
        m.apply_scale((s, s, sz))                   # radial s (angle preserved) + vertical sz
        m.apply_translation((cx, cy, z_sb))         # asset bottom (z=0) -> z_sb
        return m

    # Build the reference blade (placed + pitched) FIRST, before any outlet-rim
    # work: R_anchor (the vane's own inner working radius, below) is measured from
    # it, and pitch/placement only move the blade radially — the shroud-floor DRAPE
    # applied later only moves Z, so measuring here (pre-drape) is exact.
    bc = np.asarray(blade.vertices, dtype=float).mean(axis=0)
    theta0 = np.arctan2(bc[1], bc[0])               # reference blade angular position
    piv_x = meta["pivotRadius"] * s * np.cos(theta0) + cx
    piv_y = meta["pivotRadius"] * s * np.sin(theta0) + cy
    pang = np.radians(vane_angle_deg)
    Rp = np.array([[np.cos(pang), -np.sin(pang), 0, 0],
                   [np.sin(pang), np.cos(pang), 0, 0],
                   [0, 0, 1, 0], [0, 0, 0, 1]])

    base = place(blade)
    if vane_angle_deg:
        base.apply_translation((-piv_x, -piv_y, 0))     # pitch about the spindle
        base.apply_transform(Rp)
        base.apply_translation((piv_x, piv_y, 0))
    R_anchor = float(np.hypot(base.vertices[:, 0] - cx, base.vertices[:, 1] - cy).min())

    # Remap INPUT x-knots: where the asset's two outlet rims land after the pure
    # radial scale s (i.e. BEFORE any outlet retargeting). These are the asset-space
    # rim radii * s — NOT the old sz-adjusted OUTPUT positions.
    ri_in = meta["outletInnerR"] * s
    ro_in = meta["outletOuterR"] * s                 # == the old r_shroud
    # Remap OUTPUT y-knots (the resolved rim targets). Fallback (either param None:
    # old cached builds that predate this feature) reproduces the OLD map's rim
    # OUTPUTS: the old map was r_out = ro_in + (r_in - ro_in) * sz for every radius,
    # so its shroud rim stayed at ro_in and its hub rim landed at
    # ro_in + (ri_in - ro_in) * sz — exactly the values below.
    if outlet_outer_d is None or outlet_ratio is None:
        ro_target = ro_in
        ri_target = max(ro_in + (ri_in - ro_in) * sz, 1e-3)
    else:
        ro_target = outlet_outer_d / 2.0
        if ro_target >= VANE_OUTLET_SAFE_MARGIN * R_anchor:
            print("WARNING: outlet outer radius %.4f clamped to %.4f "
                  "(X1 too large for this vane/d_last combination)"
                  % (ro_target, VANE_OUTLET_SAFE_MARGIN * R_anchor))
            ro_target = VANE_OUTLET_SAFE_MARGIN * R_anchor
        ri_target = max(outlet_ratio * ro_target, 1e-3)

    # The HUB throat, SHROUD and OUTLET are all remapped by the SAME monotonic
    # piecewise-linear radius function: pinned at (0,0), the two ASSET-SCALED input
    # rims (ri_in, ro_in) -> their TARGETS (ri_target, ro_target), and IDENTITY from
    # R_anchor (the vane's own inner radius) outward — so the vane band, hub roof and
    # shroud brim/wall are geometrically untouched; only the outlet throat/fillet
    # (r <= R_anchor) reshapes. On [ri_in, ro_in] the interpolated slope is exactly
    # the old map's sz in the fallback, so the converging throat is reproduced; the
    # map only differs from the old single-slope map OUTSIDE that span (below the
    # outlet rim, where the throat has no vertices, and above ro_in where it holds
    # identity instead of extrapolating into the vane band).
    def place_throat(mesh):
        m = mesh.copy()
        v = np.asarray(m.vertices, dtype=float)
        r = np.hypot(v[:, 0], v[:, 1])                       # asset radius about the ring axis
        r_scaled = r * s
        r_new = np.where(
            r_scaled <= R_anchor,
            np.interp(r_scaled, [0.0, ri_in, ro_in, R_anchor],
                      [0.0, ri_target, ro_target, R_anchor]),
            r_scaled,
        )
        r_new = np.maximum(r_new, 1e-3)
        ux = np.where(r > 1e-12, v[:, 0] / r, 0.0)           # unit radial (angle preserved)
        uy = np.where(r > 1e-12, v[:, 1] / r, 0.0)
        m.vertices = np.column_stack([cx + r_new * ux, cy + r_new * uy, z_sb + v[:, 2] * sz])
        return m

    # Split the passage walls into the HUB (top + inner surface) and the SHROUD
    # (bottom + outer surface) as SEPARATE CFD wall patches. Both surfaces curve
    # DOWN to the outlet, so a flat z cut is wrong; classify each face by WHICH
    # surface it lies on, following the curve, via its normal about the ring axis:
    #   hub  faces point UP or INWARD  (toward the axis)   -> n.z - n.r_hat > 0
    #   shroud faces point DOWN or OUTWARD                 -> n.z - n.r_hat <= 0
    # where n.r_hat is the outward radial component of the face normal. This holds
    # through the 90 deg bend (flat channel: nz dominates; vertical throat: nr
    # dominates), so the hub follows down to the outlet's inner rim and the shroud
    # down to its outer rim. Done on the RAW asset (normals are unchanged by the
    # uniform place() scale + translate).
    hub_walls, shroud_walls = _split_hub_shroud(np, walls)

    # The hub and shroud are built as their FULL surfaces of revolution (roof + throat
    # + duct, floor + funnel + duct). main() turns each into a watertight solid of
    # revolution (the hub CORE, the shroud CASING) and subtracts them from the fluid, so
    # the non-wetted regions are removed by the boolean at build time; the true wetted
    # boundary is then re-split into named patches. These full surfaces are therefore
    # both the classification sources and the silhouettes the core/casing are revolved
    # from — hence the synthesised roof below (out to the upper-cyl wall) is what caps
    # the core silhouette, not a surface that is emitted verbatim.
    #
    # ANALYTIC path (spec 2026-08-10): when the X1/ratio params are present, build the
    # hub + shroud from parametric meridional profiles instead of remapping the asset
    # mesh. z uses the existing HLE map (radius is X1-driven, z is not).
    analytic = outlet_outer_d is not None and outlet_ratio is not None

    def _z(z_asset):                                    # HLE vertical map (z unchanged by X1)
        return z_sb + z_asset * sz

    hub_profile = None
    if analytic:
        # HUB = the 3-point meridional polyline (rim -> P1 -> P2 -> P3) + a flat roof
        # out to the wall. Points move per _hub_point_radii; z is fixed via the HLE map.
        r_rim, r_p1, r_p2, r_p3 = _hub_point_radii(ri_target, ro_target, meta)
        # The real invalid case is the shoulder folding (P1 overtaking P2 at high X1).
        # rim vs P1 is an inherent ~0.25 mm lean (P1_0 sits just inside R_hub0), not a fold.
        if not (r_p1 <= r_p2 <= r_p3):
            print("WARNING: hub shoulder non-monotonic (X1 too large for the point "
                  "spacing): rim=%.4f P1=%.4f P2=%.4f P3=%.4f"
                  % (r_rim, r_p1, r_p2, r_p3))
        hub_profile = np.array([
            [r_rim, _z(0.05288)],                       # outlet inner rim (passage bottom)
            [r_p1, _z(VANE_HUB_P1[1])],
            [r_p2, _z(VANE_HUB_P2[1])],
            [r_p3, _z(VANE_HUB_P3[1])],                 # roof break (z == z_mid_top)
        ], dtype=float)
        _throat = _revolve_open(np, trimesh, _densify(np, hub_profile), cx, cy)   # throat, no roof
        _hub_surface = np.vstack([hub_profile, [d_last / 2.0, _z(VANE_HUB_P3[1])]])
        hub_mesh = _revolve_open(np, trimesh, _densify(np, _hub_surface), cx, cy)  # + flat roof
    else:
        # HUB mesh = the place_throat THROAT + a synthesised flat ROOF. place_throat scales
        # the asset roof by the vertical band factor (it balloons past the wall when sz>1 and
        # shrinks short of it when sz<1), so instead of using that roof we rebuild it as a
        # clean annulus from the throat top out to the upper-cyl wall (d_last/2). The roof
        # then reaches the wall for ANY HLE band, so the hub-core silhouette is full-width.
        _hub_placed = place_throat(hub_walls)
        _hf = _hub_placed.vertices[_hub_placed.faces].mean(axis=1)
        _hfnz = _hub_placed.face_normals[:, 2]
        _roof_face = (np.abs(_hf[:, 2] - z_mid_top) < 0.02 * band) & (np.abs(_hfnz) > 0.7)
        _throat = _hub_placed.submesh([np.where(~_roof_face)[0]], append=True)
        _tv = np.asarray(_throat.vertices, dtype=float)
        _tr = np.hypot(_tv[:, 0] - cx, _tv[:, 1] - cy)
        _throat_top_r = float(_tr[_tv[:, 2] > z_mid_top - 0.02 * band].max())
        _roof = _flat_annulus(np, trimesh, cx, cy, z_mid_top, _throat_top_r, d_last / 2.0)
        hub_mesh = trimesh.util.concatenate([_throat, _roof])

    # SHROUD floor.
    shroud_profile = None
    if analytic:
        # Analytic quarter-ellipse fillet seated at the outer rim (ro_target), rising to
        # the flat brim, then out to the wall. Semi-axes scale with R_shroud so
        # R_curve/(X1/2) is constant. The floor contour f(r) drives the blade drape.
        z_brim = _z(0.09850)                        # existing brim height (asset z ~ 0.0985)
        shroud_profile = _shroud_fillet_profile(np, ro_target, z_brim,
                                                d_last / 2.0 + FLOOR_OVERCUT)
        shroud_placed = _revolve_open(np, trimesh, _densify(np, shroud_profile), cx, cy)
        _rc_v, _zf_v = shroud_profile[:, 0], shroud_profile[:, 1]
    else:
        # The SHROUD goes through place_throat (not the plain place()) so its outer rim
        # lands on ro_target too — everything at r > R_anchor (the brim, floor further
        # out) is untouched (identity). Derive its FLOOR profile f(r) = top-surface z per
        # radius from the placed mesh; reading it off the ACTUALLY-PLACED shroud makes the
        # blade drape below track HLE, diameter and the new rims automatically.
        shroud_placed = place_throat(shroud_walls)
        _sv = np.asarray(shroud_placed.vertices, dtype=float)
        _sr = np.hypot(_sv[:, 0] - cx, _sv[:, 1] - cy)
        _nb = 240
        _edges = np.linspace(_sr.min(), _sr.max(), _nb + 1)
        _rc = 0.5 * (_edges[:-1] + _edges[1:])
        _idx = np.clip(np.searchsorted(_edges, _sr) - 1, 0, _nb - 1)
        _zf = np.full(_nb, -np.inf)
        np.maximum.at(_zf, _idx, _sv[:, 2])         # per-radius top surface = the floor
        _ok = np.isfinite(_zf)
        _rc_v, _zf_v = _rc[_ok], _zf[_ok]

    def shroud_floor_z(r):
        return np.interp(r, _rc_v, _zf_v)           # clamps to end values outside the range

    # Guide-vane shroud DRAPE. The blade was already placed + pitched above (to
    # measure R_anchor); a rigid pitch shifts the (contoured) bottom edge radially
    # onto a different part of the SLOPED shroud floor, so it would otherwise hang
    # above (or dig into) the shroud — the bottom BAND is re-draped onto
    # shroud_floor_z(r) minus a small overlap, blended to zero shift a band-fraction
    # higher up so the airfoil above stays rigid (no kink). Only Z moves, so the
    # blade cross-section is untouched. The radius-preserving ring rotation below
    # then carries identical copies to their slots (drape is a function of radius,
    # so it survives the ring rotation).
    _bv = np.asarray(base.vertices, dtype=float)
    _br = np.hypot(_bv[:, 0] - cx, _bv[:, 1] - cy)
    _overlap = 0.01 * band                          # small penetration into the shroud: seals the
                                                    # blade->shroud junction (a gap would leak; a
                                                    # coincident plane confuses the mesher) and stays
                                                    # comfortably above typical snappy/cfMesh cell
                                                    # sizes so it is reliably captured. It is hidden
                                                    # behind the shroud wall, so it is invisible in the
                                                    # meshed fluid domain.
    _blend_h = 0.15 * band                          # ramp the drape over the bottom ~15% of the band
    _w = np.clip((z_mid_base + _blend_h - _bv[:, 2]) / _blend_h, 0.0, 1.0)  # 1 at the floor -> 0 above
    _bv[:, 2] = _bv[:, 2] + _w * (shroud_floor_z(_br) - _overlap - _bv[:, 2])
    base.vertices = _bv

    blades = []
    for k in range(int(meta["bladeCount"])):
        b = base.copy()
        ang = np.radians(k * meta["bladeAngleStepDeg"])
        R = np.array([[np.cos(ang), -np.sin(ang), 0, 0],
                      [np.sin(ang), np.cos(ang), 0, 0],
                      [0, 0, 1, 0], [0, 0, 0, 1]])
        b.apply_translation((-cx, -cy, 0))          # rotate about the ring axis (cx, cy)
        b.apply_transform(R)
        b.apply_translation((cx, cy, 0))
        blades.append(b)
    blades_m = trimesh.util.concatenate(blades)

    # Outlet = the passage's whole bottom annular face (hub -> shroud), the real
    # CAD outlet cap. Placed by the SAME remap as the walls, so it lands exactly on
    # the (ratio/X1-scaled) rims and keeps its slight conical form — the full
    # cross-section after the curve, not a synthesised flat ring.
    outlet = place_throat(outlet_asset)

    return {
        # FULL hub/shroud surfaces (roof/floor + throat/funnel), the true refinement
        # surfaces. Hub roof synthesised to meet the wall for any band; shroud now
        # goes through the same pinned-rim remap as the throat/outlet.
        "hub": hub_mesh,
        # THROAT only (funnel + duct, NO flat roof) — the hub-core solid is revolved
        # from this so the throat->roof corner is not cut. Not a CFD patch (not emitted).
        "hub_throat": _throat,
        "shroud": shroud_placed,
        "outlet": outlet,
        "guide_vanes": blades_m,
        # Resolved (possibly clamped) outlet rims — main() uses these downstream
        # instead of recomputing them, so there is exactly one source of truth.
        "outlet_ri": ri_target,
        "outlet_ro": ro_target,
        # Analytic meridional profiles (None on the mesh fallback path) — main() revolves
        # these into the hub-core / shroud-casing solids; hub_pts drives the meta dump.
        "hub_profile": hub_profile,
        "shroud_profile": shroud_profile,
        "hub_pts": ([r_rim, r_p1, r_p2, r_p3] if analytic else []),
    }


# --- guide-vane STEP export (OCC BREP) --------------------------------------
# The GLB/STL/triSurface/classification transport is driven by the mesh fluid body
# fluid_F (the meshing/viewer source of truth). For a clean, EDITABLE chamber.step,
# guide-vane builds ALSO rebuild the distributor as OCC BREP and cut it from the OCC
# `result`, in parallel. Hub + shroud are revolved from the SAME analytic (r,z)
# profiles the mesh distributor uses; blades are the committed clean airfoil
# (assets/guideVanes_blade_profile.json) fitted onto each placed mesh blade section
# and lofted through a periodic spline (smooth faces). The OCC solid is trusted only
# when it is a single valid solid whose volume matches fluid_F within
# VANE_STEP_VOL_TOL; otherwise the caller falls back to the vane-less STEP. Nothing
# here can fail the build — every failure path returns None -> vane-less fallback.
VANE_STEP_VOL_TOL = 0.005      # 0.5%: ~80x the observed faithful-build error (spike)


def _load_vane_blade_profile(np):
    """The committed clean airfoil loop (asset frame, (N,2) metres), or None when the
    asset is absent (then the STEP falls back to vane-less)."""
    try:
        with open(os.path.join(_vane_assets_dir(), "guideVanes_blade_profile.json")) as fh:
            data = json.load(fh)
        arr = np.asarray(data["airfoil"], dtype=float)
        return arr if arr.ndim == 2 and arr.shape[1] == 2 and len(arr) >= 8 else None
    except Exception:  # noqa: BLE001
        return None


def _resample_loop(np, ring, n):
    """Uniform arc-length resample of a closed 2D ring to n points (or None)."""
    ring = np.asarray(ring, dtype=float)[:, :2]
    closed = np.vstack([ring, ring[:1]])
    seg = np.diff(closed, axis=0)
    cum = np.concatenate([[0.0], np.cumsum(np.hypot(seg[:, 0], seg[:, 1]))])
    if cum[-1] <= 0:
        return None
    t = np.linspace(0.0, cum[-1], n, endpoint=False)
    return np.column_stack([np.interp(t, cum, closed[:, 0]), np.interp(t, cum, closed[:, 1])])


def _similarity_2d(np, X, Y):
    """Best 2D similarity (scale c, rotation R, translation t) mapping X->Y (Umeyama);
    returns (c, R, t, maxdev)."""
    muX, muY = X.mean(0), Y.mean(0)
    Xc = X - muX
    varX = float((Xc ** 2).sum() / len(X))
    Sigma = ((Y - muY).T @ Xc) / len(X)
    U, D, Vt = np.linalg.svd(Sigma)
    S = np.eye(2)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        S[-1, -1] = -1.0
    R = U @ S @ Vt
    c = float((D * np.diag(S)).sum() / varX) if varX > 0 else 1.0
    t = muY - c * (R @ muX)
    dev = float(np.hypot(*((c * (R @ X.T).T + t) - Y).T).max())
    return c, R, t, dev


def _fit_airfoil(np, src, tgt):
    """Best (c, R, t, dev) mapping closed loop src onto tgt over all cyclic shifts and
    a reversal (the two loops are the same airfoil, unknown start/winding)."""
    best = None
    for rev in (src, src[::-1]):
        for sh in range(len(src)):
            cand = _similarity_2d(np, np.roll(rev, sh, axis=0), tgt)
            if best is None or cand[3] < best[3]:
                best = cand
    return best


def build_vane_step_solid(cq, np, trimesh, result, core_prof, cas_prof, airfoil,
                          blades_mesh, cx, cy, z0, z1, fluid_volume,
                          vol_tol=VANE_STEP_VOL_TOL):
    """Return the OCC BREP fluid Workplane with the vane distributor carved, or None
    when it cannot be trusted (no blades, invalid solid, volume mismatch, or any
    error). Hub/shroud revolve the analytic profiles about the LOCAL-Y axis (global
    Z); each blade is the clean airfoil fitted onto its placed mesh section, lofted
    through a periodic spline and extruded across [z0, z1]."""
    def _revolve(prof):
        # (r, z) on the XZ workplane -> revolve about local Y (== global Z); (0,0,1)
        # is degenerate. Then move onto the part axis (cx, cy).
        pts = [(float(r), float(z)) for r, z in prof]
        return (cq.Workplane("XZ").polyline(pts).close()
                .revolve(360.0, (0, 0, 0), (0, 1, 0)).translate((cx, cy, 0)))

    dbg = os.environ.get("CHAMBER_STEP_DEBUG")
    n = len(airfoil)
    dist = _revolve(core_prof).union(_revolve(cas_prof))
    nb = 0
    for bl in blades_mesh.split(only_watertight=False):
        bz = np.asarray(bl.vertices, dtype=float)[:, 2]
        zc = 0.5 * (float(bz.min()) + float(bz.max()))
        sec = bl.section(plane_origin=[0.0, 0.0, zc], plane_normal=[0.0, 0.0, 1.0])
        if sec is None:
            continue
        tgt = _resample_loop(np, np.asarray(max(sec.discrete, key=len)), n)
        if tgt is None:
            continue
        c, R, t, dev = _fit_airfoil(np, airfoil, tgt)
        placed = (c * (R @ airfoil.T).T) + t
        # Blunt TE -> tangent arc, applied AFTER the fit (the fit target is the
        # raw blunt mesh section, so fitting stays exact) with the same rule as
        # the mesh prisms — the STEP blades keep matching the meshed fluid.
        placed = _round_blade_te(np, placed)
        pts = [(float(x), float(y)) for x, y in placed]
        blade = (cq.Workplane("XY").spline(pts, periodic=True).close()
                 .extrude(z1 - z0).translate((0, 0, z0)))
        if dbg:
            bv = blade.val()
            sys.stderr.write("STEPDBG blade %d fit_c=%.4f dev=%.5f valid=%s vol=%.6f\n"
                             % (nb, c, dev, bv.isValid(), bv.Volume()))
        dist = dist.union(blade)
        nb += 1
    if nb == 0:
        return None
    occ = result.cut(dist)
    # Unify coplanar/duplicate faces the boolean may have fragmented (ShapeUpgrade).
    # This also repairs the self-overlapping BREP that otherwise round-trips badly
    # through STEP (observed on the hollow variant).
    try:
        occ = occ.clean()
    except Exception:  # noqa: BLE001
        pass
    if len(occ.solids().vals()) != 1 or not occ.val().isValid():
        if dbg:
            sys.stderr.write("STEPDBG reject: nsolids=%d valid=%s\n"
                             % (len(occ.solids().vals()), occ.val().isValid()))
        return None
    # GATE on exactly what ships: OCC's own Volume()/isValid() and even an STL
    # tessellation can BOTH be fooled by a self-overlapping boolean result (the STEP
    # then re-imports with a wrong volume). So export to a STEP, RE-IMPORT it, and
    # trust it only if the round-tripped solid is single and matches fluid_F.
    import tempfile as _tmpf
    _fd, _tp = _tmpf.mkstemp(suffix=".step")
    os.close(_fd)
    try:
        cq.exporters.export(occ, _tp)
        _ri = cq.importers.importStep(_tp)
    finally:
        os.unlink(_tp)
    _sols = _ri.solids().vals()
    if len(_sols) != 1:
        if dbg:
            sys.stderr.write("STEPDBG reject: re-import nsolids=%d\n" % len(_sols))
        return None
    _vol = float(sum(s.Volume() for s in _sols))
    rel = abs(_vol - fluid_volume) / fluid_volume if fluid_volume > 0 else 1.0
    if dbg:
        sys.stderr.write("STEPDBG gate: reimportVol=%.6f fluidF=%.6f rel=%.4f%%\n"
                         % (_vol, fluid_volume, 100 * rel))
    if rel > vol_tol:
        return None
    return occ


# --- patch classification (ported from prepare_openfoam.py) -----------------
def _face_kind(f, adaptor, geomabs):
    s = adaptor(f.wrapped)
    t = s.GetType()
    if t == geomabs["plane"]:
        return "plane", None
    if t == geomabs["cyl"]:
        return "cyl", s.Cylinder().Radius()
    return "other", None


# --- boolean distributor helpers (guide-vane builds) ------------------------
# The non-wetted regions of the distributor (the hub CORE inside the funnel/duct
# and the shroud CASING below the shroud floor) are removed from the fluid at
# BUILD time with a mesh boolean, rather than being emitted as closed obstacle
# surfaces and left for the mesher to seal + discard. Both regions are surfaces of
# revolution, so each is reconstructed as a watertight solid of revolution and
# subtracted from the fluid; the resulting true wetted boundary is then re-split
# into named patches. This deletes the manual carve / drop-roof / roof-synthesis
# heuristics: whatever surface is actually wetted survives, everything else goes.
def _revolve_profile(np, trimesh, profile_rz, cx, cy, sections=128):
    """Revolve a closed (r, z) polygon about the vertical axis at (cx, cy) into a
    watertight solid. Inverts if the winding yielded a negative (inward) volume."""
    m = trimesh.creation.revolve(np.asarray(profile_rz, dtype=float), sections=sections)
    if m.volume < 0.0:
        m.invert()
    m.apply_translation((cx, cy, 0.0))
    return m


def _hub_core_solid(np, trimesh, throat_mesh, cx, cy, z_top, nb=200, nfine=90):
    """The hub CORE as a solid of revolution. Built from the THROAT (funnel + central
    duct) ONLY — NOT the flat roof — and capped flat at z_top. This is deliberate: the
    hub's true profile is the throat rising to the throat-top, then a FLAT roof out to
    the wall. Feeding the flat roof into an r(z) silhouette would collapse the whole
    roof to one outer point and the revolve would draw a diagonal from the throat to the
    wall (cutting the throat->roof corner), fattening the core into the vane passage. So
    the core follows the throat up to the throat-top and caps flat at z_top; the flat
    roof itself is supplied by the OCC upper-cylinder bottom (classified to hub) for
    r > throat-top, where the vanes then rest on it cleanly.

    The throat asset is coarsely tessellated in the meridional direction (~5 z-levels),
    so a raw r(z) silhouette revolves into a visibly FACETED hub. Instead the silhouette
    is SMOOTHED with a monotone PCHIP spline and resampled to `nfine` points, giving a
    smooth curved hub (matching how the throat mesh looked before the boolean)."""
    from scipy.interpolate import PchipInterpolator
    v = np.asarray(throat_mesh.vertices, dtype=float)
    r = np.hypot(v[:, 0] - cx, v[:, 1] - cy)
    z = v[:, 2]
    z0 = float(z.min())
    edges = np.linspace(z0, float(z.max()), nb + 1)
    zc = 0.5 * (edges[:-1] + edges[1:])
    idx = np.clip(np.searchsorted(edges, z) - 1, 0, nb - 1)
    rmax = np.zeros(nb)
    np.maximum.at(rmax, idx, r)
    ok = rmax > 0
    zc_v, rmax_v = zc[ok], rmax[ok]
    spl = PchipInterpolator(zc_v, rmax_v)                  # smooth monotone r(z)
    z_fine = np.linspace(float(zc_v.min()), float(zc_v.max()), nfine)
    r_fine = spl(z_fine)
    # follow the smoothed throat silhouette, then a vertical rise to z_top and a FLAT
    # cap to the axis — no diagonal shortcut across the throat->roof corner.
    prof = [(0.0, z0)] + list(zip(r_fine.tolist(), z_fine.tolist()))
    prof += [(float(r_fine[-1]), z_top), (0.0, z_top)]
    return _revolve_profile(np, trimesh, prof, cx, cy)


# --- guide-vane trailing-edge rounding ---------------------------------------
# The CAD blade ends in a BLUNT trailing edge: a flat base ~1.11% of the chord
# wide meeting the two blade surfaces at sharp corners. Those corners force
# degenerate cells / heavy local refinement on the mesher at all 16 blades, so
# every blade cross-section is rounded with a TANGENT arc before it is extruded
# (_vane_prisms, the mesh/triSurface path) or lofted (build_vane_step_solid, the
# STEP path — same rule, so the CAD keeps matching the meshed fluid and the
# volume gate stays exact). A morphological OPENING (erode by r, dilate by r)
# replaces the blunt tail — the only region of the airfoil thinner than 2r —
# with an arc tangent to both surfaces; the leading edge (radius ~6r) and the
# rest of the section are restored unchanged. r scales with the loop's own PCA
# chord, so ring-diameter scale and pitch rotation need no special handling.
VANE_TE_ROUND_R_FRAC = 0.00585  # arc radius / chord: half the CAD blunt-base
                                # width fraction (0.01114 / 2) x 1.05 margin
VANE_TE_ROUND_SEGS = 16         # buffer quad_segs: arc facets per quarter turn
VANE_TE_MAX_AREA_DRIFT = 0.02   # sanity: the opening only trims two corner
                                # slivers, it must never move >2% of the area


def _round_blade_te(np, loop):
    """Round the blunt trailing edge of a closed 2D blade section `loop` (N,2)
    with a tangent arc; returns the rounded loop (M,2). On ANY doubt (shapely
    missing, degenerate polygon, area drift beyond sanity) the input is returned
    unchanged — a blunt TE must never fail a build."""
    try:
        from shapely.geometry import MultiPolygon, Polygon
        pts = np.asarray(loop, dtype=float)[:, :2]
        poly = Polygon(pts)
        if not poly.is_valid:
            poly = poly.buffer(0.0)
        if poly.is_empty or poly.area <= 0.0:
            return loop
        X = pts - pts.mean(axis=0)                  # chord = PCA extent of the
        _u, _s, vt = np.linalg.svd(X, full_matrices=False)  # section (rotation-
        chord = float(np.ptp(X @ vt[0]))            # invariant)
        r = VANE_TE_ROUND_R_FRAC * chord
        eroded = poly.buffer(-r, quad_segs=VANE_TE_ROUND_SEGS)
        if isinstance(eroded, MultiPolygon):        # a sliver split off: keep the body
            eroded = max(eroded.geoms, key=lambda g: g.area)
        if eroded.is_empty:
            return loop
        rounded = eroded.buffer(r, quad_segs=VANE_TE_ROUND_SEGS)
        if isinstance(rounded, MultiPolygon):
            rounded = max(rounded.geoms, key=lambda g: g.area)
        if (rounded.is_empty
                or abs(rounded.area - poly.area) > VANE_TE_MAX_AREA_DRIFT * poly.area):
            return loop
        return np.asarray(rounded.exterior.coords, dtype=float)[:-1]
    except Exception:  # noqa: BLE001
        return loop


def _vane_prisms(np, trimesh, blades_mesh, cx, cy, z0, z1):
    """Turn the (prismatic) guide-vane blades into watertight vertical PRISM solids that
    span z0..z1 — below the shroud floor up to the hub roof. Each blade's airfoil
    footprint is read from a horizontal section at mid-height (the blade is prismatic, so
    the cross-section is constant) and extruded. Unioned with the hub-core / shroud-
    casing, these prisms PIERCE the hub and shroud, so the boolean cuts a real airfoil
    hole in each surface with the vane skin connected to it (no vane surface left inside
    the non-wetted solids). Extruding straight and letting the boolean cut at the shroud
    floor / hub roof also makes the blade ends conform to those curved surfaces exactly."""
    from shapely.geometry import Polygon
    prisms = []
    for blade in blades_mesh.split(only_watertight=False):
        bz = np.asarray(blade.vertices, dtype=float)[:, 2]
        zc = 0.5 * (float(bz.min()) + float(bz.max()))
        sec = blade.section(plane_origin=[0.0, 0.0, zc], plane_normal=[0.0, 0.0, 1.0])
        if sec is None:
            continue
        loop = max(sec.discrete, key=len)              # airfoil outline (world XY)
        poly = Polygon(_round_blade_te(np, loop[:, :2]))   # blunt TE -> tangent arc
        if not poly.is_valid:
            poly = poly.buffer(0.0)
        if poly.is_empty or poly.area <= 0:
            continue
        pr = trimesh.creation.extrude_polygon(poly, height=z1 - z0)
        pr.apply_translation([0.0, 0.0, z0])
        prisms.append(pr)
    return prisms


def _shroud_casing_solid(np, trimesh, shroud_mesh, cx, cy, d_last, nb=200, nfine=160):
    """The shroud CASING as an annular solid of revolution — the material below the
    shroud floor, from the inner duct rim (r_in) to the outer rim (r_out), down to
    the box floor. The top follows the shroud floor contour f(r); the annulus never
    touches the axis, so the revolve is a clean watertight ring.

    The shroud floor rises MONOTONICALLY from the inner duct rim up to the flat brim.
    A raw r-binned max-z envelope is a sawtooth, though: the shroud mesh is not perfectly
    axisymmetric, so max-z per r-bin jumps between azimuths, and revolving that sawtooth
    gives a shroud floor that visibly wobbles up and down. So the envelope is first made
    monotone non-decreasing in r (np.maximum.accumulate — the true floor never dips as r
    grows), which removes the sawtooth, then a monotone PCHIP spline resampled to `nfine`
    points gives a clean smooth fillet hugging the source (dev ~30 um).

    The OUTER wall is pushed a hair PAST the box wall (d_last/2 + FLOOR_OVERCUT). The
    shroud brim seals against the box wall, but the r-binned envelope stops ~0.2 mm short
    of it, so a raw casing would leave a paper-thin non-physical fluid sliver against the
    box wall from the brim down to the floor — the boolean then keeps that sliver's outer
    face as a full-height ring of non-wetted cylinder_walls faces under the vanes. Making
    the casing protrude past the wall (as the ducts protrude past the floor) removes the
    sliver cleanly. The feet sit far outside (r >= ~1.49), so the small overshoot never
    reaches them."""
    from scipy.interpolate import PchipInterpolator
    v = np.asarray(shroud_mesh.vertices, dtype=float)
    r = np.hypot(v[:, 0] - cx, v[:, 1] - cy)
    z = v[:, 2]
    r_in, r_out, z0 = float(r.min()), float(r.max()), float(z.min())
    edges = np.linspace(r_in, r_out, nb + 1)
    rc = 0.5 * (edges[:-1] + edges[1:])
    idx = np.clip(np.searchsorted(edges, r) - 1, 0, nb - 1)
    ztop = np.full(nb, -np.inf)
    np.maximum.at(ztop, idx, z)
    ok = np.isfinite(ztop)
    rc_v, ztop_v = rc[ok], np.maximum.accumulate(ztop[ok])  # monotone rising floor
    spl = PchipInterpolator(rc_v, ztop_v)                  # smooth top contour z(r)
    r_fine = np.linspace(float(rc_v.min()), float(rc_v.max()), nfine)
    z_fine = spl(r_fine)
    r_in, r_out = float(r_fine[0]), float(r_fine[-1])
    # push the outer wall past the box wall so the boolean leaves no sliver against it
    r_out_wall = max(r_out, d_last / 2.0) + FLOOR_OVERCUT
    # closed loop: box floor -> outer wall up -> brim out to the wall -> smoothed floor
    # contour back in -> down
    prof = [(r_in, z0), (r_out_wall, z0), (r_out_wall, float(z_fine[-1]))]
    prof += list(zip(r_fine[::-1].tolist(), z_fine[::-1].tolist()))
    prof += [(r_in, float(z_fine[0])), (r_in, z0)]
    return _revolve_profile(np, trimesh, prof, cx, cy)


def _label_by_nearest_source(np, mesh, sources):
    """Label every face of `mesh` by the nearest labelled source patch (face-centroid
    KD-tree). `sources` is a list of (label, Trimesh); returns (names, who) where
    names[i] is the label and who[f] is the source index of face f. The true wetted
    boundary coincides with the source surfaces, so nearest-centroid re-splits it."""
    from scipy.spatial import cKDTree
    cents, labels = [], []
    for li, (_, m) in enumerate(sources):
        c = m.vertices[m.faces].mean(axis=1)
        cents.append(c)
        labels.append(np.full(len(c), li, dtype=np.int64))
    tree = cKDTree(np.vstack(cents))
    lab = np.concatenate(labels)
    fc = mesh.vertices[mesh.faces].mean(axis=1)
    _, nn = tree.query(fc)
    return [name for name, _ in sources], lab[nn]


def _horiz_extent(f, ax, ay):
    ds = []
    for v in f.Vertices():
        x, y, _ = v.toTuple()
        ds.append(((x - ax) ** 2 + (y - ay) ** 2) ** 0.5)
    if ds:
        return max(ds)
    bb = f.BoundingBox()
    return max(((cx - ax) ** 2 + (cy - ay) ** 2) ** 0.5
               for cx in (bb.xmin, bb.xmax) for cy in (bb.ymin, bb.ymax))


def classify(faces, adaptor, geomabs, variant, pocket_radius, guide_vanes=False):
    """Return {patch: [face,...]} for inlet / outlet / cylinder_walls / walls.
    A face is a pocket (cavity/feet) surface when its vertices lie within
    `pocket_radius` of the part axis; box faces reach far beyond it. With
    guide_vanes the middle cylinder is omitted (only first/last remain) and the
    outlet comes from the vane mesh, so fewer cylinders are expected and no BREP
    outlet is chosen."""
    ymin = min(f.BoundingBox().ymin for f in faces)

    inlet, cyls = None, []
    for f in faces:
        kind, radius = _face_kind(f, adaptor, geomabs)
        bb = f.BoundingBox()
        if kind == "plane" and abs(bb.ymin - ymin) < PLANE_TOL \
                and abs(bb.ymax - ymin) < PLANE_TOL:
            inlet = f
        elif kind == "cyl":
            s = adaptor(f.wrapped)
            loc = s.Cylinder().Axis().Location()
            cyls.append((f, (bb.zmin + bb.zmax) / 2, radius, loc.X(), loc.Y()))

    if inlet is None:
        raise RuntimeError("could not find the inlet (min-Y) face")
    min_cyls = 1 if guide_vanes else 3
    if len(cyls) < min_cyls:
        raise RuntimeError("expected >=%d cylindrical faces, found %d" % (min_cyls, len(cyls)))

    ax = sum(c[3] for c in cyls) / len(cyls)
    ay = sum(c[4] for c in cyls) / len(cyls)

    pocket = [f for f in faces
              if id(f) != id(inlet) and _horiz_extent(f, ax, ay) <= pocket_radius]
    pocket_ids = {id(p) for p in pocket}

    if variant == "hollow" or guide_vanes:
        # Hollow (many carved surfaces) and guide-vane (outlet comes from the vane
        # mesh) builds have no single BREP flow 'outlet'; group every pocket
        # surface as cylinder_walls.
        outlet = []
    else:
        # Stepped: the MIDDLE cylinder (median z-centre) is the outlet.
        cyls.sort(key=lambda c: c[1])
        outlet = [cyls[len(cyls) // 2][0]]

    outlet_ids = {id(f) for f in outlet}
    return {
        "inlet": [inlet],
        "outlet": outlet,
        "cylinder_walls": [f for f in pocket if id(f) not in outlet_ids],
        "walls": [f for f in faces
                  if id(f) != id(inlet) and id(f) not in pocket_ids],
    }


# --- meshing helpers --------------------------------------------------------
def patch_trimesh(trimesh, np, faces, tol=TESS_TOL):
    """Tessellate a patch's CAD faces into one Trimesh (verts + triangles)."""
    vs, ts, off = [], [], 0
    for f in faces:
        verts, tris = f.tessellate(tol)
        if not verts or not tris:
            continue
        vs.append(np.array([[v.x, v.y, v.z] for v in verts], dtype=np.float64))
        ts.append(np.array(tris, dtype=np.int64) + off)
        off += len(verts)
    if not vs:
        return None
    return trimesh.Trimesh(vertices=np.vstack(vs), faces=np.vstack(ts),
                           process=False)


def patch_edges(np, curve_adaptor, geomabs_line, faces, n_curve=64):
    """True CAD edges of a patch as line-segment endpoints (2K, 3) float32.

    Straight edges -> 2 points; curved edges -> sampled. De-duplicated so an edge
    shared by two faces of the same patch is emitted once."""
    seen = set()
    segs = []
    for f in faces:
        for e in f.Edges():
            ad = curve_adaptor(e.wrapped)
            u0, u1 = ad.FirstParameter(), ad.LastParameter()
            mid = ad.Value(0.5 * (u0 + u1))
            key = (round(mid.X(), 6), round(mid.Y(), 6), round(mid.Z(), 6),
                   round(u1 - u0, 6), int(ad.GetType()))
            if key in seen:
                continue
            seen.add(key)
            n = 2 if ad.GetType() == geomabs_line else n_curve
            pts = []
            for i in range(n):
                u = u0 + (u1 - u0) * i / (n - 1)
                p = ad.Value(u)
                pts.append((p.X(), p.Y(), p.Z()))
            for i in range(n - 1):
                segs.append(pts[i])
                segs.append(pts[i + 1])
    if not segs:
        return np.zeros((0, 3), dtype=np.float32)
    return np.asarray(segs, dtype=np.float32)


def write_ascii_solid(fh, name, tri):
    """Write one Trimesh as a named ASCII STL solid (for the triSurface zip)."""
    fh.write("solid %s\n" % name)
    for face, normal in zip(tri.faces, tri.face_normals):
        fh.write("  facet normal %e %e %e\n" % (normal[0], normal[1], normal[2]))
        fh.write("    outer loop\n")
        for idx in face:
            v = tri.vertices[idx]
            fh.write("      vertex %e %e %e\n" % (v[0], v[1], v[2]))
        fh.write("    endloop\n")
        fh.write("  endfacet\n")
    fh.write("endsolid %s\n" % name)


def main():
    if len(sys.argv) not in (3, 4) or (len(sys.argv) == 4 and sys.argv[3] != "--step"):
        sys.stderr.write("usage: python buildChamber.py <paramsJson> <outDir> [--step]\n")
        sys.exit(2)

    params_path, out_dir = sys.argv[1], sys.argv[2]
    # --step: also produce the guide-vane STEP (OCC blade carve + round-trip
    # gate, ~2/3 of a vane build's wall clock). Without it a guide-vane build
    # skips chamber.step entirely — the API re-runs the builder with the flag
    # when the STEP is first downloaded. Non-vane STEPs are effectively free
    # and are always written, flag or not.
    force_step = len(sys.argv) == 4

    try:
        import numpy as np
        import cadquery as cq
        import trimesh
        from OCP.BRepAdaptor import BRepAdaptor_Surface, BRepAdaptor_Curve
        from OCP.GeomAbs import GeomAbs_Cylinder, GeomAbs_Plane, GeomAbs_Line

        geomabs = {"plane": GeomAbs_Plane, "cyl": GeomAbs_Cylinder}

        with open(params_path) as fh:
            P = json.load(fh)

        def num(key):
            return float(P[key])

        def num_opt(key):
            v = P.get(key)
            return float(v) if v is not None else None

        # resolved geometry params (metres)
        width = num("width")
        height = num("height")
        length = num("length")
        dist_c1 = num("distFromSideChamfer1")
        ch_big = (num("chamferLength1"), num("chamferWidth1"))
        ch_small = (num("chamferLength2"), num("chamferWidth2"))
        dist_from_end = num("distFromEnd")
        d_last = num("dLast")
        h_middle = num("hMiddle")
        h_first = num("hMiddlePlusFirst") - h_middle
        variant = str(P.get("variant", "stepped"))
        foot_angle = float(P.get("footAngleDeg", FOOT_ANGLE_DEG))
        guide_vanes = bool(P.get("guideVanes", False))
        chamfer_enabled = bool(P.get("chamferEnabled", True))
        feet_enabled = bool(P.get("feetEnabled", True))
        # Absolute guide-vane open angle (deg). The asset is baked at
        # VANE_BASE_ANGLE_DEG (50); each blade swings about its own spindle by
        # (vane_angle - VANE_BASE_ANGLE_DEG) to reach the requested angle. Range is
        # +-5 deg about the base (45..55). Only used by guide-vane builds.
        vane_angle = float(P.get("vaneAngleDeg", VANE_BASE_ANGLE_DEG))
        vane_pitch = vane_angle - VANE_BASE_ANGLE_DEG   # signed offset actually applied
        # Uniform scale for the WHOLE internal assembly (the three cylinders, the
        # hollow cup / central cylinder / dome, the four feet, and the guide vanes
        # which key off d_last). The box (width/length/height), the chamfers, and
        # the part AXIS (positioned by distFromSideChamfer1 / distFromEnd) are NOT
        # scaled, so the cavity grows/shrinks about its own floor-anchored axis
        # inside an unchanged box. Up-scaling is clamped below so the stack never
        # outgrows the box height; scaling down is unbounded.
        part_scale = float(P.get("partScale", 1.0))

        # --- common validation (on the UNSCALED model values) ---------------
        if min(width, height, length, d_last, h_middle) <= 0:
            raise ValueError("width/height/length/dLast/hMiddle must be > 0")
        if h_first <= 0:
            raise ValueError(
                "hFirst = hMiddlePlusFirst - hMiddle = %.4f must be > 0" % h_first)
        if not 0 < dist_c1 < width:
            raise ValueError(
                "distFromSideChamfer1 %.4f must be between 0 and width %.4f"
                % (dist_c1, width))
        if not 0 < dist_from_end < length:
            raise ValueError(
                "distFromEnd %.4f must be between 0 and length %.4f"
                % (dist_from_end, length))
        if chamfer_enabled:
            # The corner cuts eat (length-wise, width-wise) into the box; a
            # non-positive setback makes a degenerate zero-area prism (cryptic
            # OCC failure), one beyond the box is geometric nonsense.
            for _cnm, (_cl, _cw) in (("chamfer 1 (LF1/BF1)", ch_big),
                                     ("chamfer 2 (LF2/BF2)", ch_small)):
                if _cl <= 0 or _cw <= 0:
                    raise ValueError(
                        "%s setbacks must be > 0 (got length %.4f, width %.4f); "
                        "disable the chamfer instead of zeroing it" % (_cnm, _cl, _cw))
                if _cl >= length or _cw >= width:
                    raise ValueError(
                        "%s (length %.4f, width %.4f) must be smaller than the "
                        "box (Length %.4f, B Kammer %.4f)"
                        % (_cnm, _cl, _cw, length, width))
        if not 0.0 <= foot_angle <= 180.0:
            raise ValueError(
                "footAngleDeg %.3f must be between 0 and 180 "
                "(0/180 = tangential either way, 90 = radial)" % foot_angle)
        if part_scale <= 0:
            raise ValueError("partScale %.4f must be > 0" % part_scale)
        if not VANE_BASE_ANGLE_DEG - 5.0 <= vane_angle <= VANE_BASE_ANGLE_DEG + 5.0:
            raise ValueError(
                "vaneAngleDeg %.3f must be within +-5 deg of the base open angle "
                "%.1f (i.e. %.1f..%.1f)" % (
                    vane_angle, VANE_BASE_ANGLE_DEG,
                    VANE_BASE_ANGLE_DEG - 5.0, VANE_BASE_ANGLE_DEG + 5.0))

        # --- read the per-variant stack dims (UNSCALED) up front, so we can
        #     size the uniform scale against the box BEFORE building ----------
        if variant == "hollow":
            wall = num("wallThickness")
            hollow_len = num("hollowLength")
            c_dia = num("centralDiameter")
            c_h = num("centralHeight")
            dome_h = num("domeHeight")
            if not 0 < wall < d_last / 2:
                raise ValueError("wallThickness must be in (0, dLast/2)")
            if min(hollow_len, c_dia, c_h, dome_h) <= 0:
                raise ValueError("hollow params (length/central dia+height/dome) must be > 0")
            if hollow_len <= wall:
                raise ValueError("hollowLength must exceed the wall thickness (open-top cup)")
            unscaled_part_height = h_first + h_middle + max(hollow_len, c_h + dome_h)
        else:
            h_last = num("hLast")
            if h_last <= 0:
                raise ValueError("hLast must be > 0")
            # The last cylinder is pinned to the box top; only the shoulder
            # (first+middle) grows with partScale, so the clamp is sized against
            # the shoulder (not the whole stack) below.
            unscaled_shoulder = h_first + h_middle

        # Does the internal assembly fit the box at the requested partScale?
        #  - hollow: the whole stack must stay under the box top.
        #  - stepped: the last cylinder is pinned THROUGH the box top, so only the
        #    shoulder (first+middle) grows with partScale; it must leave room for at
        #    least MIN_LAST_CYL_H of last cylinder.
        # BOTH designs REFUSE when it does not fit: silently shrinking would ignore
        # the heights the user entered. (Hollow used to be scaled down to fit with a
        # warning; since most hollow configurations overflow at partScale 1, the
        # refusal names the exact Part scale that WOULD fit so the fix is one edit.)
        if variant == "hollow":
            clamp_basis = unscaled_part_height
            clamp_limit = height
        else:
            clamp_basis = unscaled_shoulder
            clamp_limit = height + 2 * FLOOR_OVERCUT - MIN_LAST_CYL_H
        if clamp_basis > 0 and part_scale * clamp_basis > clamp_limit + 1e-6:
            if variant == "hollow":
                fit_scale = clamp_limit / clamp_basis
                raise ValueError(
                    "the hollow stack (first + middle + max(cone, generator + dome)) "
                    "is %.4f m tall but H Kammer only allows %.4f m. To fit, reduce "
                    "Part scale to <= %.4f, lower the cone / generator / dome heights "
                    "or HLE, or increase H Kammer."
                    % (part_scale * clamp_basis, clamp_limit, fit_scale))
            else:
                scaled = part_scale * clamp_basis
                scale_note = "" if abs(part_scale - 1.0) < 1e-9 else (" (scaled x %.4g)" % part_scale)
                part_lever = "" if abs(part_scale - 1.0) < 1e-9 else " / reduce Part scale"
                raise ValueError(
                    "the cylinder shoulder (first + middle height, i.e. 2 x HLE) is %.4f m "
                    "tall%s but H Kammer only allows %.4f m. To fit, lower HLE%s, or "
                    "increase H Kammer." % (scaled, scale_note, clamp_limit, part_lever))

        # Manual diameter overrides (metres, UNSCALED) for the runner case (first
        # cylinder) and the guide-vanes/middle cylinder. None => use the D_last ratio.
        d_first_override = num_opt("dFirst")
        d_middle_override = num_opt("dMiddle")

        # Apply the uniform scale to every internal dimension. d_first / d_middle
        # are ratios of the (scaled) d_last, so they scale with it; the guide-vane
        # ring also keys off d_middle downstream, so it scales too. A manual override
        # is the value at partScale = 1, so it is multiplied by part_scale to match.
        d_last *= part_scale
        h_middle *= part_scale
        h_first *= part_scale
        d_first = (d_first_override * part_scale
                   if d_first_override is not None else d_last * RATIO_D_FIRST_OVER_LAST)
        d_middle = (d_middle_override * part_scale
                    if d_middle_override is not None else d_last * RATIO_D_MIDDLE_OVER_LAST)

        # --- build the part (per variant) -----------------------------------
        if variant == "hollow":
            wall *= part_scale
            hollow_len *= part_scale
            c_dia *= part_scale
            c_h *= part_scale
            dome_h *= part_scale
            if c_dia > d_last - 2 * wall:
                sys.stderr.write(
                    "WARN: central diameter %.3f exceeds the hollow bore %.3f\n"
                    % (c_dia, d_last - 2 * wall))
            part = make_part_hollow(cq, d_first, h_first, d_middle, h_middle, d_last,
                                    wall, hollow_len, c_dia, c_h, dome_h,
                                    omit_middle=guide_vanes)
            part_height = h_first + h_middle + max(hollow_len, c_h + dome_h)
            rmax = max(d_first, d_middle, d_last) / 2
        else:
            h_last *= part_scale  # scaled model value (kept for reference/logging)
            # Pin the last cylinder's TOP a hair above the box top so box.cut opens
            # it through the top at ANY partScale (mirrors the floor overcut). Base
            # stays at the scaled shoulder (h_first+h_middle); only the top is
            # decoupled from the scale. Diameter still scales via d_last above.
            # Part is later translated by z_floor = -height/2 - FLOOR_OVERCUT, so a
            # local top of (height + 2*FLOOR_OVERCUT) lands at +height/2 + FLOOR_OVERCUT.
            last_h_local = (height + 2 * FLOOR_OVERCUT) - (h_first + h_middle)
            part = make_part(cq, d_first, h_first, d_middle, h_middle, d_last, h_last,
                             omit_middle=guide_vanes, h_last_override=last_h_local)
            part_height = h_first + h_middle + last_h_local  # == height + 2*FLOOR_OVERCUT
            rmax = max(d_first, d_middle, d_last) / 2

        # Hollow: the stack must fit under the box top. Stepped: the last cylinder
        # is intentionally pinned THROUGH the top, so guard its height is positive
        # instead (the clamp above guarantees the shoulder leaves room).
        if variant == "hollow":
            if part_height > height + 1e-6:
                raise ValueError(
                    "part height %.4f exceeds box height %.4f" % (part_height, height))
        else:
            if last_h_local <= 0:
                raise ValueError(
                    "last cylinder height %.4f <= 0 (shoulder above the box top)"
                    % last_h_local)

        box = make_box(cq, width, length, height,
                       CHAMFER_END, BIG_CORNER_SIDE, ch_big, ch_small,
                       enabled=chamfer_enabled)

        big_sx = 1.0 if BIG_CORNER_SIDE.startswith(">") else -1.0
        end_sy = 1.0 if CHAMFER_END.startswith(">") else -1.0
        target_x = big_sx * (width / 2 - dist_c1)
        target_y = end_sy * (length / 2 - dist_from_end)
        part = part.translate((target_x, target_y, -height / 2 - FLOOR_OVERCUT))

        # --- fit check: the part (cylinders + torque feet) must stay INSIDE the
        # box footprint. The axis sits dist_c1 from the chamfer-side wall and
        # dist_from_end from the chamfered end. Three ways to poke out, each
        # REFUSED with the lever that fixes it (an overflow used to cut silently
        # through the box wall and the build "succeeded" with open geometry):
        #  1. the largest cylinder radius vs the four straight walls;
        #  2. the largest cylinder radius vs the two chamfer faces (corner cuts);
        #  3. any torque-foot corner vs walls or chamfer faces — the feet reach
        #     further out than the cylinders, so they are checked on the EXACT
        #     swung footprint (mirroring make_feet's plan), not a bounding
        #     circle: a leg pointing away from a near wall never refuses a build
        #     that actually fits.
        half_w, half_l = width / 2, length / 2
        clearances = [
            (dist_c1, "chamfer-side wall (B1)"),
            (width - dist_c1, "far side wall (B Kammer - B1)"),
            (dist_from_end, "chamfered end (LT)"),
            (length - dist_from_end, "inlet end (Length - LT)"),
        ]
        gap, wall_name = min(clearances, key=lambda c: c[0])

        # The two chamfer corner cuts (full-height prisms at the +Y end). Each is
        # the triangle corner P / wall point A / wall point B; geometry mirrors
        # _corner_prism exactly.
        chamfer_tris = []
        if chamfer_enabled:
            for _sx, (_len_set, _wid_set), _nm in (
                    (big_sx, ch_big, "big-corner chamfer face"),
                    (-big_sx, ch_small, "small-corner chamfer face")):
                chamfer_tris.append((
                    (_sx * half_w, end_sy * half_l),
                    (_sx * (half_w - _wid_set), end_sy * half_l),
                    (_sx * half_w, end_sy * (half_l - _len_set)),
                    _nm,
                ))

        def _seg_dist(px, py, a, b):
            vx, vy = b[0] - a[0], b[1] - a[1]
            t = max(0.0, min(1.0, ((px - a[0]) * vx + (py - a[1]) * vy)
                             / (vx * vx + vy * vy)))
            return math.hypot(px - (a[0] + t * vx), py - (a[1] + t * vy))

        def _in_tri(px, py, a, b, c):
            def _cr(o, p, q):
                return (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
            d1, d2, d3 = _cr(a, b, (px, py)), _cr(b, c, (px, py)), _cr(c, a, (px, py))
            return not (((d1 < 0) or (d2 < 0) or (d3 < 0))
                        and ((d1 > 0) or (d2 > 0) or (d3 > 0)))

        # The axis itself must not sit inside a removed corner: the radial
        # check below measures distance to the triangle EDGES, which is only a
        # containment test while the centre is outside the triangle.
        for _ta, _tb, _tc, _nm in chamfer_tris:
            if _in_tri(target_x, target_y, _ta, _tb, _tc):
                raise ValueError(
                    "the part axis (positioned by B1 / LT) lies inside the %s "
                    "corner cut. Move the axis (B1 / LT) or reduce that "
                    "chamfer." % _nm)

        def _refuse_radial(r_check, what, levers):
            """Refuse when a circle of radius r_check about the part axis pokes
            through a straight wall or a chamfer corner face."""
            if r_check > gap + 1e-6:
                raise ValueError(
                    "%s reaches %.4f m from the axis but the axis sits only "
                    "%.4f m from the %s, so it would stick out of the box. %s"
                    % (what, r_check, gap, wall_name, levers))
            for _ta, _tb, _tc, _nm in chamfer_tris:
                if min(_seg_dist(target_x, target_y, p, q)
                       for p, q in ((_ta, _tb), (_tb, _tc), (_tc, _ta))) < r_check - 1e-6:
                    raise ValueError(
                        "%s would stick out through the %s. %s" % (what, _nm, levers))

        _refuse_radial(
            rmax,
            "the part is %.4f m wide (radius %.4f m): it" % (2 * rmax, rmax),
            "Increase B Kammer / Length or move the axis (B1 / LT), or reduce "
            "Part scale / the diameter overrides.")

        if feet_enabled:
            # Exact swung plan of the four legs, mirroring make_feet (the planks
            # stay inside the leg tips + the cylinder wall, so the leg hexagon
            # corners bound the whole foot footprint).
            _hw = FOOT_WIDTH * part_scale / 2
            _r_in = d_first / 2 + FOOT_CLEARANCE * part_scale + _hw
            _r_out = _r_in + FOOT_LENGTH * part_scale
            _tap = FOOT_TAPER * part_scale
            _chf = FOOT_CHAMFER * part_scale
            _plan = [(_r_in, 0.0), (_r_in + _tap, _hw), (_r_out - _chf, _hw),
                     (_r_out, _hw - _chf), (_r_out, -(_hw - _chf)),
                     (_r_out - _chf, -_hw), (_r_in + _tap, -_hw)]
            _lean = math.radians(foot_angle - 90.0)
            _cl, _sl = math.cos(_lean), math.sin(_lean)
            _swung = [(_r_in + (x - _r_in) * _cl - y * _sl,
                       (x - _r_in) * _sl + y * _cl) for x, y in _plan]
            for _ring in FOOT_ANGLES_DEG:
                _ca, _sa = math.cos(math.radians(_ring)), math.sin(math.radians(_ring))
                for _x, _y in _swung:
                    _px = target_x + _x * _ca - _y * _sa
                    _py = target_y + _x * _sa + _y * _ca
                    _through = next((_nm for _ta, _tb, _tc, _nm in chamfer_tris
                                     if _in_tri(_px, _py, _ta, _tb, _tc)), None)
                    if abs(_px) > half_w + 1e-6 or abs(_py) > half_l + 1e-6 or _through:
                        raise ValueError(
                            "a torque foot reaches (%.3f, %.3f) m, outside the %s. "
                            "Increase B Kammer / Length or move the axis (B1 / LT), "
                            "reduce Part scale, or disable the feet."
                            % (_px, _py, _through if _through else "box walls"))

        # four torque-foot voids (both variants), centred on the part axis. Each
        # leg runs from the floor up to the BASE of the last/hollow cylinder, with
        # a horizontal plank on top reaching the cylinder wall; foot_angle orients
        # the legs (0 = tangential, 90 = radial).
        # z_last_base uses the SCALED h_first + h_middle, so a scaled stack lifts
        # the leg top with it (the leg still starts on the fixed floor z_floor).
        z_floor = -height / 2 - FLOOR_OVERCUT
        z_last_base = z_floor + h_first + h_middle
        # Feet scale uniformly with the rest of the assembly: every foot LENGTH is
        # multiplied by part_scale (the leg height scales via z_last_base above).
        # When feet are disabled, skip make_feet entirely (its geometric refusal
        # must not block a feetless build) and cut nothing; foot_r_outer = 0 so the
        # pocket classifier radius falls back to the cavity extent (rmax).
        if feet_enabled:
            feet, foot_r_outer = make_feet(
                cq, target_x, target_y, z_floor, z_last_base,
                d_last / 2, d_first, foot_angle_deg=foot_angle,
                width=FOOT_WIDTH * part_scale, length=FOOT_LENGTH * part_scale,
                taper=FOOT_TAPER * part_scale, chamfer=FOOT_CHAMFER * part_scale,
                plank_thick=FOOT_PLANK_THICK * part_scale,
                plank_overlap=FOOT_PLANK_OVERLAP * part_scale,
                gusset_min_base=FOOT_GUSSET_MIN_BASE * part_scale,
                clear=FOOT_CLEARANCE * part_scale,
            )
        else:
            feet, foot_r_outer = None, 0.0
        # Guide-vane builds: carve the first cylinder into a RING outside the vane
        # distributor. The whole distributor footprint (r < d_last/2, the upper-cyl
        # radius, which is also the shroud's outer radius) is cut away down to the box
        # floor, so the first cylinder keeps ONLY its outer ring (d_last/2 .. d_first/2)
        # and contributes NO surface inside the distributor (no first-cyl top under the
        # shroud, no central column, no slot walls). The mesh hub/shroud/outlet are the
        # sole surfaces there; being closed, they seal the hub core and the base, which
        # the mesher then removes.
        vane_z_first_top = z_floor + h_first
        vane_outlet_ri = vane_outlet_ro = 0.0
        if guide_vanes:
            # Carve the whole distributor footprint (a full disk of the upper-cyl radius)
            # out of the first cylinder, leaving only the outer ring. (The outlet rims
            # themselves are resolved inside make_vane_patches below — it needs the
            # placed/pitched blade's own footprint (R_anchor) to clamp against, which
            # is not available until that call runs.)
            vane_ring_ri = d_last / 2.0
            _cavity = (cq.Workplane("XY", origin=(target_x, target_y, z_floor))
                       .circle(vane_ring_ri).extrude(h_first))
            part = part.cut(_cavity)

        result = box.cut(part)
        if feet is not None:
            result = result.cut(feet)

        # --- split into patches --------------------------------------------
        faces = result.faces().vals()
        pocket_radius = max(rmax, foot_r_outer) + 0.1
        patches = classify(faces, BRepAdaptor_Surface, geomabs, variant, pocket_radius,
                           guide_vanes=guide_vanes)

        # --- guide-vane throat: extra MESH patches in the middle band -------
        # The vanes ride as triSurfaces + GLB nodes (no OCC boolean). z is the
        # middle-cylinder band [z_mid_base, z_mid_top]; the ring's scaled shroud
        # is wider than the d_middle void, so open the box to the shroud radius.
        vane_patches = {}
        emit_order = list(PATCH_ORDER)
        if guide_vanes:
            # The middle-cylinder intrusion was OMITTED from the part, so the band
            # is open fluid (no cut, no cylinder wall around the vanes). The vane
            # SOLIDS ride as obstacle triSurfaces; the fluid flows around them.
            z_mid_base = z_floor + h_first
            z_mid_top = z_floor + h_first + h_middle   # upper-cyl base (HLE band top)
            vane_patches = make_vane_patches(
                trimesh, np, target_x, target_y, z_mid_base, z_mid_top, d_last,
                vane_angle_deg=vane_pitch, d_ring=d_middle,
                outlet_outer_d=num_opt("outletOuterD"), outlet_ratio=num_opt("outletRatio"))
            vane_outlet_ri = vane_patches["outlet_ri"]
            vane_outlet_ro = vane_patches["outlet_ro"]

            # The distributor reaches FURTHER than the cylinder radii the fit
            # check above used: the blade tips sit at ~1.25 x the ring radius
            # and the shroud is wider still. Re-run the wall/chamfer refusals
            # with the EXACT max radial reach of the built meshes (covers the
            # vane-angle swing and any dMiddle override, no asset ratio baked
            # in) — otherwise an oversized ring carves blade holes through the
            # box wall on a "successful" build.
            _dist_r = max(
                float(np.hypot(m.vertices[:, 0] - target_x,
                               m.vertices[:, 1] - target_y).max())
                for m in (vane_patches["guide_vanes"], vane_patches["hub"],
                          vane_patches["shroud"]))
            _refuse_radial(
                _dist_r,
                "the guide-vane distributor (blades + shroud)",
                "Increase B Kammer / Length or move the axis (B1 / LT), or "
                "reduce Part scale / the Guide vanes Ø (dMiddle).")
            # The hub and shroud are the FULL true surfaces and continue straight down
            # from their natural passage bottom as mesh DUCTS (open cylinders at the
            # hub-inner rim vane_outlet_ri and the shroud-outer rim vane_outlet_ro). The
            # ducts run a hair BELOW the box floor (z_duct_bottom) so that the hub-core
            # and shroud-casing solids built from them PROTRUDE through the floor and the
            # boolean cut is clean (no coincident-plane sliver at the outlet). The OUTLET
            # source annulus stays on the TRUE box floor (-height/2), where F's floor is.
            z_box_floor = -height / 2
            z_duct_bottom = z_box_floor - 2.0 * FLOOR_OVERCUT
            _hub_zmin = float(vane_patches["hub"].vertices[:, 2].min())
            _shr_zmin = float(vane_patches["shroud"].vertices[:, 2].min())
            _hub_ext = _open_cylinder(np, trimesh, target_x, target_y,
                                      vane_outlet_ri, z_duct_bottom, _hub_zmin)
            _shr_ext = _open_cylinder(np, trimesh, target_x, target_y,
                                      vane_outlet_ro, z_duct_bottom, _shr_zmin)
            vane_patches["hub"] = trimesh.util.concatenate([vane_patches["hub"], _hub_ext])
            vane_patches["shroud"] = trimesh.util.concatenate([vane_patches["shroud"], _shr_ext])
            vane_patches["outlet"] = _flat_annulus(np, trimesh, target_x, target_y,
                                                   z_box_floor, vane_outlet_ri, vane_outlet_ro)
            # No BREP middle cylinder now, so there is no BREP outlet; the vane mesh
            # supplies it.
            patches["outlet"] = []
            emit_order = ["inlet", "cylinder_walls", "walls",
                          "hub", "shroud", "outlet", "guide_vanes"]

            # --- boolean distributor: remove the non-wetted regions --------
            # Build the distributor SOLID = hub CORE (u) shroud CASING (u) vane PRISMS,
            # and subtract it from the OCC fluid; re-split the TRUE wetted boundary F into
            # named patches by nearest source. The core/casing remove the non-wetted hub
            # centre and sub-shroud material; the vane prisms PIERCE the hub and shroud so
            # the boolean cuts a real airfoil hole in each surface with the vane skin
            # connected to it (and, being cut at the curved surfaces, the blade ends
            # conform to them). Deterministic, verifiable, no manual carve/drop/drape.
            # Core from the THROAT + its floor duct (NOT the flat roof), capped flat at
            # z_mid_top so the throat->roof corner is preserved (see _hub_core_solid).
            _hub_throat = trimesh.util.concatenate(
                [vane_patches["hub_throat"], _hub_ext])
            if vane_patches.get("hub_profile") is not None:
                # Analytic core: revolve the closed hub silhouette (duct bottom ->
                # rim -> P1 -> P2 -> P3) capped flat at z_mid_top from P3 in to the
                # axis. r > P3 (the flat roof) is supplied by the OCC upper cylinder.
                _hp = vane_patches["hub_profile"]
                _rr = float(_hp[0, 0])
                _core_prof = ([(0.0, z_duct_bottom), (_rr, z_duct_bottom)]
                              + [(float(r), float(z)) for r, z in _hp]
                              + [(0.0, z_mid_top)])
                _core = _revolve_profile(np, trimesh, _densify(np, _core_prof),
                                         target_x, target_y)
            else:
                _core = _hub_core_solid(np, trimesh, _hub_throat, target_x, target_y,
                                        z_top=z_mid_top)
            if vane_patches.get("shroud_profile") is not None:
                # Analytic casing: revolve the annulus under the shroud floor —
                # box-floor (duct bottom) -> outer wall up -> floor contour back in
                # -> inner wall down (closed by revolve).
                _sp = vane_patches["shroud_profile"]
                _rin, _rout = float(_sp[0, 0]), float(_sp[-1, 0])
                _cas_prof = ([(_rin, z_duct_bottom), (_rout, z_duct_bottom)]
                             + [(float(r), float(z)) for r, z in _sp[::-1]]
                             + [(_rin, z_duct_bottom)])   # close the annular loop (first==last)
                _casing = _revolve_profile(np, trimesh, _densify(np, _cas_prof),
                                           target_x, target_y)
            else:
                _casing = _shroud_casing_solid(np, trimesh, vane_patches["shroud"],
                                               target_x, target_y, d_last)
            # Prisms span below the shroud floor (z_duct_bottom) up past the hub roof
            # (z_mid_top) so they fully pierce both; the portion below the floor sits
            # inside the casing (absorbed by the union) and the portion above the roof
            # inside the OCC upper cylinder (no fluid there), so only the passage span
            # shows as a vane.
            _prisms = _vane_prisms(np, trimesh, vane_patches["guide_vanes"],
                                   target_x, target_y, z_duct_bottom,
                                   z_mid_top + 2.0 * FLOOR_OVERCUT)
            _solid = trimesh.boolean.union([_core, _casing] + _prisms, engine="manifold")
            _fd, _tmp_stl = tempfile.mkstemp(suffix=".stl")
            os.close(_fd)
            cq.exporters.export(result, _tmp_stl, tolerance=STL_TOLERANCE)
            _result_mesh = trimesh.load(_tmp_stl, file_type="stl")
            os.unlink(_tmp_stl)
            # OCC -> STL tessellation can shed a stray degenerate shell (e.g. a
            # single sliver triangle at the hollow cup's rim), which is not a volume
            # and breaks the manifold boolean. Drop ONLY those degenerate slivers and
            # keep every CLOSED (watertight) shell. A solid with an enclosed internal
            # void — e.g. the hollow cup + cylinders when the torque feet don't vent
            # it to the outside — legitimately tessellates as TWO watertight shells:
            # the outer body AND the inner cavity (inward normals). BOTH are needed
            # for a valid box.cut(part) volume; keeping only one (by face count OR by
            # volume) fills the cavity and destroys the cup/cone/cylinder/vane
            # geometry. For a normally-vented solid there is exactly one closed shell,
            # so this is identical to the old behaviour.
            _rcomps = _result_mesh.split(only_watertight=False)
            if len(_rcomps) > 1:
                _closed = [m for m in _rcomps if m.is_watertight]
                if _closed:
                    _result_mesh = trimesh.util.concatenate(_closed)
            fluid_F = trimesh.boolean.difference([_result_mesh, _solid],
                                                 engine="manifold")
            # Classification sources: the OCC box/part patches (inlet, walls,
            # cylinder_walls), the distributor meshes (hub, shroud, outlet) and the vane
            # prisms (guide_vanes). F's boundary coincides with these, so nearest-centroid
            # gives a clean re-split.
            _sources = []
            for _nm in ("inlet", "walls", "cylinder_walls"):
                _sm = patch_trimesh(trimesh, np, patches.get(_nm, []))
                if _sm is None:
                    continue
                if _nm == "cylinder_walls":
                    # Drop the upper-cylinder BOTTOM disk (horizontal, at z_mid_top,
                    # r < d_last/2) from the source. It is NON-WETTED (upper-cyl solid
                    # above, hub core solid below) and coincides with the wetted hub roof
                    # (the passage ceiling), so leaving it in the source ties the nearest-
                    # source vote and steals the hub roof onto cylinder_walls. Removing it
                    # lets the ceiling classify to hub, where it belongs. Faces beyond
                    # d_last/2 (foot planks, shoulders) are kept.
                    _sfc = _sm.vertices[_sm.faces].mean(axis=1)
                    _sfr = np.hypot(_sfc[:, 0] - target_x, _sfc[:, 1] - target_y)
                    _snz = _sm.face_normals[:, 2]
                    _disk = ((np.abs(_sfc[:, 2] - z_mid_top) < 3.0 * FLOOR_OVERCUT)
                             & (np.abs(_snz) > 0.9) & (_sfr < d_last / 2.0))
                    if _disk.any():
                        _sm = _sm.submesh([np.where(~_disk)[0]], append=True)
                _sources.append((_nm, _sm))
            _sources.append(("hub", vane_patches["hub"]))
            _sources.append(("shroud", vane_patches["shroud"]))
            _sources.append(("outlet", vane_patches["outlet"]))
            _sources.append(("guide_vanes", trimesh.util.concatenate(_prisms)))
            _names, _who = _label_by_nearest_source(np, fluid_F, _sources)
            # The box pocket floor and the outlet annulus are coincident at z_box_floor,
            # so nearest-source ties a few floor faces the wrong way. The outlet is
            # exactly the HORIZONTAL floor annulus [vane_outlet_ri, vane_outlet_ro] —
            # assign it by that rule so the outlet BC surface is clean and complete.
            _oi = _names.index("outlet")
            _fc = fluid_F.vertices[fluid_F.faces].mean(axis=1)
            _fr = np.hypot(_fc[:, 0] - target_x, _fc[:, 1] - target_y)
            _fnz = fluid_F.face_normals[:, 2]
            _floor = ((np.abs(_fc[:, 2] - z_box_floor) < 3.0 * FLOOR_OVERCUT)
                      & (np.abs(_fnz) > 0.9)
                      & (_fr >= vane_outlet_ri - 1e-3) & (_fr <= vane_outlet_ro + 1e-3))
            _who[_floor] = _oi
            # Same coincidence at the ROOF: the upper-cyl bottom (non-wetted) sits on the
            # wetted hub ceiling at z_mid_top, so nearest-source ties send ceiling faces to
            # cylinder_walls. The ceiling is exactly the horizontal F annulus at z_mid_top,
            # r < d_last/2 — assign it to hub (the distributor's own surface).
            _hi = _names.index("hub")
            _roof = ((np.abs(_fc[:, 2] - z_mid_top) < 3.0 * FLOOR_OVERCUT)
                     & (np.abs(_fnz) > 0.9) & (_fr <= d_last / 2.0 + 2e-3))
            _who[_roof] = _hi
            # And at the OUTLET the same coincidence hits the annular passage's VERTICAL
            # walls: the flat outlet annulus rim (and, for a wide passage, the box cylinder)
            # sit right beside the inner duct wall (r ~ vane_outlet_ri, the hub) and the
            # outer duct wall (r ~ vane_outlet_ro, the shroud), so nearest-source scatters a
            # band of each wall onto outlet/cylinder_walls — punching a hole in the hub
            # (and shroud) just above the outlet. The passage floor is horizontal (outlet)
            # and its two walls are vertical, so assign each vertical wall face by radius:
            # r ~ vane_outlet_ri -> hub, r ~ vane_outlet_ro -> shroud. Two guards keep this
            # from over-reaching: (a) |nz| (not signed nz) so the DOWN-facing outlet floor
            # (nz ~ -1) is never taken for a wall — else the outer floor ring lands on shroud
            # (hole in the outlet); (b) only BELOW the distributor passage (z < z_mid_base),
            # the duct region — else vertical box-cylinder faces that happen to sit at
            # r ~ vane_outlet_ri high up get dragged onto the hub.
            _si = _names.index("shroud")
            _wall = (np.abs(_fnz) < 0.5) & (_fc[:, 2] < z_mid_base)
            _who[_wall & (np.abs(_fr - vane_outlet_ri) < 0.03)] = _hi
            _who[_wall & (np.abs(_fr - vane_outlet_ro) < 0.03)] = _si
            final_patches = {}
            for _li, _nm in enumerate(_names):
                _idx = np.where(_who == _li)[0]
                if len(_idx):
                    final_patches[_nm] = fluid_F.submesh([_idx], append=True)

            if os.environ.get("CHAMBER_DEBUG_DUMP"):
                _dd = os.path.join(out_dir, "_debug")
                os.makedirs(_dd, exist_ok=True)
                _core.export(os.path.join(_dd, "core.stl"))
                _casing.export(os.path.join(_dd, "casing.stl"))
                _result_mesh.export(os.path.join(_dd, "result.stl"))
                _hub_throat.export(os.path.join(_dd, "hub_throat.stl"))
                vane_patches["hub"].export(os.path.join(_dd, "hub_source.stl"))
                vane_patches["shroud"].export(os.path.join(_dd, "shroud_source.stl"))
                vane_patches["guide_vanes"].export(os.path.join(_dd, "vanes_source.stl"))
                fluid_F.export(os.path.join(_dd, "F.stl"))
                with open(os.path.join(_dd, "meta.json"), "w") as _mf:
                    json.dump({"target_x": target_x, "target_y": target_y,
                               "z_mid_base": z_mid_base, "z_mid_top": z_mid_top,
                               "z_box_floor": z_box_floor, "d_last": d_last,
                               "vane_outlet_ri": vane_outlet_ri,
                               "vane_outlet_ro": vane_outlet_ro,
                               # analytic hub/shroud invariants (spec 2026-08-10) —
                               # empty/absent on the mesh fallback path.
                               "hub_pts": list(vane_patches.get("hub_pts", [])),
                               "shroud_ell": ([VANE_SHROUD_ELL_A * vane_outlet_ro,
                                               VANE_SHROUD_ELL_B * vane_outlet_ro]
                                              if vane_patches.get("hub_pts") else [])},
                              _mf)

        # --- GLB scene + manifest + edges ----------------------------------
        scene = trimesh.Scene()
        manifest = []
        edge_chunks = []
        total_edge_verts = 0
        patch_meshes = {}

        for name in emit_order:
            if guide_vanes:
                # Every patch is a triangle group of the boolean fluid boundary F
                # (blades excepted); no CAD edges — the viewer falls back to client
                # feature edges.
                tri = final_patches.get(name)
                if tri is None:
                    continue
                edge_verts = np.zeros((0, 3), dtype=np.float32)
                n_faces = len(tri.faces)
            else:
                fs = patches.get(name, [])
                tri = patch_trimesh(trimesh, np, fs)
                if tri is None:
                    continue
                edge_verts = patch_edges(np, BRepAdaptor_Curve, GeomAbs_Line, fs)
                n_faces = len(fs)             # CAD face count for this patch
            patch_meshes[name] = tri
            scene.add_geometry(tri, node_name=name, geom_name=name)

            edge_count = int(edge_verts.shape[0])
            manifest.append({
                "name": name,
                "type": PATCH_TYPES[name],
                "nFaces": n_faces,
                "edgeOffset": total_edge_verts,
                "edgeCount": edge_count,
            })
            if edge_count:
                edge_chunks.append(edge_verts)
                total_edge_verts += edge_count

        if not manifest:
            raise RuntimeError("no patches produced")

        os.makedirs(out_dir, exist_ok=True)
        exports_dir = os.path.join(out_dir, "exports")
        os.makedirs(exports_dir, exist_ok=True)

        # Every artifact is written to "<final>.tmp" and os.replace()d onto its
        # final name, so a concurrent reader (the API serves this directory
        # while a --step re-run rewrites it) always sees a complete old or
        # complete new file — never a truncation — and a killed run leaves only
        # ignorable .tmp leftovers that the next run overwrites. chamber.glb is
        # the API's cache-completeness marker, so it is exported here but
        # PROMOTED LAST (just before OK:), after every other artifact landed:
        # a build that dies anywhere in between leaves no GLB and the next
        # identical request simply rebuilds.
        def _tmp(path):
            return path + ".tmp"

        glb_path = os.path.join(out_dir, "chamber.glb")
        scene.export(_tmp(glb_path), file_type="glb")

        # edges.bin (best-effort; viewer falls back to client feature edges)
        try:
            all_edges = (np.concatenate(edge_chunks) if edge_chunks
                         else np.zeros((0, 3), dtype=np.float32))
            edges_path = os.path.join(out_dir, "edges.bin")
            with open(_tmp(edges_path), "wb") as fh:
                fh.write(all_edges.astype("<f4").tobytes())
            os.replace(_tmp(edges_path), edges_path)
        except Exception as edge_err:  # noqa: BLE001
            sys.stderr.write("WARN: could not write edges.bin: %s\n" % edge_err)

        # manifest
        manifest_path = os.path.join(out_dir, "manifest.json")
        with open(_tmp(manifest_path), "w") as fh:
            json.dump(manifest, fh)
        os.replace(_tmp(manifest_path), manifest_path)

        # exports: whole solid STL + STEP. For guide-vane builds the STL is the true
        # boolean fluid F (core + casing removed).
        stl_path = os.path.join(exports_dir, "chamber.stl")
        if guide_vanes:
            fluid_F.export(_tmp(stl_path), file_type="stl")
        else:
            cq.exporters.export(result, _tmp(stl_path), exportType="STL",
                                tolerance=STL_TOLERANCE)
        os.replace(_tmp(stl_path), stl_path)

        # STEP. Non-guide-vane builds: the OCC `result` (already the true solid),
        # written unconditionally (it costs ~0.05 s). Guide-vane builds: the carve
        # + gate below costs ~2/3 of the build, so it only runs with --step (the
        # on-demand STEP download); a plain vane build ships no chamber.step and
        # no build-meta.json. With --step: try to carve the distributor as OCC
        # BREP so the STEP carries editable vanes; on ANY failure fall back to the
        # vane-less OCC solid (a STEP issue must never fail the build).
        # step_has_vanes: True/False for guide-vane builds (False = vane-less
        # fallback), None = not a vane build / vane STEP not generated.
        step_has_vanes = None
        step_path = os.path.join(exports_dir, "chamber.step")
        if guide_vanes and force_step:
            step_has_vanes = False
            occ_fluid = None
            airfoil = _load_vane_blade_profile(np)
            try:
                _core_prof_ref, _cas_prof_ref = _core_prof, _cas_prof   # analytic path only
            except NameError:
                _core_prof_ref = _cas_prof_ref = None
            if airfoil is not None and _core_prof_ref is not None and _cas_prof_ref is not None:
                try:
                    occ_fluid = build_vane_step_solid(
                        cq, np, trimesh, result, _core_prof_ref, _cas_prof_ref, airfoil,
                        vane_patches["guide_vanes"], target_x, target_y,
                        z_duct_bottom, z_mid_top + 2.0 * FLOOR_OVERCUT,
                        float(fluid_F.volume))
                except Exception as _step_exc:  # noqa: BLE001
                    sys.stderr.write("WARN: OCC vane STEP reconstruction failed: %s\n" % _step_exc)
            if occ_fluid is not None:
                cq.exporters.export(occ_fluid, _tmp(step_path), exportType="STEP")
                step_has_vanes = True
            else:
                sys.stderr.write(
                    "WARN: chamber.step falls back to the vane-less solid (no vanes carved)\n")
                cq.exporters.export(result, _tmp(step_path), exportType="STEP")
            os.replace(_tmp(step_path), step_path)
        elif not guide_vanes:
            cq.exporters.export(result, _tmp(step_path), exportType="STEP")
            os.replace(_tmp(step_path), step_path)

        # per-build meta: does the STEP carry the guide vanes? (guide-vane builds only;
        # non-vane builds write no meta file -> the API reports stepHasVanes = null).
        if step_has_vanes is not None:
            meta_path = os.path.join(out_dir, "build-meta.json")
            with open(_tmp(meta_path), "w") as fh:
                json.dump({"stepHasVanes": bool(step_has_vanes)}, fh)
            os.replace(_tmp(meta_path), meta_path)

        # exports: OpenFOAM triSurface zip (per-patch STL + combined domain.stl)
        zip_path = os.path.join(exports_dir, "trisurface.zip")
        with zipfile.ZipFile(_tmp(zip_path), "w", zipfile.ZIP_DEFLATED) as zf:
            combined = io.StringIO()
            for name in emit_order:
                tri = patch_meshes.get(name)
                if tri is None:
                    continue
                buf = io.StringIO()
                write_ascii_solid(buf, name, tri)
                zf.writestr("%s.stl" % name, buf.getvalue())
                combined.write(buf.getvalue())
            zf.writestr("domain.stl", combined.getvalue())
        os.replace(_tmp(zip_path), zip_path)

        # Promote the GLB last: its presence marks the build directory complete.
        os.replace(_tmp(glb_path), glb_path)

        sys.stdout.write("OK: %d patches -> %s\n" % (len(manifest), glb_path))
        sys.exit(0)

    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - one-shot CLI, report and fail.
        sys.stderr.write("KO: %s\n" % exc)
        sys.exit(1)


if __name__ == "__main__":
    main()

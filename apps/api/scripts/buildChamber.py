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

Geometry (ported from the standalone box.py + prepare_openfoam.py):
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
    exports/chamber.step   the whole solid (BREP)
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


# --- geometry (ported from box.py) ------------------------------------------
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


def make_box(cq, width, length, height, end, big_side, ch_big, ch_small):
    """Box with two asymmetric chamfers on the two vertical corners of ONE end.
    ch = (length_setback, width_setback): cut along Y (length) and X (width)."""
    b = cq.Workplane("XY").box(width, length, height)
    end_sy = 1.0 if end.startswith(">") else -1.0
    big_sx = 1.0 if big_side.startswith(">") else -1.0
    b = b.cut(_corner_prism(cq, width, length, height, big_sx, end_sy,
                            ch_big[0], ch_big[1]))
    b = b.cut(_corner_prism(cq, width, length, height, -big_sx, end_sy,
                            ch_small[0], ch_small[1]))
    return b


def make_part(cq, d_first, h_first, d_middle, h_middle, d_last, h_last, omit_middle=False):
    """Three coaxial cylinders stacked along +Z, base of the FIRST at z = 0
    (the 'stepped' variant). With omit_middle the MIDDLE cylinder is left out
    (the guide-vane band is open): first (0..h_first) + last, the last floating
    at its usual height (h_first+h_middle .. +h_last) so the band is fluid."""
    part = cq.Workplane("XY").circle(d_first / 2).extrude(h_first)
    if omit_middle:
        last = (cq.Workplane("XY", origin=(0, 0, h_first + h_middle))
                .circle(d_last / 2).extrude(h_last))
        return part.union(last)
    part = part.faces(">Z").workplane().circle(d_middle / 2).extrude(h_middle)
    part = part.faces(">Z").workplane().circle(d_last / 2).extrude(h_last)
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


def vane_scale_and_height(meta, d_last):
    """The uniform vane scale and scaled contour height for a given (scaled)
    d_last. `s` pins the blade pivot-circle Ø to 0.80 x d_last; `nat_h` is the
    scaled top-to-outlet contour height (the vane passage's full height). Shared
    by main() (to size the first cylinder under the vanes) and make_vane_patches
    (to place them), so the two never drift."""
    s = (RATIO_D_MIDDLE_OVER_LAST * d_last) / (2.0 * meta["pivotRadius"])
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


def make_vane_patches(trimesh, np, cx, cy, z_mid_base, z_mid_top, d_last, vane_angle_deg=0.0):
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
    the fluid flows directly around them."""
    adir = _vane_assets_dir()
    meta = _load_vane_meta()
    blade = trimesh.load(os.path.join(adir, "guideVanes_blade.stl"))
    walls = trimesh.load(os.path.join(adir, "guideVanes_walls.stl"))
    outlet_asset = trimesh.load(os.path.join(adir, "guideVanes_outlet.stl"))

    s, _ = vane_scale_and_height(meta, d_last)      # RADIAL scale: pivot Ø -> 0.80 d_last
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

    # The SHROUD is the fixed reference (plain place() below, never moves). The HUB and
    # OUTLET scale by sz via a UNIFORM radial map ABOUT the shroud outer rim r_shroud:
    #   r_new = r_shroud + (r_asset*s - r_shroud) * sz
    # The shroud edge (r_asset*s == r_shroud) is invariant; every other radius scales
    # linearly toward/away from it. Being a single linear map (no z ramp, no shear) it
    # is MONOTONIC in radius, so the converging throat stays monotonic — it cannot dip
    # below its own rim and produce a bump. The hub inner rim lands at
    #   ri_target = r_shroud + (outletInnerR*s - r_shroud) * sz
    # elongate (sz>1) -> ri_target smaller (outlet widens inward); clip (sz<1) -> larger
    # (narrower). The straight vertical duct below the rim then sits at ri_target, so
    # the throat->outlet connection is a straight vertical wall.
    r_shroud = meta["outletOuterR"] * s

    def place_throat(mesh):
        m = mesh.copy()
        v = np.asarray(m.vertices, dtype=float)
        r = np.hypot(v[:, 0], v[:, 1])                       # asset radius about the ring axis
        r_new = np.maximum(r_shroud + (r * s - r_shroud) * sz, 1e-3)
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

    # The SHROUD stays fixed; place the FULL shroud once to derive its FLOOR profile
    # f(r) = top-surface z per radius. The shroud is a surface of revolution, so the
    # floor the blades rest on depends only on radius from the ring axis. Reading it off
    # the ACTUALLY-PLACED shroud makes the blade drape below track HLE (via the vertical
    # scale sz) and diameter (via s) automatically.
    shroud_placed = place(shroud_walls)
    _sv = np.asarray(shroud_placed.vertices, dtype=float)
    _sr = np.hypot(_sv[:, 0] - cx, _sv[:, 1] - cy)
    _nb = 240
    _edges = np.linspace(_sr.min(), _sr.max(), _nb + 1)
    _rc = 0.5 * (_edges[:-1] + _edges[1:])
    _idx = np.clip(np.searchsorted(_edges, _sr) - 1, 0, _nb - 1)
    _zf = np.full(_nb, -np.inf)
    np.maximum.at(_zf, _idx, _sv[:, 2])             # per-radius top surface = the floor
    _ok = np.isfinite(_zf)
    _rc_v, _zf_v = _rc[_ok], _zf[_ok]

    def shroud_floor_z(r):
        return np.interp(r, _rc_v, _zf_v)           # clamps to end values outside the range

    # Guide-vane PITCH + shroud DRAPE. Each blade swings about its OWN vertical
    # spindle (pivot axis at radius pivotRadius, at the blade's angular position) by
    # vane_angle_deg — a +-5 deg offset on the asset's baked-in open angle. A rigid
    # pitch shifts the (contoured) bottom edge radially onto a different part of the
    # SLOPED shroud floor, so it would otherwise hang above (or dig into) the shroud;
    # after pitching, the bottom BAND is re-draped onto shroud_floor_z(r) minus a small
    # overlap, blended to zero shift a band-fraction higher up so the airfoil above
    # stays rigid (no kink). Only Z moves, so the blade cross-section is untouched.
    # Pitch + drape act on the reference blade; the radius-preserving ring rotation
    # then carries identical copies to their slots (drape is a function of radius, so
    # it survives the ring rotation).
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
    # CAD outlet cap. Placed by the SAME ramped throat transform as the walls, so it
    # lands exactly at the (sz-scaled) passage bottom and keeps its slight conical
    # form — the full cross-section after the curve, not a synthesised flat ring.
    outlet = place_throat(outlet_asset)

    return {
        # FULL hub/shroud surfaces (roof/floor + throat/funnel), the true refinement
        # surfaces. Hub roof synthesised to meet the wall for any band; shroud is the
        # fixed reference placement (radial s, so its floor reaches the wall regardless
        # of the band).
        "hub": hub_mesh,
        # THROAT only (funnel + duct, NO flat roof) — the hub-core solid is revolved
        # from this so the throat->roof corner is not cut. Not a CFD patch (not emitted).
        "hub_throat": _throat,
        "shroud": shroud_placed,                 # FIXED: natural (s, s, sz), full surface
        "outlet": outlet,
        "guide_vanes": blades_m,
    }


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


def _hub_core_solid(np, trimesh, throat_mesh, cx, cy, z_top, nb=200):
    """The hub CORE as a solid of revolution. Built from the THROAT (funnel + central
    duct) ONLY — NOT the flat roof — and capped flat at z_top. This is deliberate: the
    hub's true profile is the throat rising to the throat-top, then a FLAT roof out to
    the wall. Feeding the flat roof into an r_max(z) silhouette would collapse the whole
    roof to one outer point and the revolve would draw a diagonal from the throat to the
    wall (cutting the throat->roof corner), fattening the core into the vane passage. So
    the core follows the throat up to the throat-top and caps flat at z_top; the flat
    roof itself is supplied by the OCC upper-cylinder bottom (classified to hub) for
    r > throat-top, where the vanes then rest on it cleanly."""
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
    # follow the throat silhouette, then a vertical rise to z_top and a FLAT cap to the
    # axis — no diagonal shortcut across the throat->roof corner.
    prof = [(0.0, z0)] + list(zip(rmax_v.tolist(), zc_v.tolist()))
    prof += [(float(rmax_v[-1]), z_top), (0.0, z_top)]
    return _revolve_profile(np, trimesh, prof, cx, cy)


def _shroud_casing_solid(np, trimesh, shroud_mesh, cx, cy, nb=200):
    """The shroud CASING as an annular solid of revolution — the material below the
    shroud floor, from the inner duct rim (r_in) to the outer rim (r_out), down to
    the box floor. The top follows the shroud floor contour f(r); the annulus never
    touches the axis, so the revolve is a clean watertight ring."""
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
    rc_v, ztop_v = rc[ok], ztop[ok]
    # closed loop: box floor -> outer wall up -> floor contour back to inner -> down
    prof = [(r_in, z0), (r_out, z0), (r_out, float(ztop_v[-1]))]
    prof += list(zip(rc_v[::-1].tolist(), ztop_v[::-1].tolist()))
    prof += [(r_in, float(ztop_v[0])), (r_in, z0)]
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
    if len(sys.argv) != 3:
        sys.stderr.write("usage: python buildChamber.py <paramsJson> <outDir>\n")
        sys.exit(2)

    params_path, out_dir = sys.argv[1], sys.argv[2]

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
            unscaled_part_height = h_first + h_middle + h_last

        # Clamp the scale UP so the scaled stack still fits under the box top (the
        # box height is fixed). Scaling DOWN is always allowed. Same float slack as
        # the exceed-box guard below, so partScale == 1 stays an exact no-op when
        # the stack already equals the box height (the stepped identity P2=P11+P12).
        if unscaled_part_height > 0 and part_scale * unscaled_part_height > height + 1e-6:
            clamped = height / unscaled_part_height
            sys.stderr.write(
                "WARN: partScale %.4f would push the stack (%.4f) past the box "
                "height %.4f; clamped to %.4f\n"
                % (part_scale, part_scale * unscaled_part_height, height, clamped))
            part_scale = clamped

        # Apply the uniform scale to every internal dimension. d_first / d_middle
        # are ratios of the (scaled) d_last, so they scale with it; the guide-vane
        # ring also keys off d_last downstream, so it scales too.
        d_last *= part_scale
        h_middle *= part_scale
        h_first *= part_scale
        d_first = d_last * RATIO_D_FIRST_OVER_LAST
        d_middle = d_last * RATIO_D_MIDDLE_OVER_LAST

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
            h_last *= part_scale
            part = make_part(cq, d_first, h_first, d_middle, h_middle, d_last, h_last,
                             omit_middle=guide_vanes)
            part_height = h_first + h_middle + h_last
            rmax = max(d_first, d_middle, d_last) / 2

        # height now equals part_height exactly for the stepped variant (the model
        # sets P2 = P11 + P12); allow a micron of float slack so that identity does
        # not trip a false "part exceeds box" failure.
        if part_height > height + 1e-6:
            raise ValueError(
                "part height %.4f exceeds box height %.4f" % (part_height, height))

        box = make_box(cq, width, length, height,
                       CHAMFER_END, BIG_CORNER_SIDE, ch_big, ch_small)

        big_sx = 1.0 if BIG_CORNER_SIDE.startswith(">") else -1.0
        end_sy = 1.0 if CHAMFER_END.startswith(">") else -1.0
        target_x = big_sx * (width / 2 - dist_c1)
        target_y = end_sy * (length / 2 - dist_from_end)
        part = part.translate((target_x, target_y, -height / 2 - FLOOR_OVERCUT))

        if abs(target_x) + rmax > width / 2 + 1e-9:
            sys.stderr.write(
                "WARN: part radius %.3f at x=%.3f exceeds box half-width %.3f "
                "-> pocket breaks a side wall\n" % (rmax, target_x, width / 2))

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
        # Guide-vane builds: carve the first cylinder into a RING outside the vane
        # distributor. The whole distributor footprint (r < d_last/2, the upper-cyl
        # radius, which is also the shroud's outer radius) is cut away down to the box
        # floor, so the first cylinder keeps ONLY its outer ring (d_last/2 .. d_first/2)
        # and contributes NO surface inside the distributor (no first-cyl top under the
        # shroud, no central column, no slot walls). The mesh hub/shroud/outlet are the
        # sole surfaces there; being closed, they seal the hub core and the base, which
        # the mesher then removes.
        vane_z_first_top = z_floor + h_first
        vane_s = vane_nat_h = vane_outlet_ri = vane_outlet_ro = vane_z_sb = 0.0
        if guide_vanes:
            _vmeta = _load_vane_meta()
            vane_s, vane_nat_h = vane_scale_and_height(_vmeta, d_last)
            # Outlet scales by the vertical band factor sz ABOUT THE FIXED SHROUD rim
            # (elongate -> wider, clip -> narrower): the shroud outer rim never moves,
            # the hub inner rim slides toward/away from the axis. Straight vertical
            # ducts drop from each rim to the floor (see make_vane_patches.place_throat,
            # which scales the mesh rims to match).
            _vane_sz = h_middle / (_vmeta["height"] - _vmeta["bladeBottomZ"])
            vane_outlet_ro = _vmeta["outletOuterR"] * vane_s              # shroud rim: FIXED
            vane_outlet_ri = vane_outlet_ro + (_vmeta["outletInnerR"] * vane_s - vane_outlet_ro) * _vane_sz
            vane_outlet_ri = max(vane_outlet_ri, 1e-3)                    # hub rim, never past the axis
            vane_z_sb = (z_floor + h_first + h_middle) - vane_nat_h  # natural passage bottom
            # Carve the whole distributor footprint (a full disk of the upper-cyl radius)
            # out of the first cylinder, leaving only the outer ring.
            vane_ring_ri = d_last / 2.0
            _cavity = (cq.Workplane("XY", origin=(target_x, target_y, z_floor))
                       .circle(vane_ring_ri).extrude(h_first))
            part = part.cut(_cavity)

        result = box.cut(part).cut(feet)

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
                vane_angle_deg=vane_pitch)
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
            # Subtract the hub CORE and shroud CASING (solids of revolution) from the
            # OCC fluid, then re-split the TRUE wetted boundary F into named patches by
            # nearest source surface. This removes the hub core, the shroud casing, and
            # every stray cylinder/roof fragment in a non-wetted area at build time,
            # deterministically — no reliance on the mesher sealing closed surfaces and
            # no manual carve/drop heuristics. The blades are thin obstacles fully
            # immersed in the passage (wetted on both faces), so they are NOT subtracted;
            # they ride as their own patch exactly as before.
            # Core from the THROAT + its floor duct (NOT the flat roof), capped flat at
            # z_mid_top so the throat->roof corner is preserved (see _hub_core_solid).
            _hub_throat = trimesh.util.concatenate(
                [vane_patches["hub_throat"], _hub_ext])
            _core = _hub_core_solid(np, trimesh, _hub_throat, target_x, target_y,
                                    z_top=z_mid_top)
            _casing = _shroud_casing_solid(np, trimesh, vane_patches["shroud"],
                                           target_x, target_y)
            _fd, _tmp_stl = tempfile.mkstemp(suffix=".stl")
            os.close(_fd)
            cq.exporters.export(result, _tmp_stl, tolerance=STL_TOLERANCE)
            _result_mesh = trimesh.load(_tmp_stl, file_type="stl")
            os.unlink(_tmp_stl)
            fluid_F = trimesh.boolean.difference([_result_mesh, _core, _casing],
                                                 engine="manifold")
            # Classification sources: the OCC box/part patches (inlet, walls,
            # cylinder_walls) plus the distributor meshes (hub, shroud, outlet). F's
            # boundary coincides with these, so nearest-centroid gives a clean re-split.
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
            final_patches = {}
            for _li, _nm in enumerate(_names):
                _idx = np.where(_who == _li)[0]
                if len(_idx):
                    final_patches[_nm] = fluid_F.submesh([_idx], append=True)

            # Trim the vane DRAPE: the blade bottom is laid a hair below the shroud floor
            # (an old seal overlap) and the inner stub dips further, so the blade protrudes
            # into the shroud casing (non-wetted). CLIP the blades with a horizontal plane
            # at the shroud floor so they end ON the floor (fused, no protrusion). The floor
            # is flat to ~3 mm across the blade span; clipping at its HIGH point guarantees
            # no protrusion below the floor anywhere (any residual sub-3 mm gap at the inner
            # edge is far below mesh cell size, so it cannot leak).
            _blades = vane_patches["guide_vanes"]
            _bv = np.asarray(_blades.vertices, dtype=float)
            _bvr = np.hypot(_bv[:, 0] - target_x, _bv[:, 1] - target_y)
            _shv = np.asarray(vane_patches["shroud"].vertices, dtype=float)
            _shr = np.hypot(_shv[:, 0] - target_x, _shv[:, 1] - target_y)
            _span = (_shr >= _bvr.min() - 0.02) & (_shr <= _bvr.max() + 0.02)
            _z_clip = float(_shv[_span, 2].max()) if _span.any() else z_mid_base
            _clipped = trimesh.intersections.slice_mesh_plane(
                _blades, plane_normal=[0.0, 0.0, 1.0],
                plane_origin=[0.0, 0.0, _z_clip], cap=False)
            if _clipped is not None and len(_clipped.faces):
                _blades = _clipped
            final_patches["guide_vanes"] = _blades

            if os.environ.get("CHAMBER_DEBUG_DUMP"):
                _dd = os.path.join(out_dir, "_debug")
                os.makedirs(_dd, exist_ok=True)
                _core.export(os.path.join(_dd, "core.stl"))
                _casing.export(os.path.join(_dd, "casing.stl"))
                vane_patches["hub"].export(os.path.join(_dd, "hub_source.stl"))
                vane_patches["shroud"].export(os.path.join(_dd, "shroud_source.stl"))
                vane_patches["guide_vanes"].export(os.path.join(_dd, "vanes_source.stl"))
                fluid_F.export(os.path.join(_dd, "F.stl"))
                with open(os.path.join(_dd, "meta.json"), "w") as _mf:
                    json.dump({"target_x": target_x, "target_y": target_y,
                               "z_mid_base": z_mid_base, "z_mid_top": z_mid_top,
                               "z_box_floor": z_box_floor, "d_last": d_last,
                               "vane_outlet_ri": vane_outlet_ri,
                               "vane_outlet_ro": vane_outlet_ro}, _mf)

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

        # GLB
        scene.export(os.path.join(out_dir, "chamber.glb"), file_type="glb")

        # edges.bin (best-effort; viewer falls back to client feature edges)
        try:
            all_edges = (np.concatenate(edge_chunks) if edge_chunks
                         else np.zeros((0, 3), dtype=np.float32))
            with open(os.path.join(out_dir, "edges.bin"), "wb") as fh:
                fh.write(all_edges.astype("<f4").tobytes())
        except Exception as edge_err:  # noqa: BLE001
            sys.stderr.write("WARN: could not write edges.bin: %s\n" % edge_err)

        # manifest
        with open(os.path.join(out_dir, "manifest.json"), "w") as fh:
            json.dump(manifest, fh)

        # exports: whole solid STL + STEP. For guide-vane builds the STL is the true
        # boolean fluid F (core + casing removed); STEP stays the OCC solid (a mesh
        # cannot be written as STEP, and the distributor booleans are mesh-only).
        if guide_vanes:
            fluid_F.export(os.path.join(exports_dir, "chamber.stl"))
        else:
            cq.exporters.export(result, os.path.join(exports_dir, "chamber.stl"),
                                tolerance=STL_TOLERANCE)
        cq.exporters.export(result, os.path.join(exports_dir, "chamber.step"))

        # exports: OpenFOAM triSurface zip (per-patch STL + combined domain.stl)
        with zipfile.ZipFile(os.path.join(exports_dir, "trisurface.zip"), "w",
                             zipfile.ZIP_DEFLATED) as zf:
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

        sys.stdout.write("OK: %d patches -> %s\n"
                         % (len(manifest), os.path.join(out_dir, "chamber.glb")))
        sys.exit(0)

    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - one-shot CLI, report and fail.
        sys.stderr.write("KO: %s\n" % exc)
        sys.exit(1)


if __name__ == "__main__":
    main()

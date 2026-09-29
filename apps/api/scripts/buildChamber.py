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
  * semi-spiral casing (params.spiral, spec 2026-09-29-semi-spiral-casing): the
    box is derived from the frozen spiral outline (mirrored, see SPIRAL_MIRROR_X),
    a nose prism and a tangent plank are cut from the fluid, and both form the
    `tongue` patch. Guide-vane builds add hub / shroud / outlet / guide_vanes.

CLI usage:
    python buildChamber.py <paramsJson> <outDir> [--step]

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
CONE_CHAMFER_SIZE = 0.05              # default Cone chamfer size (m, x partScale; both
                                      # legs of the 45 deg foot chamfer on the lower outer
                                      # edge of the LE part, both designs) when
                                      # coneChamferSize is missing (spec 2026-09-29-cone-
                                      # foot-chamfer). Mirrors CHAMBER_CONE_CHAMFER_SIZE_MM.
SNAP_D_TOL = 0.005                    # guide vanes: a Runner case Ø within 5 mm (scaled
                                      # diameters) of LE Ø is built flush with it; further
                                      # below it gets the LEDGE_GAP ledge (WS-A v2). Mirrors
                                      # CHAMBER_RUNNER_CASE_SNAP_MM of @dive/shared.
RUNNER_CASE_OUTLET_CLEARANCE = 0.020  # guide vanes: a typed Runner case Ø must be at
                                      # least Runner Ø (X1, unscaled) + this, so its wall
                                      # stays 10 mm (radius) outside the outlet passage.
                                      # Mirrors CHAMBER_RUNNER_CASE_OUTLET_CLEARANCE_MM.
LEDGE_GAP = 0.020                     # guide vanes, Runner case Ø below LE Ø: the runner
                                      # case wall stops this far (x partScale) under the
                                      # shroud brim, where the ledge runs out to LE Ø/2
                                      # (spec 2026-09-29-runner-case-below-le).
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
VANE_COUNT_MIN = 8           # guide vane counts accepted (vaneCount param): any whole
VANE_COUNT_MAX = 32          # number in [8, 32]. 16 is the asset; with n vanes each
                             # blade is scaled in XY by bladeCount / n about its pivot
                             # (same solidity, same pivot radius) and the ring step is
                             # 360 / n (specs 2026-09-29-guide-vane-count and
                             # 2026-09-29-guide-vane-count-any). Mirrors
                             # CHAMBER_VANE_COUNT_MIN / _MAX of @dive/shared.
VANE_MIN_GAP = 2e-3          # smallest gap (m) allowed between two neighbouring blade
                             # outlines (2 x VANE_SKIN_TOL: below it the skin mask
                             # cannot tell the blades apart and a mesher cannot fill
                             # the slot). Never reached with the asset over 45..55 deg
                             # at any count (smallest gap ~0.39 chord, at 8 vanes).
VANE_OUTLET_SAFE_MARGIN = 0.97   # outlet outer radius clamp: stay this fraction inside
                                 # the vane's own inner working radius (R_anchor in
                                 # make_vane_patches) so the blade always has shroud/hub
                                 # material to seat on and never overhangs the hole.
VANE_SKIN_TOL = 1e-3             # XY distance (m) within which a wetted face centroid
                                 # counts as ON a blade wall (_blade_skin_mask). Skin
                                 # centroids sit exactly on the outline (the prisms are
                                 # vertical); the nearest junction faces (hub roof /
                                 # shroud floor rings around each airfoil hole) sit a
                                 # half face-width away, >= ~1.5 mm.

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

# --- semi-spiral casing (spec 2026-09-29-semi-spiral-casing) -----------------
# The outline comes FROZEN in params.spiral (designSemiSpiral.py, run by the API
# in its own cached step); the builder never optimises. Tool frame: origin = the
# turbine axis, metres.
SPIRAL_CLEARANCE = 0.2        # nose tip -> widest part of the machine (m, NOT scaled).
                              # Mirrors CHAMBER_SPIRAL_CLEARANCE_M of @dive/shared.
SPIRAL_TIP_TOL = 1e-3         # |V6| must equal rmax + SPIRAL_CLEARANCE within this (m)
SPIRAL_PLANK_THICK = 0.05     # plank thickness (m) x partScale
SPIRAL_PLANK_OVERLAP = 0.02   # plank extension (m) x partScale into the nose and the
                              # target part so the booleans fuse (FOOT_PLANK_OVERLAP idea)
# Handedness (spec section 5.5, checked 2026-09-29): the tool frame turns the flow
# CLOCKWISE seen from +Z, but the guide-vane asset turns it COUNTER-clockwise (its
# outer leading edge -> inner trailing edge chord). The builder therefore mirrors
# the spiral (tool x -> builder -X, so the chamfer 1/2 roles swap), never the
# vanes. Locked by test_spiral_turns_with_the_guide_vanes. Mirrored by
# chamberSpiralBoxDims in @dive/shared (the table's derived values).
SPIRAL_MIRROR_X = True
SPIRAL_FEET_REFUSAL = ("The semi-spiral casing needs Feet off for now. Uncheck Feet, "
                       "or uncheck Semi-spiral casing.")

PATCH_ORDER = ("inlet", "outlet", "cylinder_walls", "walls", "tongue")
# Keep aligned with CHAMBER_PATCH_TYPES in packages/shared (the Meshing -> project
# hand-off forces these types; apps/api/tests/chamberPatchTypes.test.ts checks parity).
PATCH_TYPES = {
    "inlet": "patch",
    "outlet": "patch",
    "cylinder_walls": "wall",
    "walls": "wall",
    "hub": "wall",
    "shroud": "wall",
    "guide_vanes": "wall",
    "tongue": "wall",
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


def make_le_part(cq, r_le, z0, h, chamfer):
    """The LE part as a solid of revolution about the Z axis, from z0 to z0 + h,
    with the Cone chamfer (spec 2026-09-29-cone-foot-chamfer): outer radius
    r_le + c above z0 + c and a 45 deg frustum from r_le at z0 (the foot stands
    on LE Ø/2 at LEB, so the joint with the distributor does not move) out to
    r_le + c at z0 + c. The caller guarantees 0 < c <= h (c = h leaves no
    straight part)."""
    c = min(chamfer, h)
    prof = [(0.0, z0), (r_le, z0), (r_le + c, z0 + c)]
    if h - c > 1e-9:
        prof.append((r_le + c, z0 + h))
    prof.append((0.0, z0 + h))
    # (r, z) on the XZ workplane, revolved about local Y (== global Z), as in
    # build_vane_step_solid.
    return cq.Workplane("XZ").polyline(prof).close().revolve(360.0, (0, 0, 0), (0, 1, 0))


def make_part(cq, d_first, h_first, d_middle, h_middle, d_last, h_last,
              omit_middle=False, h_last_override=None, le_chamfer=None):
    """Three coaxial cylinders stacked along +Z, base of the FIRST at z = 0
    (the 'stepped' variant). With omit_middle the MIDDLE cylinder is left out
    (the guide-vane band is open): first (0..h_first) + last, the last floating
    at its usual height (h_first+h_middle .. +h_last) so the band is fluid.
    h_last_override, when given, is the last cylinder's extrude length instead of
    h_last -- the stepped build passes it to pin the last cylinder's TOP to the
    box top regardless of partScale (base unchanged at h_first+h_middle).
    `le_chamfer` (m, scaled; None = off) widens the last cylinder with the Cone
    chamfer (make_le_part); off keeps the historical construction (bit-identical)."""
    last_h = h_last if h_last_override is None else h_last_override
    part = cq.Workplane("XY").circle(d_first / 2).extrude(h_first)
    if le_chamfer:
        if not omit_middle:
            part = part.faces(">Z").workplane().circle(d_middle / 2).extrude(h_middle)
        return part.union(make_le_part(cq, d_last / 2, h_first + h_middle, last_h,
                                       le_chamfer))
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


def _mm(metres):
    """A length in metres as the form shows it: whole millimetres ("1100 mm")."""
    return "%d mm" % round(metres * 1000.0)


def make_part_hollow(cq, d_first, h_first, d_middle, h_middle, d_last,
                     wall, hollow_len, c_dia, c_h, dome_h, omit_middle=False,
                     le_chamfer=None):
    """The 'hollow' variant (base of the FIRST at z = 0), a union of:
      * first + middle SOLID cylinders (as in 'stepped'),
      * the LAST cylinder as an open-top hollow shell (outer d_last, wall
        thickness `wall`) of height `hollow_len`,
      * a central cylinder (dia c_dia, height c_h) rising coaxially from the top
        of the middle cylinder, capped by an oval dome of height dome_h —
        dome_h None skips the dome (Simplify Generator: the caller pins the
        cylinder through the box top instead, stepped-style).
    The whole union is later SUBTRACTED from the block, so every surface here is
    carved out (walls included). With omit_middle the MIDDLE cylinder is left out
    (the guide-vane band is open fluid); the cup/central/dome still start at
    z_mid_top so the stack above the band is unchanged.

    `le_chamfer` (m, scaled; None = off) is the Cone chamfer (spec
    2026-09-29-cone-foot-chamfer): the cone's outer wall is widened to
    d_last/2 + c above z_mid_top + c with a 45 deg foot down to d_last/2 at
    z_mid_top (make_le_part); the bore does not change, so the wall is c
    thicker. The caller guarantees 0 < c <= hollow_len - wall. Off keeps the
    historical construction (bit-identical)."""
    z_mid_top = h_first + h_middle
    part = cq.Workplane("XY").circle(d_first / 2).extrude(h_first)
    if not omit_middle:
        part = part.faces(">Z").workplane().circle(d_middle / 2).extrude(h_middle)

    # the hollow last cylinder as an open-top CUP (diameter d_last = P9): 5 cm
    # walls + a thin bottom of the same thickness, open at the top. Built as the
    # outer cylinder minus a bore that stops `wall` above the base.
    if le_chamfer:
        outer = make_le_part(cq, d_last / 2, z_mid_top, hollow_len, le_chamfer)
    else:
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
    out = part.union(tube).union(central)
    if dome_h is None:
        return out
    dome = make_dome(cq, c_dia / 2, dome_h, z_mid_top + c_h)
    return out.union(dome)


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
            "Foot angle %.0f\u00b0 cannot shape the torque feet: close to 0\u00b0 or "
            "180\u00b0 a foot misses the runner case, close to 90\u00b0 its top plate "
            "has no width. Pick an angle in between, or turn the feet off."
            % foot_angle_deg)
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


# --- semi-spiral casing (pure geometry, no CadQuery) ---------------------------
def spiral_box(vertices, mirror=SPIRAL_MIRROR_X):
    """The doubly chamfered box that carries a spiral outline (spec section 3),
    from the tool vertices V0..V9 (metres, axis at the origin). L1/L5 are the
    side walls, L3 the chamfered end, L2/L4 the corner cuts and V0 -> V9 the flat
    inlet end. Returns a dict with width, length, dist_c1 (B1: axis to the +X
    wall), dist_from_end (LT), ch_big (+X corner) / ch_small (-X corner) as
    (length_setback, width_setback), and `pts` = {id: (X, Y)} in BUILDER axes
    relative to the axis. With `mirror` the tool x becomes builder -X (so the
    +X wall is L1 and chamfer 1 is L2)."""
    raw = {}
    for v in vertices:
        raw[str(v["id"])] = (float(v["x"]), float(v["y"]))
    missing = [k for k in ("V%d" % i for i in range(10)) if k not in raw]
    if missing:
        raise ValueError("The semi-spiral outline is incomplete (missing %s). Generate "
                         "again to redesign the spiral." % ", ".join(missing))
    x_in, foot_y = raw["V0"]
    y1 = raw["V1"][1]
    x2, y_top = raw["V2"]
    x3 = raw["V3"][0]
    x4, y4 = raw["V4"]
    sx = -1.0 if mirror else 1.0
    box = {
        "width": x4 - x_in,
        "length": y_top - foot_y,
        "dist_from_end": y_top,
        "pts": {k: (sx * x, y) for k, (x, y) in raw.items()},
    }
    if mirror:
        box["dist_c1"] = -x_in
        box["ch_big"] = (y_top - y1, x2 - x_in)
        box["ch_small"] = (y_top - y4, x4 - x3)
    else:
        box["dist_c1"] = x4
        box["ch_big"] = (y_top - y4, x4 - x3)
        box["ch_small"] = (y_top - y1, x2 - x_in)
    return box


def _point_in_polygon(px, py, poly):
    """Even-odd ray test of one point against a closed polygon [(x, y), ...]."""
    inside = False
    n = len(poly)
    for i in range(n):
        (x1, y1), (x2, y2) = poly[i], poly[(i + 1) % n]
        if (y1 > py) != (y2 > py):
            xc = x1 + (py - y1) * (x2 - x1) / (y2 - y1)
            if px < xc:
                inside = not inside
    return inside


def _dist_to_polygon(px, py, poly):
    """Distance from a point to a closed polygon's boundary."""
    best = float("inf")
    n = len(poly)
    for i in range(n):
        (ax, ay), (bx, by) = poly[i], poly[(i + 1) % n]
        vx, vy = bx - ax, by - ay
        t = max(0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)))
        best = min(best, math.hypot(px - (ax + t * vx), py - (ay + t * vy)))
    return best


def spiral_plank(pts, r_t, thick, overlap):
    """The plank footprint (spec section 5.3), relative to the axis: a rectangle
    `thick` wide centred on the segment from the nose tip P = V6 to the tangent
    point T on the target circle (radius r_t), the tangent that continues the
    nose (largest dot product with L6 = V5 -> V6). Extended by `overlap` past T
    into the target part, and past P into the nose far enough that BOTH back
    corners sit inside the nose (at least `overlap`): at the tip the plank leaves
    L6 at ~40 deg, so a short extension would leave a few-mm step of plank corner
    proud of L6. Returns (P, T, rectangle corners)."""
    px, py = pts["V6"]
    r_in = math.hypot(px, py)
    if r_t >= r_in - 1e-9:
        raise ValueError(
            "The semi-spiral plank has no tangent: the generator / cone (%s across) "
            "reaches the nose tip (%s from the axis)." % (_mm(2 * r_t), _mm(r_in)))
    a = math.acos(r_t / r_in)
    ux, uy = px / r_in, py / r_in
    l6x, l6y = px - pts["V5"][0], py - pts["V5"][1]
    l6n = math.hypot(l6x, l6y)
    best = None
    for t in (a, -a):
        tx = r_t * (ux * math.cos(t) - uy * math.sin(t))
        ty = r_t * (ux * math.sin(t) + uy * math.cos(t))
        dl = math.hypot(tx - px, ty - py)
        score = ((tx - px) * l6x + (ty - py) * l6y) / (dl * l6n)
        if best is None or score > best[0]:
            best = (score, (tx, ty), dl)
    _, (tx, ty), dl = best
    dx, dy = (tx - px) / dl, (ty - py) / dl
    nx, ny = -dy, dx
    h = thick / 2.0
    nose = [pts["V5"], pts["V6"], pts["V7"], pts["V8"]]
    back = overlap
    for _ in range(40):
        corners_back = [(px - back * dx + s * h * nx, py - back * dy + s * h * ny) for s in (1, -1)]
        if all(_point_in_polygon(cx_, cy_, nose) for cx_, cy_ in corners_back):
            break
        back += overlap / 2.0
    fx, fy = tx + overlap * dx, ty + overlap * dy
    bx, by = px - back * dx, py - back * dy
    rect = [(bx + h * nx, by + h * ny), (fx + h * nx, fy + h * ny),
            (fx - h * nx, fy - h * ny), (bx - h * nx, by - h * ny)]
    return (px, py), (tx, ty), rect


def spiral_tongue_test(nose, rect, z_leb, tol=PLANE_TOL):
    """Predicate (x, y, z, nz) -> is this wetted face part of the tongue? Its
    centroid lies in the XY footprint of the nose polygon, or of the plank
    rectangle above LEB (within `tol`), and it is not horizontal (|nz| < 0.5):
    the plank underside and ceiling faces stay walls."""
    def test(x, y, z, nz):
        if abs(nz) >= 0.5:
            return False
        if _point_in_polygon(x, y, nose) or _dist_to_polygon(x, y, nose) <= tol:
            return True
        if z < z_leb - tol:
            return False
        return _point_in_polygon(x, y, rect) or _dist_to_polygon(x, y, rect) <= tol
    return test


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
                       outlet_outer_d=None, outlet_ratio=None, d_ring=None,
                       casing_overshoot=FLOOR_OVERCUT, vane_count=16):
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
    clamped) rims — main() uses these downstream instead of recomputing them.

    `vane_count` (8..32) sets the number of blades in the ring, evenly spaced
    every 360/n degrees. With n other than the asset's bladeCount (16) each blade is
    scaled UNIFORMLY in XY by bladeCount/n about its own pivot, before the pitch:
    the chord scales so the cascade solidity n*c/(2 pi R_pivot) is unchanged, the
    pivot circle does not move, and the airfoil stays similar (the STEP fit follows
    it). Z is not scaled (the span still fills the HLE band). R_anchor is measured
    on the scaled blade, so the outlet clamp follows the real blade. The returned
    "pivot" key is the reference blade's pivot (x, y): main() rescales a real blade
    outline about it to find the counts that fit the passage (_vane_count_fit)."""
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

    # Chord scale for a non-asset vane count (spec 2026-09-29-guide-vane-count):
    # uniform XY scale about the pivot. Scale and rotation about the same point
    # commute, so both ride in the pitch block; 16 vanes skips it (bit-identical).
    k_chord = int(meta["bladeCount"]) / float(vane_count)
    base = place(blade)
    if vane_angle_deg or k_chord != 1.0:
        base.apply_translation((-piv_x, -piv_y, 0))     # pitch about the spindle
        if k_chord != 1.0:
            base.apply_scale((k_chord, k_chord, 1.0))
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
                  "(Runner Ø too large for this vane/d_last combination)"
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
            print("WARNING: hub shoulder non-monotonic (Runner Ø too large for the "
                  "point spacing): rim=%.4f P1=%.4f P2=%.4f P3=%.4f"
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
                                                d_last / 2.0 + casing_overshoot)
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
    for k in range(int(vane_count)):
        b = base.copy()
        ang = np.radians(k * 360.0 / vane_count)   # 22.5 deg exactly for 16
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
        # Reference blade pivot (world XY; the ring copies rotate it about the axis).
        "pivot": (float(piv_x), float(piv_y)),
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
                          vol_tol=VANE_STEP_VOL_TOL, ledge_cut_prof=None):
    """Return the OCC BREP fluid Workplane with the vane distributor carved, or None
    when it cannot be trusted (no blades, invalid solid, volume mismatch, or any
    error). Hub/shroud revolve the analytic profiles about the LOCAL-Y axis (global
    Z); each blade is the clean airfoil fitted onto its placed mesh section, lofted
    through a periodic spline and extruded across [z0, z1]. `ledge_cut_prof` (the
    WS-A v2 runner case ledge) is the (r, z) loop of the fluid annulus under the
    ledge: each blade is clipped by it, as the mesh prisms are."""
    def _revolve(prof):
        # (r, z) on the XZ workplane -> revolve about local Y (== global Z); (0,0,1)
        # is degenerate. Then move onto the part axis (cx, cy).
        pts = [(float(r), float(z)) for r, z in prof]
        return (cq.Workplane("XZ").polyline(pts).close()
                .revolve(360.0, (0, 0, 0), (0, 1, 0)).translate((cx, cy, 0)))

    dbg = os.environ.get("CHAMBER_STEP_DEBUG")
    n = len(airfoil)
    dist = _revolve(core_prof).union(_revolve(cas_prof))
    ledge_cut = _revolve(ledge_cut_prof[:-1]) if ledge_cut_prof else None
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
        if ledge_cut is not None:
            blade = blade.cut(ledge_cut)
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
# degenerate cells / heavy local refinement on the mesher at every blade, so
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


def _blade_skin_mask(np, pts_xy, outlines, tol):
    """True for the XY points lying within `tol` of any blade outline. The
    blade prisms are STRICT vertical extrusions of these rings, so a wetted
    face lies on a blade wall iff its centroid's XY distance to a ring is ~0 —
    an exact test, unlike the nearest-centroid vote, which is biased at the
    blade/hub/shroud junctions by whichever source happens to be sampled more
    densely there (both bias directions were observed on real builds)."""
    pts = np.asarray(pts_xy, dtype=float)
    mask = np.zeros(len(pts), dtype=bool)
    for ring in outlines:
        a = np.asarray(ring, dtype=float)
        b = np.roll(a, -1, axis=0)
        ab = b - a
        ab2 = np.maximum((ab ** 2).sum(axis=1), 1e-18)
        lo, hi = a.min(axis=0) - 2 * tol, a.max(axis=0) + 2 * tol
        cand = np.where(~mask
                        & (pts[:, 0] >= lo[0]) & (pts[:, 0] <= hi[0])
                        & (pts[:, 1] >= lo[1]) & (pts[:, 1] <= hi[1]))[0]
        # Chunked point-to-segment distances: (chunk, segments, 2) stays small.
        for s in range(0, len(cand), 4096):
            ci = cand[s:s + 4096]
            ap = pts[ci][:, None, :] - a[None, :, :]
            t = np.clip((ap * ab[None]).sum(-1) / ab2[None], 0.0, 1.0)
            d2 = ((ap - t[..., None] * ab[None]) ** 2).sum(-1).min(axis=1)
            mask[ci[d2 <= tol * tol]] = True
    return mask


def _vane_prisms(np, trimesh, blades_mesh, cx, cy, z0, z1):
    """Turn the (prismatic) guide-vane blades into watertight vertical PRISM solids that
    span z0..z1 — below the shroud floor up to the hub roof. Each blade's airfoil
    footprint is read from a horizontal section at mid-height (the blade is prismatic, so
    the cross-section is constant) and extruded. Unioned with the hub-core / shroud-
    casing, these prisms PIERCE the hub and shroud, so the boolean cuts a real airfoil
    hole in each surface with the vane skin connected to it (no vane surface left inside
    the non-wetted solids). Extruding straight and letting the boolean cut at the shroud
    floor / hub roof also makes the blade ends conform to those curved surfaces exactly.

    Returns (prisms, outlines): the prism solids for the boolean, plus each
    prism's exact XY footprint ring — the input to _blade_skin_mask, which
    assigns the wetted blade skin to the guide_vanes patch analytically (the
    nearest-centroid vote is NOT used for the blades: the prisms' full-height
    side quads put every centroid on two horizontal rows, which lost half the
    skin to the hub roof; a densified source overshot the other way and stole
    shroud-floor rings around the blade roots)."""
    from shapely.geometry import Polygon
    prisms, outlines = [], []
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
        outlines.append(np.asarray(poly.exterior.coords, dtype=float)[:-1])
    return prisms, outlines


def _min_blade_gap(outlines):
    """Smallest XY distance (m) between any two blade outlines (0 when two touch or
    overlap). All pairs, not just i/i+1: blades_mesh.split() does not return the
    blades in azimuth order (496 pairs at 32 vanes is negligible)."""
    from shapely.geometry import Polygon
    polys = [Polygon(o) for o in outlines]
    gap = float("inf")
    for i in range(len(polys)):
        for j in range(i + 1, len(polys)):
            gap = min(gap, float(polys[i].distance(polys[j])))
    return gap


def _vane_count_fit(np, outline, pivot, vane_count, cx, cy, r_in, r_out):
    """Does the blade fit the distributor passage at `vane_count`, and which counts
    do? Returns (fits, a, b): `fits` for vane_count, and [a, b] the contiguous run
    of counts in [VANE_COUNT_MIN, VANE_COUNT_MAX] around the asset's 16 that fit.

    `outline` is one REAL blade outline (XY ring, built at vane_count) and `pivot`
    its spindle: the blade at count m is that outline scaled by vane_count/m about
    the pivot (the chord rule), so one outline gives every count. A count fits when
    its outline stays within radii [r_in, r_out] about the ring axis (cx, cy): the
    hub rim and LE/2, the shroud brim edge (spec 2026-09-29-guide-vane-count-any).
    The limits never get tighter than the 16-vane blade itself: a ring the user
    oversized (Guide vanes diameter) already pokes out at 16 vanes, which is not the
    count's doing, so 16 always fits and 16 and 18 build exactly as before."""
    pts = np.asarray(outline, dtype=float)[:, :2]
    piv = np.asarray(pivot, dtype=float)
    ctr = np.array([cx, cy], dtype=float)

    def extent(m):
        q = piv + (float(vane_count) / m) * (pts - piv) - ctr
        r = np.hypot(q[:, 0], q[:, 1])
        return float(r.min()), float(r.max())

    lo16, hi16 = extent(16)
    lo, hi = min(r_in, lo16) - 1e-6, max(r_out, hi16) + 1e-6

    def ok(m):
        a, b = extent(m)
        return a >= lo and b <= hi

    a = b = 16
    while a - 1 >= VANE_COUNT_MIN and ok(a - 1):
        a -= 1
    while b + 1 <= VANE_COUNT_MAX and ok(b + 1):
        b += 1
    return ok(vane_count), a, b


def _shroud_casing_solid(np, trimesh, shroud_mesh, cx, cy, d_last, nb=200, nfine=160,
                         overshoot=FLOOR_OVERCUT):
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
    r_out_wall = max(r_out, d_last / 2.0) + overshoot
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


def classify(faces, adaptor, geomabs, variant, pocket_radius, guide_vanes=False,
             tongue_test=None):
    """Return {patch: [face,...]} for inlet / outlet / cylinder_walls / walls
    (+ tongue). A face is a pocket (cavity/feet) surface when its vertices lie
    within `pocket_radius` of the part axis; box faces reach far beyond it. With
    guide_vanes the middle cylinder is omitted (only first/last remain) and the
    outlet comes from the vane mesh, so fewer cylinders are expected and no BREP
    outlet is chosen. `tongue_test` (semi-spiral builds, see spiral_tongue_test)
    claims the nose + plank faces first, before the pocket split; the nose and
    plank faces are all planar."""
    ymin = min(f.BoundingBox().ymin for f in faces)
    tongue = []
    if tongue_test is not None:
        for f in faces:
            if _face_kind(f, adaptor, geomabs)[0] != "plane":
                continue
            c = f.Center()
            n = f.normalAt(c)
            if tongue_test(c.x, c.y, c.z, n.z):
                tongue.append(f)
    tongue_ids = {id(f) for f in tongue}
    faces = [f for f in faces if id(f) not in tongue_ids]

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
        "tongue": tongue,
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
    # Messages quote the form's labels (Ø, °, ×): emit UTF-8 whatever the
    # locale (a Windows console would otherwise encode them as cp1252).
    for _stream in (sys.stdout, sys.stderr):
        if hasattr(_stream, "reconfigure"):
            _stream.reconfigure(encoding="utf-8")
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
        # Semi-spiral casing (spec 2026-09-29-semi-spiral-casing): params.spiral
        # carries the frozen outline; the box (length, B1, LT, the four chamfer
        # values) is DERIVED from it and the API leaves those keys out. `width`
        # is then only the spiral's width limit (B Kammer). Old params.json files
        # have no `spiral`: the box path below is unchanged for them.
        spiral = P.get("spiral")
        height = num("height")
        if spiral is None:
            width = num("width")
            length = num("length")
            dist_c1 = num("distFromSideChamfer1")
            ch_big = (num("chamferLength1"), num("chamferWidth1"))
            ch_small = (num("chamferLength2"), num("chamferWidth2"))
            dist_from_end = num("distFromEnd")
        else:
            sp_box = spiral_box(spiral.get("vertices", []))
            width, length = sp_box["width"], sp_box["length"]
            dist_c1, dist_from_end = sp_box["dist_c1"], sp_box["dist_from_end"]
            ch_big, ch_small = sp_box["ch_big"], sp_box["ch_small"]
        d_last = num("dLast")
        h_middle = num("hMiddle")
        h_first = num("hMiddlePlusFirst") - h_middle
        variant = str(P.get("variant", "stepped"))
        foot_angle = float(P.get("footAngleDeg", FOOT_ANGLE_DEG))
        guide_vanes = bool(P.get("guideVanes", False))
        chamfer_enabled = bool(P.get("chamferEnabled", True))
        feet_enabled = bool(P.get("feetEnabled", True))
        if spiral is not None:
            # The spiral's L2/L4 ARE the corner cuts (the Chamfer flag is ignored),
            # and legs are not designed for the spiral yet (refused, spec section 10).
            chamfer_enabled = True
            if feet_enabled:
                raise ValueError(SPIRAL_FEET_REFUSAL)
        # Simplify Generator (hollow only): no dome, and the central cylinder is
        # pinned THROUGH the box top (stepped-style) unless the API passes a
        # typed centralHeight (then a closed cylinder); domeHeight is omitted.
        simplify_generator = bool(P.get("simplifyGenerator", False))
        # Typed generator height (m, unscaled) for the Closed generator (the
        # last cylinder) and Simplify Generator; None = through the box top.
        gen_h_typed = num_opt("centralHeight") if (
            variant == "stepped" or simplify_generator) else None
        if gen_h_typed is not None and gen_h_typed <= 0:
            raise ValueError(
                "Generator height must be greater than 0 mm. Leave it blank to "
                "run the generator up through the chamber top.")
        # Absolute guide-vane open angle (deg). The asset is baked at
        # VANE_BASE_ANGLE_DEG (50); each blade swings about its own spindle by
        # (vane_angle - VANE_BASE_ANGLE_DEG) to reach the requested angle. Range is
        # +-5 deg about the base (45..55). Only used by guide-vane builds.
        vane_angle = float(P.get("vaneAngleDeg", VANE_BASE_ANGLE_DEG))
        vane_pitch = vane_angle - VANE_BASE_ANGLE_DEG   # signed offset actually applied
        # Guide vane count (any whole number 8..32; 16 = the asset). Old params.json
        # files and every 16-vane build omit the key. Only used by guide-vane builds.
        vane_count = P.get("vaneCount", 16)
        # Uniform scale for the WHOLE internal assembly (the three cylinders, the
        # hollow cup / central cylinder / dome, the four feet, and the guide vanes
        # which key off d_last). The box (width/length/height), the chamfers, and
        # the part AXIS (positioned by distFromSideChamfer1 / distFromEnd) are NOT
        # scaled, so the cavity grows/shrinks about its own floor-anchored axis
        # inside an unchanged box. Up-scaling is clamped below so the stack never
        # outgrows the box height; scaling down is unbounded.
        part_scale = float(P.get("partScale", 1.0))

        # --- common validation (on the UNSCALED model values) ---------------
        if (isinstance(vane_count, bool) or not isinstance(vane_count, (int, float))
                or vane_count != int(vane_count)
                or not VANE_COUNT_MIN <= vane_count <= VANE_COUNT_MAX):
            raise ValueError("Guide vane count must be a whole number from %d to %d (got %s)."
                             % (VANE_COUNT_MIN, VANE_COUNT_MAX, vane_count))
        vane_count = int(vane_count)
        if min(width, height, length, d_last, h_middle) <= 0:
            raise ValueError(
                "B Kammer, H Kammer, Length, LE (Durchmesser) and HLE must all be "
                "greater than 0 mm.")
        if h_first <= 0:
            raise ValueError(
                "LEB (%s) must be taller than HLE (%s): the runner case under the "
                "guide vanes would have no height. Raise LEB or lower HLE."
                % (_mm(h_first + h_middle), _mm(h_middle)))
        if not 0 < dist_c1 < width:
            raise ValueError(
                "B1 (%s) places the turbine axis outside the chamber: it must be "
                "between 0 and B Kammer (%s)." % (_mm(dist_c1), _mm(width)))
        if not 0 < dist_from_end < length:
            raise ValueError(
                "LT (%s) places the turbine axis outside the chamber: it must be "
                "between 0 and Length (%s)." % (_mm(dist_from_end), _mm(length)))
        if chamfer_enabled:
            # The corner cuts eat (length-wise, width-wise) into the box; a
            # non-positive setback makes a degenerate zero-area prism (cryptic
            # OCC failure), one beyond the box is geometric nonsense.
            for _n, (_cl, _cw) in (("1", ch_big), ("2", ch_small)):
                if _cl <= 0 or _cw <= 0:
                    raise ValueError(
                        "Corner chamfer %s needs LF%s and BF%s greater than 0 mm "
                        "(got LF%s = %s, BF%s = %s). To remove the corner cut, turn "
                        "the chamfer off instead of setting it to 0."
                        % (_n, _n, _n, _n, _mm(_cl), _n, _mm(_cw)))
                if _cl >= length or _cw >= width:
                    raise ValueError(
                        "Corner chamfer %s is as large as the chamber: LF%s (%s) "
                        "must be shorter than Length (%s) and BF%s (%s) narrower "
                        "than B Kammer (%s)."
                        % (_n, _n, _mm(_cl), _mm(length), _n, _mm(_cw), _mm(width)))
        if not 0.0 <= foot_angle <= 180.0:
            raise ValueError(
                "Foot angle must be between 0\u00b0 and 180\u00b0 (0\u00b0 and 180\u00b0 = "
                "tangential, 90\u00b0 = pointing at the axis); got %.1f\u00b0."
                % foot_angle)
        if part_scale <= 0:
            raise ValueError("Part scale must be greater than 0 (got %g)." % part_scale)
        if not VANE_BASE_ANGLE_DEG - 5.0 <= vane_angle <= VANE_BASE_ANGLE_DEG + 5.0:
            raise ValueError(
                "Vane angle must be between %.0f\u00b0 and %.0f\u00b0 (the %.0f\u00b0 "
                "base opening \u00b1 5\u00b0); got %.1f\u00b0." % (
                    VANE_BASE_ANGLE_DEG - 5.0, VANE_BASE_ANGLE_DEG + 5.0,
                    VANE_BASE_ANGLE_DEG, vane_angle))

        # --- read the per-variant stack dims (UNSCALED) up front, so we can
        #     size the uniform scale against the box BEFORE building ----------
        if variant == "hollow":
            wall = num("wallThickness")
            hollow_len = num("hollowLength")
            c_dia = num("centralDiameter")
            if simplify_generator:
                c_h = gen_h_typed
                dome_h = None
            else:
                c_h = num("centralHeight")
                dome_h = num("domeHeight")
            if not 0 < wall < d_last / 2:
                raise ValueError(
                    "Wall thickness (%s) must be greater than 0 and less than half "
                    "of LE (Durchmesser) (%s), or the cone would have no inside."
                    % (_mm(wall), _mm(d_last)))
            if simplify_generator:
                if min(hollow_len, c_dia) <= 0:
                    raise ValueError(
                        "Cone length and Generator \u00d8 must be greater than 0 mm.")
            elif min(hollow_len, c_dia, c_h, dome_h) <= 0:
                raise ValueError(
                    "Cone length, Generator \u00d8, Generator height and Dome height "
                    "must all be greater than 0 mm.")
            if hollow_len <= wall:
                raise ValueError(
                    "Cone length (%s) must be longer than the Wall thickness (%s): "
                    "the cone is an open cup whose bottom is one wall thick."
                    % (_mm(hollow_len), _mm(wall)))
            # With Simplify Generator the central cylinder is pinned to the box
            # top (it always fits) unless its height is typed; then it counts.
            if simplify_generator:
                top = hollow_len if c_h is None else max(hollow_len, c_h)
            else:
                top = max(hollow_len, c_h + dome_h)
            unscaled_part_height = h_first + h_middle + top
        else:
            h_last = num("hLast")
            if h_last <= 0:
                raise ValueError("hLast must be > 0")
            # The last cylinder is pinned to the box top; only the shoulder
            # (first+middle) grows with partScale, so the clamp is sized against
            # the shoulder (not the whole stack) below. A typed generator height
            # closes the last cylinder under the top: the whole stack counts.
            unscaled_shoulder = h_first + h_middle
            unscaled_stack = (None if gen_h_typed is None
                              else unscaled_shoulder + gen_h_typed)

        # Cone chamfer (spec 2026-09-29-cone-foot-chamfer), both designs: a 45 deg
        # foot chamfer on the lower outer edge of the LE part (the Closed-generator
        # last cylinder, the With cone outer wall), the part widened by the size
        # above it. Size in metres UNSCALED here (x partScale below). With cone:
        # at most Cone length - Wall thickness (checked here, both scale alike);
        # Closed generator: at most the generator above LEB (checked once scaled).
        cone_chamfer = None
        if bool(P.get("coneChamferEnabled", False)):
            cone_chamfer = num_opt("coneChamferSize")
            if cone_chamfer is None:
                cone_chamfer = CONE_CHAMFER_SIZE
            if cone_chamfer <= 0:
                raise ValueError(
                    "Cone chamfer size must be greater than 0 mm. Untick Cone chamfer "
                    "for a square foot.")
            if variant == "hollow" and cone_chamfer > hollow_len - wall + 1e-9:
                raise ValueError(
                    "Cone chamfer size (%s) is taller than the cone: Cone length %s "
                    "minus Wall thickness %s leaves %s. Lower the Cone chamfer size to "
                    "%s or less, or lengthen the Cone length."
                    % (_mm(cone_chamfer), _mm(hollow_len), _mm(wall),
                       _mm(hollow_len - wall), _mm(hollow_len - wall)))

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
        elif unscaled_stack is not None:
            clamp_basis = unscaled_stack
            clamp_limit = height
        else:
            clamp_basis = unscaled_shoulder
            clamp_limit = height + 2 * FLOOR_OVERCUT - MIN_LAST_CYL_H
        if clamp_basis > 0 and part_scale * clamp_basis > clamp_limit + 1e-6:
            # The messages quote the UNSCALED heights and the scaled total, in
            # the form's words (LEB, Cone length, Generator height...).
            scaled_note = ("" if abs(part_scale - 1.0) < 1e-9
                           else " at Part scale %g" % part_scale)
            leb = h_first + h_middle
            if variant == "stepped" and unscaled_stack is not None:
                raise ValueError(
                    "The generator does not fit under the chamber top: LEB %s + "
                    "Generator height %s = %s%s, but H Kammer is only %s. Lower the "
                    "Generator height, HLE or Part scale, or increase H Kammer."
                    % (_mm(leb), _mm(gen_h_typed), _mm(part_scale * clamp_basis),
                       scaled_note, _mm(clamp_limit)))
            if variant == "hollow":
                fit_scale = clamp_limit / clamp_basis
                # Name the part that sets the top of the stack (with its verb).
                if simplify_generator:
                    if c_h is not None and c_h > hollow_len:
                        what, top_desc = "generator does", "Generator height %s" % _mm(c_h)
                        levers = "lower the Generator height or HLE"
                    else:
                        what, top_desc = "cone does", "Cone length %s" % _mm(hollow_len)
                        levers = "shorten the Cone length or lower HLE"
                elif hollow_len >= c_h + dome_h:
                    what, top_desc = "cone does", "Cone length %s" % _mm(hollow_len)
                    levers = "shorten the Cone length or lower HLE"
                else:
                    what = "generator and its dome do"
                    top_desc = "Generator height %s + Dome height %s" % (
                        _mm(c_h), _mm(dome_h))
                    levers = ("lower the Generator height, Dome height or HLE "
                              "(or tick Simplify generator)")
                raise ValueError(
                    "The %s not fit under the chamber top: LEB %s + %s = %s%s, "
                    "but H Kammer is only %s. Set Part scale to %.2f or less, %s, "
                    "or increase H Kammer."
                    % (what, _mm(leb), top_desc, _mm(part_scale * clamp_basis),
                       scaled_note, _mm(clamp_limit), math.floor(fit_scale * 100) / 100,
                       levers))
            else:
                part_lever = "" if abs(part_scale - 1.0) < 1e-9 else ", Part scale"
                raise ValueError(
                    "H Kammer (%s) is too low: LEB %s%s leaves less than %s above it "
                    "for the generator. Lower HLE%s, or increase H Kammer."
                    % (_mm(height), _mm(part_scale * clamp_basis), scaled_note,
                       _mm(MIN_LAST_CYL_H), part_lever))

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

        # Guide vanes carve the whole disk r < d_last/2 out of the runner case (first
        # cylinder) and seat the distributor inside it, so the runner case only keeps
        # its outer ring [d_last/2, d_first/2] (spec 2026-09-29). Within SNAP_D_TOL of
        # LE a typed Runner case is snapped flush with LE (no ring, no casing
        # overshoot). Further below LE (WS-A v2, spec 2026-09-29-runner-case-below-le)
        # the runner case wall stands at d_first/2 up to LEDGE_GAP under the shroud
        # brim, where a ledge runs out to LE/2 (runner_case_ledge; built on the
        # shroud casing below). It must clear the outlet: d_first >= X1 +
        # RUNNER_CASE_OUTLET_CLEARANCE (X1 = outletOuterD, not scaled), else refused.
        # The auto ratio is always larger. From here on d_first is the EFFECTIVE
        # runner case (feet, fit check, pocket radius, junction labels).
        runner_case_snapped = False
        runner_case_ledge = False
        if guide_vanes and d_first_override is not None:
            _x1 = num_opt("outletOuterD")
            _auto = _mm(d_last / part_scale * RATIO_D_FIRST_OVER_LAST)
            if _x1 is not None and d_first < _x1 + RUNNER_CASE_OUTLET_CLEARANCE - 1e-9:
                raise ValueError(
                    "With guide vanes the runner case must clear the outlet: Runner case "
                    "\u00d8 (%s%s) must be at least Runner \u00d8 + 20 mm (%s). Increase "
                    "Runner case \u00d8, clear it (auto \u2248 %s), or turn Guide vanes off."
                    % (_mm(d_first_override),
                       "" if abs(part_scale - 1.0) < 1e-9
                       else ", %s at Part scale %g" % (_mm(d_first), part_scale),
                       _mm(_x1 + RUNNER_CASE_OUTLET_CLEARANCE), _auto))
            if d_first < d_last - SNAP_D_TOL - 1e-9:
                if _x1 is None:
                    # Very old params (no X1): no analytic shroud to build the ledge on.
                    raise ValueError(
                        "With guide vanes the distributor sits inside the runner case: "
                        "Runner case \u00d8 (%s) must be at least LE \u00d8 (%s). Increase "
                        "Runner case \u00d8, clear it (auto \u2248 %s), or turn Guide vanes "
                        "off." % (_mm(d_first_override), _mm(d_last / part_scale), _auto))
                runner_case_ledge = True
            if abs(d_first - d_last) <= SNAP_D_TOL + 1e-9:
                print("WARNING: Runner case \u00d8 %s is within 5 mm of LE \u00d8 %s: "
                      "built flush with it." % (_mm(d_first_override),
                                                _mm(d_last / part_scale)))
                d_first = d_last
                runner_case_snapped = True
        # The shroud casing's outer wall is pushed past LE/2 so the boolean leaves no
        # sliver against the runner-case ring; never by more than half the ring (a
        # thin ring would otherwise let it poke out into the fluid), and not at all
        # when the runner case is flush. Equals FLOOR_OVERCUT for rings >= 20 mm.
        casing_overshoot = min(FLOOR_OVERCUT, max(0.0, d_first / 2.0 - d_last / 2.0) / 2.0)

        def _reaches_top(stack_local):
            """A typed generator whose top lands within 1 mm of the box top is
            the same fluid as one running through it: pin it (no sliver)."""
            return stack_local >= height - 1e-3

        # Cone chamfer, scaled (0 = off): the LE part's widening. Every fit check
        # that uses the LE radius counts r_le + le_c (rmax, walls, chamfer faces,
        # feet clearance), and so does the semi-spiral plank tangent circle; the
        # hub-roof label rule stays at r <= r_le (the roof does not move).
        le_c = cone_chamfer * part_scale if cone_chamfer is not None else 0.0

        # --- build the part (per variant) -----------------------------------
        if variant == "hollow":
            wall *= part_scale
            hollow_len *= part_scale
            c_dia *= part_scale
            if simplify_generator and (
                    c_h is None or _reaches_top(h_first + h_middle + c_h * part_scale)):
                # Pin the generator's top a hair above the box top so box.cut
                # opens it through the top at ANY partScale (the stepped last
                # cylinder's mechanism). The part is later translated by
                # z_floor = -height/2 - FLOOR_OVERCUT, so a local top of
                # (height + 2*FLOOR_OVERCUT) lands at +height/2 + FLOOR_OVERCUT.
                c_h = (height + 2 * FLOOR_OVERCUT) - (h_first + h_middle)
            elif simplify_generator:
                c_h *= part_scale
            else:
                c_h *= part_scale
                dome_h *= part_scale
            if c_dia > d_last - 2 * wall:
                sys.stderr.write(
                    "WARN: central diameter %.3f exceeds the hollow bore %.3f\n"
                    % (c_dia, d_last - 2 * wall))
            part = make_part_hollow(cq, d_first, h_first, d_middle, h_middle, d_last,
                                    wall, hollow_len, c_dia, c_h, dome_h,
                                    omit_middle=guide_vanes, le_chamfer=le_c or None)
            part_height = h_first + h_middle + max(
                hollow_len, c_h + (0.0 if dome_h is None else dome_h))
            rmax = max(d_first, d_middle, d_last + 2 * le_c) / 2
        else:
            h_last *= part_scale  # scaled model value (kept for reference/logging)
            # Pin the last cylinder's TOP a hair above the box top so box.cut opens
            # it through the top at ANY partScale (mirrors the floor overcut). Base
            # stays at the scaled shoulder (h_first+h_middle); only the top is
            # decoupled from the scale. Diameter still scales via d_last above.
            # Part is later translated by z_floor = -height/2 - FLOOR_OVERCUT, so a
            # local top of (height + 2*FLOOR_OVERCUT) lands at +height/2 + FLOOR_OVERCUT.
            last_h_local = (height + 2 * FLOOR_OVERCUT) - (h_first + h_middle)
            if gen_h_typed is not None and not _reaches_top(
                    h_first + h_middle + gen_h_typed * part_scale):
                # Typed generator height: a flat-topped last cylinder closed
                # under the box top (fluid above it).
                last_h_local = gen_h_typed * part_scale
                le_room, gen_closed = last_h_local, True
            else:
                # LEB up to the chamber top
                le_room, gen_closed = height - (h_first + h_middle), False
            # Cone chamfer: the generator must be at least as tall as the chamfer
            # (the "no room above LEB" case is refused just below).
            if le_c and last_h_local > 0 and le_c > le_room + 1e-9:
                scaled = ("" if abs(part_scale - 1.0) < 1e-9
                          else ", %s at Part scale %g" % (_mm(le_c), part_scale))
                if gen_closed:
                    room = "the Generator height is only %s" % _mm(gen_h_typed)
                    lever = ", or raise the Generator height"
                else:
                    room = "the generator rises only %s above LEB up to the chamber top" % (
                        _mm(le_room))
                    lever = ", or increase H Kammer"
                raise ValueError(
                    "Cone chamfer size (%s%s) is taller than the generator: %s. Lower "
                    "the Cone chamfer size to %s or less%s."
                    % (_mm(cone_chamfer), scaled, room, _mm(le_room / part_scale), lever))
            part = make_part(cq, d_first, h_first, d_middle, h_middle, d_last, h_last,
                             omit_middle=guide_vanes, h_last_override=last_h_local,
                             le_chamfer=le_c or None)
            part_height = h_first + h_middle + last_h_local  # height + 2*FLOOR_OVERCUT when pinned
            rmax = max(d_first, d_middle, d_last + 2 * le_c) / 2

        # Hollow: the stack must fit under the box top — except with Simplify
        # Generator, whose central cylinder is intentionally pinned THROUGH the
        # top (stepped-style), so guard its height is positive instead. Stepped:
        # same positive-height guard on the pinned last cylinder.
        if variant == "hollow":
            if simplify_generator:
                if c_h <= 0:
                    raise ValueError(
                        "H Kammer (%s) is lower than LEB (%s): there is no room "
                        "left for the generator. Increase H Kammer, or lower HLE "
                        "or Part scale." % (_mm(height), _mm(h_first + h_middle)))
            elif part_height > height + 1e-6:
                raise ValueError(
                    "The turbine is %s tall but H Kammer is only %s. Increase "
                    "H Kammer, or lower HLE or Part scale."
                    % (_mm(part_height), _mm(height)))
        else:
            if last_h_local <= 0:
                raise ValueError(
                    "H Kammer (%s) is lower than LEB (%s): there is no room left "
                    "for the generator. Increase H Kammer, or lower HLE or Part "
                    "scale." % (_mm(height), _mm(h_first + h_middle)))

        # Semi-spiral: the frozen outline must belong to THIS machine (its nose tip
        # 200 mm from the widest part, rmax) - a stale or hand-edited spiral is
        # refused before any boolean. r_t is the target circle of the plank: the
        # Closed-generator last cylinder / the cone outer wall (both d_last/2,
        # widened by the Cone chamfer when it is on).
        if spiral is not None:
            _tip = math.hypot(*sp_box["pts"]["V6"])
            if abs(_tip - (rmax + SPIRAL_CLEARANCE)) > SPIRAL_TIP_TOL:
                raise ValueError(
                    "The semi-spiral outline was designed for another machine: its nose "
                    "tip sits %s from the axis, but the widest part (%s across) needs "
                    "%s. Generate again to redesign the spiral."
                    % (_mm(_tip), _mm(2 * rmax), _mm(rmax + SPIRAL_CLEARANCE)))
            sp_tip, sp_tan, sp_rect = spiral_plank(
                sp_box["pts"], d_last / 2.0 + le_c, SPIRAL_PLANK_THICK * part_scale,
                SPIRAL_PLANK_OVERLAP * part_scale)

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
            (dist_c1, "side wall on the chamfer side (distance B1)"),
            (width - dist_c1, "opposite side wall (distance B Kammer - B1)"),
            (dist_from_end, "chamfered end wall (distance LT)"),
            (length - dist_from_end, "inlet end wall (distance Length - LT)"),
        ]
        gap, wall_name = min(clearances, key=lambda c: c[0])

        # The two chamfer corner cuts (full-height prisms at the +Y end). Each is
        # the triangle corner P / wall point A / wall point B; geometry mirrors
        # _corner_prism exactly.
        chamfer_tris = []
        if chamfer_enabled:
            for _sx, (_len_set, _wid_set), _nm in (
                    (big_sx, ch_big, "corner chamfer 1 (LF1 \u00d7 BF1)"),
                    (-big_sx, ch_small, "corner chamfer 2 (LF2 \u00d7 BF2)")):
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
                    "The turbine axis (placed by B1 and LT) lies inside the cut "
                    "corner of %s. Move the axis with B1 / LT, or make that "
                    "chamfer smaller." % _nm)

        def _refuse_radial(r_check, what, levers):
            """Refuse when a circle of radius r_check about the part axis pokes
            through a straight wall or a chamfer corner face."""
            if r_check > gap + 1e-6:
                raise ValueError(
                    "%s would stick out of the chamber: it reaches %s from the "
                    "turbine axis, but the %s is only %s away. %s"
                    % (what, _mm(r_check), wall_name, _mm(gap), levers))
            for _ta, _tb, _tc, _nm in chamfer_tris:
                if min(_seg_dist(target_x, target_y, p, q)
                       for p, q in ((_ta, _tb), (_tb, _tc), (_tc, _ta))) < r_check - 1e-6:
                    raise ValueError(
                        "%s would stick out of the chamber through %s. %s"
                        % (what, _nm, levers))

        _refuse_radial(
            rmax,
            "The turbine (%s across at its widest)" % _mm(2 * rmax),
            "Increase B Kammer or Length, move the axis with B1 / LT, or lower "
            + ("Part scale, Runner case \u00d8, Guide vanes \u00d8 or Cone chamfer size."
               if le_c else "Part scale, Runner case \u00d8 or Guide vanes \u00d8."))

        # The feet legs keep their clearance from the runner case, from the LE part
        # widened by the Cone chamfer and, with guide vanes, from the distributor /
        # ledge at LE \u00d8/2 when the runner case is smaller (WS-A v2) (d_feet: the
        # diameter they anchor from); the planks still weld onto the LE part at LE \u00d8/2.
        d_feet = (max(d_first, d_last + 2 * le_c) if (le_c or guide_vanes)
                  else d_first)

        if feet_enabled:
            # Exact swung plan of the four legs, mirroring make_feet (the planks
            # stay inside the leg tips + the cylinder wall, so the leg hexagon
            # corners bound the whole foot footprint).
            _hw = FOOT_WIDTH * part_scale / 2
            _r_in = d_feet / 2 + FOOT_CLEARANCE * part_scale + _hw
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
                            "A torque foot would stick out of the chamber through "
                            "%s. Increase B Kammer or Length, move the axis with "
                            "B1 / LT, change the Foot angle, lower Part scale, or "
                            "turn the feet off."
                            % (_through if _through else "a side or end wall"))

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
                d_last / 2, d_feet, foot_angle_deg=foot_angle,
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
            if runner_case_snapped:
                # Flush runner case: remove the whole first cylinder (a coincident
                # cavity would leave a sliver); the casing wall becomes its wall.
                vane_ring_ri += FLOOR_OVERCUT
            _cavity = (cq.Workplane("XY", origin=(target_x, target_y, z_floor))
                       .circle(vane_ring_ri).extrude(h_first))
            part = part.cut(_cavity)

        result = box.cut(part)
        if feet is not None:
            result = result.cut(feet)

        # --- semi-spiral tongue: the nose and the plank (spec section 5) -----
        # Nose: prism V5 -> V6 -> V7 -> V8 over the full height, closed OUTSIDE
        # the wall (pushed FLOOR_OVERCUT past it, so no face is coplanar with the
        # box wall). Plank: the tangent slab, from LEB (top of the distributor)
        # up through the ceiling; above a typed generator height or the cone top
        # it simply ends as a free edge in the fluid.
        tongue_test = None
        if spiral is not None:
            def _abs(pt):
                return (target_x + pt[0], target_y + pt[1])
            _pts = sp_box["pts"]
            _out = -FLOOR_OVERCUT if SPIRAL_MIRROR_X else FLOOR_OVERCUT
            nose_poly = [_abs(_pts[k]) for k in ("V5", "V6", "V7", "V8")]
            nose_cut = nose_poly + [(nose_poly[3][0] + _out, nose_poly[3][1]),
                                    (nose_poly[0][0] + _out, nose_poly[0][1])]
            _z0, _z1 = -height / 2 - FLOOR_OVERCUT, height / 2 + FLOOR_OVERCUT
            nose = (cq.Workplane("XY", origin=(0, 0, _z0))
                    .polyline(nose_cut).close().extrude(_z1 - _z0))
            plank_rect = [_abs(p) for p in sp_rect]
            z_leb = z_last_base
            plank = (cq.Workplane("XY", origin=(0, 0, z_leb))
                     .polyline(plank_rect).close().extrude(_z1 - z_leb))
            result = result.cut(nose).cut(plank)
            tongue_test = spiral_tongue_test(nose_poly, plank_rect, z_leb)

        # --- split into patches --------------------------------------------
        faces = result.faces().vals()
        pocket_radius = max(rmax, foot_r_outer) + 0.1
        patches = classify(faces, BRepAdaptor_Surface, geomabs, variant, pocket_radius,
                           guide_vanes=guide_vanes, tongue_test=tongue_test)

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
                outlet_outer_d=num_opt("outletOuterD"), outlet_ratio=num_opt("outletRatio"),
                casing_overshoot=casing_overshoot, vane_count=vane_count)
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
                "The guide-vane distributor (blades + shroud)",
                "Increase B Kammer or Length, move the axis with B1 / LT, or "
                "lower Part scale or Guide vanes \u00d8.")
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
            if tongue_test is not None:
                emit_order.insert(3, "tongue")     # semi-spiral: after walls

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
            z_ledge = None            # WS-A v2 ledge height (set with the casing)
            _ledge_cut_prof = None    # fluid annulus under the ledge (clips the prisms)
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
                if runner_case_ledge:
                    # WS-A v2 ledge: the casing keeps r < d_first/2 from the duct
                    # bottom up to z_ledge, then the full annulus out to LE/2 (no
                    # overshoot here: _rout == LE/2) up to the shroud floor; the fluid
                    # wraps under the ledge. z_ledge = LEDGE_GAP under the brim, or
                    # under the shroud floor at the runner-case radius when that radius
                    # is still on the fillet (the floor there is below the brim).
                    _r_rc = d_first / 2.0
                    _floor_rc = float(np.interp(_r_rc, _sp[:, 0], _sp[:, 1]))
                    z_ledge = min(float(_sp[-1, 1]), _floor_rc) - LEDGE_GAP * part_scale
                    _cas_prof = ([(_rin, z_duct_bottom), (_r_rc, z_duct_bottom),
                                  (_r_rc, z_ledge), (_rout, z_ledge)]
                                 + [(float(r), float(z)) for r, z in _sp[::-1]]
                                 + [(_rin, z_duct_bottom)])
                    # The fluid annulus under the ledge, pushed 1 mm into the casing
                    # (inside and above) so clipping the vane prisms with it leaves
                    # no coincident face: blades whose outline passes over the
                    # runner-case radius must not hang down into it as pillars.
                    _ledge_cut_prof = [(_r_rc - 1e-3, z_duct_bottom - FLOOR_OVERCUT),
                                       (_rout + 0.05, z_duct_bottom - FLOOR_OVERCUT),
                                       (_rout + 0.05, z_ledge + 1e-3),
                                       (_r_rc - 1e-3, z_ledge + 1e-3),
                                       (_r_rc - 1e-3, z_duct_bottom - FLOOR_OVERCUT)]
                else:
                    _cas_prof = ([(_rin, z_duct_bottom), (_rout, z_duct_bottom)]
                                 + [(float(r), float(z)) for r, z in _sp[::-1]]
                                 + [(_rin, z_duct_bottom)])   # close the annular loop (first==last)
                _casing = _revolve_profile(np, trimesh, _densify(np, _cas_prof),
                                           target_x, target_y)
            elif runner_case_ledge:
                raise RuntimeError("the runner case ledge needs the analytic shroud profile")
            else:
                _casing = _shroud_casing_solid(np, trimesh, vane_patches["shroud"],
                                               target_x, target_y, d_last,
                                               overshoot=casing_overshoot)
            # Prisms span below the shroud floor (z_duct_bottom) up past the hub roof
            # (z_mid_top) so they fully pierce both; the portion below the floor sits
            # inside the casing (absorbed by the union) and the portion above the roof
            # inside the OCC upper cylinder (no fluid there), so only the passage span
            # shows as a vane.
            _prisms, _blade_outlines = _vane_prisms(np, trimesh,
                                                    vane_patches["guide_vanes"],
                                                    target_x, target_y, z_duct_bottom,
                                                    z_mid_top + 2.0 * FLOOR_OVERCUT)
            # Neighbouring blades must not touch (spec 2026-09-29-guide-vane-count,
            # R2), checked on the real outlines before the expensive union. It cannot
            # fire with the asset over 45..55 deg (smallest gap ~0.53 chord); it
            # guards a future angle range or asset.
            if len(_blade_outlines) != vane_count:
                raise RuntimeError("expected %d blade sections, found %d"
                                   % (vane_count, len(_blade_outlines)))
            # The blades must stay in the distributor passage, between the hub rim
            # and LE/2 (the shroud brim edge, where the runner case starts) (spec
            # 2026-09-29-guide-vane-count-any): a low count lengthens the chord
            # (x 16/n) until the tips cross LE/2. Measured on a real outline (every
            # blade is a rotation of it); the pivot-nearest one is the reference
            # blade, whose pivot _vane_count_fit rescales about.
            _piv = vane_patches["pivot"]
            _ref = min(_blade_outlines, key=lambda o: float(np.hypot(
                *(np.asarray(o, dtype=float).mean(axis=0) - np.asarray(_piv)))))
            _fits, _n_lo, _n_hi = _vane_count_fit(
                np, _ref, _piv, vane_count, target_x, target_y,
                vane_outlet_ri, d_last / 2.0)
            if not _fits:
                _X = np.asarray(_ref, dtype=float) - np.asarray(_ref, dtype=float).mean(axis=0)
                _chord = float(np.ptp(_X @ np.linalg.svd(_X, full_matrices=False)[2][0]))
                raise ValueError(
                    "With %d guide vanes the blades (chord %s) no longer fit between the "
                    "hub and the runner case edge. Use between %d and %d vanes for this "
                    "machine." % (vane_count, _mm(_chord), _n_lo, _n_hi))
            _gap = _min_blade_gap(_blade_outlines)
            if _gap < VANE_MIN_GAP:
                raise ValueError(
                    "Neighbouring guide vanes touch or overlap: with %d vanes at a Vane "
                    "angle of %g\u00b0, the closest gap between two blades is %s (at "
                    "least %s is needed). Increase the Vane angle%s."
                    % (vane_count, vane_angle, _mm(_gap), _mm(VANE_MIN_GAP),
                       " or set Guide vane count to 16" if vane_count != 16 else ""))
            if _ledge_cut_prof is not None:
                _ledge_cut = _revolve_profile(np, trimesh, _densify(np, _ledge_cut_prof),
                                              target_x, target_y)
                _prisms = [trimesh.boolean.difference([_p, _ledge_cut], engine="manifold")
                           for _p in _prisms]
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
            # cylinder_walls) and the distributor meshes (hub, shroud, outlet). F's
            # boundary coincides with these, so nearest-centroid gives a clean
            # re-split. The BLADES are deliberately NOT a source: they are assigned
            # exactly afterwards (_blade_skin_mask) — any mesh source for them is
            # sampled either sparser or denser than hub/shroud at the junctions,
            # and the vote then leaks skin onto the hub roof (sparser) or steals
            # shroud-floor rings around the blade roots (denser). Both happened.
            _sources = []
            for _nm in ("inlet", "walls", "cylinder_walls", "tongue"):
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
            # Deterministic labels at the runner-case / distributor junction (spec
            # 2026-09-29): nearest-source splits these between cylinder_walls, shroud
            # and walls when the ring is thin or the runner case is flush with LE.
            # _r_env = LE/2 (distributor envelope), _r_case = the effective runner case.
            _r_env = d_last / 2.0
            _r_case = d_first / 2.0
            _z_brim = float(vane_patches["shroud"].vertices[:, 2].max())
            _fz = _fc[:, 2]
            _vert = np.abs(_fnz) < 0.5
            _hor = np.abs(_fnz) > 0.9

            def _idx(nm):
                if nm not in _names:
                    _names.append(nm)
                return _names.index(nm)
            _cwi, _wli = _idx("cylinder_walls"), _idx("walls")
            _band = (_fz > _z_brim - 2e-3) & (_fz < z_mid_base + 2e-3)
            # the runner-case wall (vertical, below the ring top; below the ledge
            # when the runner case is smaller than LE)
            _who[_vert & (np.abs(_fr - _r_case) < 3e-3)
                 & (_fz < (z_ledge if runner_case_ledge else z_mid_base))] = _cwi
            if runner_case_ledge:
                # WS-A v2 (spec 2026-09-29-runner-case-below-le §4): the ledge
                # underside -> cylinder_walls, the band at LE/2 between the ledge
                # and the brim (the distributor casing) -> shroud.
                _who[_hor & (np.abs(_fz - z_ledge) < 2e-3)
                     & (_fr > _r_case - 1e-3) & (_fr < _r_env + 1e-3)] = _cwi
                _who[_vert & (np.abs(_fr - _r_env) < 3e-3)
                     & (_fz > z_ledge - 1e-3) & (_fz < _z_brim + 1e-3)] = _si
            # between the brim and the ring top: ring top -> cylinder_walls, brim -> shroud
            _who[_hor & _band & (_fr > _r_env + 1e-3) & (_fr < _r_case + 3e-3)] = _cwi
            _who[_hor & _band & (_fr > vane_outlet_ro + 3e-3) & (_fr < _r_env - 1e-3)] = _si
            # the small step at LE/2 between the brim and the ring top (casing edge);
            # a flush runner case has no ring, so no step
            if not runner_case_snapped:
                _who[_vert & (np.abs(_fr - _r_env) < 3e-3)
                     & (_fz > _z_brim - 1e-3) & (_fz < z_mid_base + 1e-3)] = _si
            # the box floor outside the outlet and the runner case
            _who[_hor & (np.abs(_fz - z_box_floor) < 2e-3)
                 & (_fr > max(vane_outlet_ro, _r_case) + 1e-3)] = _wli
            # Cone chamfer: its 45 deg foot face starts on the hub roof's outer
            # edge (LE Ø/2 at LEB), where nearest-source can hand its lowest
            # triangles to hub. The face is cylinder_walls (spec 2026-09-29-cone-
            # foot-chamfer): assign the sloped faces of that band exactly.
            if le_c:
                _slope = (np.abs(_fnz) > 0.5) & (np.abs(_fnz) < 0.9)
                _who[_slope & (_fr > _r_env - 2e-3) & (_fr < _r_env + le_c + 2e-3)
                     & (_fz > z_mid_top - 2e-3) & (_fz < z_mid_top + le_c + 2e-3)] = _cwi
            # The BLADE SKIN, assigned exactly (last, so no other override can
            # touch it): the prisms are strict vertical extrusions, so a wetted
            # face lies on a blade wall iff its centroid sits on a blade outline
            # in XY (within VANE_SKIN_TOL) AND the face is not horizontal — the
            # boolean fans thin hub-roof/shroud-floor slivers along each airfoil
            # hole rim whose centroids also fall inside the tolerance; those are
            # horizontal (the walls never are), so |nz| separates them exactly.
            # There is no other fluid at blade XY anywhere along z (casing below
            # the floor, hub core / upper cylinder above the roof), so no z
            # guard is needed.
            # Semi-spiral tongue (nose + plank), assigned by the exact footprint
            # rule of classify() (spec section 7) after every other override but
            # before the vane skin (still last). Candidates are pre-filtered on
            # |nz| and the footprint's bounding box.
            if tongue_test is not None:
                _ti = _idx("tongue")
                _fp = np.array(nose_poly + plank_rect)
                _lo, _hi = _fp.min(axis=0) - 1e-3, _fp.max(axis=0) + 1e-3
                _cand = np.where(_vert & (_fc[:, 0] >= _lo[0]) & (_fc[:, 0] <= _hi[0])
                                 & (_fc[:, 1] >= _lo[1]) & (_fc[:, 1] <= _hi[1]))[0]
                for _f in _cand:
                    if tongue_test(_fc[_f, 0], _fc[_f, 1], _fc[_f, 2], _fnz[_f]):
                        _who[_f] = _ti
            _names.append("guide_vanes")
            _skin = (_blade_skin_mask(np, _fc[:, :2], _blade_outlines, VANE_SKIN_TOL)
                     & (np.abs(_fnz) < 0.5))
            _who[_skin] = len(_names) - 1
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
                        float(fluid_F.volume), ledge_cut_prof=_ledge_cut_prof)
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
    except ValueError as exc:
        # Input refusals: already worded for the user (form names, mm, levers).
        sys.stderr.write("KO: %s\n" % exc)
        sys.exit(1)
    except Exception as exc:  # noqa: BLE001 - one-shot CLI, report and fail.
        # A geometry-kernel or internal failure: say so plainly, keep the raw
        # reason for whoever debugs it.
        sys.stderr.write(
            "KO: The geometry engine failed on these inputs (%s: %s). Try "
            "slightly different values; if it keeps failing, save the build "
            "and report it.\n" % (type(exc).__name__, exc))
        sys.exit(1)


if __name__ == "__main__":
    main()

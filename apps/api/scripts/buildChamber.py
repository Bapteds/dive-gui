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

PATCH_ORDER = ("inlet", "outlet", "cylinder_walls", "walls")
PATCH_TYPES = {
    "inlet": "patch",
    "outlet": "patch",
    "cylinder_walls": "wall",
    "walls": "wall",
    "guide_vane_walls": "wall",
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


def _annulus_walls(trimesh, np, r_in, r_out, z0, z1, seg=128):
    """Two coaxial straight cylinder side-walls (no caps) as one Trimesh: the
    outer + inner walls of a collar ring between z0 and z1 (built at origin)."""
    ang = np.linspace(0, 2 * np.pi, seg, endpoint=False)
    verts, faces = [], []
    for r in (r_out, r_in):
        base = len(verts)
        ring = [(r * np.cos(a), r * np.sin(a), z0) for a in ang] + \
               [(r * np.cos(a), r * np.sin(a), z1) for a in ang]
        verts.extend(ring)
        for i in range(seg):
            j = (i + 1) % seg
            faces.append([base + i, base + j, base + seg + j])
            faces.append([base + i, base + seg + j, base + seg + i])
    return trimesh.Trimesh(vertices=np.array(verts), faces=np.array(faces), process=False)


def _flat_annulus(trimesh, np, r_in, r_out, z, seg=128):
    """A flat annular ring at height z (the outlet cap face; built at origin)."""
    ang = np.linspace(0, 2 * np.pi, seg, endpoint=False)
    verts, faces = [], []
    for a in ang:
        verts.append((r_out * np.cos(a), r_out * np.sin(a), z))
        verts.append((r_in * np.cos(a), r_in * np.sin(a), z))
    for i in range(seg):
        j = (i + 1) % seg
        faces.append([2 * i, 2 * j, 2 * j + 1])
        faces.append([2 * i, 2 * j + 1, 2 * i + 1])
    return trimesh.Trimesh(vertices=np.array(verts), faces=np.array(faces), process=False)


def _clip_below(trimesh, mesh, z):
    """Return `mesh` with the part below z removed (planar cut, keep z >= plane).
    Dependency-free: trimesh.intersections.slice_faces_plane splits straddling
    triangles at the plane WITHOUT the shapely-backed capping of slice_plane()."""
    from trimesh.intersections import slice_faces_plane
    res = slice_faces_plane(mesh.vertices, mesh.faces,
                            plane_normal=[0, 0, 1], plane_origin=[0, 0, z])
    v, f = res[0], res[1]
    return trimesh.Trimesh(vertices=v, faces=f, process=False)


def _ring_radii(np, mesh, cx, cy, z0, z1):
    """Inner/outer radius of the passage cross-section in the z-band [z0, z1],
    about (cx, cy). Percentiles reject the decimated bottom's ragged stray verts."""
    v = mesh.vertices
    sel = (v[:, 2] >= z0) & (v[:, 2] <= z1)
    if sel.sum() < 16:
        sel = (v[:, 2] >= z0) & (v[:, 2] <= z0 + 3.0 * (z1 - z0))
    r = np.hypot(v[sel, 0] - cx, v[sel, 1] - cy)
    return float(np.percentile(r, 2)), float(np.percentile(r, 98))


def make_vane_patches(trimesh, np, cx, cy, z_mid_base, z_mid_top, d_last):
    """Return {patch_name: Trimesh} for the guide-vane throat: the SOLID vane
    surfaces (blades + hub/walls + a flat outlet cap) that sit as obstacles in the
    fluid box. Scaled to the middle band [z_mid_base, z_mid_top] and centred at
    (cx, cy).

    Uniform scale pins the blade PIVOT circle diameter (2 x pivotRadius) to the
    middle diameter (0.80 x d_last), preserving the blade angle and the passage
    contour. The passage TOP is pinned to z_mid_top; the bottom is clipped (ring
    taller than HLE) or extended with a straight collar (shorter) so the total
    height equals HLE. No bounding cylinder is used — the vanes are obstacles in
    the open box cavity, so the fluid flows directly around them."""
    import json
    adir = _vane_assets_dir()
    with open(os.path.join(adir, "guideVanes.json")) as fh:
        meta = json.load(fh)
    blade = trimesh.load(os.path.join(adir, "guideVanes_blade.stl"))
    walls = trimesh.load(os.path.join(adir, "guideVanes_walls.stl"))

    s = (RATIO_D_MIDDLE_OVER_LAST * d_last) / (2.0 * meta["pivotRadius"])  # pivot Ø -> 0.80 d_last
    nat_h = meta["height"] * s                      # scaled contoured height
    z_sb = z_mid_top - nat_h                         # scaled passage bottom (top pinned to z_mid_top)

    def place(mesh):
        m = mesh.copy()
        m.apply_scale(s)                            # uniform (all axes)
        m.apply_translation((cx, cy, z_sb))         # asset bottom (z=0) -> z_sb
        return m

    walls_m = place(walls)
    blades = []
    for k in range(int(meta["bladeCount"])):
        b = place(blade)
        ang = np.radians(k * meta["bladeAngleStepDeg"])
        R = np.array([[np.cos(ang), -np.sin(ang), 0, 0],
                      [np.sin(ang), np.cos(ang), 0, 0],
                      [0, 0, 1, 0], [0, 0, 0, 1]])
        b.apply_translation((-cx, -cy, 0))          # rotate about the ring axis (cx, cy)
        b.apply_transform(R)
        b.apply_translation((cx, cy, 0))
        blades.append(b)
    blades_m = trimesh.util.concatenate(blades)

    band = 0.03 * nat_h
    patches = {}
    if z_sb < z_mid_base - 1e-4:
        # taller than HLE -> clip everything below the middle-band base
        blades_min_z = float(blades_m.vertices[:, 2].min())
        walls_m = _clip_below(trimesh, walls_m, z_mid_base)
        blades_m = _clip_below(trimesh, blades_m, z_mid_base)
        if blades_min_z < z_mid_base - 1e-6:
            sys.stderr.write("WARN: guide-vane clip to HLE truncates the blades\n")
        z_out = z_mid_base
        r_in, r_out = _ring_radii(np, walls_m, cx, cy, z_out, z_out + band)
        patches["guide_vane_walls"] = walls_m
    elif z_sb > z_mid_base + 1e-4:
        # shorter than HLE -> straight collar from the band base up to z_sb
        r_in, r_out = _ring_radii(np, walls_m, cx, cy, z_sb, z_sb + band)
        collar = _annulus_walls(trimesh, np, r_in, r_out, z_mid_base, z_sb)
        collar.apply_translation((cx, cy, 0))
        patches["guide_vane_walls"] = trimesh.util.concatenate([walls_m, collar])
        z_out = z_mid_base
    else:
        z_out = z_sb
        r_in, r_out = _ring_radii(np, walls_m, cx, cy, z_sb, z_sb + band)
        patches["guide_vane_walls"] = walls_m
    outlet = _flat_annulus(trimesh, np, r_in, r_out, z_out)
    outlet.apply_translation((cx, cy, 0))
    patches["outlet"] = outlet
    patches["guide_vanes"] = blades_m
    return patches


# --- patch classification (ported from prepare_openfoam.py) -----------------
def _face_kind(f, adaptor, geomabs):
    s = adaptor(f.wrapped)
    t = s.GetType()
    if t == geomabs["plane"]:
        return "plane", None
    if t == geomabs["cyl"]:
        return "cyl", s.Cylinder().Radius()
    return "other", None


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

        # --- common validation ---------------------------------------------
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

        d_first = d_last * RATIO_D_FIRST_OVER_LAST
        d_middle = d_last * RATIO_D_MIDDLE_OVER_LAST

        # --- build the part (per variant) -----------------------------------
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
            h_last = num("hLast")
            if h_last <= 0:
                raise ValueError("hLast must be > 0")
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
        z_floor = -height / 2 - FLOOR_OVERCUT
        z_last_base = z_floor + h_first + h_middle
        feet, foot_r_outer = make_feet(
            cq, target_x, target_y, z_floor, z_last_base,
            d_last / 2, d_first, foot_angle_deg=foot_angle,
        )
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
            z_mid_top = z_floor + h_first + h_middle
            vane_patches = make_vane_patches(
                trimesh, np, target_x, target_y, z_mid_base, z_mid_top, d_last)
            # No BREP middle cylinder now, so there is no BREP outlet; the vane mesh
            # supplies it. Keep the remaining BREP walls; append the vane patches.
            patches["outlet"] = []
            emit_order = ["inlet", "cylinder_walls", "walls",
                          "guide_vane_walls", "outlet", "guide_vanes"]

        # --- GLB scene + manifest + edges ----------------------------------
        scene = trimesh.Scene()
        manifest = []
        edge_chunks = []
        total_edge_verts = 0
        patch_meshes = {}

        for name in emit_order:
            if name in vane_patches:
                # mesh patch (guide vanes): already a Trimesh, no CAD edges.
                tri = vane_patches[name]
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

        # exports: whole solid STL + STEP
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

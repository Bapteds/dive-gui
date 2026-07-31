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
FOOT_PLANK_DROP = 0.01       # leg extends this far above z_top to key into the plank
FOOT_CLEARANCE = 0.02        # radial gap the leg keeps from the first cylinder (any angle)
FOOT_ANGLE_DEG = 0.0         # default leg orientation (0/180 = tangential, 90 = radial)
FOOT_ANGLES_DEG = (0, 90, 180, 270)     # azimuth positions (aligned with the inlet axes)

PATCH_ORDER = ("inlet", "outlet", "cylinder_walls", "walls")
PATCH_TYPES = {
    "inlet": "patch",
    "outlet": "patch",
    "cylinder_walls": "wall",
    "walls": "wall",
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


def make_part(cq, d_first, h_first, d_middle, h_middle, d_last, h_last):
    """Three coaxial cylinders stacked along +Z, base of the FIRST at z = 0
    (the 'stepped' variant)."""
    part = cq.Workplane("XY").circle(d_first / 2).extrude(h_first)
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
                     wall, hollow_len, c_dia, c_h, dome_h):
    """The 'hollow' variant (base of the FIRST at z = 0), a union of:
      * first + middle SOLID cylinders (as in 'stepped'),
      * the LAST cylinder as an open-top hollow shell (outer d_last, wall
        thickness `wall`) of height `hollow_len`,
      * a central cylinder (dia c_dia, height c_h) rising coaxially from the top
        of the middle cylinder, capped by an oval dome of height dome_h.
    The whole union is later SUBTRACTED from the block, so every surface here is
    carved out (walls included)."""
    z_mid_top = h_first + h_middle
    part = cq.Workplane("XY").circle(d_first / 2).extrude(h_first)
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
              plank_overlap=FOOT_PLANK_OVERLAP, plank_drop=FOOT_PLANK_DROP,
              clear=FOOT_CLEARANCE, angles=FOOT_ANGLES_DEG):
    """Four torque-foot VOIDS spaced at `angles` (0/90/180/270). Each LEG is a
    pointed-hexagon TOP-DOWN footprint (max width `width`, a sharp tip and a blunt
    45 deg-chamfered end) extruded VERTICALLY from the floor (z0) up to the BASE of
    the last/hollow cylinder (z_top). Its inner tip anchors just outside the first
    cylinder (radial gap `clear`). `foot_angle_deg` swings the leg about the
    vertical line through that tip: 0 deg = TANGENTIAL one way, 90 deg = RADIAL
    (tip pointing at the axis), 180 deg = TANGENTIAL the other way. A horizontal PLANK
    then sits ON TOP of the leg with its bottom flush on the cylinder base z_top
    (no thin ledge under the cylinder), bridging radially from the last-cylinder
    wall (radius r_cyl, overlapping it by `plank_overlap`) out to the leg tip; the
    leg is extruded `plank_drop` above z_top to key into it. Returns (feet_union,
    r_outer) centred at the part axis (cx, cy); r_outer bounds the foot footprint
    at every angle and feeds the patch classifier."""
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
    # Extrude the leg slightly ABOVE z_top (by plank_drop) so it keys into the
    # plank from below; the plank's own bottom stays flush with the cylinder base.
    leg = cq.Workplane("XY", origin=(0, 0, z0)).polyline(plan).close().extrude((z_top + plank_drop) - z0)
    # The unrotated plan lies RADIAL (long axis along +X). Swing it (angle - 90)
    # about the vertical axis through the inner tip: 0 deg -> tangential one way,
    # 90 deg -> radial, 180 deg -> tangential the other way.
    leg = leg.rotate((r_in, 0, 0), (r_in, 0, 1), foot_angle_deg - 90.0)
    # horizontal plank ON TOP of the leg: a slab from the last-cylinder wall
    # (overlapping it) out to the leg tip. Its BOTTOM sits exactly on the cylinder
    # base (z_top) so it never dips under the cylinder (no thin sub-shoulder ledge
    # -> CFD-friendly); the leg overlaps it from below for a clean union.
    plank_r0 = r_cyl - plank_overlap
    plank_r1 = r_in + taper
    plank = (
        cq.Workplane("XY")
        .box(plank_r1 - plank_r0, width, plank_thick)
        .translate(((plank_r0 + plank_r1) / 2, 0, z_top + plank_thick / 2))
    )
    foot0 = leg.union(plank)
    feet = None
    for a in angles:
        f = foot0.rotate((0, 0, 0), (0, 0, 1), a)
        feet = f if feet is None else feet.union(f)
    return feet.translate((cx, cy, 0)), r_outer


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


def classify(faces, adaptor, geomabs, variant, pocket_radius):
    """Return {patch: [face,...]} for inlet / outlet / cylinder_walls / walls.
    A face is a pocket (cavity/feet) surface when its vertices lie within
    `pocket_radius` of the part axis; box faces reach far beyond it."""
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
    if len(cyls) < 3:
        raise RuntimeError("expected >=3 cylindrical faces, found %d" % len(cyls))

    ax = sum(c[3] for c in cyls) / len(cyls)
    ay = sum(c[4] for c in cyls) / len(cyls)

    pocket = [f for f in faces
              if id(f) != id(inlet) and _horiz_extent(f, ax, ay) <= pocket_radius]
    pocket_ids = {id(p) for p in pocket}

    if variant == "hollow":
        # The hollow variant has many carved surfaces (tube inner/outer walls,
        # central cylinder, dome, shoulders) and no single flow 'outlet'; group
        # every pocket surface as cylinder_walls.
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
                                    wall, hollow_len, c_dia, c_h, dome_h)
            part_height = h_first + h_middle + max(hollow_len, c_h + dome_h)
            rmax = max(d_first, d_middle, d_last) / 2
        else:
            h_last = num("hLast")
            if h_last <= 0:
                raise ValueError("hLast must be > 0")
            part = make_part(cq, d_first, h_first, d_middle, h_middle, d_last, h_last)
            part_height = h_first + h_middle + h_last
            rmax = max(d_first, d_middle, d_last) / 2

        if part_height > height:
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
        patches = classify(faces, BRepAdaptor_Surface, geomabs, variant, pocket_radius)

        # --- GLB scene + manifest + edges ----------------------------------
        scene = trimesh.Scene()
        manifest = []
        edge_chunks = []
        total_edge_verts = 0
        patch_meshes = {}

        for name in PATCH_ORDER:
            fs = patches[name]
            tri = patch_trimesh(trimesh, np, fs)
            if tri is None:
                continue
            patch_meshes[name] = tri
            scene.add_geometry(tri, node_name=name, geom_name=name)

            edge_verts = patch_edges(np, BRepAdaptor_Curve, GeomAbs_Line, fs)
            edge_count = int(edge_verts.shape[0])
            manifest.append({
                "name": name,
                "type": PATCH_TYPES[name],
                "nFaces": len(fs),                 # CAD face count for this patch
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
            for name in PATCH_ORDER:
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

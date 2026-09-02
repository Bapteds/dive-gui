"""End-to-end tests for scripts/buildChamber.py with the REAL CadQuery kernel.

Each fixture in params/ is a proven production configuration (copied from real
cached builds); the suite runs the builder exactly as the API does and asserts
the guarantees the app relies on: exit contract (OK:/KO:), watertight STL,
expected named patches, export artifacts, the stepHasVanes meta flag, the feet
on/off volume delta, the hollow fit-to-box clamp, and the stepped overflow
refusal.

Golden volumes are tied to the PINNED environment (requirements-geometry.txt):
a cadquery/OCP upgrade can legitimately shift tessellated volumes, in which
case refresh the goldens here in the same commit that bumps the pin.
"""

import importlib.util
import io
import json
import os
import subprocess
import sys
import zipfile

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))

# Tessellated volume tolerance. Tight enough to catch a real geometry change
# (the feet alone are ~0.24% of the solid), loose enough to survive tiny
# floating-point drift within the pinned kernel.
VOL_RTOL = 5e-3

# name -> (golden volume m^3, expected patch names in manifest order)
STEPPED_PATCHES = ("inlet", "outlet", "cylinder_walls", "walls")
VANE_PATCHES = ("inlet", "cylinder_walls", "walls", "hub", "shroud", "outlet", "guide_vanes")
GOLDEN = {
    "stepped": (131.227524, STEPPED_PATCHES),
    "stepped-feet-off": (131.545008, STEPPED_PATCHES),
    "stepped-vanes": (135.469749, VANE_PATCHES),
    "hollow-vanes": (153.090155, VANE_PATCHES),
}
WALL_TYPES = {"cylinder_walls", "walls", "hub", "shroud", "guide_vanes"}


def _zip_names(result):
    with zipfile.ZipFile(result.export_path("trisurface.zip")) as zf:
        return sorted(zf.namelist())


def _tmp_leftovers(out_dir):
    """Any *.tmp files left under the build dir (artifacts are written to tmp
    names and atomically renamed; a clean run must leave none behind)."""
    leftovers = []
    for root, _dirs, files in os.walk(out_dir):
        leftovers += [os.path.join(root, f) for f in files if f.endswith(".tmp")]
    return leftovers


@pytest.mark.parametrize("name", list(GOLDEN))
def test_build_succeeds_watertight_with_expected_patches(build, name):
    result = build(name)
    assert result.exit_code == 0, f"builder failed:\n{result.stderr}"
    # Informational WARNINGs may precede it, but a successful run always ENDS
    # with the OK: line (the success contract the API relies on).
    assert result.stdout.strip().splitlines()[-1].startswith("OK:"), result.stdout

    # The combined solid the mesher consumes must be one closed volume.
    stl = result.load_stl()
    assert stl.is_watertight, f"{name}: chamber.stl is not watertight"

    golden_volume, patch_names = GOLDEN[name]
    assert stl.volume == pytest.approx(golden_volume, rel=VOL_RTOL)

    manifest = result.manifest
    assert tuple(p["name"] for p in manifest) == patch_names
    for patch in manifest:
        expected_type = "wall" if patch["name"] in WALL_TYPES else "patch"
        assert patch["type"] == expected_type, patch
        assert patch["nFaces"] > 0, patch

    # Every patch ships as its own STL in the trisurface zip, plus the combined
    # domain.stl the meshing import consumes.
    assert _zip_names(result) == sorted([f"{p}.stl" for p in patch_names] + ["domain.stl"])


@pytest.mark.parametrize("name", list(GOLDEN))
def test_build_writes_viewer_and_cad_exports(build, name):
    import os

    result = build(name)
    assert result.exit_code == 0
    for rel in ("chamber.glb", "manifest.json"):
        path = os.path.join(result.out_dir, rel)
        assert os.path.getsize(path) > 0, f"{name}: {rel} missing or empty"
    # Feature edges only exist for BREP-tessellated (non-vane) builds; the
    # mesh-based vane pipeline writes an empty edges.bin (edgeCount 0).
    edges_size = os.path.getsize(os.path.join(result.out_dir, "edges.bin"))
    if "vanes" in name:
        assert edges_size == 0, f"{name}: expected an empty edges.bin, got {edges_size} bytes"
    else:
        assert edges_size > 0, f"{name}: edges.bin is empty"
    assert os.path.getsize(result.export_path("chamber.stl")) > 0
    # The STEP is deferred for guide-vane builds (the carve + gate is ~2/3 of
    # the build): a plain vane build ships neither chamber.step nor
    # build-meta.json — the API regenerates with --step on first download.
    if "vanes" in name:
        assert not os.path.exists(result.export_path("chamber.step")), name
        assert result.build_meta is None, name
    else:
        assert os.path.getsize(result.export_path("chamber.step")) > 0
    # Atomic-write discipline: a successful build promotes every artifact and
    # leaves no tmp files behind (the GLB is renamed last as the cache marker).
    assert _tmp_leftovers(result.out_dir) == [], name


def test_feet_toggle_carves_the_foot_voids(build):
    """Feet OFF must give back exactly the foot volume (legs + planks are one
    solid), so the feet-off solid is slightly LARGER than the feet-on one."""
    feet_on = build("stepped").load_stl()
    feet_off = build("stepped-feet-off").load_stl()
    delta = feet_off.volume - feet_on.volume
    golden_delta = GOLDEN["stepped-feet-off"][0] - GOLDEN["stepped"][0]
    assert delta == pytest.approx(golden_delta, rel=0.05)


def test_step_export_vane_policy(build):
    """A --step guide-vane build ships editable BREP vanes in the STEP. (Hollow
    used to fall back vane-less: its OCC boolean self-overlapped at the blunt
    TE corners; the tangent TE rounding fixed the overlap, so both variants now
    pass the round-trip volume gate.)"""
    for name in ("stepped-vanes", "hollow-vanes"):
        result = build(name, step=True)
        assert result.exit_code == 0, result.stderr
        assert os.path.getsize(result.export_path("chamber.step")) > 0, name
        assert result.build_meta == {"stepHasVanes": True}, name
        assert "falls back to the vane-less solid" not in result.stderr, name
        assert _tmp_leftovers(result.out_dir) == [], name


def test_hollow_overflow_is_refused(build):
    """A hollow stack taller than H Kammer fails the build (KO) with the exact
    Part scale that would fit — it is never silently scaled down (spec
    2026-08-31; the fixture itself now ships partScale 0.7944 so it fits)."""
    result = build("hollow-vanes", params_override={"partScale": 1})
    assert result.exit_code == 1
    assert "KO:" in result.stderr
    assert "H Kammer only allows" in result.stderr
    assert "reduce Part scale to <= 0.79" in result.stderr


def _section_loop_count(stl, z):
    """Closed loops of the solid's horizontal cross-section at height z (m)."""
    section = stl.section(plane_origin=(0.0, 0.0, z), plane_normal=(0.0, 0.0, 1.0))
    assert section is not None, f"no cross-section at z={z}"
    return len(section.discrete)


def test_simplify_generator_pierces_the_box_top_without_a_dome(build):
    """Simplify Generator: the central cylinder is pinned THROUGH the box top
    (stepped-style) and no dome is built. Proof by cross-section just below the
    top face: the flag-on solid shows TWO loops (box outline + generator bore),
    while the flag-off solid at the same partScale shows ONE (solid ceiling —
    the domed stack ends well below the top at this scale)."""
    # partScale 0.7: the domed stack (3.398 m unscaled) stays under H Kammer
    # (2.38 < 2.7) so the flag-off ceiling is solid; the cone stack obviously
    # fits too, so the flag-on build succeeds without touching the fixture.
    z_top_slice = 2.7 / 2 - 0.001  # box spans -height/2..+height/2
    simplified = build("hollow-vanes",
                       params_override={"partScale": 0.7, "simplifyGenerator": True})
    assert simplified.exit_code == 0, simplified.stderr
    domed = build("hollow-vanes", params_override={"partScale": 0.7})
    assert domed.exit_code == 0, domed.stderr

    stl_simplified = simplified.load_stl()
    assert stl_simplified.is_watertight
    assert _section_loop_count(stl_simplified, z_top_slice) == 2
    assert _section_loop_count(domed.load_stl(), z_top_slice) == 1

    # Same patch contract as every hollow vane build.
    assert tuple(p["name"] for p in simplified.manifest) == VANE_PATCHES
    assert _tmp_leftovers(simplified.out_dir) == []


def test_simplify_generator_overflow_names_the_cone_stack(build):
    """With Simplify Generator the fit check considers only first+middle+cone
    (the generator fits by construction) — an overgrown cone is refused with
    cone-stack wording, not the generator+dome message."""
    result = build("hollow-vanes", params_override={
        "partScale": 1, "simplifyGenerator": True, "hollowLength": 2.0,
    })
    assert result.exit_code == 1
    assert "KO:" in result.stderr
    assert "hollow cone stack" in result.stderr
    assert "H Kammer only allows" in result.stderr
    assert "generator + dome" not in result.stderr


def test_part_wider_than_box_is_refused(build):
    """A part whose radius does not clear every box wall from its axis fails the
    build (KO) instead of silently cutting through the side wall."""
    result = build("stepped", params_override={"dFirst": 8.0})
    assert result.exit_code == 1
    assert "KO:" in result.stderr
    assert "stick out of the box" in result.stderr
    assert "reduce Part scale / the diameter overrides" in result.stderr


def test_feet_outside_the_box_are_refused(build):
    """The torque feet reach further out than the cylinders, so a part whose
    cylinders fit can still have a foot poking through a wall — that too fails
    the build (KO), checked on the exact swung foot footprint. Here the box is
    widened so the cylinders clear every wall (radius 3.19 m vs 3.5 m gaps) but
    the feet (reaching ~4.2 m) cannot."""
    result = build("stepped", params_override={
        "partScale": 2.3, "width": 7.0, "length": 14.0, "height": 4.0,
        "distFromSideChamfer1": 3.5, "distFromEnd": 7.0,
    })
    assert result.exit_code == 1
    assert "KO:" in result.stderr
    assert "a torque foot reaches" in result.stderr
    # Same params with the feet disabled must build fine (the cylinders fit).
    ok = build("stepped", params_override={
        "partScale": 2.3, "width": 7.0, "length": 14.0, "height": 4.0,
        "distFromSideChamfer1": 3.5, "distFromEnd": 7.0, "feetEnabled": False,
    })
    assert ok.exit_code == 0, ok.stderr


def test_zero_chamfer_setback_is_refused(build):
    """A zero (or negative) chamfer setback used to make a degenerate zero-area
    prism deep inside OCC; now it is refused up front with the lever."""
    result = build("stepped", params_override={"chamferWidth1": 0.0})
    assert result.exit_code == 1
    assert "KO:" in result.stderr
    assert "chamfer 1 (LF1/BF1) setbacks must be > 0" in result.stderr


def test_axis_inside_chamfer_corner_is_refused(build):
    """Chamfers big enough to swallow the part axis evaded every fit check (the
    circle-vs-triangle test measures edge distance, valid only for an axis
    OUTSIDE the triangle). B1 1.5 / LT 3.0 inside a 4.0 x 8.0 corner cut
    (1.5/4 + 3/8 = 0.75 < 1) must refuse, not build inside removed space."""
    result = build("stepped", params_override={
        "chamferLength1": 8.0, "chamferWidth1": 4.0,
        "distFromSideChamfer1": 1.5, "distFromEnd": 3.0,
    })
    assert result.exit_code == 1
    assert "KO:" in result.stderr
    assert "lies inside" in result.stderr
    assert "corner cut" in result.stderr


def test_vane_distributor_outside_box_is_refused(build):
    """The guide-vane distributor reaches ~1.25 x the ring radius — further
    than any cylinder. Cylinders fit here (radius 3.25 m vs 3.5 m gaps) but a
    dMiddle of 6.5 m puts the blade tips at ~4.07 m: the exact mesh-reach
    check must refuse instead of carving blade holes through the box wall."""
    result = build("stepped-vanes", params_override={
        "dFirst": 6.0, "dMiddle": 6.5, "width": 7.0, "length": 14.0,
        "height": 4.0, "distFromSideChamfer1": 3.5, "distFromEnd": 7.0,
        "feetEnabled": False,
    })
    assert result.exit_code == 1
    assert "KO:" in result.stderr
    assert "guide-vane distributor" in result.stderr
    assert "Guide vanes" in result.stderr


def test_stepped_overflow_is_refused(build):
    """A stepped part that cannot fit H Kammer must fail the build (KO:) with an
    actionable message - never silently shrink the part."""
    result = build("stepped", params_override={"partScale": 5})
    assert result.exit_code == 1
    assert "KO:" in result.stderr
    assert "H Kammer only allows" in result.stderr
    assert "reduce Part scale" in result.stderr


# --- guide-vane trailing-edge rounding ---------------------------------------
# The CAD blade has a BLUNT trailing edge (a flat base with two sharp corners);
# the builder rounds it with a tangent arc so the mesher never sees the corners
# (spec 2026-08-31). Unit-tested on the committed clean airfoil and end-to-end
# on a built vane section.


def _builder_module():
    """Import buildChamber.py as a module (its heavy deps load inside main())."""
    spec = importlib.util.spec_from_file_location(
        "buildChamber", os.path.join(HERE, "..", "buildChamber.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _committed_airfoil(np):
    path = os.path.join(HERE, "..", "assets", "guideVanes_blade_profile.json")
    with open(path) as fh:
        return np.asarray(json.load(fh)["airfoil"], dtype=float)


def _chord_axis(np, loop):
    """(chord length, unit chord direction, per-point chordwise coord t)."""
    X = loop - loop.mean(axis=0)
    _u, _s, vt = np.linalg.svd(X, full_matrices=False)
    t = X @ vt[0]
    return float(np.ptp(t)), vt[0], t


def _fit_circle(np, pts):
    """Least-squares circle through pts (M,2) -> (radius, max residual)."""
    A = np.column_stack([2.0 * pts, np.ones(len(pts))])
    b = (pts ** 2).sum(axis=1)
    sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    ctr = sol[:2]
    radius = float(np.sqrt(sol[2] + ctr @ ctr))
    res = float(np.abs(np.hypot(*(pts - ctr).T) - radius).max())
    return radius, res


def _poly_area(np, loop):
    x, y = loop[:, 0], loop[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def test_round_blade_te_replaces_the_blunt_base_with_a_tangent_arc():
    import numpy as np
    from shapely.geometry import Point, Polygon

    bc = _builder_module()
    P = _committed_airfoil(np)
    Q = bc._round_blade_te(np, P)

    chord, _dir, t = _chord_axis(np, P)
    r_exp = bc.VANE_TE_ROUND_R_FRAC * chord
    # The blunt base = the two chordwise-extreme points (the sharp TE corners).
    corners = P[np.argsort(t)[-2:]]
    base_mid = corners.mean(axis=0)

    # Area is preserved (the corners are tiny) and the airfoil away from the TE
    # is untouched (LE radius ~6x the arc radius, so the opening restores it).
    assert _poly_area(np, Q) == pytest.approx(_poly_area(np, P), rel=0.01)
    src = Polygon(P)
    far = Q[np.hypot(*(Q - base_mid).T) > 3.0 * r_exp]
    assert max(src.exterior.distance(Point(p)) for p in far) < 5e-4

    # Both sharp corners are trimmed away...
    rounded = Polygon(Q)
    assert all(rounded.exterior.distance(Point(c)) > 3e-4 for c in corners)
    # ...and replaced by an arc of the expected radius (a circle fits the new
    # points around the old base with a tiny residual).
    arc = Q[np.hypot(*(Q - base_mid).T) < 1.2 * r_exp]
    assert len(arc) >= 8
    radius, res = _fit_circle(np, arc)
    assert radius == pytest.approx(r_exp, rel=0.25)
    assert res < 1e-4

    # Rounding an already-round loop is (nearly) a no-op.
    Q2 = bc._round_blade_te(np, Q)
    assert _poly_area(np, Q2) == pytest.approx(_poly_area(np, Q), rel=0.002)


def test_round_blade_te_returns_the_input_on_degenerate_loops():
    import numpy as np

    bc = _builder_module()
    line = np.array([[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]])  # zero-area "loop"
    assert bc._round_blade_te(np, line) is line


def test_built_vane_sections_have_a_round_trailing_edge(build):
    """End-to-end: a mid-height section of a built vane (from the trisurface
    the mesher consumes) ends in a circular arc of the expected radius instead
    of the blunt CAD base."""
    import numpy as np
    import trimesh

    bc = _builder_module()
    result = build("stepped-vanes")
    assert result.exit_code == 0
    with zipfile.ZipFile(result.export_path("trisurface.zip")) as zf:
        data = zf.read("guide_vanes.stl")
    vanes = trimesh.load(io.BytesIO(data), file_type="stl")
    blade = max(vanes.split(only_watertight=False), key=lambda b: len(b.faces))
    z = blade.vertices[:, 2]
    sec = blade.section(plane_origin=[0.0, 0.0, 0.5 * (z.min() + z.max())],
                        plane_normal=[0.0, 0.0, 1.0])
    loop = np.asarray(max(sec.discrete, key=len), dtype=float)[:, :2]

    chord, _dir, t = _chord_axis(np, loop)
    r_exp = bc.VANE_TE_ROUND_R_FRAC * chord
    fits = []
    for tip in (loop[np.argmax(t)], loop[np.argmin(t)]):
        near = loop[np.hypot(*(loop - tip).T) < 1.2 * r_exp]
        if len(near) >= 6:
            fits.append(_fit_circle(np, near))
    assert any(abs(radius - r_exp) < 0.3 * r_exp and res < 1e-4
               for radius, res in fits), \
        f"no rounded trailing edge on the built vane section (fits: {fits})"


# --- mirrored STEP ("Change rotational direction") ----------------------------
# scripts/mirrorStep.py flips a built STEP on the z-y plane while keeping the
# original bounding box (spec 2026-09-01): the API runs it on demand for
# guide-vane builds whose STEP carries the real vanes (stepHasVanes true).

MIRROR_SCRIPT = os.path.join(HERE, "..", "mirrorStep.py")
MIRROR_TIMEOUT_S = 600


def test_mirror_step_flips_handedness_in_place(build, tmp_path):
    """The mirrored STEP has the same solids, volume and bounding box as the
    original, with the centroid reflected about the box's x-centre — the
    geometry stays in place, only the rotational direction flips.

    All comparisons run on TESSELLATED meshes (trimesh), not BRepGProp: OCC's
    analytic mass properties are unreliable on mirrored ("indirect") surface
    parametrizations (+0.1% phantom volume on this model), while the actual
    geometry — verified by identical watertight tessellations — is exact."""
    import cadquery as cq
    import trimesh

    result = build("stepped-vanes", step=True)
    assert result.build_meta == {"stepHasVanes": True}
    src = result.export_path("chamber.step")
    dst = str(tmp_path / "chamber-mirrored.step")

    proc = subprocess.run([sys.executable, MIRROR_SCRIPT, src, dst],
                          capture_output=True, text=True, timeout=MIRROR_TIMEOUT_S)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip().startswith("OK:"), proc.stdout
    assert os.path.getsize(dst) > 0

    def _mesh(step_path, stl_name):
        wp = cq.importers.importStep(step_path)
        assert len(wp.vals()) == 1, step_path
        stl = str(tmp_path / stl_name)
        cq.exporters.export(wp, stl, exportType="STL", tolerance=1e-3)
        return trimesh.load(stl)

    orig = _mesh(src, "orig.stl")
    mirr = _mesh(dst, "mirr.stl")
    assert orig.is_watertight and mirr.is_watertight
    assert mirr.volume == pytest.approx(orig.volume, rel=1e-3)

    # Same bounding box: the mirror is translated back onto the original spot.
    (lo_o, hi_o), (lo_m, hi_m) = orig.bounds, mirr.bounds
    for o, m in zip(list(lo_o) + list(hi_o), list(lo_m) + list(hi_m)):
        assert m == pytest.approx(o, abs=1e-3)

    # Centroid reflected about the box's x-centre, y/z unchanged. The build is
    # x-asymmetric (part axis at B1, not centred), so this is a REAL constraint
    # a no-op copy could not satisfy.
    x_centre = 0.5 * (lo_o[0] + hi_o[0])
    cx_o, cy_o, cz_o = orig.center_mass
    cx_m, cy_m, cz_m = mirr.center_mass
    assert abs(cx_o - x_centre) > 5e-3
    assert cx_m == pytest.approx(2.0 * x_centre - cx_o, abs=1e-3)
    assert cy_m == pytest.approx(cy_o, abs=1e-3)
    assert cz_m == pytest.approx(cz_o, abs=1e-3)


def test_mirror_step_refuses_a_missing_input(tmp_path):
    """A bad input follows the builder's exit contract (KO:/1) and leaves no
    output file behind (the atomic tmp+rename never lands)."""
    dst = tmp_path / "out.step"
    proc = subprocess.run(
        [sys.executable, MIRROR_SCRIPT, str(tmp_path / "nope.step"), str(dst)],
        capture_output=True, text=True, timeout=MIRROR_TIMEOUT_S)
    assert proc.returncode == 1
    assert "KO:" in proc.stderr
    assert not dst.exists()

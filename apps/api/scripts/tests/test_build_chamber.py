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
# Semi-spiral casing (spec 2026-09-29-semi-spiral-casing): `tongue` (nose + plank)
# follows walls on both paths.
SPIRAL_PATCHES = ("inlet", "outlet", "cylinder_walls", "walls", "tongue")
SPIRAL_VANE_PATCHES = ("inlet", "cylinder_walls", "walls", "tongue", "hub", "shroud", "outlet",
                       "guide_vanes")
GOLDEN = {
    "stepped": (131.227524, STEPPED_PATCHES),
    "stepped-feet-off": (131.545008, STEPPED_PATCHES),
    "stepped-vanes": (135.469749, VANE_PATCHES),
    "hollow-vanes": (153.090155, VANE_PATCHES),
    # Real cached build (feet off, dFirst/dMiddle overrides, partScale 1) whose
    # passage proportions reproduced the blade-skin/hub classification tie.
    "hollow-vanes-overrides": (167.700993, VANE_PATCHES),
    # stepped-vanes with 18 guide vanes (chord x 16/18 about the pivot, spec
    # 2026-09-29-guide-vane-count): the blades' total section drops by 16/18.
    "stepped-vanes-18": (135.495642, VANE_PATCHES),
    # Semi-spiral casing, frozen vertices in params.spiral (computed 2026-09-29
    # with the reference tool, Q = 8 m3/s, 0.922 m/s): copies of stepped-vanes /
    # hollow-vanes with Feet off and the spiral on (the API leaves the box keys out).
    "stepped-spiral": (51.657323, SPIRAL_VANE_PATCHES),
    "hollow-vanes-spiral": (47.762966, SPIRAL_VANE_PATCHES),
}
WALL_TYPES = {"cylinder_walls", "walls", "hub", "shroud", "guide_vanes", "tongue"}


def _is_vane_build(name):
    with open(os.path.join(HERE, "params", f"{name}.json")) as fh:
        return bool(json.load(fh).get("guideVanes", False))


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
    if _is_vane_build(name):
        assert edges_size == 0, f"{name}: expected an empty edges.bin, got {edges_size} bytes"
    else:
        assert edges_size > 0, f"{name}: edges.bin is empty"
    assert os.path.getsize(result.export_path("chamber.stl")) > 0
    # The STEP is deferred for guide-vane builds (the carve + gate is ~2/3 of
    # the build): a plain vane build ships neither chamber.step nor
    # build-meta.json — the API regenerates with --step on first download.
    if _is_vane_build(name):
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
    for name in ("stepped-vanes", "hollow-vanes", "stepped-vanes-18", "stepped-spiral"):
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
    assert "but H Kammer is only" in result.stderr
    assert "Set Part scale to 0.79 or less" in result.stderr


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
    # centralHeight/domeHeight None: the API omits them in Simplify unless typed.
    simplified = build("hollow-vanes",
                       params_override={"partScale": 0.7, "simplifyGenerator": True,
                                        "centralHeight": None, "domeHeight": None})
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
        "centralHeight": None, "domeHeight": None,
    })
    assert result.exit_code == 1
    assert "KO:" in result.stderr
    assert "The cone does not fit under the chamber top" in result.stderr
    assert "but H Kammer is only" in result.stderr
    assert "Dome height" not in result.stderr


def test_closed_generator_height_closes_the_last_cylinder(build):
    """A typed generator height (Closed generator) turns the last cylinder into
    a flat-topped cylinder under the box top: the slice just below the top is
    one loop (solid ceiling) instead of two (box + generator bore), and the
    fluid gains the volume above the generator."""
    z_top_slice = 3.9536807404765995 / 2 - 0.001
    pinned = build("stepped")
    closed = build("stepped", params_override={"centralHeight": 1.5})
    assert closed.exit_code == 0, closed.stderr
    stl = closed.load_stl()
    assert stl.is_watertight
    assert _section_loop_count(pinned.load_stl(), z_top_slice) == 2
    assert _section_loop_count(stl, z_top_slice) == 1
    assert stl.volume > pinned.load_stl().volume
    assert tuple(p["name"] for p in closed.manifest) == STEPPED_PATCHES


def test_closed_generator_reaching_the_top_is_pinned(build):
    """A generator height that reaches the box top builds exactly like a blank
    one (pinned through the top, no sliver of fluid above it)."""
    pinned = build("stepped")
    # H Kammer - LEB of the fixture (its own LEOW): the top lands on the box top.
    to_top = build("stepped", params_override={"centralHeight": 2.7143476996499993})
    assert to_top.exit_code == 0, to_top.stderr
    assert to_top.load_stl().volume == pytest.approx(pinned.load_stl().volume, rel=1e-6)


def test_closed_generator_taller_than_the_box_is_refused(build):
    result = build("stepped", params_override={"centralHeight": 5.0})
    assert result.exit_code == 1
    assert "The generator does not fit under the chamber top" in result.stderr
    assert "but H Kammer is only" in result.stderr


def test_simplify_generator_with_a_height_is_closed(build):
    """Simplify Generator + a typed height: no dome, and the generator stops
    below the box top (solid ceiling) instead of piercing it."""
    z_top_slice = 2.7 / 2 - 0.001
    closed = build("hollow-vanes", params_override={
        "partScale": 0.7, "simplifyGenerator": True, "centralHeight": 1.0,
        "domeHeight": None})
    assert closed.exit_code == 0, closed.stderr
    stl = closed.load_stl()
    assert stl.is_watertight
    assert _section_loop_count(stl, z_top_slice) == 1


def test_part_wider_than_box_is_refused(build):
    """A part whose radius does not clear every box wall from its axis fails the
    build (KO) instead of silently cutting through the side wall."""
    result = build("stepped", params_override={"dFirst": 8.0})
    assert result.exit_code == 1
    assert "KO:" in result.stderr
    assert "would stick out of the chamber" in result.stderr
    assert "Runner case Ø or Guide vanes Ø" in result.stderr


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
    assert "A torque foot would stick out of the chamber" in result.stderr
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
    assert "Corner chamfer 1 needs LF1 and BF1 greater than 0 mm" in result.stderr


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
    assert "lies inside the cut corner" in result.stderr


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
    assert "is too low" in result.stderr
    assert "Lower HLE, Part scale" in result.stderr


# --- guide-vane pocket vs Runner case Ø (spec 2026-09-29, WS-A) ---------------
# With guide vanes the whole disk r < LE Ø/2 is carved out of the runner case and
# the distributor sits inside it. Within 5 mm of LE Ø the runner case is snapped
# flush (WARNING) and a thin ring keeps clean runner-case labels. Further below LE
# Ø (WS-A v2, spec 2026-09-29-runner-case-below-le) the runner case wall stops
# 20 mm under the shroud brim and a ledge runs out to LE Ø/2; below Runner Ø
# (X1) + 20 mm the build is refused.

RUNNER_CASE_FIXTURES = ["hollow-vanes-overrides", "stepped-vanes"]


def _fixture_params(name):
    with open(os.path.join(HERE, "params", f"{name}.json")) as fh:
        return json.load(fh)


def _junction_faces(result, name, d_first):
    """Per-patch (r, z, |nz|) of every wetted face about the part axis, plus the
    resolved radii / heights of the junction (metres, scaled)."""
    import numpy as np
    import trimesh

    p = _fixture_params(name)
    s = p.get("partScale", 1)
    h_first = (p["hMiddlePlusFirst"] - p["hMiddle"]) * s
    z_mid_base = -p["height"] / 2 - 0.01 + h_first
    r_env = p["dLast"] * s / 2
    r_case = d_first * s / 2
    with zipfile.ZipFile(result.export_path("trisurface.zip")) as zf:
        meshes = {n[:-4]: trimesh.load(io.BytesIO(zf.read(n)), file_type="stl")
                  for n in zf.namelist() if n != "domain.stl"}
    axis = meshes["outlet"].vertices.mean(axis=0)
    faces = {}
    for pname, m in meshes.items():
        fc = m.vertices[m.faces].mean(axis=1)
        faces[pname] = (np.hypot(fc[:, 0] - axis[0], fc[:, 1] - axis[1]), fc[:, 2],
                        np.abs(m.face_normals[:, 2]), m.area_faces)
    return faces, r_env, r_case, z_mid_base


@pytest.mark.parametrize("name", RUNNER_CASE_FIXTURES)
def test_runner_case_too_close_to_the_outlet_is_refused(build, name):
    """Runner case Ø = Runner Ø (X1) + 10 mm: the runner case wall would sit 5 mm
    outside the outlet passage. Refused with the levers (spec
    2026-09-29-runner-case-below-le, WS-A v2)."""
    p = _fixture_params(name)
    x1 = p["outletOuterD"]
    d_first = x1 + 0.01
    result = build(name, params_override={"dFirst": d_first})
    assert result.exit_code == 1
    expected = (
        "KO: With guide vanes the runner case must clear the outlet: Runner case Ø "
        "(%d mm) must be at least Runner Ø + 20 mm (%d mm). Increase Runner case Ø, "
        "clear it (auto ≈ %d mm), or turn Guide vanes off."
        % (round(d_first * 1000), round((x1 + 0.02) * 1000),
           round(p["dLast"] * 1.14703 * 1000)))
    assert expected in result.stderr


def _ledge(build, name):
    """The LE Ø - 100 mm build and its junction: (result, faces, r_le, r_case,
    z_ledge, z_brim, z_floor)."""
    p = _fixture_params(name)
    d_first = p["dLast"] - 0.1
    result = build(name, params_override={"dFirst": d_first})
    assert result.exit_code == 0, f"builder failed:\n{result.stderr}"
    faces, r_le, r_case, _z_mid_base = _junction_faces(result, name, d_first)
    z_brim = float(_patch_mesh(result, "shroud").vertices[:, 2].max())
    z_ledge = z_brim - 0.02 * p.get("partScale", 1)
    return result, faces, r_le, r_case, z_ledge, z_brim, -p["height"] / 2


@pytest.mark.parametrize("name", RUNNER_CASE_FIXTURES)
def test_runner_case_below_le_builds_a_ledge(build, name):
    """LE Ø - 100 mm with guide vanes (used to be refused): builds, watertight,
    same patches; just below the ledge the section shows the runner case circle
    at its typed radius with fluid wrapping under the ledge; above the ledge the
    distributor envelope (LE Ø/2) is unchanged."""
    result, _f, r_le, r_case, z_ledge, z_brim, _z0 = _ledge(build, name)
    import numpy as np

    assert "built flush" not in result.stdout
    assert tuple(pt["name"] for pt in result.manifest) == VANE_PATCHES
    stl = result.load_stl()
    assert stl.is_watertight
    axis = _patch_mesh(result, "outlet").vertices.mean(axis=0)[:2]
    dirs = [np.array([np.cos(a), np.sin(a)]) for a in np.radians([45, 135, 225, 315])]
    z = z_ledge - 0.005
    assert _fluid_mask(stl, [axis + (r_case - 0.004) * d for d in dirs], z) == [False] * 4
    assert _fluid_mask(stl, [axis + (r_case + 0.004) * d for d in dirs], z) == [True] * 4
    assert _fluid_mask(stl, [axis + (r_le - 0.004) * d for d in dirs], z) == [True] * 4
    # between the ledge and the brim: solid out to LE Ø/2, fluid beyond
    z = 0.5 * (z_ledge + z_brim)
    assert _fluid_mask(stl, [axis + (r_le - 0.004) * d for d in dirs], z) == [False] * 4
    assert _fluid_mask(stl, [axis + (r_le + 0.004) * d for d in dirs], z) == [True] * 4


@pytest.mark.parametrize("name", RUNNER_CASE_FIXTURES)
def test_runner_case_ledge_labels(build, name):
    """Runner case wall and ledge underside -> cylinder_walls, the 20 mm band at
    LE Ø/2 -> shroud, the floor outside the runner case -> walls."""
    import numpy as np

    result, faces, r_le, r_case, z_ledge, z_brim, z0 = _ledge(build, name)

    def area_by_patch(sel_fn):
        out = {}
        for pname, (r, z, nz, a) in faces.items():
            sel = sel_fn(r, z, nz)
            if sel.any():
                out[pname] = float(a[sel].sum())
        return out

    wall = area_by_patch(lambda r, z, nz: (nz < 0.5) & (np.abs(r - r_case) < 2e-3)
                         & (z > z0 + 2e-3) & (z < z_ledge - 2e-3))
    assert set(wall) == {"cylinder_walls"}, wall
    assert wall["cylinder_walls"] == pytest.approx(2 * np.pi * r_case * (z_ledge - z0), rel=0.05)
    ledge = area_by_patch(lambda r, z, nz: (nz > 0.9) & (np.abs(z - z_ledge) < 2e-3)
                          & (r > r_case + 3e-3) & (r < r_le - 3e-3))
    assert set(ledge) == {"cylinder_walls"}, ledge
    assert ledge["cylinder_walls"] == pytest.approx(np.pi * (r_le ** 2 - r_case ** 2), rel=0.05)
    band = area_by_patch(lambda r, z, nz: (nz < 0.5) & (np.abs(r - r_le) < 2e-3)
                         & (z > z_ledge + 2e-3) & (z < z_brim - 2e-3))
    assert set(band) == {"shroud"}, band
    floor = area_by_patch(lambda r, z, nz: (nz > 0.9) & (np.abs(z - z0) < 2e-3)
                          & (r > r_case + 3e-3) & (r < r_le + 0.05))
    assert set(floor) == {"walls"}, floor


@pytest.mark.parametrize("name", RUNNER_CASE_FIXTURES)
def test_runner_case_ledge_keeps_every_guide_vane_triangle(build, name):
    result = _ledge(build, name)[0]
    plain = build(name)
    gv, gv0 = _patch_mesh(result, "guide_vanes"), _patch_mesh(plain, "guide_vanes")
    assert len(_vane_components(result)) == 16
    assert gv.area == pytest.approx(gv0.area, rel=2e-3)


def test_deep_runner_case_ledge_clips_the_vane_prisms(build):
    """Runner case Ø = LE Ø - 400 mm on stepped-vanes: the runner case wall now
    passes under the blades (their outlines reach ~LE Ø/2 - 56 mm). The vane
    prisms must not hang down into the fluid under the ledge as pillars: the
    guide_vanes patch keeps the plain build's skin."""
    p = _fixture_params("stepped-vanes")
    result = build("stepped-vanes", params_override={"dFirst": p["dLast"] - 0.4})
    assert result.exit_code == 0, f"builder failed:\n{result.stderr}"
    assert result.load_stl().is_watertight
    assert tuple(pt["name"] for pt in result.manifest) == VANE_PATCHES
    plain = _patch_mesh(build("stepped-vanes"), "guide_vanes")
    gv = _patch_mesh(result, "guide_vanes")
    assert len(_vane_components(result)) == 16
    assert gv.area == pytest.approx(plain.area, rel=2e-3)
    assert float(gv.vertices[:, 2].min()) == pytest.approx(float(plain.vertices[:, 2].min()),
                                                           abs=2e-3)


@pytest.mark.parametrize("name", RUNNER_CASE_FIXTURES)
def test_runner_case_within_5_mm_of_le_is_built_flush(build, name):
    """LE Ø + 2 mm: snapped flush with LE Ø (WARNING). The casing overshoot
    used to poke out of the 1 mm ring and its wall was split between
    cylinder_walls, shroud and walls."""
    import numpy as np

    p = _fixture_params(name)
    d_first = p["dLast"] + 0.002
    result = build(name, params_override={"dFirst": d_first})
    assert result.exit_code == 0, f"builder failed:\n{result.stderr}"
    assert ("WARNING: Runner case Ø %d mm is within 5 mm of LE Ø %d mm: "
            "built flush with it." % (round(d_first * 1000), round(p["dLast"] * 1000))
            ) in result.stdout
    assert tuple(pt["name"] for pt in result.manifest) == VANE_PATCHES
    assert result.load_stl().is_watertight

    faces, r_env, _r_case, z_mid_base = _junction_faces(result, name, d_first)
    r, _z, _nz, _a = faces["shroud"]
    assert int((r > r_env + 1e-3).sum()) == 0, "shroud faces outside LE Ø/2"
    for pname in ("shroud", "walls"):
        r, z, nz, _a = faces[pname]
        on_wall = (nz < 0.5) & (np.abs(r - r_env) < 3e-3) & (z < z_mid_base)
        assert int(on_wall.sum()) == 0, f"{pname} faces on the runner-case wall"


@pytest.mark.parametrize("name", RUNNER_CASE_FIXTURES)
def test_thin_runner_case_ring_keeps_clean_labels(build, name):
    """LE Ø + 12 mm (a 6 mm ring): the casing overshoot (10 mm) used to poke
    out of the ring and become a wetted wall labelled shroud / walls. Every
    vertical wetted face just outside LE Ø/2 must now be the runner case."""
    import numpy as np

    p = _fixture_params(name)
    d_first = p["dLast"] + 0.012
    result = build(name, params_override={"dFirst": d_first})
    assert result.exit_code == 0, f"builder failed:\n{result.stderr}"
    assert "built flush" not in result.stdout
    assert tuple(pt["name"] for pt in result.manifest) == VANE_PATCHES
    assert result.load_stl().is_watertight

    faces, r_env, r_case, z_mid_base = _junction_faces(result, name, d_first)
    band = {}
    for pname, (r, z, nz, a) in faces.items():
        sel = (nz < 0.5) & (r > r_env + 1e-3) & (r < r_case + 0.015) & (z < z_mid_base)
        if sel.any():
            band[pname] = float(a[sel].sum())
    assert set(band) == {"cylinder_walls"}, band
    # The runner-case wall is there, whole, at its typed radius.
    expected = 2 * np.pi * r_case * (z_mid_base + p["height"] / 2)
    assert band["cylinder_walls"] == pytest.approx(expected, rel=0.05)


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


# --- vane-skin patch integrity ------------------------------------------------
# The wetted blade skin must classify to guide_vanes, never leak into hub or
# shroud. Regression guard: the vane classification source (the extruded
# prisms) had full-height side faces, so ALL its centroids sat on two
# horizontal rows; the upper triangle of every blade-skin quad then sat ~h/3
# from the nearest vane sample while the (uncut) hub roof was directly above —
# a near-tie the nearest-source vote lost ~90% of the time, speckling the
# blades across guide_vanes/hub (4407 leaked faces on a real cached build,
# reproduced by hollow-vanes-overrides).


@pytest.mark.parametrize("name", ["stepped-vanes", "hollow-vanes", "hollow-vanes-overrides",
                                  "stepped-vanes-18"])
def test_vane_skin_stays_on_the_guide_vanes_patch(build, name):
    import numpy as np
    import trimesh

    result = build(name)
    assert result.exit_code == 0, f"builder failed:\n{result.stderr}"

    def patch(pname):
        with zipfile.ZipFile(result.export_path("trisurface.zip")) as zf:
            return trimesh.load(io.BytesIO(zf.read(f"{pname}.stl")), file_type="stl")

    # Part axis from the outlet annulus (a flat ring centred on it).
    axis = patch("outlet").vertices.mean(axis=0)

    def azimuthal(mesh):
        """|n_theta| per face: ~0 on a surface of revolution, large on blades."""
        fc = mesh.vertices[mesh.faces].mean(axis=1)
        n = mesh.face_normals
        dx, dy = fc[:, 0] - axis[0], fc[:, 1] - axis[1]
        r = np.maximum(np.hypot(dx, dy), 1e-9)
        return np.abs((n[:, 0] * -dy + n[:, 1] * dx) / r)

    # Hub and shroud are surfaces of revolution: every face normal is
    # meridional up to facet noise. The blade skin is the only strongly
    # azimuthal surface in the band; none of it may land on hub/shroud.
    for pname in ("hub", "shroud"):
        nth = azimuthal(patch(pname))
        leaked = int((nth > 0.35).sum())
        assert leaked == 0, f"{name}: {leaked} blade-like faces classified as {pname}"

    # Reverse direction: the blades are strict VERTICAL prisms, so the vane
    # patch may contain (almost) no horizontal faces — a horizontal face there
    # is a stolen piece of the shroud floor / hub roof. (Regression guard: a
    # denser vane source once out-sampled the revolved sources at the junctions
    # and pulled a speckled ring of floor faces around every blade root onto
    # guide_vanes — 3794 faces on a real cached build.)
    gv = patch("guide_vanes")
    horiz = float((np.abs(gv.face_normals[:, 2]) > 0.7).mean())
    assert horiz < 0.01, f"{name}: {horiz:.1%} horizontal faces in guide_vanes"

    # Sanity for the metric itself: the blades ARE strongly azimuthal.
    assert (azimuthal(gv) > 0.35).mean() > 0.5


# --- guide vane count (16 or 18) ----------------------------------------------
# With 18 vanes every blade is scaled by 16/18 about its pivot (same solidity,
# same pivot radius) and the ring step is 360/18 = 20 deg (spec
# 2026-09-29-guide-vane-count). A refusal guards neighbouring blades touching.


def _patch_mesh(result, pname):
    import trimesh

    with zipfile.ZipFile(result.export_path("trisurface.zip")) as zf:
        return trimesh.load(io.BytesIO(zf.read(f"{pname}.stl")), file_type="stl")


def _vane_components(result):
    """Connected blade components of the guide_vanes patch (> 20 faces each)."""
    gv = _patch_mesh(result, "guide_vanes")
    return [c for c in gv.split(only_watertight=False) if len(c.faces) > 20]


def _mid_chord(np, blade):
    z = blade.vertices[:, 2]
    sec = blade.section(plane_origin=[0.0, 0.0, 0.5 * (z.min() + z.max())],
                        plane_normal=[0.0, 0.0, 1.0])
    loop = np.asarray(max(sec.discrete, key=len), dtype=float)[:, :2]
    return _chord_axis(np, loop)[0]


def test_eighteen_vanes_put_eighteen_blades_on_the_guide_vanes_patch(build):
    import numpy as np

    r16 = build("stepped-vanes")
    r18 = build("stepped-vanes-18")
    assert r18.exit_code == 0, f"builder failed:\n{r18.stderr}"
    blades16 = _vane_components(r16)
    blades18 = _vane_components(r18)
    assert len(blades16) == 16
    assert len(blades18) == 18

    # Chord scaled by 16/18 (solidity kept).
    c16 = float(np.mean([_mid_chord(np, b) for b in blades16]))
    c18 = float(np.mean([_mid_chord(np, b) for b in blades18]))
    assert c18 / c16 == pytest.approx(16.0 / 18.0, rel=0.02)

    # Evenly spaced every 20 deg about the outlet centre.
    axis = _patch_mesh(r18, "outlet").vertices.mean(axis=0)
    ang = sorted(float(np.degrees(np.arctan2(c[1] - axis[1], c[0] - axis[0]))) % 360.0
                 for c in (b.vertices.mean(axis=0) for b in blades18))
    steps = np.diff(ang + [ang[0] + 360.0])
    assert np.allclose(steps, 20.0, atol=0.5), steps


def test_min_blade_gap_detects_touching_outlines():
    import numpy as np

    bc = _builder_module()

    def square(x0, y0=0.0):
        return np.array([[x0, y0], [x0 + 1.0, y0], [x0 + 1.0, y0 + 1.0], [x0, y0 + 1.0]])

    assert bc._min_blade_gap([square(0.0), square(1.001)]) == pytest.approx(1e-3, abs=1e-9)
    assert bc._min_blade_gap([square(0.0), square(0.5)]) == 0.0
    # Shuffled order: the true minimum is between the first and the last ring.
    rings = [square(0.0), square(5.0), square(1.002)]
    assert bc._min_blade_gap(rings) == pytest.approx(2e-3, abs=1e-9)
    assert bc.VANE_MIN_GAP == pytest.approx(2e-3)
    assert bc.VANE_COUNTS == (16, 18)


def test_vane_count_outside_16_or_18_is_refused(build):
    result = build("stepped-vanes", params_override={"vaneCount": 17})
    assert result.exit_code == 1
    assert "KO:" in result.stderr
    assert "Guide vane count must be 16 or 18 (got 17)." in result.stderr


# --- cone chamfer: 45 deg foot on the LE part (both designs) --------------------
# The LE part (the Closed-generator last cylinder, the With cone outer wall) is
# widened by c above LEB + c, with a 45 deg frustum from LE Ø/2 at LEB (the joint
# with the distributor does not move) out to LE Ø/2 + c (spec
# 2026-09-29-cone-foot-chamfer). It only adds part material, so the tests assert
# the volume DELTA against the plain fixture, not a new GOLDEN.

CONE_CHAMFER_50 = {"coneChamferEnabled": True, "coneChamferSize": 0.05}
CONE_CHAMFER_FIXTURES = ["stepped-vanes", "hollow-vanes"]


def _le_foot(name):
    """(r_le, z_leb, H, c) of the fixture, scaled, in the builder's frame: the LE
    radius, the LEB height, the LE part height inside the box above LEB (to the
    ceiling for Closed generator, the cone length for With cone) and the 50 mm
    chamfer x Part scale."""
    p = _fixture_params(name)
    s = p.get("partScale", 1)
    z_leb = -p["height"] / 2 - 0.01 + p["hMiddlePlusFirst"] * s
    if p["variant"] == "hollow":
        h = p["hollowLength"] * s
    else:
        h = p["height"] / 2 - z_leb
    return p["dLast"] * s / 2, z_leb, h, 0.05 * s


def _foot_faces(result, patches, r_le, z_leb, c, tol=0.002):
    """{patch: count} of 45 deg triangles (|nz| and |n.r| ~ 0.707) in the band of
    the foot chamfer: r_le - tol <= r <= r_le + c + tol, z_leb - tol <= z <= z_leb + c + tol."""
    import numpy as np

    axis = _patch_mesh(result, "outlet").vertices.mean(axis=0)
    counts = {}
    for pname in patches:
        m = _patch_mesh(result, pname)
        fc = m.vertices[m.faces].mean(axis=1)
        n = m.face_normals
        dx, dy = fc[:, 0] - axis[0], fc[:, 1] - axis[1]
        r = np.hypot(dx, dy)
        nr = (n[:, 0] * dx + n[:, 1] * dy) / np.maximum(r, 1e-9)
        sel = ((np.abs(np.abs(n[:, 2]) - 0.7071) < 0.08) & (np.abs(np.abs(nr) - 0.7071) < 0.08)
               & (r >= r_le - tol) & (r <= r_le + c + tol)
               & (fc[:, 2] >= z_leb - tol) & (fc[:, 2] <= z_leb + c + tol))
        counts[pname] = int(sel.sum())
    return counts


@pytest.mark.parametrize("name", CONE_CHAMFER_FIXTURES)
def test_cone_foot_chamfer_widens_the_le_part(build, name):
    """Builds, watertight, same patches; the fluid loses the widening ring minus
    the triangle under the 45 deg foot (Pappus): pi H (2 r c + c^2) - pi c^2 (r + 2c/3)."""
    import math

    plain = build(name)
    chamfered = build(name, params_override=CONE_CHAMFER_50)
    assert chamfered.exit_code == 0, f"builder failed:\n{chamfered.stderr}"
    stl = chamfered.load_stl()
    assert stl.is_watertight
    assert tuple(p["name"] for p in chamfered.manifest) == VANE_PATCHES

    r, _z, h, c = _le_foot(name)
    expected = math.pi * h * (2 * r * c + c * c) - math.pi * c * c * (r + 2 * c / 3.0)
    delta = plain.load_stl().volume - stl.volume
    # the feet planks already occupy a sliver of the ring (< 2 %)
    assert delta == pytest.approx(expected, rel=0.03)


@pytest.mark.parametrize("name", CONE_CHAMFER_FIXTURES)
def test_cone_foot_chamfer_section_shows_the_sloped_wall(build, name):
    """At LEB + 0.6 c (above the vane prisms) the part wall sits at r_le + 0.6 c:
    solid just inside, fluid just outside; the plain build is fluid there. Probed
    between the feet (45 deg + k x 90 deg)."""
    import numpy as np

    r, z_leb, _h, c = _le_foot(name)
    z = z_leb + 0.6 * c
    r_wall = r + 0.6 * c
    chamfered = build(name, params_override=CONE_CHAMFER_50)
    assert chamfered.exit_code == 0, f"builder failed:\n{chamfered.stderr}"
    axis = _patch_mesh(chamfered, "outlet").vertices.mean(axis=0)[:2]
    dirs = [np.array([np.cos(a), np.sin(a)]) for a in np.radians([45, 135, 225, 315])]
    inside = [axis + (r_wall - 0.004) * d for d in dirs]
    outside = [axis + (r_wall + 0.004) * d for d in dirs]
    stl = chamfered.load_stl()
    assert _fluid_mask(stl, inside, z) == [False] * 4
    assert _fluid_mask(stl, outside, z) == [True] * 4
    assert _fluid_mask(build(name).load_stl(), inside, z) == [True] * 4


@pytest.mark.parametrize("name", CONE_CHAMFER_FIXTURES)
def test_cone_foot_chamfer_face_is_cylinder_walls(build, name):
    r, z_leb, _h, c = _le_foot(name)
    counts = _foot_faces(build(name, params_override=CONE_CHAMFER_50), VANE_PATCHES,
                         r, z_leb, c)
    assert counts["cylinder_walls"] > 0, counts
    assert all(v == 0 for k, v in counts.items() if k != "cylinder_walls"), counts
    # The plain fixture has no 45 deg face in that band.
    plain = _foot_faces(build(name), VANE_PATCHES, r, z_leb, c)
    assert sum(plain.values()) == 0, plain


def test_cone_foot_chamfer_on_closed_generator_without_vanes(build):
    """The BREP path (no guide vanes): same four patches, the outlet is still the
    middle cylinder and the foot face lands in cylinder_walls."""
    result = build("stepped", params_override=CONE_CHAMFER_50)
    assert result.exit_code == 0, f"builder failed:\n{result.stderr}"
    assert result.load_stl().is_watertight
    assert tuple(p["name"] for p in result.manifest) == STEPPED_PATCHES
    assert result.load_stl().volume < build("stepped").load_stl().volume
    r, z_leb, _h, c = _le_foot("stepped")
    counts = _foot_faces(result, STEPPED_PATCHES, r, z_leb, c)
    assert counts["cylinder_walls"] > 0, counts
    assert all(v == 0 for k, v in counts.items() if k != "cylinder_walls"), counts


def test_cone_foot_chamfer_taller_than_the_cone_is_refused(build):
    result = build("hollow-vanes", params_override={
        "coneChamferEnabled": True, "coneChamferSize": 0.6})
    assert result.exit_code == 1
    assert ("KO: Cone chamfer size (600 mm) is taller than the cone: Cone length 600 mm "
            "minus Wall thickness 50 mm leaves 550 mm. Lower the Cone chamfer size to "
            "550 mm or less, or lengthen the Cone length.") in result.stderr


def test_cone_foot_chamfer_taller_than_the_generator_is_refused(build):
    to_top = build("stepped", params_override={
        "coneChamferEnabled": True, "coneChamferSize": 3.0})
    assert to_top.exit_code == 1
    assert ("KO: Cone chamfer size (3000 mm) is taller than the generator: the generator "
            "rises only 2714 mm above LEB up to the chamber top. Lower the Cone chamfer "
            "size to 2714 mm or less, or increase H Kammer.") in to_top.stderr
    closed = build("stepped", params_override={
        "coneChamferEnabled": True, "coneChamferSize": 0.6, "centralHeight": 0.5})
    assert closed.exit_code == 1
    assert ("KO: Cone chamfer size (600 mm) is taller than the generator: the Generator "
            "height is only 500 mm. Lower the Cone chamfer size to 500 mm or less, or "
            "raise the Generator height.") in closed.stderr


def test_cone_foot_chamfer_non_positive_size_is_refused(build):
    result = build("stepped", params_override={
        "coneChamferEnabled": True, "coneChamferSize": 0.0})
    assert result.exit_code == 1
    assert "KO: Cone chamfer size must be greater than 0 mm." in result.stderr


def test_cone_foot_chamfer_counts_in_the_chamber_fit(build):
    """Runner case flush with LE (typed) and the axis 1250 mm from the side wall:
    the plain part (1211 mm radius) fits, the widened one (1261 mm) does not."""
    p = _fixture_params("stepped")
    over = {"dFirst": p["dLast"], "distFromSideChamfer1": 1.25, "feetEnabled": False}
    assert build("stepped", params_override=over).exit_code == 0
    result = build("stepped", params_override={**over, **CONE_CHAMFER_50})
    assert result.exit_code == 1
    assert "The turbine (2521 mm across at its widest) would stick out" in result.stderr
    assert "Guide vanes Ø or Cone chamfer size." in result.stderr


def test_cone_foot_chamfer_widens_the_spiral_plank_target(build):
    """Semi-spiral: the plank runs tangent to the WIDENED LE part (r_le + c).
    The fixture's auto runner case stays the widest part, so its frozen spiral
    still matches the machine."""
    import numpy as np

    name = "stepped-spiral"
    result = build(name, params_override=CONE_CHAMFER_50)
    assert result.exit_code == 0, result.stderr
    p, V, axis, _r, s, z_leb, _W, _L = _spiral_frame(name)
    stl = result.load_stl()
    P, T = _plank_segment(np, V, axis, p["dLast"] * s / 2.0 + 0.05 * s)
    d = (T - P) / float(np.linalg.norm(T - P))
    n = np.array([-d[1], d[0]])
    mid = P + 0.5 * (T - P)
    h = 0.025 * s
    z_high = z_leb + 0.5 * (p["height"] / 2.0 - z_leb)
    assert _fluid_mask(stl, [mid + (h - 0.002) * n, mid - (h - 0.002) * n], z_high) == [False, False]
    assert _fluid_mask(stl, [mid + (h + 0.002) * n, mid - (h + 0.002) * n], z_high) == [True, True]


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


# --- semi-spiral casing -----------------------------------------------------------
# The footprint is the semi-spiral outline (frozen vertices in params.spiral, the
# builder never optimises), the nose tip clears the widest part by 200 mm, and a
# plank runs from the nose tip tangent to the generator / cone circle, from LEB
# to the ceiling. Nose + plank = the `tongue` patch. Spec
# brain/specs/2026-09-29-semi-spiral-casing-design.md, section 11.

def _spiral_frame(name):
    """(params, vertices in BUILDER coordinates, axis (x, y), r_machine, scale,
    z_leb, box W, box L). The builder mirrors the tool frame (x -> -x) so the
    spiral turns with the guide vanes (see the handedness test)."""
    import numpy as np

    p = _fixture_params(name)
    raw = {v["id"]: (v["x"], v["y"]) for v in p["spiral"]["vertices"]}
    x_in, foot_y = raw["V0"]
    x4, y_top = raw["V4"][0], raw["V2"][1]
    W, L = x4 - x_in, y_top - foot_y
    ax, ay = (x4 + x_in) / 2.0, -(y_top + foot_y) / 2.0
    V = {k: np.array([ax - x, ay + y]) for k, (x, y) in raw.items()}
    s = p.get("partScale", 1.0)
    d_last = p["dLast"] * s
    r_machine = max(1.147030 * d_last, 0.8 * d_last, d_last) / 2.0
    z_leb = -p["height"] / 2.0 - 0.01 + p["hMiddlePlusFirst"] * s
    return p, V, np.array([ax, ay]), r_machine, s, z_leb, W, L


def _plank_segment(np, V, axis, r_t):
    """Nose tip P and the tangent point T the builder picks (spec section 5.3)."""
    P = V["V6"] - axis
    r_in = float(np.hypot(*P))
    a = np.arccos(r_t / r_in)
    u = P / r_in
    l6 = (V["V6"] - V["V5"]) / np.linalg.norm(V["V6"] - V["V5"])
    best = None
    for t in (a, -a):
        T = r_t * np.array([u[0] * np.cos(t) - u[1] * np.sin(t), u[0] * np.sin(t) + u[1] * np.cos(t)])
        score = float(np.dot((T - P) / np.linalg.norm(T - P), l6))
        if best is None or score > best[0]:
            best = (score, T)
    return P + axis, best[1] + axis


def _fluid_mask(stl, pts_xy, z):
    """Is each XY point inside the fluid at height z? Even-odd count over the
    closed loops of the horizontal cross-section."""
    import numpy as np
    from shapely.geometry import Point, Polygon

    section = stl.section(plane_origin=(0.0, 0.0, z), plane_normal=(0.0, 0.0, 1.0))
    assert section is not None, f"no cross-section at z={z}"
    loops = [Polygon(np.asarray(d)[:, :2]) for d in section.discrete if len(d) >= 4]
    return [sum(lp.contains(Point(*pt)) for lp in loops) % 2 == 1 for pt in pts_xy]


@pytest.mark.parametrize("name", ["stepped-spiral", "hollow-vanes-spiral"])
def test_spiral_inlet_is_the_single_bottom_opening(build, name):
    import numpy as np

    result = build(name)
    assert result.exit_code == 0, result.stderr
    _p, _V, _axis, _r, _s, _z, W, L = _spiral_frame(name)
    inlet = _patch_mesh(result, "inlet")
    assert np.allclose(inlet.vertices[:, 1], -L / 2.0, atol=1e-6)      # one plane, min Y
    assert float(np.ptp(inlet.vertices[:, 0])) == pytest.approx(W, abs=1e-3)   # x4 - x_in


@pytest.mark.parametrize("name", ["stepped-spiral", "hollow-vanes-spiral"])
def test_spiral_nose_tip_clears_the_widest_part_by_200_mm(build, name):
    import numpy as np

    result = build(name)
    assert result.exit_code == 0, result.stderr
    _p, V, axis, r_machine, _s, z_leb, _W, _L = _spiral_frame(name)
    tongue = _patch_mesh(result, "tongue")
    below = tongue.vertices[tongue.vertices[:, 2] < z_leb - 0.01]     # the nose only (no plank)
    assert len(below)
    r = np.hypot(below[:, 0] - axis[0], below[:, 1] - axis[1])
    assert float(r.min()) == pytest.approx(r_machine + 0.2, abs=1e-3)
    assert np.hypot(*(V["V6"] - axis)) == pytest.approx(r_machine + 0.2, abs=1e-5)


@pytest.mark.parametrize("name", ["stepped-spiral", "hollow-vanes-spiral"])
def test_spiral_plank_runs_from_the_nose_to_the_target_circle_above_leb(build, name):
    """Solid all along P -> T between LEB and the ceiling (it crosses the
    section and touches the circle), open fluid there in the vane band,
    50 mm x Part scale thick."""
    import numpy as np

    result = build(name)
    assert result.exit_code == 0, result.stderr
    p, V, axis, _r, s, z_leb, _W, _L = _spiral_frame(name)
    stl = result.load_stl()
    P, T = _plank_segment(np, V, axis, p["dLast"] * s / 2.0)
    length = float(np.linalg.norm(T - P))
    assert 0.9 < length < 1.3                                  # spec: 0.94 to 1.22 m
    d = (T - P) / length
    n = np.array([-d[1], d[0]])
    line = [P + f * (T - P) for f in np.linspace(0.08, 0.92, 9)]
    z_high = z_leb + 0.5 * (p["height"] / 2.0 - z_leb)
    assert not any(_fluid_mask(stl, line, z_high)), "the plank must be solid above LEB"
    # the plank end reaches the circle: solid right up to T
    assert not any(_fluid_mask(stl, [T - 0.01 * d], z_high))
    # thickness 50 mm x Part scale: solid just inside both faces, fluid just outside
    mid = P + 0.5 * (T - P)
    h = 0.025 * s
    assert _fluid_mask(stl, [mid + (h - 0.002) * n, mid - (h - 0.002) * n], z_high) == [False, False]
    assert _fluid_mask(stl, [mid + (h + 0.002) * n, mid - (h + 0.002) * n], z_high) == [True, True]
    # below LEB (the vane band) the same line is fluid: the plank starts at LEB
    z_band = z_leb - 0.25 * p["hMiddle"] * s
    assert all(_fluid_mask(stl, line[2:7], z_band)), "no plank in the vane band"


@pytest.mark.parametrize("name", ["stepped-spiral", "hollow-vanes-spiral"])
def test_spiral_tongue_faces_are_never_horizontal(build, name):
    import numpy as np

    result = build(name)
    assert result.exit_code == 0, result.stderr
    tongue = _patch_mesh(result, "tongue")
    assert len(tongue.faces) > 0
    assert float(np.abs(tongue.face_normals[:, 2]).max()) < 0.5


def test_spiral_turns_with_the_guide_vanes(build):
    """Handedness (spec section 5.5 / 14 task 5): the guide-vane asset turns the
    flow counter-clockwise seen from +Z (outer leading edge -> inner trailing
    edge), so the inlet flow (+Y, along L1) must run on the +X side of the axis
    and the nose sit on the -X side: the builder mirrors the tool frame."""
    import numpy as np

    loop = _committed_airfoil(np)
    r = np.hypot(loop[:, 0], loop[:, 1])
    le, te = loop[r.argmax()], loop[r.argmin()]
    lz = le[0] * (te - le)[1] - le[1] * (te - le)[0]
    assert lz > 0                                              # counter-clockwise swirl

    result = build("stepped-spiral")
    assert result.exit_code == 0, result.stderr
    _p, _V, axis, _r, _s, z_leb, _W, _L = _spiral_frame("stepped-spiral")
    tongue = _patch_mesh(result, "tongue")
    nose = tongue.vertices[tongue.vertices[:, 2] < z_leb - 0.01]
    assert np.sign(nose[:, 0].mean() - axis[0]) == -np.sign(lz)


def test_spiral_brep_path_carries_the_tongue_patch(build):
    """Without guide vanes (BREP classify): the tongue patch follows walls, the
    solid stays watertight and no tongue face is horizontal."""
    import numpy as np

    result = build("stepped-spiral", params_override={"guideVanes": False})
    assert result.exit_code == 0, result.stderr
    assert result.load_stl().is_watertight
    assert tuple(p["name"] for p in result.manifest) == SPIRAL_PATCHES
    assert {p["name"]: p["type"] for p in result.manifest}["tongue"] == "wall"
    assert _zip_names(result) == sorted([f"{p}.stl" for p in SPIRAL_PATCHES] + ["domain.stl"])
    tongue = _patch_mesh(result, "tongue")
    assert float(np.abs(tongue.face_normals[:, 2]).max()) < 0.5
    assert os.path.getsize(result.export_path("chamber.step")) > 0


def test_spiral_with_feet_is_refused(build):
    result = build("stepped-spiral", params_override={"feetEnabled": True})
    assert result.exit_code == 1
    assert "KO: The semi-spiral casing needs Feet off for now." in result.stderr


def test_spiral_vertices_for_another_machine_are_refused(build):
    """The frozen vertices must match the machine: a Part scale change without a
    new spiral is caught before the booleans."""
    result = build("stepped-spiral", params_override={"partScale": 0.9})
    assert result.exit_code == 1
    assert "KO:" in result.stderr and "semi-spiral" in result.stderr

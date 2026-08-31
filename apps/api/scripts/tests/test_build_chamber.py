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
    assert os.path.getsize(result.export_path("chamber.step")) > 0
    assert os.path.getsize(result.export_path("chamber.stl")) > 0


def test_feet_toggle_carves_the_foot_voids(build):
    """Feet OFF must give back exactly the foot volume (legs + planks are one
    solid), so the feet-off solid is slightly LARGER than the feet-on one."""
    feet_on = build("stepped").load_stl()
    feet_off = build("stepped-feet-off").load_stl()
    delta = feet_off.volume - feet_on.volume
    golden_delta = GOLDEN["stepped-feet-off"][0] - GOLDEN["stepped"][0]
    assert delta == pytest.approx(golden_delta, rel=0.05)


def test_step_export_vane_policy(build):
    """Every guide-vane build ships editable BREP vanes in the STEP. (Hollow
    used to fall back vane-less: its OCC boolean self-overlapped at the blunt
    TE corners; the tangent TE rounding fixed the overlap, so both variants now
    pass the round-trip volume gate.)"""
    for name in ("stepped-vanes", "hollow-vanes"):
        result = build(name)
        assert result.build_meta == {"stepHasVanes": True}, name
        assert "falls back to the vane-less solid" not in result.stderr, name


def test_hollow_overflow_clamps_to_fit_with_a_warning(build):
    """The hollow stack is allowed to exceed H Kammer: it is scaled down to fit
    and the builder says so on stderr (stepped refuses instead, tested below)."""
    result = build("hollow-vanes")
    assert result.exit_code == 0
    assert "exceeds H Kammer" in result.stderr
    assert "scaled to" in result.stderr


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

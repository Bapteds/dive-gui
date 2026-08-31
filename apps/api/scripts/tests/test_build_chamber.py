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

import zipfile

import pytest

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
    """Stepped ships editable BREP vanes in the STEP; hollow's malformed boolean
    is rejected by the round-trip gate and falls back to the vane-less STEP."""
    stepped = build("stepped-vanes")
    assert stepped.build_meta == {"stepHasVanes": True}

    hollow = build("hollow-vanes")
    assert hollow.build_meta == {"stepHasVanes": False}
    assert "chamber.step falls back to the vane-less solid" in hollow.stderr


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

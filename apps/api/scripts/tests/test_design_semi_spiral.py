"""Tests for scripts/designSemiSpiral.py, the semi-spiral casing designer.

Plain numpy + scipy (no CadQuery), so they run on any dev machine. The three
acceptance cases of the tool spec (documents/Semi-spiral-creation/
SEMI_SPIRAL_TOOL_SPEC.md section 9.3) each run the real optimiser (30 to 90 s):
they are marked `slow` (deselect with -m "not slow"). Spec:
brain/specs/2026-09-29-semi-spiral-casing-design.md, section 11.
"""

import importlib.util
import json
import math
import os
import subprocess
import sys

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "designSemiSpiral.py")
GOLDEN_DIR = os.path.join(HERE, "spiral_golden")


def _load_module():
    spec = importlib.util.spec_from_file_location("designSemiSpiral", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


dss = _load_module()

# tool spec section 9.3: inputs, expected width, width binding, worst error limit (+0.02)
CASES = {
    "A": (dict(Q=12, c_flow=0.922, H_ch=2.97, D_LE=3.074, clearance=0.20, max_width=6.15, phi_start=160),
          6.05, False, 0.46 + 0.02),
    "B": (dict(Q=12, c_flow=0.922, H_ch=2.97, D_LE=3.074, clearance=0.20, max_width=6.15, phi_start=150),
          6.15, True, 0.57 + 0.02),
    "C": (dict(Q=12, c_flow=0.66, H_ch=2.97, D_LE=2.92, clearance=0.20, max_width=6.90, phi_start=160),
          6.90, True, 0.63 + 0.02),
}
SPEC_A = CASES["A"][0]


@pytest.fixture(scope="module")
def designed():
    """design_semi_spiral(**inputs), each distinct input set run once per module."""
    cache = {}

    def _run(**inputs):
        key = json.dumps(inputs, sort_keys=True)
        if key not in cache:
            cache[key] = dss.design_semi_spiral(**inputs)
        return cache[key]

    return _run


def _vertices(geom):
    return {v["id"]: np.array([v["x"], v["y"]]) for v in geom["vertices"]}


# --- fast checks (no optimisation) ------------------------------------------------
def test_derived_quantities_match_the_spreadsheet():
    """Tool spec section 3 / 9.1: the spreadsheet values of the current design."""
    a = dict(Q=12, c_flow=0.922, H_ch=2.97, D_LE=3.074, clearance=0.2)
    A160, R160 = dss.derived(phi=160.0, **a)
    A360, R360 = dss.derived(phi=360.0, **a)
    assert A160 == pytest.approx(7.230658, abs=1e-6)
    assert R160 == pytest.approx(4.171565, abs=1e-6)
    assert A360 == pytest.approx(0.0, abs=1e-12)
    assert R360 == pytest.approx(1.737, abs=1e-9)
    # A = H_ch * (R_cl - r_inner) holds identically over the span
    phi = np.linspace(160, 360, 201)
    A, R = dss.derived(phi=phi, **a)
    np.testing.assert_allclose(A, 2.97 * (R - (3.074 / 2 + 0.2)), atol=1e-12)


def test_frame_puts_the_tongue_on_the_inner_wall():
    """Tool spec section 5 / 9.2, with the CORRECTED 160 deg value (the spec's
    (1.632200, -0.594072) is off by 4.6e-5; spec 2026-09-29 section 2)."""
    v160 = dss.to_frame(1.737, 360.0, 160)[0]
    v150 = dss.to_frame(1.737, 360.0, 150)[0]
    assert v160 == pytest.approx([1.632246, -0.594089], abs=1e-5)
    assert v150 == pytest.approx([1.504286, -0.868500], abs=1e-5)
    # the spiral start lands on the -x axis (horizontal inlet ray, L1 vertical)
    assert dss.to_frame(4.0, 160.0, 160)[0] == pytest.approx([-4.0, 0.0], abs=1e-12)


def test_ray_distances_take_the_farthest_hit_and_flag_misses():
    wall = np.array([[2.0, -5.0], [2.0, 5.0]])
    U = np.array([[1.0, 0.0], [math.sqrt(0.5), math.sqrt(0.5)], [-1.0, 0.0]])
    r = dss.ray_distances(wall, U)
    assert r[0] == pytest.approx(2.0)
    assert r[1] == pytest.approx(2.0 * math.sqrt(2.0))
    assert math.isnan(r[2])
    # a folded polyline hit twice by one ray reports the farther wall
    folded = np.array([[1.0, -1.0], [1.0, 1.0], [3.0, 1.0], [3.0, -1.0]])
    assert dss.ray_distances(folded, U[:1])[0] == pytest.approx(3.0)


def test_area_error_is_the_worst_ray_and_penalises_a_miss():
    U = np.array([[1.0, 0.0], [0.0, 1.0]])
    wall = np.array([[2.0, -1.0], [2.0, 3.0], [-1.0, 3.0]])     # r = 2 along x, 3 along y
    err = dss.area_error(wall, U, np.array([1.0, 1.0]), 1.0, 1.0)
    assert err == pytest.approx(1.0)                           # |1*(3-1) - 1|
    assert dss.area_error(wall[:2], U, np.array([1.0, 1.0]), 1.0, 1.0) >= 1e3


def test_build_nose_mirrors_l6_between_two_stubs():
    V5, V6 = np.array([2.0, -0.10]), np.array([1.6322, -0.594072])
    V7, V8, V9 = dss.build_nose(V5, V6)
    assert V7 == pytest.approx([1.6322, -1.044072])
    assert V8 == pytest.approx([2.0, -1.538144])
    assert V9 == pytest.approx([2.0, -1.988144])


@pytest.mark.parametrize("bad", [
    dict(Q=0), dict(c_flow=-1), dict(H_ch=0), dict(D_LE=-3), dict(clearance=-0.1),
    dict(max_width=0), dict(phi_start=0), dict(phi_start=360), dict(Q=float("nan")),
])
def test_invalid_inputs_are_refused_by_name(bad):
    inputs = dict(SPEC_A, **bad)
    name = next(iter(bad))
    with pytest.raises(dss.SpiralInputError, match="invalid input %s=" % name):
        dss.design_semi_spiral(**inputs)


def test_degenerate_spiral_is_refused_before_optimising():
    """r_inner >= R_cl(phi_start): the outer wall starts inside the gap. With
    R_cl = r_inner + A/H_ch this needs A/H_ch to vanish in floating point (a
    guard: legal chamber inputs never reach it)."""
    with pytest.raises(dss.SpiralDegenerateError):
        dss.design_semi_spiral(**dict(SPEC_A, Q=1e-20))


def test_chamber_messages_name_the_lever():
    assert "200 mm gap around the turbine" in dss.degenerate_message()
    msg = dss.infeasible_message(4.0, 4.4312)
    assert "B Kammer (4000 mm)" in msg
    assert "Raise B Kammer to at least 4432 mm" in msg


def test_width_warning_only_when_binding():
    geom = {"inputs": {"max_width": 6.15},
            "quality": {"worst_area_error_m2": 0.5741, "at_phi_deg": 150.0, "width_binding": True}}
    assert dss.width_warning(geom) == (
        "The semi-spiral casing is limited by B Kammer (6150 mm): worst cross-section "
        "error 0.57 m² at 150°. Raise B Kammer to reduce it.")
    geom["quality"]["width_binding"] = False
    assert dss.width_warning(geom) is None


# --- Length Max (spec 2026-09-30-spiral-length) ---------------------------------------
GOLDEN_A = dict(V0=(-4.05, -1.938178), V2=(-2.05, 3.0), V5=(2.0, -0.15), V6=(1.632246, -0.594089))


def test_spiral_length_is_the_top_to_foot_distance():
    """length = yt - foot_y, foot_y = V9.y = 2 V6.y - y5 - 2 STUB (golden case A)."""
    g = GOLDEN_A
    assert dss.spiral_length(g["V6"][1], g["V2"][1], g["V5"][1]) == pytest.approx(
        g["V2"][1] - g["V0"][1], abs=1e-9)


def test_length_limit_is_one_more_shape_constraint_only_when_set():
    V6 = np.array(GOLDEN_A["V6"])
    args = (V6, 10.0, -4.05, 0.95, -2.05, 3.0, 0.6, 2.0, 1.5, -0.15)
    base = dss._shape_ok(*args)
    assert len(base) == 9
    assert dss._shape_ok(*args, max_length=None) == base
    limited = dss._shape_ok(*args, max_length=4.9)
    assert limited[:9] == base
    assert limited[9] == pytest.approx(4.9 - 4.938178, abs=1e-6)


def test_invalid_length_limit_is_refused_by_name():
    with pytest.raises(dss.SpiralInputError, match="invalid input max_length="):
        dss.design_semi_spiral(**SPEC_A, max_length=0)


def test_length_limit_below_the_shortest_spiral_is_refused_before_optimising():
    prob = dss._Problem(SPEC_A["Q"], SPEC_A["c_flow"], SPEC_A["H_ch"], SPEC_A["D_LE"],
                        SPEC_A["clearance"], SPEC_A["phi_start"])
    shortest = dss.shortest_length(prob)
    assert 3.5 < shortest < 4.938178        # below case A's natural 4.94 m
    with pytest.raises(dss.SpiralLengthInfeasibleError) as info:
        dss.design_semi_spiral(**SPEC_A, max_length=shortest - 0.01)
    assert info.value.max_length == pytest.approx(shortest - 0.01)
    assert info.value.shortest == pytest.approx(shortest)


def test_length_messages_name_the_lever():
    msg = dss.length_infeasible_message(3.9, 4.0183)
    assert msg == ("The semi-spiral casing does not fit in the Length Max (3900 mm): the shortest "
                   "valid spiral for these inputs is 4019 mm long. Raise the Length Max to at "
                   "least 4019 mm.")
    geom = {"inputs": {"max_width": 6.15, "max_length": 4.5},
            "quality": {"worst_area_error_m2": 0.8123, "at_phi_deg": 250.0, "width_binding": False,
                        "length_binding": True}}
    assert dss.length_warning(geom) == (
        "The semi-spiral casing is limited by the Length Max (4500 mm): worst cross-section "
        "error 0.81 m² at 250°. Raise the Length Max to reduce it.")
    geom["quality"]["length_binding"] = False
    assert dss.length_warning(geom) is None
    del geom["quality"]["length_binding"]
    assert dss.length_warning(geom) is None


def _cli(*args):
    return subprocess.run([sys.executable, SCRIPT, *args], capture_output=True, text=True,
                          encoding="utf-8", timeout=600)


def test_cli_usage_and_refusals(tmp_path):
    assert _cli().returncode == 2
    src = tmp_path / "in.json"
    out = tmp_path / "out.json"
    src.write_text(json.dumps(dict(SPEC_A, Q=1e-20)))
    proc = _cli(str(src), str(out))
    assert proc.returncode == 1
    assert proc.stderr.startswith("KO: Q_max is too small")
    assert not out.exists()
    src.write_text(json.dumps(dict(SPEC_A, max_length=1.0)))
    proc = _cli(str(src), str(out))
    assert proc.returncode == 1
    assert proc.stderr.startswith("KO: The semi-spiral casing does not fit in the Length Max (1000 mm)")
    assert not out.exists()
    src.write_text(json.dumps({"Q": 12}))
    proc = _cli(str(src), str(out))
    assert proc.returncode == 1 and "KO:" in proc.stderr and "missing input" in proc.stderr


# --- the real optimiser (slow) ------------------------------------------------------
def _assert_valid_wall(geom, inputs, width, binding, limit):
    V = _vertices(geom)
    x_in, y0 = V["V0"]
    _, y1 = V["V1"]
    x2, yt = V["V2"]
    x3, _ = V["V3"]
    x4, y4 = V["V4"]
    _, y5 = V["V5"]
    V6 = V["V6"]
    # section 6.1 ordering + the vertical / horizontal lines
    assert V["V1"][0] == x_in and V["V5"][0] == x4 and V["V3"][1] == yt
    assert x_in < x2 < x3 < x4
    assert yt > y4 > y5 > V6[1]
    assert y1 > y5 and y1 > y0 and x4 > V6[0]
    # free corners on the 0.05 m grid; V6 never rounded (on the inner wall)
    for c in (x_in, y1, x2, yt, x3, x4, y4, y5):
        assert abs(c / dss.GRID - round(c / dss.GRID)) < 1e-6, c
    r_in = inputs["D_LE"] / 2 + inputs["clearance"]
    assert float(np.hypot(*V6)) == pytest.approx(r_in, abs=2e-6)
    # nose + single foot level
    assert V["V9"][1] == pytest.approx(y0) and V["V8"][0] == pytest.approx(x4)
    dims, q = geom["dimensions"], geom["quality"]
    assert dims["width"] <= inputs["max_width"] + 1e-9
    assert dims["width"] == pytest.approx(width, abs=1e-6)
    assert dims["foot_y"] == pytest.approx(y0)
    assert q["width_binding"] is binding
    assert q["worst_area_error_m2"] <= limit
    assert geom["algorithm"] == dss.ALGORITHM
    assert geom["warnings"] == ([dss.width_warning(geom)] if binding else [])


@pytest.mark.slow
@pytest.mark.parametrize("case", list(CASES))
def test_acceptance_cases(designed, case):
    inputs, width, binding, limit = CASES[case]
    _assert_valid_wall(designed(**inputs), inputs, width, binding, limit)


@pytest.mark.slow
@pytest.mark.parametrize("case", list(CASES))
def test_golden_vertices_on_the_pinned_scipy(designed, case):
    """Exact vertices only reproduce on the scipy version that produced them."""
    import scipy

    with open(os.path.join(GOLDEN_DIR, "case_%s.json" % case)) as fh:
        golden = json.load(fh)
    if scipy.__version__ not in golden["scipy"]:
        pytest.skip("golden vertices pinned to scipy %s (running %s)"
                    % (", ".join(golden["scipy"]), scipy.__version__))
    geom = designed(**CASES[case][0])
    assert [(v["id"], v["x"], v["y"]) for v in geom["vertices"]] == [
        (v["id"], v["x"], v["y"]) for v in golden["vertices"]]
    assert geom["quality"] == golden["quality"]
    assert geom["dimensions"] == golden["dimensions"]


@pytest.mark.slow
def test_cli_is_deterministic_and_matches_the_library(designed, tmp_path):
    """Same inputs, another process: byte-identical JSON (tool spec section 9.4)."""
    src = tmp_path / "in.json"
    out = tmp_path / "out.json"
    src.write_text(json.dumps(SPEC_A))
    proc = _cli(str(src), str(out))
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.startswith("OK:")
    assert "WARN:" not in proc.stderr          # case A is not width-bound
    assert out.read_text() == dss.to_json(designed(**SPEC_A))
    assert not (tmp_path / "out.json.tmp").exists()


@pytest.mark.slow
def test_narrow_width_builds_width_bound(designed):
    """Tool spec 9.4 is not reproduced by the reference: max_width 5.5 returns a
    width-bound wall (spec 2026-09-29 section 2, finding 3; chamber policy =
    build with a warning)."""
    inputs = dict(SPEC_A, max_width=5.5)
    geom = designed(**inputs)
    assert geom["dimensions"]["width"] == pytest.approx(5.5, abs=1e-6)
    assert geom["quality"]["width_binding"] is True
    assert geom["quality"]["worst_area_error_m2"] == pytest.approx(1.23, abs=0.02)
    assert geom["warnings"] == [dss.width_warning(geom)]


@pytest.mark.slow
def test_length_limit_reshapes_the_spiral_and_warns(designed):
    """A binding Length Max (spec 2026-09-30-spiral-length): length <= the limit,
    a valid wall, the length warning, and the limit echoed in the result."""
    inputs = dict(SPEC_A, max_length=4.5)
    geom = designed(**inputs)
    V = _vertices(geom)
    length = V["V2"][1] - V["V0"][1]
    assert length <= 4.5 + 1e-9
    assert geom["dimensions"]["length"] == pytest.approx(length, abs=1e-6)
    assert geom["inputs"]["max_length"] == 4.5
    assert geom["quality"]["length_binding"] is True
    assert geom["quality"]["worst_area_error_m2"] < dss.INFEASIBLE_ERR
    assert V["V9"][1] == pytest.approx(V["V0"][1])
    assert geom["warnings"] == [dss.length_warning(geom)]


@pytest.mark.slow
def test_a_loose_length_limit_is_not_binding(designed):
    """A Length Max well above the natural length (4.94 m) does not bind: no flag,
    no warning. (The vertices may still differ slightly from the unlimited run:
    the global search visits, and penalises, walls longer than the limit.)"""
    loose = designed(**dict(SPEC_A, max_length=6.0))
    V = _vertices(loose)
    assert V["V2"][1] - V["V0"][1] <= 6.0
    assert loose["quality"]["length_binding"] is False
    assert loose["quality"]["worst_area_error_m2"] <= CASES["A"][3]
    assert loose["warnings"] == []

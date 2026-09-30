"""Regression tests of the vendored LID ITERATION KIT scripts (scripts/lidkit/).

Needs numpy + scipy + shapely (the CHAMBER_PYTHON_BIN / LIDKIT_PYTHON_BIN
interpreter); the module SKIPS without them. No OpenFOAM: the lid export is a
synthetic legacy VTK pair and the base STL is a small closed box.

  * --flat regression: fitting a flat field reproduces the flat lid (every lid
    vertex at Z_LID, no clamped point, no upstand, no new open edge);
  * surface: z_s = Z_LID + (p - p0_inlet) / g on a synthetic lid / inlet pair.
"""

import json
import os
import subprocess
import sys

import pytest

np = pytest.importorskip("numpy")
pytest.importorskip("scipy")
pytest.importorskip("shapely")

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.join(HERE, "..", "lidkit")
Z_LID = 0.3


def _quad(a, b, c, d):
    """Two triangles of the quad a-b-c-d (vertices in order)."""
    return [(a, b, c), (a, c, d)]


def _write_box_stl(path):
    """Closed box 1 x 0.6 x 0.3: atmosphere (top), inlet (x = 0), walls (rest)."""
    x0, x1, y0, y1, z0, z1 = 0.0, 1.0, 0.0, 0.6, 0.0, Z_LID
    p = {
        "000": (x0, y0, z0), "100": (x1, y0, z0), "110": (x1, y1, z0), "010": (x0, y1, z0),
        "001": (x0, y0, z1), "101": (x1, y0, z1), "111": (x1, y1, z1), "011": (x0, y1, z1),
    }
    solids = {
        "atmosphere": _quad(p["001"], p["101"], p["111"], p["011"]),
        "inlet": _quad(p["000"], p["001"], p["011"], p["010"]),
        "walls": _quad(p["000"], p["010"], p["110"], p["100"])      # bottom
        + _quad(p["100"], p["110"], p["111"], p["101"])             # x = 1
        + _quad(p["000"], p["100"], p["101"], p["001"])             # y = 0
        + _quad(p["010"], p["011"], p["111"], p["110"]),            # y = 1
    }
    with open(path, "w") as f:
        for name, tris in solids.items():
            f.write(f"solid {name}\n")
            for t in tris:
                f.write("  facet normal 0 0 0\n    outer loop\n")
                for v in t:
                    f.write("      vertex %.9e %.9e %.9e\n" % v)
                f.write("    endloop\n  endfacet\n")
            f.write(f"endsolid {name}\n")


def _read_solids(path):
    solids, cur = {}, None
    with open(path) as f:
        for line in f:
            s = line.split()
            if not s:
                continue
            if s[0] == "solid":
                cur = s[1]
                solids.setdefault(cur, [])
            elif s[0] == "vertex":
                solids[cur].append(tuple(float(x) for x in s[1:4]))
    return solids


def test_flat_fit_reproduces_the_flat_lid(tmp_path):
    base = tmp_path / "base.stl"
    out = tmp_path / "flat.stl"
    rep = tmp_path / "flat.json"
    _write_box_stl(base)
    r = subprocess.run(
        [sys.executable, os.path.join(KIT, "lidkit_fitlid.py"), str(base), str(out), "--flat",
         "--z-lid", str(Z_LID), "--report", str(rep)],
        capture_output=True, text=True, timeout=300,
    )
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-2000:]
    report = json.loads(rep.read_text())
    assert report["clamped_lid_points"] == 0
    assert report["upstand_facets"] == 0
    assert report["audit_all"]["open_edges"] == report["audit_base_all"]["open_edges"] == 0
    assert report["audit_all"]["non_manifold_edges"] == 0
    assert abs(report["lid_z_vs_Z_LID_mm"]["min"]) < 1e-6
    assert abs(report["lid_z_vs_Z_LID_mm"]["max"]) < 1e-6
    solids = _read_solids(out)
    assert set(solids) == {"atmosphere", "inlet", "walls"}
    lid_z = np.array([v[2] for v in solids["atmosphere"]])
    assert np.allclose(lid_z, Z_LID, atol=1e-9)
    # Every wall vertex stays inside the box.
    walls = np.array(solids["walls"])
    assert walls[:, 2].max() <= Z_LID + 1e-9 and walls[:, 2].min() >= -1e-9


def _write_vtk(path, points, faces, p, U):
    """Legacy ASCII VTK polydata with FIELD cell data p (scalar) and U (vector)."""
    lines = ["# vtk DataFile Version 2.0", "sampleSurface", "ASCII", "DATASET POLYDATA",
             f"POINTS {len(points)} float"]
    lines += ["%g %g %g" % tuple(pt) for pt in points]
    size = sum(len(f) + 1 for f in faces)
    lines.append(f"POLYGONS {len(faces)} {size}")
    lines += [" ".join(str(i) for i in [len(f), *f]) for f in faces]
    lines += [f"CELL_DATA {len(faces)}", "FIELD attributes 2", f"p 1 {len(faces)} float"]
    lines += ["%g" % v for v in p]
    lines.append(f"U 3 {len(faces)} float")
    lines += ["%g %g %g" % tuple(u) for u in U]
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


def test_surface_matches_the_analytic_level(tmp_path):
    g = 9.81
    d = tmp_path / "lidSurfaces" / "500"
    d.mkdir(parents=True)
    # Inlet: one unit square at x = 0, p = 1, U = (2, 0, 0) -> p0 = 1 + 2 = 3.
    inlet_pts = [(0, 0, 0), (0, 1, 0), (0, 1, 0.3), (0, 0, 0.3)]
    _write_vtk(d / "inlet.vtk", inlet_pts, [[0, 1, 2, 3]], [1.0], [(2.0, 0.0, 0.0)])
    # Lid: two quads at Z_LID with p giving a 50 mm and a 20 mm drawdown.
    lid_pts = [(0, 0, Z_LID), (1, 0, Z_LID), (1, 1, Z_LID), (0, 1, Z_LID), (2, 0, Z_LID), (2, 1, Z_LID)]
    p_lid = [3.0 - g * 0.05, 3.0 - g * 0.02]
    _write_vtk(d / "lid.vtk", lid_pts, [[0, 1, 2, 3], [1, 4, 5, 2]], p_lid, [(0, 0, 0), (0, 0, 0)])
    out = tmp_path / "zs_iter0.npy"
    r = subprocess.run(
        [sys.executable, os.path.join(KIT, "lidkit_surface.py"), str(d), str(out), "--z-lid", str(Z_LID)],
        capture_output=True, text=True, timeout=120,
    )
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-2000:]
    zs = np.load(out)
    assert zs.shape == (2, 4)
    assert np.allclose(zs[:, 2], [Z_LID - 0.05, Z_LID - 0.02], atol=1e-9)
    rep = json.loads((tmp_path / "zs_iter0.json").read_text())
    assert rep["p0_ref_m2s2"] == pytest.approx(3.0)
    assert rep["zs_vs_Z_LID_mm"]["min"] == pytest.approx(-50.0, abs=1e-6)
    assert rep["zs_vs_Z_LID_mm"]["mean"] == pytest.approx(-35.0, abs=1e-6)
    assert rep["lid_residual_mm"]["max_abs"] == pytest.approx(50.0, abs=1e-6)


def test_post_figure_writes_a_png(tmp_path):
    pytest.importorskip("matplotlib")
    d = tmp_path / "export"
    d.mkdir()
    lid_pts = [(0, 0, Z_LID), (1, 0, Z_LID), (1, 1, Z_LID), (0, 1, Z_LID)]
    _write_vtk(d / "lid.vtk", lid_pts, [[0, 1, 2, 3]], [0.0], [(0, 0, 0)])
    np.save(tmp_path / "zs_iter1.npy", np.array([[0.5, 0.5, Z_LID - 0.01, 1.0]]))
    (tmp_path / "zs_iter1.json").write_text(json.dumps(
        {"lid_residual_mm": {"rms": 10.0, "max_abs": 10.0}, "zs_vs_Z_LID_mm": {"min": -10.0, "mean": -10.0}}))
    png = tmp_path / "lid_iter1.png"
    r = subprocess.run(
        [sys.executable, os.path.join(KIT, "lidkit_post.py"), str(d / "lid.vtk"), str(tmp_path), "1", str(png),
         "--z-lid", str(Z_LID), "--tol", "3", "--name", "Box"],
        capture_output=True, text=True, timeout=300,
    )
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-2000:]
    assert png.stat().st_size > 1000

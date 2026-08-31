"""Fixtures for the REAL chamber-builder geometry tests.

These tests run scripts/buildChamber.py end-to-end with the actual CadQuery/OCC
kernel — no mocks. They need the pinned geometry environment
(scripts/requirements-geometry.txt); when cadquery is not importable the whole
suite SKIPS with a pointer instead of failing, so `pytest` stays green on dev
machines without the env (CI always installs it and is the authority).

Builds are expensive (tens of seconds each), so each params fixture is built at
most ONCE per session and every test asserts against the cached result.
"""

import json
import os
import subprocess
import sys
from dataclasses import dataclass

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "buildChamber.py")
PARAMS_DIR = os.path.join(HERE, "params")

# A single real build is normally well under 2 minutes; a hung OCC boolean
# should fail the test, not stall the whole CI job.
BUILD_TIMEOUT_S = 600

try:
    import cadquery  # noqa: F401
    import trimesh  # noqa: F401

    HAS_GEOMETRY_ENV = True
except ImportError:
    HAS_GEOMETRY_ENV = False

def pytest_collection_modifyitems(config, items):
    """Skip every test in this directory when the geometry env is absent."""
    if HAS_GEOMETRY_ENV:
        return
    skip = pytest.mark.skip(
        reason=(
            "cadquery/trimesh not installed - the geometry suite runs in CI; "
            "locally: pip install -r apps/api/scripts/requirements-geometry.txt"
        ),
    )
    for item in items:
        item.add_marker(skip)


@dataclass
class BuildResult:
    """One completed builder run: process outcome + output directory."""

    name: str
    exit_code: int
    stdout: str
    stderr: str
    out_dir: str

    @property
    def manifest(self):
        with open(os.path.join(self.out_dir, "manifest.json")) as fh:
            return json.load(fh)

    @property
    def build_meta(self):
        path = os.path.join(self.out_dir, "build-meta.json")
        if not os.path.exists(path):
            return None
        with open(path) as fh:
            return json.load(fh)

    def export_path(self, *parts):
        return os.path.join(self.out_dir, "exports", *parts)

    def load_stl(self):
        import trimesh

        return trimesh.load(self.export_path("chamber.stl"))


def run_builder(params_path: str, out_dir: str, name: str) -> BuildResult:
    """Run buildChamber.py exactly as the API does: python <script> <params> <out>."""
    proc = subprocess.run(
        [sys.executable, SCRIPT, params_path, out_dir],
        capture_output=True,
        text=True,
        timeout=BUILD_TIMEOUT_S,
    )
    return BuildResult(
        name=name,
        exit_code=proc.returncode,
        stdout=proc.stdout,
        stderr=proc.stderr,
        out_dir=out_dir,
    )


@pytest.fixture(scope="session")
def build(tmp_path_factory):
    """Build a named params fixture (params/<name>.json) once per session."""
    cache: dict[str, BuildResult] = {}

    def _build(name: str, params_override: dict | None = None) -> BuildResult:
        key = name if params_override is None else f"{name}:{json.dumps(params_override, sort_keys=True)}"
        if key in cache:
            return cache[key]
        params_path = os.path.join(PARAMS_DIR, f"{name}.json")
        out_dir = str(tmp_path_factory.mktemp(f"build-{name}"))
        if params_override is not None:
            with open(params_path) as fh:
                params = json.load(fh)
            params.update(params_override)
            params_path = os.path.join(out_dir, "params.json")
            with open(params_path, "w") as fh:
                json.dump(params, fh)
        cache[key] = run_builder(params_path, out_dir, name)
        return cache[key]

    return _build

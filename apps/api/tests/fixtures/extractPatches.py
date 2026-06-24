# Test fixture: a stub standing in for the real apps/api/scripts/extractPatches.py.
# The mesh-extraction pipeline checks the script exists before spawning python;
# the real script (and its heavy pyvista/trimesh deps) lives outside the test
# path, so the tests point the EXTRACT_PATCHES_SCRIPT env var at this stub and
# fake the command runner. This file is therefore never actually executed.
import sys
sys.exit("stub: this script is never run; the test runner is faked")

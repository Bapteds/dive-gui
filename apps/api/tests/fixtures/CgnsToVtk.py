# Test fixture: a stub standing in for the real python/CgnsToVtk.py.
#
# The conversion pipeline checks that the configured CGNS->VTK script exists on
# disk before spawning pvpython (a fail-fast for a clearer error). The real
# script lives outside the app repo, so the test suite points
# CGNS_TO_VTK_SCRIPT at this committed stub (see vitest.config.ts) and injects a
# fake command runner — this file is never actually executed.
import sys

sys.exit("stub: this script is never run; the test runner is faked")

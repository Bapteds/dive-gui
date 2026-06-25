# Test fixture: a stub standing in for the real python/CgnsToVtk.py.
#
# The conversion pipeline checks that the configured CGNS->VTK script exists on
# disk before spawning the python3 interpreter (a fail-fast for a clearer
# error). The real script (apps/api/scripts/CgnsToVtk.py) needs the VTK wheel,
# which isn't installed for the unit tests, so the suite points
# CGNS_TO_VTK_SCRIPT at this committed stub (see vitest.config.ts) and injects a
# fake command runner — this file is never actually executed.
import sys

sys.exit("stub: this script is never run; the test runner is faked")

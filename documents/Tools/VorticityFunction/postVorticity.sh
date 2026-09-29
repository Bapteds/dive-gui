#!/bin/bash
#------------------------------------------------------------------------------
# Prepare fields for vorticity / Q-criterion analysis WITHOUT re-running the
# solver. Uses the `postProcess` utility (reads existing fields, computes
# derived ones) exactly like the SETUP_EXAMPLE did for Q and vorticity, plus
# writeCellVolumes for the cell-volume field V (mesh resolution / enstrophy),
# and (added 2026-09-29, user: "edit the postVorticity script ... to also
# include this Qfiltered") the wall-distance field and Qfiltered = Q masked to
# the cells farther than <distance> from any wall, merged from postQfiltered.sh.
#
#   usage: ./postVorticity.sh <caseDir> [distance_m]    # latest (converged) time; distance default 0.03 m
# Writes, into the latest time directory:
#   Q            [1/s^2]   Q-criterion  (0.5*(|Omega|^2 - |S|^2))
#   vorticity    [1/s]     curl(U)
#   V            [m^3]     cell volumes
#   wallDistance [m]       distance to the nearest wall (wallDist, meshWave; coded FO run once)
#   Qfiltered    [1/s^2]   Q where wallDistance > distance, else 0 (near-wall shear masked out)
# and prints the Q>5 vortex volume, unmasked and masked.
#
# Requires the OpenFOAM environment: source .../openfoam2606/etc/bashrc
#------------------------------------------------------------------------------
CASE="$1"
DIST=${2:-0.03}
cd "$(dirname "$0")/$CASE" || exit 1
. "${WM_PROJECT_DIR:?source the OpenFOAM bashrc first}/bin/tools/RunFunctions"

postProcess -func Q                -latestTime > log.post_Q         2>&1
postProcess -func vorticity        -latestTime > log.post_vorticity 2>&1
postProcess -func writeCellVolumes -latestTime > log.post_V         2>&1

lt=$(foamListTimes | tail -1)
echo "$CASE: wrote Q, vorticity, V into $lt/"
ls "$lt" | grep -E '^(Q|vorticity|V)$' | tr '\n' ' '; echo

# ---- wallDistance: a coded function object (wallDist) run once by postProcess on a temporary copy of controlDict
cp system/controlDict system/controlDict.solverbak
python3 - <<PY
txt = open('system/controlDict.solverbak').read()
i = txt.index('\nfunctions')
j = txt.index('{', i); d, k = 1, j+1
while d: d += {'{':1, '}':-1}.get(txt[k], 0); k += 1
fo = '''
functions
{
    wallDistWrite
    {
        type            coded;
        libs            (utilityFunctionObjects);
        name            wallDistWrite;
        codeInclude
        #{
            #include "wallDist.H"
        #};
        codeWrite
        #{
            const volScalarField& y = Foam::wallDist::New(mesh()).y();
            volScalarField yOut("wallDistance", y);
            yOut.write();
        #};
    }
}
'''
open('system/controlDict', 'w').write(txt[:i] + fo + txt[k:])
PY
postProcess -latestTime > log.wallDist 2>&1
cp system/controlDict.solverbak system/controlDict && rm system/controlDict.solverbak
[ -f "$lt/wallDistance" ] || { echo "wallDistance MISSING in $lt (see log.wallDist)"; exit 1; }

# ---- Qfiltered: Q masked to the cells farther than DIST from any wall; Q>5 volumes with and without the mask
python3 - "$lt" "$DIST" <<'PY'
import re, sys
import numpy as np
T, DIST = sys.argv[1], float(sys.argv[2])

def scalars(path):
    t = open(path).read()
    m = re.search(r'internalField\s+nonuniform List<scalar>\s*\n(\d+)\s*\n\(', t)
    n = int(m.group(1)); b = t[m.end():]
    return np.fromstring(b[:b.index(')\n;')], sep='\n')[:n]

Q = scalars(f'{T}/Q'); y = scalars(f'{T}/wallDistance'); Vc = scalars(f'{T}/V')
Qf = np.where(y > DIST, Q, 0.0)
vals = '\n'.join(f'{v:.6g}' for v in Qf)
open(f'{T}/Qfiltered', 'w').write(f"""FoamFile
{{
    version     2.0;
    format      ascii;
    class       volScalarField;
    location    "{T}";
    object      Qfiltered;
}}

// Q-criterion masked to cells farther than {DIST} m from any wall
dimensions      [0 0 -2 0 0 0 0];

internalField   nonuniform List<scalar>
{len(Qf)}
(
{vals}
)
;

boundaryField
{{
    ".*"
    {{
        type            zeroGradient;
    }}
}}
""")
a, m = Q > 5, (Q > 5) & (y > DIST)
print(f'Qfiltered written to {T}/ | Q>5 volume: unmasked {Vc[a].sum():.4f} m3 '
      f'({a.sum()} cells) -> {DIST*1000:.0f}mm-masked {Vc[m].sum():.4f} m3 ({m.sum()} cells)')
PY
echo "$CASE: wrote wallDistance, Qfiltered into $lt/"

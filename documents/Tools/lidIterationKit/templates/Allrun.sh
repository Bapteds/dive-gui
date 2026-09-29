#!/bin/sh
# LID ITERATION KIT — one iteration case: mesh copied from MESHSRC, parent BC family, then the lid export for the next surface.
cd "${0%/*}" || exit 1
. "${WM_PROJECT_DIR:?Source an OpenFOAM environment first}/bin/tools/RunFunctions"
MESHSRC="${MESHSRC:?set MESHSRC=<mesh polyMesh dir>}"
[ -f "$MESHSRC/owner" ] || { echo "ERROR: no mesh at $MESHSRC"; exit 1; }
rm -f log.renumberMesh log.potentialFoam log.decomposePar log.simpleFoam log.reconstructPar log.postProcess.lidSurfaces
rm -rf processor* postProcessing 0 [1-9]* constant/polyMesh
cp -r "$MESHSRC" constant/polyMesh; rm -rf constant/polyMesh/sets
runApplication renumberMesh -overwrite
cp -r 0.orig 0
runApplication potentialFoam -writephi -initialiseUBCs
runApplication decomposePar
runParallel simpleFoam
runApplication reconstructPar -latestTime
runApplication postProcess -func lidSurfaces -latestTime
echo "Done."

# OpenFOAM v2606: RMS vorticity inside a Q-core region

This template is intended for a converged steady `simpleFoam` case. It computes

```text
omegaRMS = sqrt( integral_zone(|curl(U)|^2 dV) / integral_zone(dV) )
```

over the cell zone

```text
vortexQcore = { cells where Q > Qcrit and cell volume V > Vmin }.
```

`V > Vmin` is an approximation for excluding boundary-layer cells. It also
excludes any other cells smaller than `Vmin`, such as fine tip-gap or wake
refinement cells. It cannot guarantee that every prism-layer cell is removed
unless cell volume cleanly separates the layers from the rest of the mesh.

## Files

- `system/vorticityRMSFields`: creates `QForVorticityRMS`,
  `vorticityForVorticityRMS`, `omegaMagSqrForVorticityRMS`, and `V`.
- `system/topoSetDict.vorticityRMS`: creates the `vortexQcore` cell zone.
- `system/vorticityRMSMetric`: volume-averages squared vorticity in that zone.
- `calculateVorticityRMS.py`: takes the square root and writes the final RMS.

OpenFOAM v2606 `volFieldValue` supports `volAverage`, but not a direct RMS
operation. The Python helper only performs the final square root; it does not
recalculate any CFD field and needs no third-party packages.

## Manual settings — required

### 1. Velocity field

In `system/vorticityRMSFields`, set the same `field` in both marked locations:

```foam
field U;
```

Use:

- `U` for absolute/stationary-frame vorticity and Q;
- `Urel` for blade-relative vorticity and Q, provided `Urel` exists at the
  processed time.

Do not calculate Q from one velocity field and vorticity from another.

### 2. Q threshold

In `system/topoSetDict.vorticityRMS`, replace:

```foam
min QCRIT_VALUE;
```

with a number in `1/s2`, for example:

```foam
min 2e4;
```

The example is not a recommendation. Select `Qcrit` for your operating point
and then use exactly the same value for every design variant.

### 3. Cell-volume threshold

In the same file, replace:

```foam
max VMIN_VALUE;
```

with the largest cell volume that should be treated as boundary-layer/fine
mesh, in `m3`, for example:

```foam
max 2e-10;
```

The `delete` action removes cells with `V <= Vmin`. Inspect the `V` field or a
cell-volume histogram before choosing this value.

### 4. Names, only if you change them

The following names must stay consistent between files:

```text
QForVorticityRMS
omegaMagSqrForVorticityRMS
vortexQcore
vorticityMeanSquareQcore
```

You normally do not need to change them.

## Procedure

Copy the three supplied files into the case `system` directory and put
`calculateVorticityRMS.py` in the case root.

### Stage 1: create the fields

Inside the existing `functions` dictionary in `system/controlDict`, add only:

```foam
#include "vorticityRMSFields"
```

Run at the final time:

```bash
postProcess -latestTime
```

For a decomposed case, use:

```bash
postProcess -parallel -latestTime
```

Check that the latest time now contains:

```text
QForVorticityRMS
vorticityForVorticityRMS
omegaMagSqrForVorticityRMS
V
```

### Stage 2: create the Q-core cell zone

Serial/reconstructed case:

```bash
topoSet -latestTime -dict system/topoSetDict.vorticityRMS
```

Decomposed case:

```bash
topoSet -parallel -latestTime -dict system/topoSetDict.vorticityRMS
```

This creates the cell zone `vortexQcore` from cells satisfying both:

```text
QForVorticityRMS >= Qcrit
V > Vmin
```

### Stage 3: calculate the volume mean of squared vorticity

Add the second include inside the same `functions` dictionary:

```foam
#include "vorticityRMSMetric"
```

The block should now contain both includes:

```foam
functions
{
    #include "vorticityRMSFields"
    #include "vorticityRMSMetric"
}
```

Run `postProcess` again, serial or parallel as above. OpenFOAM writes the mean
squared vorticity under:

```text
postProcessing/vorticityMeanSquareQcore/
```

The `volFieldValue` output also reports the selected cell count and zone
volume, which are useful checks across design variants.

### Stage 4: take the square root

From the case root:

```bash
python3 calculateVorticityRMS.py .
```

The final file is:

```text
postProcessing/vorticityRMS_Qcore/vorticityRMS_Qcore.csv
```

Its `rms_vorticity_1_per_s` column is the requested metric.

## Interpretation and comparison rules

- The result has units `1/s`.
- A larger value means stronger RMS vorticity inside the cells that passed the
  Q and volume thresholds.
- The zone is generated from the analyzed time and is therefore static. For a
  transient case, regenerate it for every required time or use a dynamic mask.
- Keep `Qcrit`, `Vmin`, velocity frame, mesh strategy, and operating point the
  same across variants.
- A different `vortexQcore` volume can change the RMS because it changes the
  population being averaged. Report both RMS vorticity and the zone volume.


## postVorticity.sh — Q, vorticity, V, wallDistance and Qfiltered in one call (added 2026-09-29)

Independent of the RMS metric above: a plain post-processing script for any converged case (no solver run, no function
objects to install). Copy it next to your case folders (it changes into `<caseDir>` relative to its own location) and run,
with the OpenFOAM v2606 environment sourced:

```bash
./postVorticity.sh <caseDir> [distance_m]      # distance default 0.03 m
```

It writes into the latest time directory: `Q`, `vorticity`, `V` (cell volumes), `wallDistance` (wallDist meshWave, via a
coded function object run once by `postProcess` on a temporary copy of `system/controlDict` — the controlDict is restored
afterwards, so it needs a `functions { ... }` block, even an empty one) and `Qfiltered` = Q where wallDistance > distance,
else 0 (masks the near-wall shear so that Q-isosurfaces show the free vortices only). It prints the Q > 5 vortex volume with
and without the mask. Needs python3 with numpy (for `Qfiltered`); nothing else.

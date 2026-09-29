# ConvergenceFunctions — portable convergence toolkit

Drop-in convergence auto-stop + monitoring for a steady `simpleFoam` draft-tube
(or any single-inlet/single-outlet) case. Copy the files you need into a model,
edit the input blocks, run.

## Files
| file | what it is |
|---|---|
| `convergenceControl`        | **robust** auto-stop (coded FO): Dp0 mean-drift + zero-slope + residual gate, K consecutive checks. **Recommended.** |
| `SimplePDropConvergence`    | **simpler** auto-stop (coded FO): Dp0 within ±devTol of trailing mean for N consecutive iters. |
| `pressureLossMonitors`      | function objects producing `pTotal` + the inlet/outlet total-pressure logs the plot & SimplePDrop read. |
| `plotConvergence.py`        | residuals + Dp0 + zoom + Cp figure (`convergence.png`). Mirrors `convergenceControl`. |

Pick **one** of the two convergence FOs.

## Apply to a new model (robust option)
1. Copy into the case `system/`:  `convergenceControl`  and  `pressureLossMonitors`.
2. In `system/controlDict`, inside `functions { ... }`:
   ```
   #include "pressureLossMonitors"
   #include "convergenceControl"
   ```
3. In `system/fvSolution`, **delete the `residualControl` block** from `SIMPLE`
   (else the solver stops on residuals alone and bypasses the FO).
4. Edit the **USER INPUTS** at the top of each file (patch names + tolerances;
   see below). In `pressureLossMonitors` edit the `name inlet` / `name outlet`
   patch names if yours differ (keep the object names).
5. Copy `plotConvergence.py` into the case root; edit its **USER CONFIG** block
   (`APP`, and `W,TOLMEAN,K,RESTOL` to match the FO). Run `python3 plotConvergence.py`.

Simpler option: copy `SimplePDropConvergence` + `pressureLossMonitors` instead of
`convergenceControl`, and `#include` it (residualControl can stay — it has no
residual gate). Edit its input block.

## Inputs (convergenceControl / plotConvergence)
| input | meaning | default |
|---|---|---|
| `inletPatch`, `outletPatch` | patch names for Dp0 | inlet / outlet |
| `W`        | averaging / check window [iterations] | 100 |
| `tolMean`  | [Pa] gate for mean-drift (crit 1) and slope·(W-1) (crit 2) | 50 |
| `K`        | consecutive passing checks required | 2 |
| `resTol`   | max initial residual (all eqns) allowed in the window | 1e-3 |

`SimplePDropConvergence`: `window` (100), `devTol` (0.03 = ±3%), `nPass` (100).

## ⚠ resTol caveat
For swirling / vortex-rope flows the steady residuals limit-cycle and don't reach
1e-4 (often a floor ~1e-3, sometimes higher — dominated by `k` or `p`). If
`resTol` is set below that floor the gate never passes and the run rides to
`endTime`. **Set `resTol` just above your case's residual floor** (read it from the
plot's residual panel), or use the simple FO which has no residual gate.

## How convergence is judged (why it's robust)
Steady RANS on a rope oscillates ±~100 Pa on Dp0 and never gives 1e-4 residuals.
Judging by `|instantaneous − mean|` (the OpenFOAM built-in `average`) is fooled by
the oscillation crossing its own mean, and by a slow ramp passing through the mean.
This toolkit instead requires the **windowed mean to stop drifting** AND the
**slope to be ~0**, held for K checks — insensitive to where the oscillation is.
The residual gate is an extra sanity check.

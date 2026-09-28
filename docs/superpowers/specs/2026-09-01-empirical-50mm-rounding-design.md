# 50 mm rounding of empirical chamber dimensions — design

**Date:** 2026-09-01
**Status:** approved (user-refined over three rounds; final rule below)

## Goal

Dimensions the app finds on its own (the empirical X1/X2/X3 model and its
relations) are estimates; manufacturing-friendly values sit on a 50 mm grid.
Snap those estimates to the nearest 50 mm — but never touch a number the user
entered, and never break a true identity driven by a user-entered number.

## Where

`computeChamberOutputs` in `packages/shared/src/index.ts` — the single place
the model lives. The web live Parameters table, the server build
(`chamber.service.ts`), and the cache hash all read it, so they agree for
free. The Python builder is untouched (it receives resolved metres and does no
model math).

## The rule

Every output carries an internal **user-driven** marker:

- **Directly user-driven:** its final came from the user — status `set exact`,
  `capped at max`, or `raised to min`.
- **Inherited:** an *identity* relation output is user-driven when any partner
  in its chain is user-driven.

Then, per output:

1. **Fitted formulas are ALWAYS snapped** to the nearest 50 mm
   (`Math.round(v / 50) * 50`), and are never user-driven by inheritance:
   - each output's own X1/X2/X3 fit (`linear` / `power`);
   - `refine` fits (e.g. B Kammer sharpened by a measured B1) — still a
     regression estimate, so still snapped;
   - **LE `= f(HLE)`** (255.16 + 3.4954 × HLE) — a fitted formula despite
     being a `combination` relation, so snapped even when HLE is user-defined
     (explicit user decision).
2. **True identities propagate user-driven values verbatim:**
   `BF1 = LF1`, `LF2 = LF1`, `BF2 = LF2`, `LT = LF1 + LF2`,
   `H Kammer = LEB + LEOW`, `LEB = 2 × HLE`, and the auto
   `Length = 2 × B Kammer` (in `resolveGeometryParams`). When any partner is
   user-driven the result is NOT rounded (LF1 = 1 012 ⇒ BF1 = 1 012,
   LT = 2 024; HLE = 253 ⇒ LEB = 506). When the whole chain is empirical the
   result is snapped — usually a no-op, since snapped partners keep sums
   on-grid.
3. **Snapping happens BEFORE the user's Min/Max clamp**, and the clamp
   compares against the snapped value: model 3 524 with max 3 510 caps to
   3 510 (user's number verbatim); with max 3 560 the final is the snapped
   3 500. An output whose clamp bites becomes user-driven for anything
   downstream. `! min>max` keeps today's behaviour (snapped model value,
   flagged status).
4. `set exact` is the user's value verbatim, always.

## Mechanics

- New shared constant `CHAMBER_GRID_MM = 50` and helper
  `snapToChamberGrid(v)`; exported so tests and the service use one
  definition.
- `ChamberRelation` gets `empirical?: boolean` — set only on dLast's
  `= f(HLE)` relation — meaning "this relation's result is a fitted estimate:
  always snap, never inherit user-driven".
- `computeChamberOutputs` tracks the user-driven marker per output while
  resolving (pass 1 fits, pass 2 combination fixpoint). The marker is exposed
  on `ChamberOutput` as `userDriven: boolean` so `resolveGeometryParams` can
  decide the auto-Length rule and tests can assert propagation.
- `resolveGeometryParams` (chamber.service.ts): auto length =
  `2 × width.final`, snapped only when width is not user-driven;
  `lengthOverride` is passed through untouched, as today.

## Out of scope

- The ratio-derived geometry hints (D first / D middle from D last, generator
  diameter/height, dome height) — fixed geometric ratios, not empirical fits;
  they keep full precision.
- The Python builder and its golden fixtures (they take direct metre params).

## UI

No new status and no new column: the Model column keeps the raw regression
value, Final shows the snapped or propagated value. The difference between the
two IS the rounding, visible as-is.

## Side effect (accepted)

Every build's param hash changes (finals move to the grid), so previously
cached builds rebuild on next request. No migration needed.

## Tests (apps/api/tests/chamberModel.test.ts + service tests)

- A fitted output's final is a multiple of 50 and equals the snapped model.
- `set exact` off-grid value is untouched; identity partners (`BF1 = LF1`,
  `LT = LF1 + LF2`) equal it verbatim, off-grid.
- `LEB = 2 × HLE` with HLE exact 253 → 506 verbatim; H Kammer = LEB + LEOW
  stays the exact sum.
- LE with HLE exact 253 → snap(255.16 + 3.4954 × 253) — rounded despite the
  user-defined HLE.
- Min/Max clamps compare against the snapped value and yield the bound
  verbatim when they bite; a bitten clamp marks the output user-driven and
  propagates through identities unrounded.
- Purely empirical chains: every final is on-grid (H Kammer sum no-op case).
- Auto Length: 2 × snapped width (on-grid) when width empirical; 2 × exact
  width verbatim when width user-driven; `lengthOverride` untouched.

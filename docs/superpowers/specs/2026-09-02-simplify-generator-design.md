# "Simplify Generator" option (hollow variant) — design

**Date:** 2026-09-02
**Status:** approved

## Goal

A new toggle (off by default, hollow variant only): when ON, the generator
(central cylinder) becomes a STRICT cylinder from the top of the middle
cylinder pinned THROUGH the box top — exactly the stepped variant's mechanism
for its last cylinder (`+2·FLOOR_OVERCUT` above the top so the boolean cut
opens a circular hole in the box's top face) — and **no dome is built**.
Generator Ø keeps coming from the Gen Dim model (Power/X4 and the Ø override
still matter); Generator height and Dome height become meaningless: their form
fields are hidden while the toggle is on, and values present in old saves are
silently ignored (same pattern as vaneAngleDeg when guideVanes is off).

## Builder (`buildChamber.py`)

- New param `simplifyGenerator` (bool, default false; read like `guideVanes`).
  Hollow branch only. When true:
  - `centralHeight` / `domeHeight` are NOT read (the API omits them); the >0
    validation covers only `hollowLength` and `centralDiameter`.
  - The fit/overflow check uses `h_first + h_middle + hollow_len` vs H Kammer
    (the generator fits by construction); its refusal message names the CONE
    stack and levers (no "generator + dome" wording in this mode).
  - After partScale is applied: `c_h_local = (height + 2·FLOOR_OVERCUT) −
    (h_first + h_middle)` (mirrors stepped's `last_h_local`; positive whenever
    the cone stack fits, since hollow_len > wall > 0).
  - `make_part_hollow` accepts `dome_h=None` → no dome union; callers pass the
    computed `c_h_local` as `c_h`. `part_height = height + 2·FLOOR_OVERCUT`.
  - The "central diameter exceeds the hollow bore" WARN and every radial check
    are unchanged.
- After the builder change, purge the build cache
  (`rm -rf apps/api/storage/chamber/*`) — house rule (hash covers params, not
  code).

## API

- `chamberBuildSchema`: `simplifyGenerator: z.boolean().default(false)` (pattern:
  `guideVanes`). `ChamberInput.simplifyGenerator?: boolean` in shared.
- `buildParams` hollow branch: `params.simplifyGenerator` is ALWAYS set (part of
  the cache key, like the other geometry flags); when true,
  `params.centralHeight` / `params.domeHeight` are OMITTED — two bodies
  differing only in a hidden height land on the SAME cached build. The flag is
  not written for the stepped variant (a stray `simplifyGenerator: true` on a
  stepped body does not re-key).
- `params.centralDiameter` (resolved via `computeChamberGeneratorDims`) is
  passed in both modes; the shared function is untouched.

## Web

- `ChamberFormValues.simplifyGenerator: boolean` (non-optional, like guideVanes),
  schema `z.boolean()`, default `false`, snapshot-load fallback to the default.
- A checkbox styled like Guide vanes / Chamfer / Feet, INSIDE the
  `variant === 'hollow'` block, above the hollow field grid:
  label "Simplify generator", description "Extend the generator as a
  straight cylinder through the chamber top — no dome (like the closed
  design's last cylinder)."
- Checked → the "Generator height (mm)" and "Dome height (mm)" fields are NOT
  rendered (Power and Generator Ø stay). Unchecking restores them with any
  previously typed values (form state is kept; the API simply ignores hidden
  values while the flag is on).
- Saves, the staleness note, and the invalid-submit summary pick the field up
  automatically (it is a plain form value).

## Tests

- **Geometry** (`test_build_chamber.py`): flag-on build of the hollow-vanes
  fixture asserts exit 0, watertight STL, and the PIERCING: a horizontal
  cross-section just below the box top has TWO closed loops (box rectangle +
  generator bore) with the flag vs ONE without it (solid ceiling; flag-off
  comparison run at a partScale small enough that the dome stays below the
  top). The overflow refusal still fires with cone-stack wording when
  hollow_len alone overgrows H Kammer at the given scale.
- **API** (`chamber.test.ts`): default false; the flag re-keys a hollow build;
  with the flag ON, two bodies differing only in centralHeight/domeHeight give
  the SAME hash; with it OFF they differ (existing behavior); a stepped body
  with the flag gives the stepped hash.
- **Web**: toggle renders in the hollow section only; checking hides the two
  fields and submitting carries `simplifyGenerator: true`; snapshot round-trip
  (old saves without the field load as false).
- Suites: geometry (WSL, ~6 min), API chamber trio, web chamber, typecheck.

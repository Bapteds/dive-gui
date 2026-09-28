# Chamber vocabulary sweep (display copy only) — design

**Date:** 2026-09-02
**Status:** approved

## Goal

Align every user-visible chamber string with the current vocabulary. The old
words are legacy: **"stepped" → "Closed generator"**, **"box" → "chamber"**,
and the anonymous "cylinders" are now named parts — **runner case** (first),
**outlet** (middle), **cone** (the open-top cup), **generator** (central).
The design menu options lose their explanations ("Closed generator" and
"With cone", nothing after). Internal identifiers (`variant: 'stepped' |
'hollow'`, `dMiddle`, param keys, saves, cache) are UNCHANGED.

## The string changes (all in `ChamberInputsForm.tsx` unless noted)

1. Field label "Cylinder design" → **"Design"**.
2. Options: "Closed generator — three solid cylinders" → **"Closed generator"**;
   "With cone — open-top cone" → **"With cone"**.
3. Guide vanes description: "Replace the middle cylinder with…" →
   "Replace the **outlet** with a ring of guide vanes (both designs)."
4. Chamfer description: "…square-ended box - the rest of the geometry
   (cylinders, feet, outputs table)…" → "…square-ended **chamber** - the rest
   of the geometry (**internals**, feet, outputs table)…".
5. Feet description: "…keep the box solid… - the cylinders and outputs table…"
   → "…keep the **chamber** solid… - the **internals** and outputs table…".
6. Part scale helper: "Scales all cylinders, feet & vanes together; box & axis
   stay fixed. Stepped: overgrowing the box is refused; cone: scaled down to
   fit" → "Scales runner case, outlet, cone & generator, feet & vanes
   together; chamber & axis stay fixed. Closed generator: overgrowing the
   chamber is refused; with cone: scaled down to fit".
7. dMiddle field label "Guide vanes Ø (mm)" → **"Outlet Ø (mm)"** (the middle
   cylinder IS the outlet; helper keeps "· sets the vane ring in guide-vane
   builds").
8. Simplify generator description: "…no dome (like the closed design's last
   cylinder)." → "…no dome (as in the Closed generator design)."
9. `packages/shared` relation descriptions (visible in the relations
   dropdown): "H Kammer = LEB + LEOW (middle+first plus last cylinder
   height)." → "…(runner case + outlet heights plus the height above them)."
   and "LEB = 2 × HLE (middle+first height is twice the middle height)." →
   "…(runner case + outlet height is twice the outlet height)."

## Out of scope (accepted remnants)

- Code/doc comments, keys, the `variant` enum values.
- Python builder KO/WARN texts ("stick out of the box", "the cylinder
  shoulder…") — same precedent as the X1 rename: renaming there means
  geometry-suite churn for copy; offered as a separate sweep if wanted.
- The Chamber page header/subtitle (already speaks "chamber").

## Tests

No existing test pins any changed string (verified by grep); the web chamber
suite + typecheck re-run green. Shared changes → rebuild shared first.

## Addendum (2026-09-02, user correction)

"Outlet" is NOT the middle cylinder — it is the flow outlet (in the no-vane
build it sits further downstream; in vane builds the guide vanes take the
middle region). Reverted from the first pass: the dMiddle field label stays
**"Guide vanes Ø (mm)"** (+ its FIELD_LABELS entry), the guide-vanes toggle
description says "middle cylinder" again, the Part scale helper enumerates
"runner case, middle cylinder, cone & generator", and the two shared relation
descriptions return to their original height wording. Kept from the first
pass: menu options, "Design" label, chamber-for-box, Closed generator.

Additionally the builder's two user-visible WARNING texts drop the last X
references (previous sweeps had left them): "(X1 too large for this
vane/d_last combination)" → "(Runner Ø too large …)" and "hub shoulder
non-monotonic (X1 too large for the point spacing)" → "(Runner Ø too large
for the point spacing)". Geometry unchanged (print strings only — py_compile
+ the simplify geometry tests re-run as smoke; cache purged per house rule);
the fake-runner fixtures in chamber.test.ts / ChamberBuildWarnings.test.tsx
updated to match.

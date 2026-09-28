# Physical names for X1–X4 (display only) — design

**Date:** 2026-09-02
**Status:** approved

## Goal

The chamber inputs stop being anonymous: **X1 → Runner Ø (mm), X2 → Head (m),
X3 → Q_max (m³/s), X4 → Power (kW)** (the units make the Gen Dim chain
readable: Power = 0.9 · 9.81 · Head · Q_max). DISPLAY ONLY: the internal keys
(`x1`…`x4`), the API body, saved-build snapshots, and cache keys are
unchanged — old saves and cached builds keep working verbatim.

## The six user-visible changes

1. `ChamberInputsForm` labels: "X1"/"X2"/"X3" → "Runner Ø (mm)" / "Head (m)" /
   "Q_max (m³/s)". The "Valid min–max" range helpers stay as they are.
2. The X4 field: label → "Power (kW)"; hint →
   `Blank = auto ≈ N kW (0.9 · 9.81 · Head · Q_max)` (and the no-value variant
   `Blank = auto (0.9 · 9.81 · Head · Q_max)`).
3. Relations copy: "…make every parameter depend on X1–X3 only." →
   "…make every parameter depend on Runner Ø / Head / Q_max only."
4. `ChamberPage` `FIELD_LABELS` (the invalid-submit error summary):
   x1/x2/x3/x4 → the four new labels.
5. `ChamberViewer` empty state: "Enter X1, X2, X3 and a length, then Generate…"
   → "Enter Runner Ø, Head and Q_max plus a length, then Generate…".
6. API 422 refusal (chamber.service.ts): "…Adjust X1/X2/X3, the structural
   relations, or the Min/Max/Exact constraints." → "…Adjust Runner Ø / Head /
   Q_max, the structural relations, or the Min/Max/Exact constraints."

Accepted near-collision: "Runner Ø (mm)" (X1, the runner itself) coexists with
"Runner case Ø (mm)" (`dFirst`, the first-cylinder case) — the user confirmed
they are different things and the labels stand.

## Unchanged on purpose

- Code/doc comments, constant and key names (`CHAMBER_X4_MAX`, `x4`, …) —
  developer-facing, and they cite the workbook, which speaks X1–X4.
- The Python builder's texts (e.g. the "X1 too large for this vane/d_last
  combination" warning): renaming there means geometry-suite churn for a
  label; it stays as the one X-name a user can still meet. Accepted.

## Tests

Label queries and strings pinned by existing tests move with the rename:
`ChamberInputsForm.test.tsx` (`getByLabelText('X1'/'X4')` → new labels, the X4
hint string, test names), and the `ChamberBuildWarnings.test.tsx` fixture
`'X1: Enter a number'` → `'Runner Ø (mm): Enter a number'` (fixture realism).
No new tests: the updated ones pin the new labels. Suites: web chamber vitest,
API chamber vitest trio (no message assertions exist on the 422 text),
typecheck. Shared and the builder are untouched.

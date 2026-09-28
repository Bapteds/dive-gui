# Chamber minor polish: saves robustness, a11y, export nits — design

**Date:** 2026-09-01
**Status:** approved (batch 4 "minor" of the chamber review: findings 15–17)

## 15. Saves robustness

- **Concurrent mutation 500 → clean 404/no-op.** `updateChamberSave` catches
  Prisma P2025 (row deleted between the manage-check and the update) → 404
  NOT_FOUND. `deleteChamberSave` switches to `deleteMany({ where: { id } })`,
  which never throws for a missing row — deleting an already-deleted save is
  simply done.
- **Cascade on user deletion: deliberately KEPT.** `Project` and `Template`
  owners cascade identically; the saves feature was specified to mirror
  templates, so changing only ChamberSave to `SetNull` would break the house
  pattern and force a nullable owner through shared types and UI. If
  off-boarding should preserve shared resources, that is one product decision
  across projects/templates/saves — out of scope here, flagged to the team.

## 16. Accessibility

- **New derived token `--color-accent-strong: #8f4f00`** (Tailwind
  `accent-strong`): dark orange for SMALL text, computed to pass AA 4.5:1 on
  both white (6.4:1) and the `#FFF3E6` tint (5.5:1). The existing
  `accent-hover` (#CC6E00, ~3.3–3.6:1 at 12–14 px) stays for hover states and
  large/bold uses, per the charte. Swapped in the chamber UI:
  - Parameters table: `capped at max` / `raised to min` status text and the
    "Low" confidence pill;
  - Build-warnings panel: the orange heading.
- **`title`-only information becomes reachable.** The confidence pill shows
  the CV error visibly ("Low · 38.9 %") instead of hiding it in a tooltip;
  the `refined` and `no effect` badges gain `sr-only` text carrying their
  explanation (the `title` stays for sighted hover users).

## 17. Export nits

- **The "can take a minute" toast fires once per build.** The export buttons
  remember which kinds already downloaded for the current hash (reset when the
  hash changes); a re-download of a cached STEP no longer warns about a wait
  that won't happen. (The first click still toasts even when another user
  already generated the file server-side — the wording says "can", accepted.)
- **`Cache-Control: private, max-age=31536000, immutable` on export
  downloads** — a hash-addressed artifact never changes once served; geometry/
  edges keep their existing short-lived headers (the viewer revalidates).

## Deliberately declined (from the review's minor list)

- 409 → 404 for unknown hashes on read endpoints: pure churn with behavioral
  risk (the web already maps CHAMBER_NOT_BUILT); no user value.
- Disk quota/eviction for the build cache and a builder-version component in
  the cache key: real but infra-sized features, not polish — separate work if
  wanted.

## Tests

- API: the export download test asserts the immutable Cache-Control header;
  saves suites stay green (the P2025 window itself is not deterministically
  testable — the fix is a straight error-mapping).
- Web: the confidence pill's visible CV %; the STEP toast fires once across
  two downloads of the same build (sonner mocked); existing chamber suites
  green.

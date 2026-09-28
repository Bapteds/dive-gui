# Playbook: Add a chamber input, option or derived parameter

> When to use: a new field on the Chamber Creation form (empirical input, geometry option or flag, manual override of a derived dimension), a new derived output of the empirical model, or a change of the Gen Dim v3 model · Related: `brain/features/chamber-creation.md` (§3.1 to §3.7, §4.7, §5.1, §10), `brain/conventions/vocabulary.md`, `brain/codemap/root-shared-mcp.md` (chamber model), `brain/codemap/api-core.md` (module `chamber`), `brain/codemap/web-features-assemble-chamber.md` (`features/chamber`), `change-chamber-geometry.md` · Updated: 2026-09-28

## Before you start
- Read `brain/features/chamber-creation.md` §3 and §5.1 (what enters the cache hash) and `brain/conventions/vocabulary.md` §1 (display names, keys never change).
- Classify the change, it decides which layers move:
  | Kind | Example | Reaches the builder / hash? |
  |---|---|---|
  | Model-only input | `x4` (Gen Dim v3 only) | never, only through resolved values |
  | Geometry option or flag | `feetEnabled`, `vaneAngleDeg`, `simplifyGenerator` | yes |
  | Override of a derived dimension | `dFirst`, `centralDiameter` | yes, only when typed |
  | New derived output | a 13th entry of `CHAMBER_OUTPUT_SPECS` | yes, always (new Final) |
- Settle with the user (one question at a time): displayed label (English, vocabulary rules, no explanation after a design name), internal key (camelCase, permanent), unit, range, default, which design (`stepped` = Closed generator, `hollow` = With cone), whether it may be hidden, and any Gen Dim v3 change (the workbook `documents/Gen Dim v3 Only Calculator (standalone).xlsx` is the source of record). Then a spec in `brain/specs/`.
- Non-negotiable: **old saves and old cached builds keep working**. A save is a JSON snapshot of the build body (no Prisma column per field, no migration); a cached `params.json` can be re-fed to the builder later.

## Steps
1. **Shared model** (`packages/shared/src/index.ts`):
   - add the field to `ChamberInput` with a JSDoc stating unit, default, design and "geometry-only" or not (model: `simplifyGenerator`, `x4`);
   - bounds as exported constants next to `CHAMBER_INPUT_RANGES` / `CHAMBER_X4_MAX` / `CHAMBER_DIMENSION_MAX_MM` so API and web share them;
   - new derived output: key in `CHAMBER_OUTPUT_KEYS`, spec in `CHAMBER_OUTPUT_SPECS` (fit `linear` or `power`, optional `relation` `refine` / `combination`, `defaultOn`); `computeChamberOutputs` then produces it, the table shows it, and `resolveGeometryParams` sends it to the builder under the same key. A relation also appears in `CHAMBER_RELATIONS`;
   - Gen Dim v3: edit `computeChamberGeneratorDims` only in line with the workbook.
   - `npm run build:shared`.
2. **API schema** `chamberBuildSchema` (`apps/api/src/modules/chamber/chamber.schemas.ts`):
   - options and flags get `.default(<previous behaviour>)` so an old body or save parses to the old geometry (model: `feetEnabled: z.boolean().default(true)`);
   - overrides stay optional (`dimensionMm.optional()`); variant-specific requirements go in `superRefine` (model: `hollowLength`);
   - saves reuse this schema (`chamber-saves.schemas.ts`), so a field missing here is also stripped from every new save: the `validate` middleware replaces `req.body` with the parsed value.
3. **Service** `resolveGeometryParams` (`apps/api/src/modules/chamber/chamber.service.ts`): everything placed in `params` enters `chamberHash(params)`, i.e. the cache key.
   - Add the key only if it changes the geometry, and only in the design where it does (model: the `if (variant === 'hollow')` block; `simplifyGenerator` omits `centralHeight` / `domeHeight` so hidden overrides cannot re-key).
   - Lengths go in metres (`* MM_TO_M`). Overrides are set only when typed (model: `if (input.dFirst != null) params.dFirst = ...`), so a blank field and "auto" hash the same.
   - A model-only input (like `x4`) never goes into `params`; only the values it resolves do.
   - Model-level refusals (422 before any build) belong in `buildChamber` next to `nonPositiveChamberFinals` and the Min > Max check.
4. **Builder** (`apps/api/scripts/buildChamber.py`): read with `P.get("key", <previous behaviour>)`, validate and refuse with `ValueError`, then follow `change-chamber-geometry.md` entirely (pytest first, GOLDEN, **cache purge**). Skip for a model-only input.
5. **Web form contract** (`apps/web/src/features/chamber/chamberForm.ts`):
   - `ChamberFormValues`: the field with its JSDoc;
   - `chamberFormSchema`: the same bounds as the API, with user-facing messages (model: `outletRatio`, `optionalPositive`);
   - `CHAMBER_FORM_DEFAULTS`: the form default (may differ from the API default on purpose, like `guideVanes`: form `true`, API `false`; record such a choice in `brain/decisions.md`);
   - `chamberInputToFormValues`: `input.key ?? CHAMBER_FORM_DEFAULTS.key` for any field with a server default (this is what makes old saves load); plain `input.key` for overrides (blank = auto);
   - an override with an auto value: extend `ChamberAutoDims` and `computeChamberAutoDims`, computing through the shared function so the hint equals the build.
6. **Form UI** (`apps/web/src/features/chamber/ChamberInputsForm.tsx`, reuses primitives: step 4 of the skill sequence is enough unless a new pattern appears):
   - numeric required: `<Field label=... error=... helperText=...><Input type="number" step="any" {...register('key', { valueAsNumber: true })} /></Field>`;
   - optional override: `placeholder="auto"`, `helperText={autoHint(autoDims.key)}` ("Blank = auto ≈ N mm"), `register('key', { setValueAs: numOrUndef })`;
   - flag: copy the `feetEnabled` checkbox label block (title + one-line explanation);
   - design-specific fields go inside the `variant === 'hollow' &&` block; a field that hides others is watched in `ChamberPage` and passed as a prop (model: `simplifyGenerator`).
7. **Page** (`apps/web/src/pages/ChamberPage.tsx`): add the key to `FIELD_LABELS` (used by the "Build errors" list on invalid submit). The stale-build note (`chamberBodyKey`) and the Save snapshot (`{ ...values, constraints }`) pick the field up without code.

## Tests
- `apps/api/tests/chamber.test.ts` (fake builder, no Python): the value re-keys the build and leaves the 12 outputs unchanged (copy `keys the build on the feet-enabled flag, defaulting to on`); explicit default == omitted gives the same hash; no effect in the other design gives the same hash (copy `keys the hollow build on x4 (a new frame) but ignores x4 on stepped`); out-of-range 422 (copy `rejects an outlet ratio outside 0.35-0.50`).
- `apps/api/tests/chamberModel.test.ts`: any model, output, relation or Gen Dim change (parity reference X1 = 1450, X2 = 7, X3 = 10); `chamberSaves.test.ts` if the snapshot normalisation matters.
- `apps/web/src/features/chamber/chamberForm.test.ts`: schema bounds, shipped defaults, round trip, and "defaults on old saves" (copy `round-trips through a saved snapshot and defaults to false on old saves`), hints via `computeChamberAutoDims`.
- `apps/web/src/features/chamber/ChamberInputsForm.test.tsx`: the local `Harness` (`useForm` + `zodResolver`), field visible per design, submitted value; mount fresh to test other defaults.
- Builder touched: the real pytest suite (`change-chamber-geometry.md`).

## Verify
- `npm run build:shared`
- `cd apps/api && npx vitest run tests/chamber.test.ts tests/chamberModel.test.ts tests/chamberSaves.test.ts`
- `cd apps/web && npx vitest run src/features/chamber`
- `npm run typecheck` and `npm run lint` at the root.
- Builder touched: `pytest apps/api/scripts/tests -q` with the CadQuery interpreter, then `rm -rf apps/api/storage/chamber/*`.
- Manual: load an existing saved build (it must open without validation errors and generate the same geometry), toggle the new field, check the "Inputs changed since this build" note and the "Build errors" label.

## Update the brain
- [ ] Changelog entry (shared, backend, frontend, python zones as relevant; tests run; purge).
- [ ] `brain/features/chamber-creation.md`: tables §3.1 / §3.6 / §3.7 (key, label, form default, API default, range, effect), hash contents §5.1, old-save compatibility §4.7, refusals §3.8, key → label glossary §11.
- [ ] `brain/conventions/vocabulary.md` for a new term; `brain/decisions.md` for a chosen default.
- [ ] Codemaps `root-shared-mcp.md`, `api-core.md`, `web-features-assemble-chamber.md` (and `api-scripts.md`), then `python brain/codemap/build-index.py`.

## Pitfalls
- A field forgotten in `chamberBuildSchema` never reaches the service and silently disappears from saves.
- A missing `?? CHAMBER_FORM_DEFAULTS.key` in `chamberInputToFormValues`: old saves load `undefined`, the checkbox or input shows empty and zod blocks Save / Generate.
- Setting a param unconditionally re-keys builds where it changes nothing (lesson of `vaneAngleDeg` / `outletRatio`, which enter the hash even without vanes). Every cached build is rebuilt once: acceptable only if intended.
- Hidden fields stay in the body (K20); the server must ignore them per design, never trust the UI to drop them.
- `x4`-style inputs must never be forwarded to the builder.
- 50 mm rounding applies to estimates only; typed overrides, ratios and Gen Dim values pass verbatim (`chamber-creation.md` §3.4).
- `dFirst` / `dMiddle` go to the builder unscaled (the builder applies `partScale`); ratios are duplicated in TS and Python.
- A pure `@dive/shared` model change re-keys builds by itself (Finals change); a builder change does not, hence the purge.
- The outputs table does not know `chamferEnabled` (a disabled chamfer ≤ 0 still shows "not buildable"): a new option that exempts a dimension may need the same care in `ChamberOutputsTable`.
- Visible strings in English without em dashes (several existing `ChamberPage` toasts still contain one: do not copy them). "Runner Ø" (X1) and "Runner case Ø" (`dFirst`) are different things.
- `brain/assets/chamber-parameter-map.html` is frozen at model v2 (2026-08-04): do not update it unless asked.

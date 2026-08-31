# Chamber Creation — Chamfer Disable Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `chamferEnabled` toggle (default on) to the Chamber Creation feature that skips the box's two corner cuts entirely when off, while every other geometry value (chamfer model numbers in the outputs table, the internal part's position, cylinders, feet) stays byte-identical either way.

**Architecture:** A pure geometry flag threaded straight through the existing `guideVanes`/`footAngleDeg` pipeline — shared `ChamberInput` type → API zod schema → `resolveGeometryParams()` → the params JSON `buildChamber.py` reads. It never touches `computeChamberOutputs()` (the empirical model), so the outputs table is unaffected by construction, not by convention.

**Tech Stack:** TypeScript (Node/Express API, React + react-hook-form + zod web), Python 3 + CadQuery 2.8 (`apps/api/scripts/buildChamber.py`), Vitest.

## Global Constraints

- Field name: `chamferEnabled?: boolean`, default `true` (today's always-on behaviour is the default; no behaviour change for existing callers/cached params).
- The flag gates **only** the two `.cut()` calls inside `make_box()` in `buildChamber.py`. No other function reads it.
- When disabled, `make_box()` must **skip the cuts entirely** — never call `_corner_prism` with a zero-size setback (a repeated-point polyline is a degenerate wire and CadQuery/OCC will reject it).
- `chamferLength1/2`, `chamferWidth1/2`, `distFromSideChamfer1`, `distFromEnd` keep being computed by `computeChamberOutputs()` and shown in the outputs table unchanged, regardless of the toggle (confirmed with the user).
- `dist_c1` / `dist_from_end` (the internal part's axis position) are computed identically regardless of `chamferEnabled` — the part never moves.
- Out of scope: the torque feet's own fixed 45° chamfer (`FOOT_CHAMFER`, not a user parameter), any change to `computeChamberOutputs()`, per-corner (big vs. small) toggles.
- Spec: `docs/superpowers/specs/2026-08-11-chamfer-disable-toggle-design.md`.

---

### Task 1: Wire `chamferEnabled` through shared type → API schema → service (TDD)

**Files:**
- Modify: `packages/shared/src/index.ts:2270-2276` (add field to `ChamberInput`)
- Modify: `apps/api/src/modules/chamber/chamber.schemas.ts:38-40` (add zod field)
- Modify: `apps/api/src/modules/chamber/chamber.service.ts:107-109` (add to `resolveGeometryParams`)
- Test: `apps/api/tests/chamber.test.ts`

**Interfaces:**
- Consumes: nothing new — follows the existing `guideVanes?: boolean` field already on `ChamberInput`, `chamberBuildSchema`, and `resolveGeometryParams`.
- Produces: `ChamberInput.chamferEnabled?: boolean`, `ChamberBuildInput.chamferEnabled: boolean` (zod-defaulted), and `params.chamferEnabled: boolean` in the dict `resolveGeometryParams()` returns — consumed by Task 2's Python change.

- [ ] **Step 1: Write the failing test**

In `apps/api/tests/chamber.test.ts`, add a new test right after the existing `'keys the build on the guide-vanes flag'` test (after line 194):

```ts
  it('keys the build on the chamfer-enabled flag, defaulting to on', async () => {
    setCommandRunner(successRunner);
    const auth = authHeader(await createTestUser());

    const enabled = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send(BUILD)
      .expect(200);
    const disabled = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, chamferEnabled: false })
      .expect(200);

    // Disabling the chamfer changes the geometry => a different cache key,
    // but the twelve outputs (the model) are untouched either way.
    expect(enabled.body.hash).not.toBe(disabled.body.hash);
    expect(disabled.body.outputs).toEqual(enabled.body.outputs);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build:shared && npm run test -w @dive/api -- chamber.test.ts -t 'chamfer-enabled'"
```

Expected: FAIL — `enabled.body.hash` equals `disabled.body.hash` (the flag doesn't exist yet, so it never reaches the params dict / cache key; both requests hash to the same params).

- [ ] **Step 3: Add the field to the shared type**

In `packages/shared/src/index.ts`, right after the `guideVanes` field block (after line 2275, before `vaneAngleDeg`):

```ts
  /**
   * Cut the two asymmetric corners at the box's inlet end (the chamfer).
   * Geometry-only (not part of the empirical model) — the chamfer's own model
   * values (chamferLength1/2, chamferWidth1/2, distFromSideChamfer1,
   * distFromEnd) are still computed and shown in the outputs table, and the
   * internal part's position is unaffected, regardless of this flag. Default
   * true.
   */
  chamferEnabled?: boolean;
```

- [ ] **Step 4: Add the field to the API zod schema**

In `apps/api/src/modules/chamber/chamber.schemas.ts`, right after line 40 (`guideVanes: z.boolean().default(false),`):

```ts
    // Cut the two corners at the box's inlet end (geometry-only; the chamfer's
    // own model values keep being computed regardless). A different flag =>
    // a different cached build.
    chamferEnabled: z.boolean().default(true),
```

- [ ] **Step 5: Add the field to `resolveGeometryParams`**

In `apps/api/src/modules/chamber/chamber.service.ts`, right after line 109 (`params.guideVanes = input.guideVanes ?? false;`):

```ts
  // Whether the box's two inlet-end corners get cut. Geometry-only: the
  // chamfer's own model values (chamferLength1/2 etc., in the loop below) are
  // computed unconditionally either way, and only this flag decides whether
  // make_box() actually cuts them. Default true (today's always-on behaviour).
  params.chamferEnabled = input.chamferEnabled ?? true;
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build:shared && npm run test -w @dive/api -- chamber.test.ts"
```

Expected: PASS — all `chamber.test.ts` tests green, including the new one.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/index.ts apps/api/src/modules/chamber/chamber.schemas.ts apps/api/src/modules/chamber/chamber.service.ts apps/api/tests/chamber.test.ts
git commit -m "feat(chamber): add chamferEnabled geometry flag (shared+api)"
```

---

### Task 2: Skip the corner cuts in `make_box()` when disabled

**Files:**
- Modify: `apps/api/scripts/buildChamber.py:129-139` (`make_box`)
- Modify: `apps/api/scripts/buildChamber.py:1067` area (read the flag)
- Modify: `apps/api/scripts/buildChamber.py:1178-1179` (call site)

**Interfaces:**
- Consumes: `params["chamferEnabled"]` (boolean, produced by Task 1; absent in old cached params JSON, must default to `True`).
- Produces: `make_box(cq, width, length, height, end, big_side, ch_big, ch_small, enabled=True)` — the `enabled` keyword is new; all other geometry functions (`make_feet`, `classify`, the part `translate`) are unchanged and keep reading `width`/`length`/`height`/`dist_c1`/`dist_from_end` exactly as before.

- [ ] **Step 1: Modify `make_box` to accept and honor `enabled`**

In `apps/api/scripts/buildChamber.py`, replace lines 129-139:

```python
def make_box(cq, width, length, height, end, big_side, ch_big, ch_small):
    """Box with two asymmetric chamfers on the two vertical corners of ONE end.
    ch = (length_setback, width_setback): cut along Y (length) and X (width)."""
    b = cq.Workplane("XY").box(width, length, height)
    end_sy = 1.0 if end.startswith(">") else -1.0
    big_sx = 1.0 if big_side.startswith(">") else -1.0
    b = b.cut(_corner_prism(cq, width, length, height, big_sx, end_sy,
                            ch_big[0], ch_big[1]))
    b = b.cut(_corner_prism(cq, width, length, height, -big_sx, end_sy,
                            ch_small[0], ch_small[1]))
    return b
```

with:

```python
def make_box(cq, width, length, height, end, big_side, ch_big, ch_small, enabled=True):
    """Box with two asymmetric chamfers on the two vertical corners of ONE end
    (when enabled). ch = (length_setback, width_setback): cut along Y (length)
    and X (width). When enabled=False the box is returned untouched -- ch_big/
    ch_small are ignored entirely, never coerced to a zero-size cut (which
    would be a degenerate zero-area wire)."""
    b = cq.Workplane("XY").box(width, length, height)
    if not enabled:
        return b
    end_sy = 1.0 if end.startswith(">") else -1.0
    big_sx = 1.0 if big_side.startswith(">") else -1.0
    b = b.cut(_corner_prism(cq, width, length, height, big_sx, end_sy,
                            ch_big[0], ch_big[1]))
    b = b.cut(_corner_prism(cq, width, length, height, -big_sx, end_sy,
                            ch_small[0], ch_small[1]))
    return b
```

- [ ] **Step 2: Read the flag in `main()`**

In `apps/api/scripts/buildChamber.py`, right after line 1067 (`guide_vanes = bool(P.get("guideVanes", False))`), add:

```python
        chamfer_enabled = bool(P.get("chamferEnabled", True))
```

- [ ] **Step 3: Pass it at the call site**

In `apps/api/scripts/buildChamber.py`, replace lines 1178-1179:

```python
        box = make_box(cq, width, length, height,
                       CHAMFER_END, BIG_CORNER_SIDE, ch_big, ch_small)
```

with:

```python
        box = make_box(cq, width, length, height,
                       CHAMFER_END, BIG_CORNER_SIDE, ch_big, ch_small,
                       enabled=chamfer_enabled)
```

- [ ] **Step 4: Byte-compile check**

```bash
wsl.exe -e bash -lc "/home/hristo/cadquery-env/bin/python -m py_compile /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts/buildChamber.py && echo COMPILE_OK"
```

Expected: `COMPILE_OK`, no syntax errors.

- [ ] **Step 5: Verify the geometry actually changes, in the real CadQuery venv**

This is the step that proves the toggle works — Task 1's test only proves the flag reaches the params dict, since it mocks the Python builder. Write a throwaway verification script (not committed) and run both a chamfer-enabled and chamfer-disabled build with the same otherwise-valid params, then compare them.

Create `/tmp/verify_chamfer_toggle.py` (inside WSL) with:

```python
import json, os, subprocess, sys, tempfile
import trimesh

REPO = "/mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui"
SCRIPT = f"{REPO}/apps/api/scripts/buildChamber.py"
PY = "/home/hristo/cadquery-env/bin/python"

# A small, internally-consistent, hand-picked param set (metres) satisfying
# buildChamber.py's own validation (part_height <= height, 0 < dist_c1 <
# width, hFirst = hMiddlePlusFirst - hMiddle > 0, footAngleDeg in a
# non-degenerate gusset range, vaneAngleDeg within +-5 of 50).
BASE = {
    "width": 4.4, "length": 8.8, "height": 3.155,
    "distFromSideChamfer1": 2.0,
    "chamferLength1": 0.5, "chamferWidth1": 0.5,
    "chamferLength2": 0.4, "chamferWidth2": 0.4,
    "distFromEnd": 0.9,
    "dLast": 1.2, "hMiddle": 0.5, "hMiddlePlusFirst": 0.8, "hLast": 2.355,
    "variant": "stepped", "footAngleDeg": 45.0, "guideVanes": False,
    "vaneAngleDeg": 50.0, "partScale": 1.0, "outletRatio": 0.45,
    "outletOuterD": 1.0,
}

def build(out_dir, chamfer_enabled):
    params = dict(BASE, chamferEnabled=chamfer_enabled)
    params_path = os.path.join(out_dir, "params.json")
    with open(params_path, "w") as fh:
        json.dump(params, fh)
    result_dir = os.path.join(out_dir, "out")
    os.makedirs(result_dir, exist_ok=True)
    proc = subprocess.run([PY, SCRIPT, params_path, result_dir],
                           capture_output=True, text=True)
    assert proc.returncode == 0, f"build failed (enabled={chamfer_enabled}):\n{proc.stdout}\n{proc.stderr}"
    with open(os.path.join(result_dir, "manifest.json")) as fh:
        manifest = json.load(fh)
    mesh = trimesh.load(os.path.join(result_dir, "exports", "chamber.stl"))
    return manifest, mesh

with tempfile.TemporaryDirectory() as tmp:
    m_on, mesh_on = build(os.path.join(tmp, "on"), True)
    m_off, mesh_off = build(os.path.join(tmp, "off"), False)

# Same four patches either way.
names_on = sorted(p["name"] for p in m_on)
names_off = sorted(p["name"] for p in m_off)
assert names_on == names_off == ["cylinder_walls", "inlet", "outlet", "walls"], (names_on, names_off)

# The BIG_CORNER_SIDE/CHAMFER_END corner is (+width/2, +length/2) at both
# z = +-height/2 (BIG_CORNER_SIDE=">X", CHAMFER_END=">Y" in the script).
corner_xy = (BASE["width"] / 2, BASE["length"] / 2)
def has_corner_vertex(mesh, xy, tol=1e-3):
    return any(abs(v[0] - xy[0]) < tol and abs(v[1] - xy[1]) < tol for v in mesh.vertices)

assert not has_corner_vertex(mesh_on, corner_xy), "chamfer enabled: sharp corner vertex should NOT exist"
assert has_corner_vertex(mesh_off, corner_xy), "chamfer disabled: sharp corner vertex SHOULD exist"

# Disabling the chamfer removes geometry (2 fewer cut corners) => fewer or
# equal faces in the whole solid; watertight either way.
assert mesh_on.is_watertight, "chamfer-enabled solid is not watertight"
assert mesh_off.is_watertight, "chamfer-disabled solid is not watertight"
assert len(mesh_off.faces) != len(mesh_on.faces), "expected a different face count between on/off"

print("ALL PASS")
print("faces on/off:", len(mesh_on.faces), len(mesh_off.faces))
```

Run it:

```bash
wsl.exe -e bash -lc "/home/hristo/cadquery-env/bin/python /tmp/verify_chamfer_toggle.py"
```

Expected: `ALL PASS` printed, with a face-count line showing the two counts differ. If any `assert` fires, read the message — it tells you exactly which invariant broke (wrong corner, non-watertight solid, or patches changed).

- [ ] **Step 6: Commit**

```bash
git add apps/api/scripts/buildChamber.py
git commit -m "feat(chamber): make_box skips the corner cuts when chamferEnabled is false"
```

---

### Task 3: Add the "Chamfer" checkbox to the web form

**Files:**
- Modify: `apps/web/src/features/chamber/chamberForm.ts:32-43` (interface), `:56-57` (zod schema), `:97` (defaults)
- Modify: `apps/web/src/features/chamber/ChamberInputsForm.tsx:136-148` area (add checkbox)

**Interfaces:**
- Consumes: nothing new from earlier tasks (the web form is independent of the shared/API types at compile time — `ChamberFormValues` is its own interface, spread into the build request body by `ChamberPage.tsx`'s existing `onGenerate`, which needs no changes since it already does `build.mutate({ ...v, constraints })`).
- Produces: `ChamberFormValues.chamferEnabled: boolean`, registered as `chamferEnabled` on the form — the request body key the API schema from Task 1 expects.

- [ ] **Step 1: Add the field to `ChamberFormValues`**

In `apps/web/src/features/chamber/chamberForm.ts`, right after line 32 (`guideVanes: boolean;`):

```ts
  /** Cut the two corners at the box's inlet end. Geometry-only. */
  chamferEnabled: boolean;
```

- [ ] **Step 2: Add the field to the zod schema**

In the same file, right after line 56 (`guideVanes: z.boolean(),`):

```ts
    chamferEnabled: z.boolean(),
```

- [ ] **Step 3: Add the default**

In the same file, right after line 97 (`guideVanes: false,`):

```ts
  chamferEnabled: true,
```

- [ ] **Step 4: Add the checkbox in the form UI**

In `apps/web/src/features/chamber/ChamberInputsForm.tsx`, right after the existing "Guide vanes" `<label>` block (after line 148, before the `<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">` on line 150):

```tsx
      <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-bg p-3">
        <input
          type="checkbox"
          {...register('chamferEnabled')}
          className="mt-0.5 size-4 shrink-0 cursor-pointer rounded-sm border-border accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/40"
        />
        <span className="text-sm">
          <span className="font-medium text-text">Chamfer</span>
          <span className="mt-0.5 block text-text-secondary">
            Cut the two corners at the inlet end. Turn off for a square-ended box - the rest of
            the geometry (cylinders, feet, outputs table) is unaffected.
          </span>
        </span>
      </label>

```

- [ ] **Step 5: Typecheck + lint**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run typecheck"
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npx eslint apps/web/src/features/chamber/chamberForm.ts apps/web/src/features/chamber/ChamberInputsForm.tsx"
```

Expected: both commands exit 0, no type errors, no lint errors.

- [ ] **Step 6: Run the existing web chamber test to confirm no regression**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run test -w @dive/web -- ChamberOutputsTable"
```

Expected: PASS (this test doesn't touch `ChamberInputsForm`, so it's a pure regression check — it must stay green since `chamferEnabled` never reaches `computeChamberOutputs`).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/chamber/chamberForm.ts apps/web/src/features/chamber/ChamberInputsForm.tsx
git commit -m "feat(chamber): add Chamfer toggle checkbox to the chamber form"
```

---

### Task 4: Full gate run, browser verification, and PLAN.md changelog entry

**Files:**
- Read-only verification (no source changes)
- Modify: `PLAN.md` (append changelog entry per CLAUDE.md §0)

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: nothing new — this task is the Definition-of-Done gate for the whole feature.

- [ ] **Step 1: Run the full test suite**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run test"
```

Expected: all suites green (or only the known-flaky, unrelated `meshes.test.ts` "undo-all" failure noted elsewhere in `PLAN.md:770` — if any *other* test fails, stop and investigate before continuing).

- [ ] **Step 2: Run the full typecheck**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run typecheck"
```

Expected: exit 0.

- [ ] **Step 3: Provision the dev database (first run only)**

Check whether it already exists, and set it up if not:

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api && test -f dev.db && echo EXISTS || (npm run db:migrate && npm run db:seed)"
```

- [ ] **Step 4: Start the dev server in the background**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && nohup npm run dev > /tmp/dive-dev.log 2>&1 & disown; sleep 8; tail -n 40 /tmp/dive-dev.log"
```

Expected: log shows both `api` and `web` workspaces started with no fatal errors (API listening on port 4000, Vite dev server for `web` on its printed port).

- [ ] **Step 5: Open the app in the browser and verify the toggle end-to-end**

Using the Browser tool:
1. Navigate to the web dev server URL (from the log in Step 4, typically `http://localhost:5173`).
2. Log in with `admin@dive-turbinen.de` / `ChangeMe!2026` (from `apps/api/.env`, `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`).
3. Navigate to `/chamber`.
4. Confirm the new "Chamfer" checkbox renders, checked by default, right after "Guide vanes".
5. Leave defaults, click "Generate". Confirm the 3D viewer renders a chamber with two visibly cut corners at the inlet end, and note a value from the outputs table (e.g. the "LF1" row's FINAL value).
6. Uncheck "Chamfer", click "Generate" again. Confirm: (a) the 3D viewer now shows a square-ended box at that end, no cut corners; (b) the outputs table's "LF1"/"BF1"/"LF2"/"BF2"/"B1"/"LT" values are unchanged from step 5; (c) no console errors.
7. Re-check "Chamfer", click "Generate" once more. Confirm the two cut corners reappear.

- [ ] **Step 6: Stop the dev server**

```bash
wsl.exe -e bash -lc "pkill -f 'npm run dev' || true; pkill -f 'concurrently' || true"
```

- [ ] **Step 7: Append the PLAN.md changelog entry (CLAUDE.md §0 requirement)**

Add a new entry at the very end of `PLAN.md` (after the last existing entry), following the file's established style (French, one paragraph, bolded section labels):

```markdown

#### Feature — Chamber : bascule pour désactiver le chamfer sans toucher au reste de la géométrie [shared+backend+frontend+tests] (2026-08-11)
Demande user : un toggle pour désactiver complètement le chamfer (les deux coins asymétriques coupés à l'extrémité inlet de la boîte), **sans affecter le reste de la géométrie**. Spec+plan : `docs/superpowers/specs/2026-08-11-chamfer-disable-toggle-design.md`, `docs/superpowers/plans/2026-08-11-chamfer-disable-toggle.md`. **Piège évité** : `distFromEnd` (LT) a une relation `= chamferLength1 + chamferLength2`, et `chamferWidth1/2` valent `= chamferLength1/2` — mettre le chamfer à zéro via le modèle aurait donc déplacé l'axe de la pièce interne. Le toggle est donc un **flag géométrie pure** (`chamferEnabled`, défaut `true`), câblé comme `guideVanes`/`footAngleDeg` (shared → zod → `resolveGeometryParams` → JSON params), qui ne touche jamais `computeChamberOutputs()` : les valeurs de chamfer (LF1/BF1/LF2/BF2/B1/LT) restent affichées et inchangées dans la table de sorties quel que soit l'état du toggle (confirmé avec l'user), et `dist_c1`/`dist_from_end` gardent leur calcul habituel. **Python** (`buildChamber.py`) : `make_box()` gagne un paramètre `enabled` — à `False` elle retourne la boîte **sans exécuter les deux `.cut()`**, plutôt que de passer un setback à zéro (qui produirait un polyline dégénéré rejeté par CadQuery/OCC). **Web** : case à cocher « Chamfer » dans `ChamberInputsForm.tsx`, à côté de « Guide vanes », cochée par défaut. **Tests** : `chamber.test.ts` +1 (le flag change la clé de cache ; les 12 sorties restent identiques on/off). **Vérification géométrique réelle** (script `_verify_chamfer_toggle.py`, non commité, exécuté dans le venv `cadquery-env` de WSL) : build on/off avec les mêmes params → mêmes 4 patches, solide watertight des deux côtés, le sommet du coin (width/2, length/2) est **absent** quand le chamfer est actif et **présent** quand il est désactivé, nombre de faces différent. **Gates** : build:shared/typecheck OK, suite `test` verte (hors l'échec `meshes.test.ts` "undo-all" pré-existant et sans rapport, cf. entrée du 2026-08-06), eslint 0 erreur sur les fichiers touchés. **VERIFY (navigateur)** : `/chamber` → case « Chamfer » cochée par défaut → Generate → 2 coins coupés visibles ; décocher → Generate → boîte à coins droits, table de sorties inchangée ; recocher → Generate → coins coupés de retour.
```

- [ ] **Step 8: Commit**

```bash
git add PLAN.md
git commit -m "docs(chamber): log the chamfer disable toggle in PLAN.md"
```

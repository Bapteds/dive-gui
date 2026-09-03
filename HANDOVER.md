# Handover — Chamber: Gen Dim v3 generator dims, Simplify Generator, physical names

> Branch: `feat/chamber-ui-feedback`, tip `5b7d147`, **committed AND pushed**, **42 commits
> ahead of `main`**.
> **PR #3 is OPEN**: https://github.com/Bapteds/dive-gui/pull/3 — it covers EVERYTHING on the
> branch since PR #2 was merged (2026-08-31), including this session. Next integration step is
> review/merge of that PR; keep pushing to the branch and the PR follows.
> Supersedes the previous handover (state at `158dc25`); its §0 toolchain section is carried
> over below — the rest of it is history now summarised in §3 of PLAN.md's changelog.
> Every feature has a French changelog entry at the bottom of `PLAN.md` and a spec under
> `docs/superpowers/specs/` (five new ones dated 2026-09-02).

---

## 0. Access & toolchain (READ FIRST if new to this repo)

The toolchain lives in **WSL**, outside this folder:

- `npm`/`node` are **WSL-only** — Git Bash / PowerShell on Windows fail with "npx: command not
  found". Windows python DOES exist (3.12, has openpyxl) but has NO cadquery.
- CadQuery Python is a **WSL venv**: `/home/hristo/cadquery-env/bin/python`
  (the API reads it via `CHAMBER_PYTHON_BIN`; the mesh viewer uses `MESH_PYTHON_BIN` →
  `/home/hristo/mesh-viz-env`).
- Invoke via `wsl bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/... && ..."`.
  Harmless `Failed to translate 'H:\bin'` lines print on every call — ignore them.
  Complex inline python through PowerShell→WSL gets mangled — write a script file instead.
- `gh` CLI is installed and authenticated (account `hristovdimitrov222`). gh commands hang if
  a stray command consumes stdin — append `< /dev/null` when scripting.

```bash
# REAL geometry suite (CadQuery in WSL; 24 tests, ~7.5 min, fixtures built once per session)
wsl bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts && \
  /home/hristo/cadquery-env/bin/python -m pytest tests/test_build_chamber.py -q'

# Chamber TS gates (FAKE builder — never runs CadQuery)
wsl bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api && \
  npx vitest run tests/chamber.test.ts tests/chamberModel.test.ts tests/chamberSaves.test.ts'
wsl bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/web && \
  npx vitest run src/features/chamber'

# Typecheck (rebuild shared FIRST whenever packages/shared changed)
wsl bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build:shared && \
  npx tsc -p apps/api/tsconfig.json --noEmit && npx tsc -p apps/web/tsconfig.json --noEmit'
```

- After **any** `buildChamber.py` change, **purge the build cache**
  (`rm -rf apps/api/storage/chamber/*`): builds are hashed on params, not code. Done twice this
  session (Simplify Generator; warning-text sweep).
- `CHAMBER_DEBUG_DUMP=1` dumps `core.stl`, `casing.stl`, `meta.json`… into `<outDir>/_debug/`.
- Full API vitest is slow and `conversion.test.ts` / `meshes.test.ts` fail on THIS box for
  pre-existing environment reasons (OpenFOAM tooling) — run targeted suites.
- PowerShell 5.1 mangles double quotes in commit messages → commit via Git Bash (Bash tool)
  or keep quotes out; check `git log` after.

## 1. State in one paragraph

Chamber Creation's generator dimensions are now EMPIRICAL: blank hollow-variant boxes
(Generator Ø / height / dome) come from the **Gen Dim v3 model** (workbook committed at
`documents/Gen Dim v3 Only Calculator (standalone).xlsx` — the source of record) via one shared
function used by both the API build and the web hints; a new optional **Power (kW)** input (x4)
steers the frame suggestion, and a typed Ø re-bases the height/dome autos. A new **Simplify
Generator** toggle pins the generator as a strict cylinder THROUGH the chamber top with no dome
(the closed design's mechanism). The four inputs display as **Runner Ø (mm) / Head (m) /
Q_max (m³/s) / Power (kW)** and the design menu reads just "Closed generator" / "With cone" —
all display-only (internal keys `x1..x4`, `variant: 'stepped'|'hollow'`, saves and cache are
untouched).

## 2. Features landed this session (specs in docs/superpowers/specs/, all dated 2026-09-02)

1. **Gen Dim v3 generator dimensions** (`…-generator-dimensions-design.md` + an
   implementation plan under docs/superpowers/plans/). `computeChamberGeneratorDims` in
   `packages/shared` returns `auto` (hints, own override ignored / upstream kept) and
   `resolved` (build values): X4used = x4 ?? 0.9·9.81·X2·X3 → frame R (range rules, ~70–77%)
   → L = clamp30..215(round5(132.21 − 0.8294R − 0.0825X1 + 13.861X3)); Ø = catalog[R]
   {26:572, 36:745, 38:753, 45:976, 46:933, 48:986, 62:1242, 77:1545, 115:2225};
   height = 71.258 + 0.45856·Ø(resolved) + 6.2368·L; dome = 79.609 + 0.21315·Ø(resolved).
   The old 0.75·X1 / 1.33·Ø / 0.2·h ratio constants are DELETED. x4 is validated
   (0, 100 000] and never forwarded to the builder — the cache re-keys via resolved values,
   so pre-existing entries self-invalidated. Old saves load as auto (no migration).
2. **Physical input names** (`…-physical-input-names-design.md`). Display labels only, six
   spots incl. the API 422 text ("Adjust Runner Ø / Head / Q_max…") and the X4 hint
   "Blank = auto ≈ N kW (0.9 · 9.81 · Head · Q_max)".
3. **Simplify Generator** (`…-simplify-generator-design.md`). `simplifyGenerator` flag
   (default false, hollow only): builder pins the central cylinder through the box top
   (+2·FLOOR_OVERCUT, stepped-style, `make_part_hollow` takes `dome_h=None`), overflow check
   considers only first+middle+cone with its own "hollow cone stack" refusal wording; the API
   OMITS centralHeight/domeHeight from builder params while on (hidden overrides can't re-key
   the cache) and never writes the flag for stepped; the web checkbox hides the two height
   fields (form state kept — unchecking restores).
4. **Vocabulary sweep + correction** (`…-chamber-vocabulary-design.md`, see its Addendum).
   Menu options are exactly "Closed generator" / "With cone" (field label "Design");
   "chamber" replaces "box"; parts are named runner case / middle cylinder / cone / generator.
   **CORRECTION (user): "outlet" is the FLOW outlet, NOT the middle cylinder** — the dMiddle
   field stays "Guide vanes Ø (mm)". Also swept the last user-visible X refs: the two builder
   WARNINGs now say "Runner Ø too large …" (print strings only; fixtures aligned).

## 3. Open threads (user has NOT decided — do not implement unasked)

- **Hub shoulder monotonicity**: analysed at the user's request. The warning at
  `buildChamber.py:633` fires only when P1 > P2 (fold ≈ Runner Ø 2179 mm at ratio 0.45,
  ≈ 1961 mm at 0.50 — verified numerically); the rim→P1 segment always leans 0.25 mm inward
  (asset-inherent, deliberately unflagged), and near the crossover the shoulder is vertical
  with no message. It is a WARNING, never a refusal. OFFERED but not requested: an
  early-warning margin (warn when P2 − P1 < some fraction of the baseline 97 mm spacing)
  and/or promoting to a refusal. The outlet clamp (0.97·R_anchor) can freeze the rims before
  the fold — config-dependent.
- **Builder texts still using old vocabulary**: "stick out of the box", "the cylinder
  shoulder…" etc. — offered as a separate sweep (means geometry-test string updates); user
  has not asked.
- **In-browser visual pass**: Simplify Generator geometry is proven by tests (cross-section
  loop counts) but nobody has eyeballed the 3D preview; dev server is user-managed.
- From the previous session, still open: STL patch normals flip (deprioritized), saves
  owner-cascade product decision, multi-instance build lock.

## 4. Verification state (2026-09-03, at `5b7d147`)

- Geometry suite: **24/24** (~7.5 min; includes the 2 new Simplify Generator tests — piercing
  proven by cross-section loop counts, cone-stack refusal wording).
- API: chamber **36**, chamberModel **43**, chamberSaves **8** — all green. Web chamber:
  **79/79**. Typecheck API+web clean. Build cache purged after the last builder edit.
- Working tree CLEAN; everything pushed.

## 5. Conventions & gotchas for the next agent

- **Vocabulary rules** (user-approved; also in auto-memory
  `chamber-vocabulary-outlet-is-flow-outlet.md`): display renames are LABEL-ONLY — internal
  keys, the `variant` enum, saves snapshots and cache keys never change. Never call the middle
  cylinder "outlet".
- House workflow: brainstorm (one question at a time) → spec committed BEFORE implementing →
  test-first. French note at the bottom of `PLAN.md` for every code change. Continuous
  commit+push per feature ON THIS BRANCH (don't carry to other branches unasked).
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; PR bodies end
  with the Claude Code attribution line.
- `CLAUDE.md` frontend skill sequence applies to UI (JSX/CSS) only; those skills are not
  installed here — apply the rules manually (tokens only, AA contrast, one orange CTA per
  zone). New chamber UI this session reused existing primitives — zero new styles.
- The Gen Dim workbook in `documents/` is the model's source of record — if its formulas
  change again, `computeChamberGeneratorDims` + the parity tests in
  `apps/api/tests/chamberModel.test.ts` (and `chamberForm.test.ts` hints) must move with it.
- No secrets in commits: `apps/api/.env` is gitignored.

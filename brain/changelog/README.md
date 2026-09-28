# Changelog: rules

> Log of EVERY change to the repository (code, scripts, config, structural docs).
> Kept **automatically by the agent**: no change is finished without its entry.
> Replaces the old log at the bottom of `PLAN.md` (migrated here on 2026-09-28, full content kept).
> **Language**: entries written before 2026-09-28 are in French (history, not translated). Every new entry is in **English**.

## Organization

- One file per month: `YYYY-MM.md` (e.g. `2026-10.md`). Create it with the header below at the first change of the month.
- **Newest entries at the TOP** of the file.
- For recent context, read the current month (and the previous one if needed), not the whole history. Month files are large: search them (by date, area or file name) rather than reading them end to end.

## When to write an entry

- Any code change (`apps/`, `packages/`, Python scripts, tests, CI, config).
- Any decision taken with the user that changes behavior or rules (type `Decision`).
- Any structural change to the brain or the root docs (type `Docs`).
- One entry per logical change. A series of commits on the same feature = one entry, enriched as the work goes.
- No entry for a mere read, question or exploration without changes.

## Entry format

```markdown
## YYYY-MM-DD · <Type> · <Functional area>: <short title>
**Area**: shared | backend | frontend | python | tests | ci | docs · **Commits**: `abc1234` (if committed)
**Summary**: 1 to 2 sentences: what changes and why.
**Details**:
- Root cause (for a fix), implementation choices, decisions, known limits.
- What remains to verify (e.g. "to validate on the Debian server").
**Files**: `path/a.ts`, `path/b.tsx`, …
**Tests**: suites run and result (e.g. `chamber.test.ts` 36/36, typecheck OK), or "not run: reason".
**Spec**: `brain/specs/…` (if applicable)
```

Types: `Feature`, `Fix`, `Refactor`, `Perf`, `UX`, `Docs`, `Chore`, `Decision`, `Security`, `Test`.
(French entries use the labels `Zone`, `Résumé`, `Détails`, `Fichiers`, `Tests`, `Spec` for the same fields.)

## Header of a new month file

```markdown
# Changelog: <Month> YYYY

> Newest entries at the TOP. Format: see `brain/changelog/README.md`.
```

## Style

- English, identifiers in backticks.
- Factual: what was done, not what was planned. If tests were not run, say so.
- No em dash in titles (separator `·`).
- After the entry, check whether `brain/STATUS.md`, a `brain/features/*` sheet, a `brain/codemap/*` section (then `python brain/codemap/build-index.py`) or a playbook must change too (see `brain/README.md` §3).

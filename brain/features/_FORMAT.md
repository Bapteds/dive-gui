# Feature sheet format

> One sheet per feature, seen end to end (user → UI → API → services → external tools → storage).
> Codemaps describe files; feature sheets describe **behavior** and connect the files together.

## Rules

- English; identifiers, paths, routes and UI strings in backticks.
- Faithful to the current code (check the code when unsure; otherwise write "to verify"). No line numbers.
- Point to codemaps and specs instead of copying them: the sheet explains **how things work together**.
- Update it in the same change as any code that alters the behavior, rules, routes or storage of the feature.

## Template

```markdown
# Feature · <Name>

> **Status**: in production | in progress | experimental · **Updated**: YYYY-MM-DD
> **Specs**: `brain/specs/…` · **Codemaps**: `brain/codemap/…`

## 1. Purpose
What the feature brings to the user (3 to 6 lines), who has access.

## 2. User journey
Where it lives in the UI (route, tab, button), steps, states (loading/empty/error), key messages.

## 3. Business rules and invariants
List of hard rules (permissions, validations, bounds, refusals, guaranteed behaviors).

## 4. Technical flow
Full chain: components and hooks (query keys) → endpoints → controller/service → lib, Python scripts, OpenFOAM tools → files written. One subsection per main flow.

## 5. Data and storage
Prisma models, files and folders under `STORAGE_DIR`, caches and their invalidation.

## 6. Configuration and external dependencies
Env vars, binaries, Python interpreters, behavior when a tool is missing.

## 7. Tests
Suites that lock the feature (API, web, geometry) and what they cover.

## 8. History
Dated milestones (creation, rewrites, major fixes) pointing to `brain/changelog/YYYY-MM.md`.

## 9. Known limits and bugs
References to `brain/known-issues.md` IDs (C*, H*, M*, L*, K*) + open threads.

## 10. Changing this feature
Pitfalls, files to change together, house rules (cache purge, shared rebuild, fixture parity…), matching playbooks.
```

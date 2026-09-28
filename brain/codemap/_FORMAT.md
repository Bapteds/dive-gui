# Codemap sheet format

> Common template of every sheet in `brain/codemap/`. Follow it for every creation or update.

## Rules

- **Language**: English; identifiers, paths, signatures and error messages exactly as written in the code, in backticks.
- **Completeness**: every git-tracked file of the scope has its section (tests, configs and assets included). A binary file or asset gets one line.
- **Faithfulness**: describe only what you read in the code. No speculation. When unsure, write "to verify".
- **No line numbers**: they drift. Reference functions by name.
- **Order**: sections follow the tree order (folder then file, alphabetical).
- **Update**: creating, deleting or renaming a file, or changing the role of an export, requires updating the matching section in the same code change, then running `python brain/codemap/build-index.py`.
- **Index contract**: `brain/INDEX.md` takes the one-line description of each file from the `**Role**:` line (or `**Covers**:` for a test, or the first paragraph of a short-form section). Keep that first sentence meaningful on its own.

## Template

```markdown
# Codemap: <area>

> Scope: `<paths>` · Updated: YYYY-MM-DD

## Overview
3 to 10 lines: role of the area, how the files fit together, main flows, entry points.

## `path/from/the/root/file.ts`
**Role**: 2 to 5 sentences. What the file does, where it sits in the flow, who calls it.
**Exports**:
- `function(arg: Type): Return`. What it does, side effects (DB, FS, process, network), errors raised (codes).
- `Component` (key props). What it renders, states handled, hooks used.
- `CONSTANT`. Value or meaning.
**Depends on**: key internal modules. **Used by**: main consumers.
**Notes**: invariants, pitfalls, env vars read, `brain/known-issues.md` references, links to specs.
```

For a small file (under 40 lines), the short form is accepted: `## path` followed by one paragraph.
For a test file: **Covers** (what is locked), **Technique** (fakes, fixtures, mocks), **Notable cases**.

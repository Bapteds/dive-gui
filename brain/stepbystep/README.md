# Step by step

> Plain-language log of gated, one-item-at-a-time work sessions: one file per item, written when the item is done.

The user asked for it on 2026-10-01: when a brief is worked through item by item, each finished item gets a short note here, in English, that a non-developer can read.

## Format of a note

File name: `YYYY-MM-DD-<brief-topic>-<NN>-<item-topic>.md` (`NN` = order in the session).

```markdown
# <Item title>

> <One sentence that sums up what was done.>

**Brief**: <brief path> item <n> · **Spec**: <spec path or "none"> · **Branch**: <branch> · **PR**: <link or "not opened">

## What changed
<The details: behaviour before and after, what the user sees, what stays the same.>

## Example
<One concrete example with real numbers.>

**Explanation**: <why the example comes out that way.>

## How to use it
<Where to click / what to type in the app.>
```

The changelog stays the technical record; these notes do not replace it.

## Sessions

- Brief `brain/briefs/2026-09-30-chamber-spiral-and-optimisation-fixes.md` (started 2026-10-01): `2026-10-01-spiral-fixes-00-status-bf-relations.md`, `2026-10-01-spiral-fixes-01-length-row.md`.

# Chamber Creation: full-width layout + saved builds — design

**Date:** 2026-08-31
**Status:** approved (visibility: team-shared; controls: page-header row; Inputs column scales too; Parameters table and Patches panel keep their sizes)

## Feature 1 — Full-width Chamber page

### Problem
Every non-project page is centered at `max-w-content` (1200 px) by `AppShell`. On wide
monitors the Chamber tab wastes most of the screen; the 3D preview especially.

### Design
- `AppShell.tsx`: add `/chamber` to the full-width opt-outs — `w-full px-4 py-6
  sm:px-6 sm:py-8 lg:px-8` (no `mx-auto max-w-content`). The page still flows and
  scrolls normally (no viewport pinning; the chamber page is a form + viewer + table,
  not a dashboard).
- `ChamberPage.tsx` grid: `lg:grid-cols-[minmax(0,22rem)_1fr]` becomes proportional —
  `lg:grid-cols-[minmax(22rem,1fr)_2.5fr]`. The Inputs/Export column scales with the
  window (never below today's 22 rem); the viewer keeps the larger share (~today's
  ratio at 1200 px, growing together beyond it).
- The Patches panel inside `ChamberViewer` keeps its fixed `minmax(200px,15rem)`
  column — unchanged.
- `ChamberBuildWarnings` + `ChamberOutputsTable` are wrapped in a `max-w-content`
  block (left-aligned, under the Inputs column edge) so the Parameters table does NOT
  extend when the upper section stretches.

### Rejected alternatives
Raising the global `max-w-content` (stretches every page); a bespoke wider max-width
for chamber only (still dead margins on ultrawides).

## Feature 2 — Saved chamber builds (optional, team-shared)

### Problem
Re-opening the Chamber tab means re-entering everything (X1/X2/X3, variant, toggles,
manual dims, Min/Max/Exact constraints). Geometry artifacts are already hash-cached
server-side; only the *form state* is lost.

### Design
A saved build is a **named snapshot of exactly the `POST /chamber/build` body**
(form values + constraints). Building stays unchanged and never requires saving.

#### Data model (Prisma/SQLite, follows the `Template` pattern)
```prisma
model ChamberSave {
  id        String   @id @default(cuid())
  name      String   @unique
  ownerId   String
  owner     User     @relation("ChamberSaveOwner", fields: [ownerId], references: [id], onDelete: Cascade)
  /// JSON-encoded ChamberBuildInput (the exact POST /chamber/build body).
  snapshot  String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([ownerId])
}
```
Visibility: every authenticated user lists and loads every save; only the author or a
super-admin may overwrite or delete one (same guard as templates).

#### API (chamber module, new `chamber-saves.*` files, mounted under `/api/v1/chamber/saves`)
- `GET /chamber/saves` → `ChamberSaveSummary[]` sorted by `updatedAt` desc:
  `{ id, name, snapshot, owner: { id, fullName }, updatedAt }` (snapshots are small;
  including them makes load a pure client-side action).
- `POST /chamber/saves` `{ name, snapshot }` → 201 created; 409 when the name is taken.
- `PUT /chamber/saves/:id` `{ name?, snapshot }` → overwrite; 403 unless author/admin;
  409 when renaming onto a taken name.
- `DELETE /chamber/saves/:id` → 204; 403 unless author/admin.
- `snapshot` is validated with the existing `chamberBuildSchema` (a save can never
  hold an unbuildable state); `name` is trimmed, 1..80 chars.
- `PUT` accepts `name` and/or `snapshot`, so it serves both overwrite and rename.
  Duplicate needs no endpoint: the client `POST`s the source snapshot under a new
  name (the copy is owned by whoever duplicated).
- Shared types (`ChamberSaveSummary`, payloads) go to `@dive/shared`.

#### Frontend
- `lib/api/chamberSaves.ts` + `useChamberSaves.ts` hooks: list query
  (`['chamber','saves']`), create/update/delete mutations invalidating the list.
- `ChamberSavesMenu` rendered in the `PageHeader` `action` slot of `ChamberPage`:
  - **dropdown** listing saves as "name — author"; picking one loads it: `reset()`
    the form with the snapshot's values and `setConstraints(snapshot.constraints)`,
    toast "Loaded 'name'". No auto-generate.
  - **Save** button → small dialog with a name field, prefilled with the loaded
    save's name. Submitting an existing name the user may manage → overwrite (the
    dialog says "Updates 'name'"); a new name → create. A name owned by someone
    else → inline 409 error ("pick another name").
  - **"⋯" menu** on the selected save (dropdown-menu primitive) with:
    - **Rename** (author/admin): dialog with a name field → `PUT` with the new
      name (snapshot untouched); 409 inline when the name is taken.
    - **Duplicate** (anyone): dialog prefilled "name (copy)" → `POST` the source
      snapshot under the new name, owned by the current user; the copy becomes
      the selected save.
    - **Delete** (author/admin): confirm dialog, then delete + clear selection.
  - Loading, empty ("No saved builds yet"), and error states per house rules.
- Snapshot mapping: `{ ...formValues, constraints }` — the same object `onGenerate`
  already posts. Loading maps it back (`constraints` into page state, the rest into
  the form). Missing optional fields load as blank (auto) exactly like defaults.

### Non-goals (YAGNI)
No per-user privacy toggle, no folders/tags, no auto-save, no save-on-generate, no
migration of past builds into saves.

## Testing
- **API** (`apps/api/tests/`): CRUD happy paths; 401 unauthenticated; 409 duplicate
  name; 403 non-author overwrite/delete; super-admin override; snapshot validation
  rejects an invalid body.
- **Web** (feature tests, existing conventions): dropdown lists and loads a save into
  the form + constraints; save dialog creates; prefilled overwrite updates; rename
  updates the name only; duplicate creates a copy and selects it; delete confirms;
  409 shows the inline error.
- Layout: no unit test (visual); verified in the browser + `web-design-guidelines`
  review pass.

## Implementation notes
UI work follows the CLAUDE.md skill sequence (ui-ux-pro-max → frontend-design →
design-taste-frontend → web-design-guidelines); tokens only, one orange CTA max,
AA contrast, keyboard + ARIA complete. PLAN.md gets the change note.

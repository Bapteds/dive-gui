# Zone rules: `apps/web` (React SPA)

> Loaded automatically when working in `apps/web/`. Complements the root `AGENTS.md`.
> Deep references: `brain/conventions/frontend.md`, `brain/design/design-system.md`, `brain/architecture/frontend.md`, codemaps `brain/codemap/web-*.md`.

## Before writing any JSX or CSS
1. Run the UI skill sequence: `ui-ux-pro-max` → `frontend-design` (or `impeccable`) → `design-taste-frontend`, then `web-design-guidelines` as the exit review. Point design skills at `brain/design/design-system.md` and `brain/design/product.md` (they look for `DESIGN.md` / `PRODUCT.md` at the root by default).
2. A change that only reuses existing primitives without new styling may skip to step 4 (review).

## Hard rules
- **Tokens only**: classes mapped to `src/styles/tokens.css` through `tailwind.config.ts`. Tailwind's default palette and scales are still reachable (`theme.extend`) but forbidden: no `text-white`, `bg-gray-*`, `rounded-full`, arbitrary `rounded-[6px]` or hex values.
- **One orange CTA per zone**: `--color-cta` `#A85F00` (white bold label). Brand orange `#EE7F00` never behind white or small text; small orange text uses `text-accent-strong`. Light theme only.
- **Reuse before creating**: `components/ui/*` (button, input, field, native-select, dialog, alert-dialog, dropdown-menu, tooltip, table, tabs, skeleton, sonner…) and `components/common/*` (`EmptyState` (`variant="inline"` inside a panel), `ErrorState`, `PageHeader`, `RenameDialog`, `StatusBadge`, `UnsavedChangesPrompt`). Never hand-style a native `<select>`.
- **Every state**: loading (skeleton, not a centered spinner), empty (teaches the next step), error (`ErrorState` + retry), hover, focus-visible, disabled. Icons: `lucide-react`, `strokeWidth` 1.75, `aria-label` on icon-only buttons.
- **Data**: TanStack Query hooks live in `features/<domain>/use*.ts` with an exported key (`['projects', id, …]`, `['meshing', …]`, `['chamber', hash, …]`). After a mutation: `setQueryData` with the server response, invalidate the parent list, `removeQueries` for 3D artifacts. Prefix invalidation refreshes everything below it: be precise (see known-issues K16). Pipelines resolve with `success: false` instead of rejecting: always check `result.success`.
- **Polling**: short interval while the status is not terminal, keep retrying when there is no data yet (fix H5), stop on a terminal status.
- **Editors / autosave**: reload the draft only when the file path changes, never on the save echo (fix H4).
- **Shared contract**: import types and constants from `@dive/shared`; after changing `packages/shared`, run `npm run build:shared` (Vitest and `tsc` read its `dist/`).
- UI strings in English; no em dashes in visible strings.

## Tests
- Vitest + Testing Library + jsdom, next to the code (`*.test.tsx`). A data router is only needed when the test navigates or uses `useBlocker`; those tests also need the `Request` override shown in `components/common/UnsavedChangesPrompt.test.tsx`. WebGL is absent in jsdom (3D viewers render their fallback).
- Targeted run: `cd apps/web && npx vitest run src/features/<zone>`; full: `npm test` at the root.

## Playbooks
`brain/playbooks/add-web-page-or-tab.md`, `add-chamber-input-or-parameter.md`, `add-solver-or-turbulence-model.md`.

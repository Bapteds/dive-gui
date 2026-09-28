# Frontend and design conventions

> Mandatory rules for creating or changing any UI (JSX, CSS, Tailwind). Short version, loaded automatically in `apps/web/`: `apps/web/AGENTS.md`.
> The detailed visual contract (tokens, components, screens) is **`brain/design/design-system.md`** (formerly `DESIGN.md`; code comments cite it as `brain/design/design-system.md section N`). Product positioning: **`brain/design/product.md`** (formerly `PRODUCT.md`). Design skills (`impeccable`, `ui-ux-pro-max`…) look for `DESIGN.md` / `PRODUCT.md` at the root by default: **give them these two paths explicitly**.
> Frontend technical architecture: `brain/architecture/frontend.md`.
> **Arbitration**: `brain/design/design-system.md` is authoritative for visual RULES (tokens, components, states, anti-slop). Its §5 and §7 describe the first-phase app (2-item sidebar, empty Home, dialogs reserved to admin): for the current STRUCTURE (6 navigation entries, pages, domain dialogs), the code and `brain/architecture/frontend.md` are authoritative.

## 1. Skill sequence (before writing a single line of UI)

1. `ui-ux-pro-max`: frame styles, palette, typography, layout, component choices.
2. `frontend-design` (or **`impeccable`** when `frontend-design` is not installed, as has been the case since the start of the project): production-grade design.
3. `design-taste-frontend`: anti-slop pass (remove anything that looks like a generic template).
4. `web-design-guidelines`: compliance review, the exit gate before declaring the task done.

Add-ons: `redesign-existing-projects` after step 1 for a redesign; `ckm-ui-styling` for fine shadcn/Tailwind styling; `react-best-practices` for performance; `full-output-enforcement` for placeholder-free output.
Rule: if a skill from 1 to 3 was skipped, start over. If a skill is not available in the environment, apply its rules by hand (tokens, AA contrast, one orange CTA per zone) and say so in the changelog.
Practical exception: a change that only reuses existing primitives without new styling (e.g. a new form field) may go straight to step 4.

## 2. Brand identity (non-negotiable)

| Role | Hex | Usage |
|---|---|---|
| Primary blue | `#004A99` | Brand: header, links, active states, strong titles, secondary outline buttons. |
| Accent orange | `#EE7F00` | Non-text accents, highlights. **Never** behind white or small text (2.74:1, fails AA). |
| Neutral grey | `#BCBDBF` | Strong borders, separators, disabled, secondary icons. |

Derived scale (light theme): background `#F5F7FA`, surface `#FFFFFF`, text `#1A2230` (never `#000`), secondary text `#5B6676`, borders `#E4E8EE` / `#BCBDBF`, blue `#003A78` (hover) `#1E63B5` (light, focus) `#E8F0F9` (tint), orange `#CC6E00` (hover) `#FFF3E6` (tint).

**Decision (2026-06-19, AA review)**: the primary CTA uses `--color-cta` `#A85F00` (darkened brand orange, white bold text 4.88:1) and `--color-cta-hover` `#8C4E00`. It is the only orange derivative allowed as a text background. For small orange text (link, label), use `--color-accent-strong` `#8F4F00` (class `text-accent-strong`), AA on white. The `success` / `danger` signal colors are functional (statuses only), not brand colors.

Theme: **light only**. No dark mode unless explicitly requested; if it ever is, through `[data-theme]`. Only dark surface allowed: the terminal (`--terminal-*` tokens).

## 3. Tokens (single source)

- Everything goes through `apps/web/src/styles/tokens.css` (CSS variables) mirrored in `apps/web/tailwind.config.ts` (semantic names). **Zero** hard-coded color, spacing, radius or shadow in a component.
- Careful: the Tailwind config declares the tokens under `theme.extend`, so Tailwind's **default** palette and scales stay available (`text-white`, `rounded-full`, `bg-gray-*`…). They are forbidden: only use the semantic classes listed in `brain/architecture/frontend.md` (tokens → classes section).
- Type: self-hosted Inter (`@fontsource/inter`). Scale 12 / 14 / 16 (base) / 18 / 20 / 24 / 30 / 36 / 48; line-height 1.5 body, 1.2 headings. Weight 700 and bold italic reserved to branding. `tabular-nums` for numbers in tables.
- Spacing on a 4 px grid: 4, 8, 12, 16, 24, 32, 48, 64.
- Radius: `xs` 4 px (micro-controls only), `sm` 8 px (inputs, buttons, badges), `md` 12 px (cards, dialogs), `lg` 16 px (large containers). No pills, no "bubble".
- Soft, rare shadows: `0 1px 2px rgba(16,24,40,.05)`, `0 4px 12px rgba(16,24,40,.08)`, dialogs `0 12px 32px rgba(16,24,40,.10)`.
- Motion: 150 to 200 ms `ease-out`, only `transform` / `opacity` / `background-color`, respect `prefers-reduced-motion`.
- Semantic z-index (`--z-dropdown` … `--z-tooltip`), never a magic value.

## 4. Visual direction

- Light, clean, technical, premium: lots of white, strict alignment, hairlines (1 px borders) rather than elevation.
- **One filled orange CTA per action zone.** Everything else is blue outline or grey ghost. Destructive actions in `danger`, inside a confirmation.
- Identity motif: the logo **diamond**, discreet and monochrome (sidebar active marker, empty states, brand lockup, favicon). Never large, never orange, one per zone.
- Icons: `lucide-react` only, `strokeWidth` 1.75, never emoji.
- Banned: purple/indigo gradients, gradient text, glassmorphism, huge shadows, large radii, emoji icons, generic hero, eyebrow above every section, em dashes in visible strings, fake "John Doe / Acme" data.

## 5. Reuse before creating

Existing primitives and blocks to reuse (see `brain/codemap/web-core.md`): `components/ui/*` (button, input, field, native-select, select, segmented, dialog, alert-dialog, dropdown-menu, tooltip, table, tabs, badge, skeleton, sonner, textarea, password-input…), `components/common/*` (`EmptyState` with `variant="inline"` inside a panel, `ErrorState` for every load failure, `PageHeader`, `RenameDialog`, `StatusBadge`, `RoleBadge`, `UnsavedChangesPrompt`, `FullPageLoader`). Never restyle a native `<select>` by hand (use `NativeSelect`), never re-implement the error block.

## 6. Accessibility (AA minimum)

Visible focus everywhere (2 px blue ring, 2 px offset); full keyboard navigation; `aria-label` on every icon button; `role="alert"` / `aria-live` for errors and toasts; labels above fields, never placeholder-as-label; correct `autocomplete`; contrasts checked (especially orange).

## 7. Definition of Done (UI)

- [ ] Skill sequence §1 followed (or deviation justified in the changelog).
- [ ] Zero hard-coded design value; exact palette + derived scale only.
- [ ] Light theme, AA contrasts checked.
- [ ] Responsive mobile → desktop (no horizontal scroll at 375 px; sidebar as a slide-over below 1024 px).
- [ ] States: loading (skeletons, not a centered spinner), empty (teaches the next step), error (`ErrorState` + retry), hover, focus, active, disabled.
- [ ] Keyboard + ARIA OK.
- [ ] Complete output: no placeholder, `// TODO` or truncated `...`.
- [ ] `web-design-guidelines` review passed.
- [ ] Testing Library tests added or adjusted for visible behavior.

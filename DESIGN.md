# DESIGN.md — DIVE Turbinen (visual + component contract)

> Single source of truth for the look & feel of the app. Synthesised from the mandatory skill sequence
> (`ui-ux-pro-max` → `impeccable` → `design-taste-frontend`) and constrained by `CLAUDE.md` / `AGENTS.md`,
> which **override** any conflicting skill default. Frontend engineers MUST follow this file.
> Light theme only. Register = product (app UI). All tokens live in one place: `apps/web/src/styles/tokens.css`
> mirrored into `tailwind.config.ts`. No hard-coded colors / spacing / radius in components.

---

## 0. Design read & dials

**Reading this as:** a *product* surface (auth + admin back office + app shell) for *internal engineering users*, with a *serious industrial / engineered* language, leaning toward *Tailwind v3 + shadcn-style primitives + Inter*, color identity locked to the DIVE logo.

Skill dials (product-tuned, low-key on purpose):

- `DESIGN_VARIANCE: 3` — orderly, symmetric, grid-aligned. This is instrumentation, not an art piece.
- `MOTION_INTENSITY: 2` — utilitarian transitions only (150–200ms ease-out). No choreography.
- `VISUAL_DENSITY: 4` — comfortable app density; the admin table runs a touch denser.

CLAUDE.md mandates Inter, `lucide-react`, and Tailwind v3. `design-taste-frontend` discourages those as *defaults* but allows them for neutral/technical/standard briefs (its own override path) — which this is. So: **Inter, lucide-react (one family, strokeWidth 1.75), Tailwind v3** are the intended, approved choices here.

---

## 1. The signature idea — "engineered hairline + diamond node"

What makes it feel like DIVE rather than a template: treat the UI like a **precision technical drawing**.

- **Hairline structure.** 1px borders in `--border` do the work that cards and shadows do elsewhere. Group with `border` / `divide-y`, not with heavy elevation. Shadows are soft and rare.
- **The diamond node.** The logo's rhombus (a 45°-rotated square) is the recurring "joint" of that drawing. Use it sparingly and monochrome:
  - the active item marker in the sidebar (small 6px diamond in `--primary`),
  - the bullet/marker in empty states and section dividers,
  - the brand mark lockup in the header and on the login screen,
  - the favicon.
  Never as a large decorative shape, never filled orange, never more than one per visual zone.
- **Optional blueprint ground (very subtle).** The login page may carry a faint engineering grid: `--border`-colored 1px lines at a 32px cadence over `--bg`, opacity ~0.5. It must be barely perceptible. Skip it inside the authenticated app (keeps work surfaces calm).

Restraint test: if the diamond or the grid is the first thing you notice, it is too strong.

---

## 2. Color tokens (LOCKED — exactly these, nothing else)

Define as CSS variables in `tokens.css`; mirror into Tailwind under semantic names. Raw hex never appears in a component.

| Token | Hex | Role |
|---|---|---|
| `--color-primary` | `#004A99` | Brand blue: header, links, active states, strong titles, primary outline buttons. |
| `--color-primary-hover` | `#003A78` | Hover/pressed for primary. |
| `--color-primary-light` | `#1E63B5` | Lighter blue for subtle accents / focus ring base. |
| `--color-primary-tint` | `#E8F0F9` | Blue wash: selected rows, info surfaces, active sidebar item bg. |
| `--color-accent` | `#EE7F00` | Brand orange (logo). Reserved for non-text accents/highlights and surfaces carrying dark text. Not used behind white/small text (fails AA). |
| `--color-accent-hover` | `#CC6E00` | Darker brand orange for accent hover states. |
| `--color-accent-tint` | `#FFF3E6` | Orange wash: warning/attention surfaces (used very sparingly). |
| `--color-cta` | `#A85F00` | **Primary CTA fill** (accessible darkened brand orange). White **bold** label = 4.88:1, passes AA for normal text at any size. The single most important action per zone. |
| `--color-cta-hover` | `#8C4E00` | Hover/pressed for the primary CTA (6.55:1 on white). |
| `--color-neutral` | `#BCBDBF` | Logo grey: marked borders, disabled fills, secondary icons. |
| `--color-bg` | `#F5F7FA` | Page background. |
| `--color-surface` | `#FFFFFF` | Cards, panels, header, table surface. |
| `--color-text` | `#1A2230` | Primary text (never pure `#000`). |
| `--color-text-secondary` | `#5B6676` | Secondary/muted text, helper text, table meta. |
| `--color-border` | `#E4E8EE` | Default hairline border / divider. |
| `--color-border-strong` | `#BCBDBF` | Emphasised border (focused inputs idle, separators that must read). |

Semantic state colors are derived from the same family + standard signal hues used **only** for status (kept muted, always paired with an icon/text, never color-only):

| Token | Hex | Role |
|---|---|---|
| `--color-success` | `#1E7B4F` | Success text/icon (e.g. "active"). |
| `--color-success-tint` | `#E7F4EE` | Success surface. |
| `--color-danger` | `#B42318` | Destructive action, error text/icon. |
| `--color-danger-hover` | `#911A12` | Destructive hover. |
| `--color-danger-tint` | `#FDECEA` | Error surface / destructive ghost hover. |
| `--color-focus-ring` | `#1E63B5` | Focus ring color (blue, 2px, with 2px offset). |

> Brand hues are blue/orange/grey ONLY. The success/danger hues above are **functional signal colors**, not brand colors, and appear only in status/feedback. Do not introduce any other decorative hue.

Contrast notes (verified): body text `--color-text` on `--surface`/`--bg` ≥ 12:1. `--color-text-secondary` on `--surface` ≈ 5.8:1 (AA). The white-text CTA uses `--color-cta` `#A85F00` ≈ 4.88:1 (AA normal text); the lighter brand orange `--color-accent` `#EE7F00` with white text is only ≈ 2.74:1, so it is never placed behind white/small text. Never use orange as small text on white.

---

## 3. Typography

- **Family:** Inter (self-hosted via `@fontsource/inter` or `font-display: swap`), `font-feature-settings: "cv05","ss01"` optional; system-ui fallback. One family across the whole UI.
- **Numerals in tables:** `font-variant-numeric: tabular-nums` for dates/counts so columns don't jitter.
- **Fixed rem scale** (product UI, not fluid). Steps and intended use:

| Name | Size / line-height | Weight | Use |
|---|---|---|---|
| `text-xs` | 12 / 16 | 500 | badges, table meta, helper text |
| `text-sm` | 14 / 20 | 400–500 | body in dense UI, inputs, table cells, buttons |
| `text-base` | 16 / 24 | 400 | default body |
| `text-lg` | 18 / 28 | 500–600 | card titles, dialog titles |
| `text-xl` | 20 / 28 | 600 | section headings |
| `text-2xl` | 24 / 32 | 600 | page titles |
| `text-3xl` | 30 / 36 | 700 | login wordmark / large brand moments only |

Weights: 400 body, 500 labels, 600 headings/buttons, 700 reserved for brand. Headings letter-spacing `-0.01em`; never tighter than `-0.02em`. Prose capped at 65–75ch; table content may run wider.

---

## 4. Spacing, radius, shadow, motion, z-index

- **Spacing scale (4px):** 4, 8, 12, 16, 24, 32, 48, 64. Use rhythm, not one uniform gap.
- **Radius (documented Shape Lock — apply consistently):**
  - `--radius-sm: 8px` → inputs, buttons, badges, dropdowns, small controls.
  - `--radius-md: 12px` → cards, dialogs, panels, table container.
  - `--radius-lg: 16px` → the login card and other large standalone containers.
  No pill buttons, no full-round "bubble" radii.
- **Shadows (soft, low, tinted — rare):**
  - `--shadow-sm: 0 1px 2px rgba(16,24,40,.05)` → resting cards, inputs.
  - `--shadow-md: 0 4px 12px rgba(16,24,40,.08)` → dropdowns, popovers.
  - `--shadow-lg: 0 12px 32px rgba(16,24,40,.10)` → dialogs only.
  Never pure-black, never neon/glow.
- **Motion:** 150–200ms, `ease-out` (`cubic-bezier(0.16,1,0.3,1)`). Animate `transform`/`opacity`/`background-color` only. `:active` gives a 1px tactile push (`translate-y-[1px]` or `scale-[0.99]`). Dialogs scale+fade from 0.98→1. Everything wrapped for `prefers-reduced-motion: reduce` (degrade to instant/crossfade).
- **z-index scale (semantic, no magic 9999):** `--z-base:0`, `--z-dropdown:1000`, `--z-sticky:1100`, `--z-overlay:1200`, `--z-modal:1300`, `--z-toast:1400`, `--z-tooltip:1500`.

---

## 5. App-shell pattern

Authenticated layout = **fixed top header + left sidebar + content area**.

- **Header (64px, `--surface`, bottom `1px --border`):** left = brand lockup (diamond mark + "DIVE Turbinen" wordmark in `--primary`, the bold-italic style reserved for branding). Right = user menu (avatar/initials button → dropdown with email, role, "Log out"). No search in this phase. Single line, never taller than 72px.
- **Sidebar (240px desktop, `--surface`, right `1px --border`):** vertical nav, icon + label (lucide, strokeWidth 1.75). Items this phase: **Home** (always), **Administration** (super-admin only). Active item: `--primary-tint` background, `--primary` text/icon, and a 6px `--primary` diamond marker at the left edge. Hover: `--bg`. Full keyboard nav; `aria-current="page"` on the active item.
- **Content area:** `--bg`, max content width `max-w-[1200px]`, padding `24–32px`. Page title row at top (title + optional primary action aligned right).
- **Responsive (structural, not fluid type):** < 1024px the sidebar collapses behind a header menu button into a `lucide:Menu`-triggered slide-over (Radix Dialog/Sheet); content goes full-width with `px-4`. Header stays fixed. No horizontal scroll at 375px.

---

## 6. Component inventory & states

Every interactive component ships **all** of: default, hover, focus-visible, active, disabled, and where relevant loading & error. Built on shadcn-style primitives (Radix under the hood), restyled to these tokens — never shipped in default shadcn skin.

- **Button** variants:
  - `primary` (orange CTA): `--color-cta` (`#A85F00`) fill, white **bold (700)** label (4.88:1, AA), `--color-cta-hover` on hover, 1px active push. The single most important action in a zone. `disabled` → `--border` fill + `--text-secondary` label (legible, 4.73:1).
  - `secondary` (blue outline): transparent bg, `1px --primary` border, `--primary` label; hover `--primary-tint` bg.
  - `ghost` (grey): transparent; hover `--bg`; for low-emphasis/toolbar actions.
  - `destructive`: used only inside confirm dialogs — `--danger` fill, white label, `--danger-hover`.
  - Sizes: `sm` (h-32px), `md` (h-40px, default), `icon` (40×40, must have `aria-label`). Loading state: disable + inline `lucide:Loader2` spinner + keep label; never a layout shift.
- **Input / Field:** label **above** (`text-sm` 500), input `h-40px`, `--radius-sm`, `1px --border`; idle border darkens to `--border-strong` on hover. Focus: `--focus-ring` 2px ring + 2px offset, border `--primary`. Helper text below in `--text-secondary`; error text below in `--danger` with `role="alert"`; errored input border `--danger`. Password field has a show/hide toggle (`lucide:Eye`/`EyeOff`). Never placeholder-as-label. `autocomplete` set correctly (email, current-password, new-password).
- **Badge (role/status):** `text-xs` 500, `--radius-sm`, 4px 8px padding. `super-admin` → `--primary-tint` bg + `--primary` text + tiny diamond glyph. `user` → neutral: `--bg` bg + `--text-secondary` text + `1px --border`. Status badges (if shown) pair a dot/icon with text (never color-only).
- **Table (admin):** surface card with `--radius-md`, `1px --border`, `--shadow-sm`. Header row: `--bg` background, `text-xs` uppercase-off `--text-secondary` 500 labels, sortable headers show `aria-sort` + chevron. Body rows: `h-56px`, `text-sm`, `divide-y --border`, hover `--bg`, `tabular-nums` for dates. Row actions live in a trailing right-aligned cell (ghost icon buttons or a `lucide:MoreHorizontal` dropdown). The protected super-admin row: actions for delete & role-downgrade are **disabled** with a tooltip "The super-admin account is permanent and cannot be removed or downgraded." Selected/own row may carry a subtle `--primary-tint` left state. No zebra striping (hairlines do the separation).
- **Dialog (Radix):** centered, `--surface`, `--radius-md`, `--shadow-lg`, max-w 480px (forms) / 420px (confirmations). Scrim `rgba(16,24,40,.45)`. Title `text-lg` 600, body `text-sm` `--text-secondary`. Footer: secondary (ghost/outline) + one primary, right-aligned. Esc + scrim click close; focus trapped; focus returns to trigger. Used for create/edit user and delete confirmation only (modals are reserved, not the first reflex).
- **Dropdown menu / Tooltip / Avatar / Separator:** Radix primitives, tokenised. Tooltips explain disabled actions and icon-only buttons.
- **Toasts (`sonner`, tokenised):** transient success/error feedback, top-right, auto-dismiss 4s, `aria-live="polite"`, never steals focus. Success = `--success` accent; error = `--danger` accent.
- **Skeletons:** loading uses skeleton blocks matching final layout (table → header + N shimmer rows), not centered spinners. Shimmer is a slow `--border`→`--bg` sweep, reduced-motion → static `--border` block.
- **Empty state:** centered, a small monochrome diamond mark, a `text-lg` line + one `text-sm` `--text-secondary` line of guidance, and (where it makes sense) one action. Teaches the next step; never just "Nothing here."

---

## 7. Screen specs

### 7.1 Login (`/login`)
- Calm full-height (`min-h-[100dvh]`) `--bg` page with the optional faint blueprint ground. Centered card: `--surface`, `--radius-lg`, `--shadow-md`, max-w 400px, padding 32px.
- Inside: brand lockup (diamond + wordmark) → `text-2xl` "Sign in" → email field → password field (with show/hide) → **one** primary orange button "Sign in" (full width). A single secondary line only if needed (e.g. inline error). No social login, no "remember me" theatrics, no marketing.
- States: idle; submit → button loading + fields disabled; error → inline `role="alert"` banner above the fields ("Invalid email or password.") + errored field borders; success → redirect to `/`. First field autofocused; Enter submits; `autocomplete` correct.

### 7.2 Home (`/`)
- Intentionally blank **content**, full **shell**. Page title "Home" / short welcome line addressing the signed-in user by name. Content area shows a tasteful empty state: diamond mark + "Your workspace is ready." + one muted line noting the solver-control tools arrive in a later phase. No fake widgets, no placeholder charts.

### 7.3 Administration (`/admin`, super-admin only)
- Guarded route (non-super-admin → redirected / 403 view). Page title "Administration" + subtitle "Manage who can access the platform." Primary action top-right: **one** orange "Add user" button (opens create dialog).
- Users table per §6. Columns: **Name**, **Email**, **Role** (badge), **Created** (tabular date), **Actions** (Edit, Delete). The super-admin row shows the protected badge and disabled Delete/downgrade with explanatory tooltip.
- Create/Edit dialog: fields Full name, Email, Role (select: super-admin / user — editing the super-admin locks the role to super-admin), Password (required on create, "leave blank to keep" on edit). Inline validation on blur, error summary + first-invalid-field focus on submit failure. Save → toast + optimistic table update (TanStack Query).
- Delete: confirmation dialog naming the user; destructive button. Protected account can never reach this state. After delete → toast, row removed; cannot delete your own account (guarded with explanation).
- States: loading → skeleton rows; empty (only super-admin exists) → friendly note inviting "Add user"; error → inline error block with retry.

---

## 8. Anti-slop checklist (product-specific — enforce before "done")

- [ ] **Zero em-dashes / en-dash-as-separator** in any visible string. Use hyphen. (design-taste-frontend §9.G, non-negotiable.)
- [ ] **Color lock:** only blue/orange/grey brand (+ the accessible CTA derivative `--color-cta`) + functional success/danger signals. One filled CTA per zone (white bold on `--color-cta`); never small orange text on white.
- [ ] **Shape lock:** the 8/12/16 radius rule applied consistently; no pill/bubble radii.
- [ ] **One icon family** (lucide-react), uniform strokeWidth 1.75; no emoji icons; no hand-rolled icon paths.
- [ ] **Full states** on every control (default/hover/focus/active/disabled/loading/error). Skeletons not spinners. Empty states teach.
- [ ] **WCAG AA** verified: focus ring visible everywhere, keyboard path complete, ARIA on icon buttons, `aria-live` errors/toasts, orange contrast respected.
- [ ] **No AI tells:** no "John Doe"/"Acme" seed data (use realistic German-context names/emails where examples are needed), no fake-precise numbers, no decorative status dots (role badge is semantic and allowed), no eyebrow above every section, no scroll cues, no version/locale/weather strips, no gradient text, no side-stripe borders.
- [ ] **Hairlines over heaviness:** group with borders/dividers; shadows soft and rare; no glassmorphism, no huge shadows.
- [ ] **Theme lock:** light only, consistent across all surfaces.
- [ ] **Tokens only:** no raw hex / px color / radius in components; everything via `tokens.css` + Tailwind semantic names.
- [ ] **Diamond motif** present but subtle (sidebar active marker, empty states, brand lockup, favicon) — never dominant, never orange-filled.

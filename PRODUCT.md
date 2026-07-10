# Product

## Register

product

## Users

Internal staff of **DIVE Turbinen GmbH & Co. KG** (German B2B turbine manufacturer):

- **Engineers / CFD analysts** who prepare OpenFOAM cases (mesh import & conversion, case setup, multi-part assembly), launch solver runs and watch their residuals live, and export results for CFD-Post — all per project, from the browser.
- **Administrators (super-admin)** who manage the roster of accounts that may access the platform.

Context of use: desktop, office environment, focused task work (not casual browsing, not mobile-first). Users return to the tool repeatedly and expect it to be predictable and fast.

## Product Purpose

A controlled internal web platform to **prepare, run and post-process OpenFOAM CFD cases** from the browser. Per project it delivers the full workflow — mesh import & CGNS→Foam conversion, a 3D viewer, multi-part assembly, solver runs with live residuals, and export to CFD-Post — on top of a secure foundation: JWT authentication and an admin back office where the super-admin account is permanent. Success = a secure, trustworthy tool an engineering team can log into daily to drive their CFD work, with account administration that cannot be misused (no accidental lockout — the super-admin is protected).

## Brand Personality

Three words: **Engineered, Precise, Trustworthy.** Voice is sober and technical, like good instrumentation: it states facts, never sells. Visual tone is industrial and geometric — lots of white, strict 4px alignment, restrained use of the brand orange. It should feel like serious German engineering software, not a flashy startup SaaS.

## Anti-references

- Flashy startup SaaS landing aesthetics (oversized gradient heroes, marketing fluff).
- AI-default "purple/indigo glow" gradients; gradient text.
- Glassmorphism-everywhere, huge soft shadows, bubble-radius "friendly app" look.
- Playful/consumer dashboard styling, emoji icons, decorative motion.
- Generic admin-template look (zebra mega-tables, three identical stat cards, eyebrow label above every section).

## Design Principles

1. **The tool disappears into the task.** Earned familiarity beats novelty; standard affordances for standard jobs.
2. **Engineered precision.** Everything aligns to the grid; geometry and hairlines over decoration. The interface should read like a clean technical drawing.
3. **Orange is a scalpel, not paint.** Exactly one filled orange CTA per zone; the accent marks the single most important action and nothing else.
4. **Trust through legible state.** Every state (loading, empty, error, disabled, protected) is always explicit and understandable. No silent failures, no ambiguous controls.
5. **Protect the operator.** Destructive and irreversible actions are guarded, confirmed, and — for the super-admin — impossible by design.

## Accessibility & Inclusion

WCAG **AA** minimum. Full keyboard operability with a visible focus ring on every interactive element; logical tab order; ARIA labels on icon-only controls; `aria-live` for form errors and toasts. The brand orange `#EE7F00` fails AA for small text on white, so it is used only as a fill behind white text or for large/bold text — never as small body text on white. Respect `prefers-reduced-motion`.

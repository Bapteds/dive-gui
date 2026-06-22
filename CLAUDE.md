# CLAUDE.md — DIVE Turbinen Frontend

> Application web React pour **DIVE Turbinen GmbH & Co. KG**.
> Ce fichier régit le **design et la qualité du front** : charte couleurs, thème clair, design tokens, et la séquence de skills à respecter.
> Il ne décrit volontairement PAS l'architecture applicative — uniquement le "look" et les règles de qualité UI.

---

## 0. RÈGLE D'OR — Séquence skills obligatoire (frontend)

**AVANT toute création ou modification d'UI**, exécuter dans cet ordre, sans exception :

1. `ui-ux-pro-max` — cadrer styles, palette, fonts, layout, choix de composants.
2. `frontend-design` (ou `frontend-design:frontend-design`) — design production-grade distinctif.
3. `design-taste-frontend` — passe anti-slop : retirer tout ce qui ressemble à un template générique.
4. `web-design-guidelines` — review de conformité aux Web Interface Guidelines avant de considérer une tâche terminée.

Pour un **redesign** d'écran existant : ajouter `redesign-existing-projects` après l'étape 1.
Pour du styling shadcn/Tailwind détaillé : `ckm-ui-styling`.

Ne JAMAIS écrire de JSX/CSS avant d'avoir consulté les skills 1→3. Si un skill est sauté, recommencer.
Pour chaque modification du code le notifier en bas du fichier PLAN.md

---

## 1. Identité de marque (NON négociable)

Couleurs extraites du logo officiel. Utiliser **exactement** ces valeurs hex, jamais d'approximation.

| Rôle | Hex | Usage |
|------|-----|-------|
| **Blue / Primary** | `#004A99` | Couleur de marque principale. Header, liens, états actifs, titres forts. |
| **Orange / Accent** | `#EE7F00` | Action principale (CTA), badges, highlights, focus. À doser : c'est un accent, pas un fond. |
| **Grey / Neutral** | `#BCBDBF` | Bordures, séparateurs, états désactivés, icônes secondaires. |

### Échelle dérivée (thème CLAIR uniquement)
- **Background page** : `#F5F7FA`
- **Surface / cards** : `#FFFFFF`
- **Texte principal** : `#1A2230` (jamais `#000` pur)
- **Texte secondaire** : `#5B6676`
- **Bordures** : `#E4E8EE` (claire), `#BCBDBF` (marquée)
- Dérivés bleu : `#003A78` (hover/foncé), `#1E63B5` (clair), `#E8F0F9` (tint de fond)
- Dérivés orange : `#CC6E00` (hover/foncé), `#FFF3E6` (tint de fond)

### Thème
- **Clair par défaut, et seul thème livré.** Pas de dark mode sauf demande explicite. Si demandé un jour : via `[data-theme]`, jamais en dur.

---

## 2. Design tokens (source unique)

Centraliser TOUT dans un fichier de tokens unique (CSS variables + miroir dans `tailwind.config`). Aucune couleur / spacing / radius en dur dans les composants.

- **Couleurs** : `--color-primary`, `--color-accent`, `--color-neutral` + l'échelle ci-dessus.
- **Typo** : sans-serif moderne (ex. *Inter*, *Geist*, ou *Manrope*). Le style italique gras du logo est réservé au branding/gros titres, pas au corps de texte.
- **Échelle typo** : 12 / 14 / 16 (base) / 18 / 20 / 24 / 30 / 36 / 48. Line-height 1.5 corps, 1.2 titres.
- **Spacing** : échelle 4px (4, 8, 12, 16, 24, 32, 48, 64).
- **Radius** : `--radius-sm: 8px`, `--radius-md: 12px`, `--radius-lg: 16px`.
- **Ombres** : douces et basses (`0 1px 2px rgba(16,24,40,.05)`, `0 4px 12px rgba(16,24,40,.08)`). Pas d'ombres dures ni de néon.
- **Clin d'œil identité** : le losange du logo peut servir de motif discret (puces, vide-états, séparateurs). Subtil, jamais envahissant.

---

## 3. Conventions front

- **React + Vite + TypeScript**. Composants fonctionnels + hooks uniquement.
- **Styling** : Tailwind CSS (branché sur les tokens) + shadcn/ui pour les primitives.
- **Icônes** : `lucide-react`, trait fin cohérent.
- **Performance** : appliquer `react-best-practices` (memo ciblé, code-split par route, pas de re-render inutile).
- **Accessibilité** : AA minimum. L'orange `#EE7F00` sur blanc est limite pour du petit texte → ne l'utiliser que pour texte large/bold ou sur fond, pas pour du body text. Focus visibles, navigation clavier complète, labels ARIA.

---

## 4. Direction visuelle (le "look")

- **Thème clair, propre, technique, premium.** Beaucoup de blanc, alignement strict sur la grille 4px, coins arrondis (8–16px), ombres douces.
- **CTA** : un seul bouton orange plein par zone d'action. Le reste en bleu outline ou ghost gris.
- **Motion** : transitions courtes et utilitaires (150–200ms, ease-out). Pas d'animations spectaculaires.
- **Ton** : entreprise industrielle sérieuse → sobre et géométrique, pas "startup flashy".

À BANNIR (signaux de "slop") : dégradés violet/indigo génériques, glassmorphism partout, emojis comme icônes, ombres énormes, gros border-radius façon "bubble". `design-taste-frontend` doit valider l'absence de ces patterns.

---

## 5. Definition of Done (front)

- [ ] Skills 1→4 (section 0) exécutés dans l'ordre.
- [ ] Zéro couleur / spacing / radius en dur — tout passe par les tokens.
- [ ] Palette = exactement `#004A99` / `#EE7F00` / `#BCBDBF` + échelle dérivée. Aucune autre teinte de marque.
- [ ] Thème clair, contrastes AA vérifiés (surtout l'orange).
- [ ] Responsive (mobile → desktop) testé.
- [ ] États gérés : loading, empty, error, hover, focus, disabled.
- [ ] Accessibilité clavier + ARIA OK.
- [ ] Sortie complète, aucun placeholder / `// TODO` / `...` tronqué → `full-output-enforcement`.
- [ ] Review `web-design-guidelines` passée.

---

## 6. Rappels permanents

- En cas de doute sur une couleur → revenir au logo (`#004A99` / `#EE7F00` / `#BCBDBF`).
- En cas de doute sur le style → "clair, propre, géométrique, peu d'orange, beaucoup de blanc".
- Toujours préférer la clarté et la cohérence à l'effet.

# AGENTS.md — DIVE Turbinen Frontend

> Instructions pour tout agent (Claude Code, Codex, ou autre) travaillant sur le front de **DIVE Turbinen GmbH & Co. KG**.
> `CLAUDE.md` reste la référence détaillée (charte, tokens, DoD). Ce fichier est le **mode d'emploi opérationnel** côté design/front.
> Périmètre : couleurs, thème clair, qualité UI. Pas d'architecture applicative.

---

## 1. Contexte

- **Client** : DIVE Turbinen — industriel B2B allemand. Ton visuel : sobre, technique, premium.
- **Thème** : **clair uniquement**. Pas de dark mode sans demande explicite.
- **Charte (extraite du logo)** :
  - Bleu primaire `#004A99`
  - Orange accent `#EE7F00`
  - Gris neutre `#BCBDBF`
  - Fond `#F5F7FA`, surfaces `#FFFFFF`, texte `#1A2230`.

Avant d'agir, l'agent lit `CLAUDE.md`. Si une instruction contredit la charte ou le thème clair, demander confirmation explicite.

---

## 2. Séquence de skills OBLIGATOIRE (tout travail UI)

```
1. ui-ux-pro-max          → palette, fonts, layout, choix composants
2. frontend-design        → design production-grade (skill principal)
3. design-taste-frontend  → passe anti-slop (retire le générique/templaté)
4. web-design-guidelines  → review conformité = porte de sortie
```

Compléments selon le cas :
- Redesign d'existant → `redesign-existing-projects` après l'étape 1.
- Styling shadcn/Tailwind → `ckm-ui-styling`.
- Perf React → `react-best-practices`.

> Règle dure : pas de code UI tant que les skills 1→3 n'ont pas été consultés. Skill sauté = on recommence.

---

## 3. Règles de design appliquées sans qu'on les redemande

1. **Tokens d'abord.** Un fichier unique de design tokens (CSS variables + `tailwind.config`). **Aucune** couleur / spacing / radius / ombre en dur dans un composant.
2. **Palette stricte.** Seulement `#004A99` / `#EE7F00` / `#BCBDBF` + l'échelle dérivée de `CLAUDE.md`. Jamais de nouvelle teinte de marque (pas de violet/indigo génériques).
3. **Orange = accent rare.** Un seul CTA orange plein par zone. Jamais en grand aplat de fond, jamais pour du petit texte (contraste insuffisant sur blanc).
4. **Beaucoup de blanc**, grille 4px, coins arrondis (8–16px), ombres douces et basses.
5. **Motion utilitaire** : 150–200ms ease-out. Pas d'effets spectaculaires.
6. **Identité** : le losange du logo en motif discret (puces, vide-états, séparateurs).
7. **Accessibilité AA** : focus visibles, navigation clavier, ARIA, contrastes vérifiés (surtout l'orange).

Signaux de "slop" à éliminer : dégradés violets, glassmorphism partout, emojis-icônes, ombres énormes, hero générique, gros radius "bubble".

---

## 4. Stack

- React + **Vite** + **TypeScript**, composants fonctionnels + hooks.
- **Tailwind CSS** (branché sur les tokens) + **shadcn/ui**.
- Icônes : **lucide-react**, trait fin cohérent.

---

## 5. Definition of Done

- [ ] Séquence skills 1→4 exécutée dans l'ordre.
- [ ] Palette exacte `#004A99` / `#EE7F00` / `#BCBDBF` + échelle dérivée, rien d'autre.
- [ ] Thème clair, contrastes AA validés.
- [ ] Zéro valeur de design en dur (tout via tokens).
- [ ] Responsive mobile → desktop testé.
- [ ] États couverts : loading, empty, error, hover, focus, disabled.
- [ ] Accessibilité clavier + ARIA OK.
- [ ] Sortie complète, aucun placeholder / `// TODO` / `...` tronqué → `full-output-enforcement`.

---

## 6. Garde-fous

- Ne jamais dévier de la charte ou passer en dark mode sans accord explicite.
- Ambiguïté de couleur → revenir au logo (`#004A99` / `#EE7F00` / `#BCBDBF`).
- Ambiguïté de style → "clair, propre, géométrique, peu d'orange, beaucoup de blanc".
- Préférer toujours la cohérence et la clarté à l'effet visuel.

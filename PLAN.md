# PLAN.md — DIVE Turbinen · openFOAM Solver Control

> Plan d'implémentation de la base applicative.
> Objectif de cette phase : **fondations** — auth, back office admin de gestion des comptes, page d'accueil vierge.
> Le pilotage réel d'`openFoamSolver` (serveur distant) **n'est PAS** dans le périmètre de cette phase (pas de serveur dispo). On prépare seulement le terrain.

---

## 1. Décisions validées (avec l'utilisateur)

| Sujet | Choix | Note |
|-------|-------|------|
| API | **Vrai backend Node + TypeScript** (Express) | Serveur séparé, REST, prêt à brancher openFOAM plus tard. |
| Persistance | **SQLite (fichier local) via Prisma** | Zéro install serveur ; migration Postgres triviale ensuite. |
| Authentification | **JWT access + refresh** | Access token court (15 min), refresh en cookie `httpOnly` (7 j). |
| Rôles | **`super-admin` / `user`** | `super-admin` indélébile et non rétrogradable. |

> Choix du framework backend : **Express** (léger, explicite, TypeScript). Alternative écartée pour l'instant : NestJS (plus structuré mais lourd pour une base). À rediscuter si le périmètre grossit.

---

## 2. Architecture du dépôt (monorepo)

```
app/
├── apps/
│   ├── api/                 # Backend Express + TS + Prisma
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   └── seed.ts       # crée le super-admin initial
│   │   ├── src/
│   │   │   ├── config/       # env, constantes
│   │   │   ├── lib/          # prisma client, jwt, hashing, logger
│   │   │   ├── middleware/   # auth, role guard, error handler, validation
│   │   │   ├── modules/
│   │   │   │   ├── auth/      # routes login / refresh / logout / me
│   │   │   │   └── users/     # CRUD comptes (back office)
│   │   │   ├── app.ts        # app Express
│   │   │   └── server.ts     # bootstrap
│   │   ├── .env.example
│   │   └── package.json
│   └── web/                  # Frontend React + Vite + TS
│       ├── src/
│       │   ├── app/          # routes, providers, guards
│       │   ├── components/   # UI réutilisable + primitives shadcn
│       │   ├── features/
│       │   │   ├── auth/     # login, contexte session
│       │   │   └── admin/    # back office users
│       │   ├── lib/          # client API (fetch + refresh auto), utils
│       │   ├── pages/        # Home, Login, Admin
│       │   ├── styles/
│       │   │   └── tokens.css # design tokens (source unique CSS vars)
│       │   └── main.tsx
│       ├── tailwind.config.ts # miroir des tokens
│       └── package.json
├── package.json              # workspaces (npm) + scripts racine
├── AGENTS.md                 # (existant) règles front
├── CLAUDE.md                 # (existant) charte design
└── PLAN.md                   # ce fichier
```

> Découplage strict front/back. Le front parle au back uniquement via le client API (`apps/web/src/lib/api`). Quand le serveur openFOAM existera, on ajoutera un module `solver/` côté API sans toucher au reste.

---

## 3. Modèle de données (Prisma / SQLite)

```prisma
model User {
  id           String   @id @default(cuid())
  email        String   @unique
  fullName     String
  passwordHash String
  role         Role     @default(USER)
  isProtected  Boolean  @default(false) // true = super-admin indélébile
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}

enum Role {
  SUPER_ADMIN
  USER
}
```

- **Mots de passe** : hash `argon2` (jamais en clair, jamais loggués).
- **Seed** : crée 1 `super-admin` (`isProtected = true`) depuis variables d'env (`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`). Idempotent.

---

## 4. API REST — contrat

Préfixe : `/api/v1`. Réponses JSON. Erreurs normalisées `{ error: { code, message } }`.

### Auth
| Méthode | Route | Accès | Rôle |
|---------|-------|-------|------|
| POST | `/auth/login` | public | — | corps `{ email, password }` → access token + pose le cookie refresh |
| POST | `/auth/refresh` | cookie | — | renvoie un nouvel access token |
| POST | `/auth/logout` | auth | — | invalide le cookie refresh |
| GET  | `/auth/me` | auth | — | profil de l'utilisateur courant |

### Users (back office)
| Méthode | Route | Rôle requis |
|---------|-------|-------------|
| GET    | `/users` | `super-admin` | liste paginée |
| POST   | `/users` | `super-admin` | crée un compte |
| GET    | `/users/:id` | `super-admin` | détail |
| PATCH  | `/users/:id` | `super-admin` | modifie (nom, rôle, mot de passe) |
| DELETE | `/users/:id` | `super-admin` | supprime |

**Règles métier dures (testées) :**
- Un compte `isProtected` (super-admin) **ne peut pas** être supprimé → `409`.
- Le super-admin ne peut pas être rétrogradé en `user`.
- On ne peut pas supprimer son **propre** compte.
- Email unique ; validation des entrées via `zod`.

---

## 5. Sécurité

- Hash mots de passe : `argon2id`.
- JWT signés (`jsonwebtoken`), secret en env ; access 15 min, refresh 7 j (cookie `httpOnly`, `SameSite=Lax`, `Secure` en prod).
- Middleware : `requireAuth` (vérifie l'access token) + `requireRole('SUPER_ADMIN')`.
- `helmet`, CORS restreint à l'origine front, rate-limit sur `/auth/login`.
- Aucune donnée sensible en log. Variables secrètes uniquement via `.env` (jamais commit ; `.env.example` fourni).

---

## 6. Frontend — écrans & routing

Stack imposée par `CLAUDE.md` / `AGENTS.md` : React + Vite + TS, Tailwind branché sur les tokens, shadcn/ui, `lucide-react`.

- **Routing** : `react-router`. Garde de route (`<RequireAuth>`, `<RequireRole>`).
- **Session** : contexte React + client API qui rafraîchit l'access token automatiquement sur `401`.
- **Écrans** :
  1. `/login` — formulaire email + mot de passe (états : idle, loading, erreur).
  2. `/` — **page d'accueil vierge** (layout + header de marque, contenu vide volontairement).
  3. `/admin` — back office (réservé `super-admin`) : table des comptes, création, édition, suppression avec confirmation. Le super-admin apparaît avec un badge « protégé » et actions delete/downgrade désactivées.
- **États gérés partout** : loading, empty, error, hover, focus, disabled (DoD CLAUDE.md).
- **Design** : 100 % via tokens (`tokens.css` + `tailwind.config`), palette stricte `#004A99 / #EE7F00 / #BCBDBF` + échelle. Thème clair uniquement.

> ⚠️ Règle CLAUDE.md §0 : avant TOUT JSX/CSS, exécuter la séquence skills **1) ui-ux-pro-max → 2) frontend-design → 3) design-taste-frontend → 4) web-design-guidelines**. Aucune ligne d'UI ne sera écrite avant ça.

---

## 7. Qualité / outillage

- TypeScript strict des deux côtés. ESLint + Prettier. Code **commenté en anglais**.
- Tests : `vitest` (front) + tests API (supertest) ciblés sur les règles métier critiques (suppression super-admin, auth, rôles).
- Scripts racine : `dev` (front + api en parallèle), `build`, `lint`, `test`, `db:migrate`, `db:seed`.
- `full-output-enforcement` : aucun placeholder ni `// TODO` tronqué dans le code livré.

---

## 8. Découpage en lots (ordre d'exécution proposé)

1. **Lot 0 — Scaffolding** : monorepo (workspaces), configs TS/ESLint/Prettier, `.env.example`, scripts racine.
2. **Lot 1 — Backend auth & DB** : Prisma + SQLite, schéma, seed super-admin, modules auth (login/refresh/logout/me), middlewares sécurité. + tests.
3. **Lot 2 — Backend users** : CRUD + règles métier (protection super-admin). + tests.
4. **Lot 3 — Front fondation** : Vite, tokens design, Tailwind, shadcn, client API, contexte session, routing + gardes. *(skills 1→4 d'abord)*
5. **Lot 4 — Écrans** : Login, Home vierge, Back office Admin. *(skills 1→4 d'abord)*
6. **Lot 5 — Finitions** : responsive, a11y AA, review `web-design-guidelines`, README de lancement.

> Je te propose de **valider ce plan**, puis d'exécuter lot par lot (je te montre le résultat à chaque lot). Dis-moi si tu veux ajuster le framework backend, le périmètre des rôles, ou l'ordre des lots.

---

## 9. Points encore ouverts (à confirmer si besoin)

- **Gestionnaire de paquets** : npm workspaces par défaut
- **Inscription publique** : aucune — les comptes sont créés uniquement par le super-admin via le back office.
- **Réinitialisation mot de passe / email** : hors périmètre de cette base (pas de serveur mail). À planifier plus tard.

---

## 10. Journal des modifications de code
<!-- Chaque modification de code est notée ici (exigence CLAUDE.md §0). Format : date — lot — fichiers — description. -->

| Date | Lot | Fichiers / zone | Description |
|------|-----|-----------------|-------------|
| 2026-06-19 | Design (skills 1→3) | `PRODUCT.md`, `DESIGN.md` | Direction design issue de `ui-ux-pro-max` → `impeccable` (substitut de `frontend-design`, non installé) → `design-taste-frontend`. Contrat visuel + tokens verrouillés + specs des 3 écrans. |
| 2026-06-19 | Lot 0 (Scaffolding) | racine, `apps/api`, `apps/web` | Monorepo npm workspaces ; `@dive/api` (Express+TS CommonJS, app bootable, env validé zod) + `@dive/web` (Vite+React 18+TS, alias `@`) ; configs TS/ESLint9/Prettier ; install unique (555 paquets, argon2 natif OK). Gates verts (typecheck/build/lint/health). |
| 2026-06-19 | Lot 1+2 (Backend) | `apps/api/prisma`, `apps/api/src`, `apps/api/tests` | Prisma/SQLite (modèle `User` ; `role` en `String` car SQLite/Prisma 5.22 sans enum natif, enum appliqué côté zod) + migration `init` + seed super-admin argon2id idempotent. JWT access+refresh, révocation par `tokenVersion` au logout, cookie refresh httpOnly path-scopé. Middlewares auth/role/validate/rate-limit. CRUD `/users` + règles dures (`PROTECTED_ACCOUNT`, `PROTECTED_ROLE`, `SELF_DELETE_FORBIDDEN`, `EMAIL_TAKEN`). 29 tests supertest verts. Note : `DATABASE_URL=file:./dev.db` (résolu relativement à `prisma/`). |
| 2026-06-19 | Lot 3 (Front fondation) | `apps/web/src` | `tokens.css` + `tailwind.config.ts` (charte exacte, tout en variables CSS), primitives shadcn/Radix tokenisées (button/input/field/password/badge/table/dialog/alert-dialog/select/dropdown/tooltip/avatar/separator/skeleton/sonner), client API (refresh single-flight sur 401), contexte session (token en mémoire + bootstrap via cookie refresh), react-router + gardes `RequireAuth`/`RequireRole`, app-shell (header/sidebar/nav mobile), pages **Login + Home finalisées**. Gates verts. Inter chargé via `<link>` Google Fonts (pas de paquet font dispo). |
| 2026-06-19 | Lot 4 (Écrans Admin) | `apps/web/src/features/admin`, `pages/AdminPage.tsx`, `vitest.config.ts` | Back office complet : table users (états loading skeleton / empty / error), dialogue create/edit (react-hook-form + zod, mapping des codes d'erreur API), confirmation de suppression (AlertDialog), **super-admin protégé** (delete + downgrade désactivés avec tooltip via `aria-disabled` focusable), garde anti-auto-suppression, mutations react-query + toasts. 4 tests RTL verts. Table responsive (colonne « Created » masquée < 640px, pas de scroll horizontal à 375px). |
| 2026-06-19 | Lot 5 (QA / intégration / review) | racine, `apps/web/src`, `index.html` | Gate monorepo vert (lint 0 erreur / typecheck / **33 tests** : 29 API + 4 web / build). **Smoke e2e live** sur serveur réel (10/10) : login super-admin seedé, cookie httpOnly, `/me`, `/users`, delete protégé → 409, mauvais mdp → 401, non-auth → 401. **Review `web-design-guidelines` (skill 4)** : 12 correctifs a11y appliqués — CTA accessible `--color-cta #A85F00` blanc gras (**4.88:1** AA), placeholder 5.82:1, bouton désactivé 4.73:1, skip-link, `theme-color`, préload font, `touch-action`, `break-words`, overscroll popovers, ellipses placeholders, focus mobile gardé, live-region erreur login. README de lancement finalisé. **Différé (hors-scope base, documenté)** : état des dialogues dans l'URL, garde de saisie non sauvegardée. |
| 2026-06-19 | Perf (post-livraison) | `apps/web` : `app/router.tsx`, `components/layout/AppShell.tsx`, `features/auth/AuthProvider.tsx`, `vite.config.ts` | Optimisations (skill `react-best-practices`) suite au constat de lenteur. **Mesure** : backend rapide (login argon2 ~65 ms, lecture DB ~7 ms) → goulot côté front. Code-splitting par route (`lazy` + `Suspense` dans le shell) : bundle unique 554 kB → chunks `react`/`router`/`radix`/`query`/`forms`/`vendor` + 1 chunk/page ; `forms`+`AdminPage` (~29 kB gzip) différés jusqu'à `/admin`. Bootstrap session : suppression du `me()` redondant (`refresh()` renvoie déjà l'utilisateur). `optimizeDeps.include` (évite la ré-optimisation Vite à la 1re navigation) + `manualChunks` (vendors cacheables). Valeur de contexte mémoïsée. Gates verts. |
| 2026-06-19 | Perf (police + diagnostic `/`) | `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/package.json` | **Diagnostic** du « ~2000 ms pour le document `/` » : prod `/` mesuré à **~5 ms** (preview) → les 2 s = cold-start Vite (pré-bundling des deps au 1er chargement, **dev uniquement**), pas l'app. **Correctif durable** : Inter **self-hosté** via `@fontsource/inter` (400/500/600/700 + 700 italic), suppression de la requête Google Fonts externe bloquante (~300 ms) → même origine, hors-ligne. Build : 0 référence externe dans le HTML, 35 woff2 bundlés (sous-ensemble latin à la demande). Gates verts (typecheck/lint/33 tests/build). |
| 2026-06-19 | Feature (Compte self-service) | `apps/api/src/modules/auth/*`, `apps/api/src/modules/users/users.service.ts`, `apps/api/tests/{account,users}.test.ts`, `apps/web/src/features/account/*`, `pages/AccountPage.tsx`, `lib/api/{auth,types,client}.ts`, `features/auth/{AuthProvider,auth-context}`, `app/router.tsx`, `components/layout/UserMenu.tsx` | Issu de l'analyse 5 agents (manque fonctionnel n°1 : un USER ne pouvait rien changer sur lui-même). **Backend** : `PATCH /auth/me` (nom propre uniquement ; email/rôle restent administrés), `POST /auth/change-password` (re-vérifie le mot de passe courant → 400 `INVALID_PASSWORD`, hash argon2id, **bump `tokenVersion` → révoque les AUTRES sessions** puis re-pose le cookie refresh pour garder l'appareil courant connecté). **Correctif sécu** : `users.service.updateUser` bump `tokenVersion` quand le rôle change réellement ou le mot de passe est réinitialisé (révocation quasi-immédiate d'un compte rétrogradé/réinitialisé ; un no-op de rôle ne révoque pas). **Frontend** (séquence skills obligatoire `ui-ux-pro-max → impeccable (substitut frontend-design) → design-taste-frontend → web-design-guidelines`) : page `/account` (RequireAuth, accès via le menu user en **vrai `<Link>` `asChild`**), section **Profil** (email+rôle en lecture seule via `dl`, note « managed by your administrator », nom éditable, Save désactivé tant que non modifié) + section **Mot de passe** (current/new/confirm, show/hide, zod `onBlur` : ≥8 / match / ≠ courant ; mapping `INVALID_PASSWORD` → erreur sur le champ courant), `AuthProvider.setUser` pour resync la session (avatar/menu), `client.changePassword` avec `credentials:'include'` (le serveur fait tourner le cookie). Décisions anti-slop : hairline = signature (pas de marqueur diamant répété par section), 1 CTA orange par zone. **Tests** : +13 API (`account` 9 + révocation `users` 4) + 13 web (`schemas` 8, `ProfileSection` 2, `ChangePasswordSection` 3). **Gates verts** : typecheck, lint 0 erreur, **59 tests** (42 API + 17 web), build (chunk `AccountPage` lazy ~2 kB gzip). **Différé** (cohérent avec l'app, déjà noté §lot 5) : garde de saisie non sauvegardée. |
| 2026-06-22 | Lot « App web » (backlog §11, hors track solveur) | racine (`package.json`, `.github/workflows/ci.yml`), `packages/shared/*`, `apps/api/{prisma,src,tests}`, `apps/web/src/{components,features,pages,lib,app}` | Quatre tracks du backlog livrés en un lot. **Correctifs & polish** : bug AA `sonner.tsx` `actionButton` orange `#EE7F00` → `--color-cta` (blanc gras) ; bordures d'erreur `aria-invalid` sur email+mdp du login quand `INVALID_CREDENTIALS` (effacées à la frappe, message en banner `aria-live`) ; `apps/web/.env.example` + garde *lazy* `getBaseUrl()` (erreur claire si `VITE_API_URL` absent, sans casser les tests) ; **durcissement API** : `app.set('trust proxy', env.TRUST_PROXY)`, `express.json({ limit:'16kb' })`, `config/env.ts` impose en prod des secrets JWT ≥32 char, distincts, non-placeholder (+ `SEED_ADMIN_PASSWORD`). **Robustesse** : pipeline **CI** GitHub Actions (prisma generate → build:shared → lint → typecheck → test → build) ; table **`AuditLog`** (append-only, acteur/cible dénormalisés) + `lib/audit.ts` best-effort, enregistrée sur login/logout/profil/mdp et create/update/delete/disable/enable ; `GET /audit-logs` (super-admin, paginé) + page **/activity**. **Profondeur back-office** : migration Prisma `add_audit_log_and_account_status` (`User.isActive`, `User.lastLoginAt`) ; login stampe `lastLoginAt` et **refuse 403 `ACCOUNT_DISABLED`** (après vérif mdp, pas d'énumération) ; `requireAuth`+`refresh` rejettent un compte désactivé ; `updateUser` gère `isActive` (désactiver bump `tokenVersion`, garde `PROTECTED_ACCOUNT` + nouvelle `SELF_DISABLE_FORBIDDEN`) ; table admin **recherche** (nom+email, Échap efface) + **tri** colonnes (`aria-sort`) + colonne **Last login** + badge **Active/Disabled** (icône+texte) + action **Disable/Enable** (confirm dialog pour désactiver, direct pour réactiver) ; séquence skills obligatoire suivie (`ui-ux-pro-max → design-taste-frontend → web-design-guidelines`). **Contrat partagé** : `packages/shared` (`@dive/shared`, dual CJS+ESM) source unique de `Role`/`roleSchema`/`PASSWORD_MIN/MAX`/`FULL_NAME_MAX`/`SERVER_ERROR_CODES`, consommé par les schémas zod API + web (supprime la dérive de longueur de mdp). **Garde de saisie** : `UnsavedChangesPrompt` (`useBlocker` + `beforeunload`) sur `/account` (état dirty agrégé des 2 sections) et le dialogue admin create/edit. **Gates verts** : lint 0 erreur, typecheck, **82 tests** (55 API + 27 web), build (chunks `AdminPage`/`ActivityPage` lazy). Note : pré-requis CI/local `npm run build:shared` avant typecheck/test/dev (intégré aux scripts racine). |
| 2026-06-22 | Feature (Projects) | `packages/shared/src/index.ts`, `apps/api/{prisma,src/modules/projects,tests/projects.test.ts,app.ts,tests/helpers.ts}`, `apps/web/src/{lib/api,features/projects,pages/ProjectsPage.tsx,components/layout/nav.ts,app/router.tsx}` | Zone **Projects** : un utilisateur connecté crée un projet (titre seul, rien d'autre). **Backend** : modèle Prisma `Project` (titre, `ownerId` relation `User` `onDelete: Cascade`) + migration `add_project` ; module `projects` (requireAuth, **owner-scoped**) — `POST /projects` (zod `title` 1..`PROJECT_TITLE_MAX_LENGTH` partagé) + `GET /projects` (les siens, plus récents d'abord) ; `ownerId` jamais sérialisé. **Frontend** (système DESIGN.md déjà cadré par la séquence skills cette session) : nav item **Projects** (tous les rôles), route `/projects` lazy, page = 1 form de création (champ titre + 1 CTA orange) au-dessus de la liste (états loading skeleton / empty / error / data ; colonne Created `tabular-nums`). **Tests** : +4 API (auth requise, création 201 owner-scopée, titre vide 422, isolation entre users) + 3 web (schéma titre). `resetDatabase` purge `project` aussi. **Gates verts** : typecheck, lint 0 erreur, **89 tests** (59 API + 30 web), build (chunk `ProjectsPage` lazy ~1.9 kB gzip). |
| 2026-06-22 | Feature (Projects: collaborateurs, détail, delete) | `packages/shared/src/index.ts`, `apps/api/{prisma,src/modules/projects/*,tests/projectsAccess.test.ts}`, `apps/web/src/{lib/api/{types,projects},features/projects/useProjects,pages/{ProjectsPage,ProjectDetailPage},app/router.tsx}` | Évolution du modèle d'accès des projets. **Visibilité** : un projet est visible par son **owner**, ses **collaborateurs**, et **tout super-admin** ; un étranger reçoit **404** (pas de fuite d'existence). **Migration** `add_project_collaborators` : m2m implicite `Project.collaborators ↔ User` (relations nommées `ProjectOwner`/`ProjectCollaborators`). **Backend** : `GET /projects` (owner+collab ; super-admin → tout), `GET /projects/:id` (404 si non-membre), `DELETE /projects/:id` (**owner ou super-admin** ; un simple collaborateur → 403 `FORBIDDEN`), `POST /projects/:id/collaborators` (ajout **par email** ; 404 `USER_NOT_FOUND`, 409 `COLLABORATOR_EXISTS` si owner/déjà collab), `DELETE /projects/:id/collaborators/:userId`. `PublicProject` sérialise désormais `owner` + `collaborators` (résumés `{id,fullName,email}`). Nouveaux codes partagés `USER_NOT_FOUND`/`COLLABORATOR_EXISTS`. **Frontend** : liste = titres **cliquables** (lien vers `/projects/:id`) + colonne **Owner** (« You » si c'est l'utilisateur) ; **page détail** `/projects/:id` (lazy) avec section Détails (owner, date) + section Collaborateurs (ajout par email + retrait, réservés owner/super-admin via `canManage` = owner || super-admin) + bouton **Delete project** (déclencheur secondaire teinté danger → dialogue de confirmation destructif), état not-found dédié. **Tests** : +14 API (visibilité owner/collab/étranger/super-admin, détail 404, delete 204/403/404/super-admin, ajout/retrait collaborateur, email inconnu, doublon, non-manager 403). **Gates verts** : typecheck, lint 0 erreur, **103 tests** (73 API + 30 web), build (chunk `ProjectDetailPage` lazy ~2.6 kB gzip). Note Windows : régénérer le client Prisma exige d'arrêter le dev server (`tsx watch` verrouille le moteur). |
| 2026-06-22 | Tweak UI (déplacement delete + retrait visuel Activity) | `apps/web/src/pages/ProjectDetailPage.tsx`, `apps/web/src/{components/layout/nav.ts,app/router.tsx,lib/api/types.ts}` (+ suppressions) | **(1)** Sur demande `/ui-ux-pro-max` : le bouton **Delete project** quitte le header (slot du CTA principal) pour une section **« Danger zone »** en bas de la page détail (bordure `border-danger/40`, libellé + ligne explicative), conforme à `destructive-nav-separation` / `destructive-emphasis`. **(2)** Retrait de la **partie visuelle Activity** : suppression de `pages/ActivityPage.tsx`, `features/admin/{useAuditLogs,auditActions}.ts`, `lib/api/audit.ts`, du nav item + route `/activity`, et des types `AuditLogEntry`/`ListAuditLogsResponse`. **Backend conservé** (non visuel) : table `AuditLog`, enregistrement, `GET /audit-logs` + ses tests. **Gates verts** : typecheck, lint 0 erreur, **103 tests** (73 API + 30 web), build (plus de chunk `ActivityPage`). |
| 2026-06-22 | Feature (Projects: import de cas OpenFOAM) | `packages/shared`, `apps/api/{.env*,vitest.config,src/config/env,src/lib/{caseStorage,openfoamCase},src/modules/projects/{files.service,files.controller,projects.routes,projects.service},tests/{openfoamCase,projectFiles}.test.ts}`, `apps/web/src/{lib/api/{client,types,projects},features/projects/{useCaseFiles,CaseFilesSection,CaseFilesSection.test},pages/ProjectDetailPage}`, `.gitignore` | **Premier pas du track solveur** : importer un cas OpenFOAM dans un projet, le visualiser, le télécharger, et auto-générer les fichiers de base manquants (cf. `docs/openfoam-fichiers-obligatoires.md`). Le serveur OpenFOAM n'existe pas encore → **100 % applicatif** (aucun appel `fluentMeshToFoam`/solveur). **Stockage** : filesystem par projet sous `STORAGE_DIR` (`apps/api/storage/projects/<id>/case/`), **anti-traversal + anti-zip-slip** (sanitize `..`/absolu/drive, `confineJoin`), **cross-platform** (forward-slash logique, `path.sep` natif) — l'app finira sur **Linux**. Multer 2.x (`preservePath: true` pour garder le chemin relatif du dossier — busboy strip sinon) + adm-zip. **Normalisation d'import** : un dossier `polyMesh` seul atterrit sous `constant/polyMesh/`, un wrapper (nom du dossier sélectionné / dossier de cas) est retiré. **Endpoints** (auth + visibilité projet, membres inclus) : `GET /projects/:id/files` (arbre), `POST .../files/import` (dossier `files[]` ou zip `archive`), `GET .../files/download` (zip), `GET .../files/verify` (rapport mesh + base scaffoldable), `POST .../files/scaffold` (génère `system/{controlDict,fvSchemes,fvSolution}` + `0/{U,p}` génériques minimaux, `boundaryField` câblé sur les patches lus dans `constant/polyMesh/boundary`, jamais d'écrasement). Storage nettoyé au delete projet (best-effort). Nouveaux error codes partagés `NO_FILES_UPLOADED`/`INVALID_ARCHIVE`/`PAYLOAD_TOO_LARGE` + `CASE_UPLOAD_MAX_BYTES` (200 Mo). **Frontend** (séquence skills `CLAUDE.md §0` suivie : `ui-ux-pro-max → design-taste-frontend → web-design-guidelines`) : `client.ts` étendu (`postForm` multipart + `getBlob` réutilisant le refresh single-flight), hooks `useCaseFiles`, section **Case files** sur `/projects/:id` — états loading skeleton / empty (prompt d'import, 1 CTA orange = dossier) / error / data (toolbar import dossier+zip / download / **Verify**), arbre indenté (icônes lucide, tailles `tabular-nums`, `truncate`+`title`), et **overlay** (AlertDialog `overscroll-contain`) qui s'ouvre sur Verify quand des fichiers de base manquent → « Create files » (CTA `--color-cta` AA) appelle scaffold. **Tests** : +25 API (12 unité `openfoamCase` : parse boundary, templates, normalisation/anti-traversal ; 13 intégration `projectFiles` : import dossier/zip, zip-slip 400, verify, scaffold + non-écrasement, download 404/zip, accès collaborateur/super-admin) + 3 web (empty / arbre / overlay). **Gates verts** : typecheck, lint 0 erreur, **131 tests** (98 API + 33 web), build (chunk `ProjectDetailPage` ~16 kB). Note : `npm i -w @dive/api multer@^2 adm-zip` (+ `@types`). **Différé** : conversion réelle du maillage (Ansys/Fluent → polyMesh) et reste du cas (`constant/...Properties` selon solveur) quand le serveur distant existera ; drag-and-drop d'import. |
| 2026-06-22 | Tweak UI (engrenage settings projet) + fix limite upload | `apps/web/src/pages/ProjectDetailPage.tsx` ; (+ fix : `apps/api/{.env*,vitest.config? non,src/config/env,src/modules/projects/files.controller}`, `packages/shared/src/index.ts`) | **(1) Engrenage de réglages** (`/ui-ux-pro-max` → recommandation : menu plutôt que dialog combiné, conforme `overflow-menu`/`destructive-nav-separation`/`destructive-emphasis`/`progressive-disclosure`). Bouton **gear** (`Settings`, ghost icon, `aria-label`, **owner/super-admin only**) dans le slot action du `PageHeader` → **DropdownMenu** : « Manage collaborators » (→ **Dialog** : form ajout par email avec 1 CTA orange + liste + retrait) **/ séparateur /** « Delete project » (item `destructive` → **AlertDialog** de confirmation). Ouverture des overlays **différée** (`setTimeout 0`) pour éviter la course focus/aria-hidden au retour-focus du menu Radix. La page garde une **liste collaborateurs en lecture seule** (visible par tous → overview), la gestion (add/remove) et le delete passent derrière l'engrenage ; l'ancienne « Danger zone » en bas de page et le form inline sont retirés. **(2) Fix** (signalé en run) : la limite multer **200 Mo/fichier** rejetait de vrais maillages CFD (`413 PAYLOAD_TOO_LARGE`) → **`MAX_UPLOAD_MB`** (env, défaut **1024**) pilote `limits.fileSize` ; constante partagée `CASE_UPLOAD_MAX_BYTES` retirée. **Gates verts** : typecheck, lint 0 erreur, **131 tests** (98 API + 33 web), build (chunk `ProjectDetailPage` ~17 kB). Note mémoire : uploads bufferisés en RAM (memoryStorage) → pour des maillages multi-Go, passer en `diskStorage` streaming (différé). |
| 2026-06-22 | Feature (Édition de fichiers de cas) + retrait liste collaborateurs page | `packages/shared/src/index.ts`, `apps/api/src/modules/projects/{files.service,files.controller,files.schemas(new),projects.routes}.ts`, `apps/api/tests/projectFiles.test.ts`, `apps/web/src/{lib/api/{client,types,projects},features/projects/{useCaseFiles,CaseFileEditor(new),CaseFilesSection},pages/{ProjectEditPage(new),ProjectEditPage.test,ProjectDetailPage},app/router.tsx,vite.config.ts}` | Étape « modifier les paramètres avant le solve ». **(A)** Retrait de la liste collaborateurs en lecture seule de la page détail (déjà gérée via l'engrenage) → page = Details + Case files. **(B) Éditeur de fichiers** (plan validé ; séquence skills `CLAUDE.md §0` suivie, choix éditeur = **CodeMirror** validé par l'utilisateur). **Backend** : `EDITABLE_FILE_MAX_BYTES` (2 Mo) + code `FILE_TOO_LARGE` partagés ; `readCaseFileContent` (404 absent / 413 trop gros) + `saveCaseFileContent` (édition d'un fichier **existant** uniquement, 404 sinon ; cap 413) réutilisant `readCaseFile`/`writeCaseFile`/`caseFileExists` (déjà path-safe) + `assertProjectVisible` ; `GET`/`PUT /projects/:id/files/content?path=` — le `PUT` a son **propre** parser `express.text({type:'*/*', limit})` car le `json` global est à 16 ko ; le client envoie le contenu en `text/plain`. **Frontend** : `apiClient.putText` (corps texte brut, réutilise le refresh 401) ; hooks `useCaseFileContentQuery`/`useSaveCaseFile` ; bouton **« Edit files »** (secondaire) dans la toolbar Case files → route lazy `/projects/:id/edit` ; page **deux volets** (liste fichiers à gauche / éditeur CodeMirror `cpp()` à droite), Save = unique CTA orange (désactivé tant que non *dirty*), états no-selection (diamant) / loading skeleton / **413 trop-gros** (notice + download) / error ; garde `UnsavedChangesPrompt` (quitter la page) + dialogue **discard** au changement de fichier si édits non sauvés. `CaseFileEditor` isolé (dép. lourde) + **`manualChunks` dédié `codemirror`** (522 ko, chargé seulement avec la page d'édition ; `vendor` retombe à 108 ko) + `optimizeDeps`. **Tests** : +6 API (get/put content : 200/404/413/traversal/save-readback) + 3 web (liste, sélection charge le contenu, save) — éditeur mocké en `<textarea>`, data-router pour `useBlocker`. **Gates verts** : typecheck, lint 0 erreur, **140 tests** (104 API + 36 web), build (chunk `ProjectEditPage` ~8 ko + `codemirror` lazy). Dép. : `npm i -w @dive/web @uiw/react-codemirror @codemirror/lang-cpp`. **Différé** : création de nouveaux fichiers via l'éditeur (édition only), conversion réelle du maillage + solve. |
| 2026-06-22 | Tweak UI (éditeur plein écran + autosave) | `apps/web/src/components/layout/AppShell.tsx`, `apps/web/src/pages/{ProjectEditPage,ProjectEditPage.test}.tsx` | Sur retour utilisateur. **(1) Plein écran** : `AppShell` détecte la route `/projects/:id/edit` (regex sur `useLocation`) et rend le contenu **full-bleed** (sans `max-w-content` ni centrage, `main`/wrapper en `flex flex-col flex-1 min-h-0`) ; la page d'édition devient une colonne flex pleine hauteur (`lg:flex-1 lg:min-h-0`), volet fichiers + éditeur remplissent le viewport (hauteur définie `h-[60vh]` sur mobile, `lg:flex-1` sur desktop pour que CodeMirror `height:100%` se résolve). Les autres pages restent centrées à 1200px. **(2) Autosave** : sauvegarde **débouncée 600 ms** après la dernière frappe (plus de bouton Save) ; le flush est déclenché aussi au changement de fichier (zéro perte) ; indicateur de statut `aria-live` (« Saving… » / « All changes saved » / « Save failed » + Retry) à la place du CTA ; suppression du dialogue de discard (autosave). Garde `UnsavedChangesPrompt` conservée pour la fenêtre avant flush / échec réseau. **Gates verts** : typecheck, lint 0 erreur, **140 tests** (104 API + 36 web), build. |
| 2026-06-22 | Tweak UI (éditeur : retrait titre + scroll interne) | `apps/web/src/components/layout/AppShell.tsx`, `apps/web/src/pages/{ProjectEditPage,ProjectEditPage.test}.tsx` | Retour utilisateur. **(1)** Retrait du `PageHeader` (titre projet + « Edit case files ») de la page d'édition → gain de hauteur, le chemin du fichier en haut du volet éditeur suffit comme contexte ; le `BackLink` reste. **(2) Scroll interne** : la page d'édition est désormais **bornée à la hauteur du viewport** pour que seul CodeMirror scrolle (pas la page). Dans `AppShell`, `min-h-0` + `overflow-hidden` ne s'appliquent qu'à la route full-bleed via un `mainClass` conditionnel — **pas** sur les pages normales (sinon leur contenu long serait coupé au lieu de scroller). Test ajusté (plus d'assertion sur le titre). **Gates verts** : typecheck, lint 0 erreur, **140 tests**, build. |
| 2026-06-22 | Fix (éditeur : page scrollait encore) | `apps/web/src/components/layout/AppShell.tsx`, `apps/web/src/pages/ProjectEditPage.tsx` | La chaîne `min-h-0 flex-1` ne bornait pas réellement : le volet éditeur était un **item de CSS grid à ligne implicite `auto`** (taille = contenu), donc aucune hauteur définie ne descendait jusqu'à CodeMirror → l'éditeur prenait la taille du fichier et la **page** grandissait/scrollait. **Correctif déterministe** : le conteneur full-bleed est épinglé à `h-[calc(100dvh_-_4rem)]` (viewport − header `h-16` 64px, vérifié compilé en `calc(100dvh - 4rem)`) + `overflow-hidden` → la page ne peut plus scroller ; `main` **rétabli** à `min-w-0 flex-1` (son `min-content` = la hauteur fixe réserve exactement l'espace → zéro débordement, et aucune régression sur les pages normales longues qui doivent scroller). Le **two-pane passe de grid à flex** (`flex-col lg:flex-row`) car `flex` (align stretch) propage une hauteur définie là où une ligne grid `auto` ne le fait pas ; volets en `min-h-0 flex-1`, liste fichiers `overflow-auto`, conteneur éditeur `min-h-0 flex-1` → CodeMirror `height:100%` se résout et scrolle en interne. Suppression du bricolage `h-[60vh] lg:h-auto`. **Gates verts** : typecheck, lint 0 erreur, **140 tests**, build. |
| 2026-06-22 | Feature (détail plein écran + Reset des fichiers) | `apps/web/src/components/layout/AppShell.tsx`, `apps/web/src/pages/ProjectDetailPage.tsx`, `apps/web/src/features/projects/{useCaseFiles,CaseFilesSection,CaseFilesSection.test}.tsx`, `apps/web/src/lib/api/projects.ts`, `apps/api/src/{lib/caseStorage,modules/projects/{files.service,files.controller,projects.routes}}.ts`, `apps/api/tests/projectFiles.test.ts` | **(1) Détail plein écran** : `AppShell` distingue deux modes projet — éditeur (`…/edit`, hauteur fixe + scroll interne, déjà en place) **et** détail (`/projects/:id`, **pleine largeur mais scroll de page normal** : `w-full` sans `max-w-content`). La page détail perd son cap interne `max-w-3xl` → contenu pleine largeur. Les autres pages restent centrées. **(2) Reset** : suppression de tous les fichiers importés (« si je me suis trompé »). Backend `DELETE /projects/:id/files` (auth + visibilité, membre OK comme l'import) → `clearCase` (rm récursif du dossier `case`, recréé au prochain import) → renvoie l'arbre vide. Frontend : bouton **Reset** (danger outline, icône `RotateCcw`) visible seulement quand des fichiers existent, dans le groupe droit de la toolbar à côté de Verify (séparé visuellement, couleur danger), confirmation `AlertDialog` destructive ; au succès le cache vide → retour automatique à l'état import. Hook `useResetCase` + `resetCase` API. **Tests** : +2 API (reset 200 + arbre vide, auth 401) + 1 web (Reset → dialogue → `resetCase`). **Gates verts** : typecheck, lint 0 erreur, **143 tests** (106 API + 37 web), build. Note : Reset autorisé aux membres (canView, cohérent avec import/edit) ; à restreindre aux managers si besoin plus tard. |

---

## 11. Backlog d'améliorations (analyse 5 agents — post-fondation)

> Issu de l'analyse de 5 agents le 2026-06-19 (la fondation `PLAN.md` §1-§9 étant livrée).
> L'utilisateur a choisi de construire **track 1 (Compte self-service)** en premier ; le reste est **validé mais pas encore construit**.
> ⚠️ Toute UI ici passe d'abord par la séquence skills obligatoire (`CLAUDE.md §0`). Vérifier que les références fichier/ligne tiennent toujours avant d'agir.

### Fait
| # | Amélioration | Détail |
|---|---|---|
| ✅ 1 | **Compte self-service** | Page `/account` + `PATCH /auth/me` + `POST /auth/change-password`. Voir §10 (2026-06-19). |
| ✅ 2 | **Révocation de session au changement mdp/rôle** | `tokenVersion` bumpé dans `users.service.updateUser` + au change-password. Voir §10. |
| ✅ 3 | **Correctifs & polish** | Bug AA sonner → `--color-cta` ; bordures d'erreur login ; `apps/web/.env.example` + garde `VITE_API_URL` ; durcissement API (`trust proxy`, `json limit 16kb`, secrets prod imposés). Voir §10 (2026-06-22). |
| ✅ 4 | **Robustesse fondation** | Pipeline CI GitHub Actions + table `AuditLog` (enregistrement admin/auth) + `GET /audit-logs` + page `/activity`. Voir §10 (2026-06-22). |
| ✅ 5 | **Profondeur back-office** | Recherche + tri + colonne `lastLoginAt` + statut Active/Disabled + désactiver/réactiver (`isActive`, login bloqué 403 `ACCOUNT_DISABLED`). Voir §10 (2026-06-22). |
| ✅ 6 | **Contrat partagé** | `packages/shared` (`@dive/shared`) : `Role`/`roleSchema`/longueurs/error codes consommés des deux côtés. Voir §10 (2026-06-22). |
| ✅ 7 | **Garde de saisie non sauvegardée** | `UnsavedChangesPrompt` (`useBlocker` + `beforeunload`) sur `/account` et le dialogue admin. Voir §10 (2026-06-22). |

### À faire (les « modifs manquantes » restantes)

**Track — Socle solveur + Home** *(le plus gros pas produit, ~L ; volontairement laissé pour une phase dédiée)*
- [x] **Import de cas OpenFOAM dans un projet** (dossier polyMesh / zip), arbre, download, **verify + scaffold** des fichiers de base manquants (`system/` trio + `0/{U,p}` génériques minimaux, `boundaryField` câblé sur les patches du mesh). 100 % applicatif. Voir §10 (2026-06-22, Feature import de cas).
- [ ] Modèles Prisma `Case` (projet CFD) + `Run` (statut, stub) ; routes `/cases` ; page liste + détail.
- [ ] Remplacer le `EmptyState` vide de la Home par une vraie page d'accueil « workspace ».
- [ ] Données seed réalistes (étage de turbine, etc.). Dispatch = stub tant que le serveur openFOAM n'existe pas.
- [ ] **Conversion réelle du maillage** (Ansys/Fluent `.msh` → `constant/polyMesh/` via `fluent3DMeshToFoam`, option `-scale`) + `checkMesh` + `constant/...Properties` selon le solveur — quand le serveur distant existera. Règle à respecter : `0/*.boundaryField` doit couvrir **tous** les patches de `constant/polyMesh/boundary`.

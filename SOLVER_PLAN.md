# SOLVER_PLAN.md — DIVE Turbinen · Onglet « Solver » (exécution OpenFOAM)

> Plan d'implémentation de l'**exécution réelle d'un solveur OpenFOAM** depuis l'app.
> C'est le **dernier verbe manquant** : tout l'amont (import maillage, conversion CGNS→Foam, `checkMesh`, édition des fichiers, templates, viewer 3D) est déjà livré. Il reste à **LANCER** le calcul.
> Statut : **PLAN — aucun code de prod écrit.** Synthèse de 5 agents (architecture backend, correctness OpenFOAM, parsing/streaming des résidus, UX, conventions/tests). Chaque tranche livrée sera journalisée dans `PLAN.md` §10 (règle CLAUDE.md §0).

---

## 0. Le point central (pourquoi c'est un nouveau pas d'archi)

Tout ce que l'app fait aujourd'hui est **synchrone** : un POST lance un outil (`pvpython`, `vtkUnstructuredToFoam`, `checkMesh`, `autoPatch`), on attend ≤ 10 min, on renvoie un rapport. **Un solveur ne rentre pas dans ce moule** : il tourne **minutes → heures → jours**, on veut voir **les résidus en direct**, ça doit **survivre à un refresh**, et on doit pouvoir **l'arrêter**. C'est exactement le morceau différé du backlog (« modèle `Run` + jobs en tâche de fond »). On y est.

**Bonne nouvelle :** toute la plomberie d'exécution existe (`commandRunner` injectable + never-throw, `planOpenfoamCommand` qui source `OPENFOAM_BASHRC` en argv injection-safe, config toolchain dans `env.ts`, modèle d'accès `assertProjectVisible`). Le **seul vrai muscle nouveau** : rendre **un** de ces runs *long-lived et observable*.

---

## 1. Découverte clé — un cas scaffoldé n'est PAS exécutable

`files.service.scaffoldCase` ne génère que `BASE_FILE_PATHS` = `system/{controlDict,fvSchemes,fvSolution}` + `0/{U,p}`, et écrit `application foamRun;`. Il **exclut volontairement** les fichiers solveur-dépendants (`openfoamCase.ts` ligne 32). Donc pour **simpleFoam** (RANS incompressible stationnaire) il **manque** :

| Manquant | Rôle |
|---|---|
| `constant/transportProperties` | `transportModel Newtonian;` + viscosité cinématique `nu` |
| `constant/turbulenceProperties` | `simulationType RAS;` + `RAS { RASModel kOmegaSST; turbulence on; }` |
| `0/k`, `0/omega`, `0/nut` | champs de turbulence (1 entrée `boundaryField` par patch) |
| `system/{fvSchemes,fvSolution}` complets | `divSchemes` non-`none`, `residualControl`, `relaxationFactors` |

**Solution retenue (réutilise l'existant, zéro nouvelle machinerie) :** s'appuyer sur le **système de templates déjà livré**. On fournit un **template intégré « simpleFoam steady (k-omegaSST) »** contenant ces fichiers ; le **gate de runnabilité** vérifie simplement leur **présence** (peu importe la source : scaffold, template, ou import). Ça transforme un gros chantier de génération en **un template + un check de présence**.

> Décision : **le solveur est lu depuis `controlDict.application`** (jamais codé en dur). Si c'est `foamRun`, l'app le signale et propose de basculer sur `simpleFoam`. `SOLVER_IDS = ['simpleFoam','foamRun']` en v1.

---

## 2. Le solveur MVP — simpleFoam (l'essentiel)

- **Physique** : continuité + quantité de mouvement moyennées (RANS), couplage pression-vitesse **SIMPLE**, incompressible → grandeurs **cinématiques** (`p = p/ρ` en m²/s², `nu` en m²/s, pas de densité ni d'énergie). Le bon premier solveur : pas de stabilité Courant à régler, convergence par résidus, « finit » tout seul.
- **Binaire** : `simpleFoam`, invoqué `simpleFoam -case <caseDir>` via `planOpenfoamCommand` (même chemin que `checkMesh` aujourd'hui).
- **Pré-requis avant « Run »** (le *gate*) :
  1. `constant/polyMesh/*` complet (sinon `NO_MESH`) ;
  2. `checkMesh` « Mesh OK. » (déjà lancé à la conversion) ;
  3. fichiers du §1 présents (sinon `NOT_RUNNABLE`, avec lien « Appliquer le template simpleFoam ») ;
  4. `application` ∈ `SOLVER_IDS`.
- **Convergence (stationnaire)** : `system/fvSolution → SIMPLE → residualControl` (tolérances par champ, ex. `1e-4`). Quand tous les champs passent sous tolérance à la même itération, simpleFoam s'arrête **avant** `endTime` et imprime `SIMPLE solution converged in N iterations`.
- **Forme du log à parser** (cible exacte du parser) — un bloc par itération :
  ```
  Time = 327
  smoothSolver:  Solving for Ux, Initial residual = 9.34e-05, Final residual = 7.21e-06, No Iterations 2
  smoothSolver:  Solving for Uy, Initial residual = 8.11e-05, ...
  GAMG:  Solving for p, Initial residual = 9.97e-05, Final residual = 8.6e-07, No Iterations 4
  smoothSolver:  Solving for k, Initial residual = 6.55e-05, ...
  smoothSolver:  Solving for omega, Initial residual = 5.02e-05, ...
  ExecutionTime = 41.7 s  ClockTime = 42 s
  ```
  → on trace l'**Initial residual** par champ vs itération (Ux/Uy/Uz fusionnés en une trace « U » côté UI).
- **Divergence / échec** : résidus → `nan`/`inf`, `FOAM FATAL ERROR`, `Floating point exception`, exit ≠ 0.
- **Différé** : parallèle (`decomposePar` → `mpirun -np N simpleFoam -parallel` → `reconstructPar`) ; turbomachine (`constant/MRFProperties` MRF, interfaces `cyclicAMI`) — **même binaire, config en plus** ; transitoire (`pimpleFoam`).

---

## 3. États d'un run (réconciliés)

Union `RunStatus` partagée (`@dive/shared`), 7 états :

| Statut | Déclencheur | Traitement UI |
|---|---|---|
| `queued` | créé, spawn imminent | neutre (`Clock`) |
| `running` | process vivant | primary (`Loader2` spin) + chrono + itération live |
| `converged` | exit 0 **+** bannière « converged in N » | **succès** (voir note token §10) |
| `completed` | exit 0, `endTime` atteint, **sans** bannière | **avertissement** (orange/`accent`) : « a tourné jusqu'au bout sans converger » |
| `diverged` | `nan`/`inf`/FPE détecté | avertissement (orange/`accent`) |
| `failed` | exit ≠ 0 / ENOENT / timeout | **danger** (rouge, `role="alert"`) |
| `stopped` | arrêt utilisateur | neutre (`MinusCircle`) |

> Synthèse : l'agent UX avait 6 états ; j'ajoute **`completed`** (cas réel et fréquent : on met `endTime=2000`, ça tourne 2000 itérations sans atteindre `1e-4`) — le confondre avec `converged` mentirait à l'utilisateur. La table d'états UX (§6) gagne donc une ligne `completed`.

---

## 4. Flux de données

```
   Web (onglet Solver)                         API (Express)                        Disque
 ───────────────────────       ────────────────────────────────────────       ─────────────────────────
  POST /projects/:id/runs  ─────►  runs.service.startRun                         storage/projects/<id>/
   { solver }                       • assertProjectVisible (404 étranger)          ├── case/        (entrée)
                                     • gate runnable (NO_MESH / NOT_RUNNABLE)       ├── cgns/  viz/
                                     • guard 1 run actif (409 RUN_IN_PROGRESS)      └── runs/<runId>/
                                     • ensure runTimeModifiable yes                       └── solver.log  (sortie, append)
                                     • runStream(planOpenfoamCommand(SOLVER_BIN…))
   201 { run }  ◄─────────────────  • DB Run = running, pid, startedAt
                                                                  │ spawn (non détaché) pipe stdout/stderr ─► solver.log
  GET …/runs/:runId/stream ────►  tail(solver.log, from=offset) ──┘
   (fetch + ReadableStream)         • parse résidus (regex) → NDJSON {it, r:{…}}
   ◄═══ flux NDJSON live ═══════    • event status terminal, puis close
                                  onExit ► statut terminal (exit + tail log) ► DB
  POST …/runs/:runId/stop  ─────►  écrit `stopAt writeNow;` (grâce) → SIGTERM (fallback)
  GET …/runs (historique)  ─────►  Run[] desc
```

---

## 5. Backend

### 5.1 Modèle Prisma `Run`
```prisma
model Run {
  id         String    @id @default(cuid())
  projectId  String
  project    Project   @relation(fields: [projectId], references: [id], onDelete: Cascade)
  solver     String                         // 'simpleFoam' | 'foamRun' (validé zod vs SOLVER_IDS)
  status     String    @default("queued")   // RunStatus (String : SQLite sans enum natif, cf. User.role)
  pid        Int?
  exitCode   Int?
  command    String                          // ligne logique affichée
  logPath    String                          // chemin du solver.log (forward-slash logique)
  reason     String?                         // courte explication terminale (diverged/failed/stopped)
  startedAt  DateTime?
  finishedAt DateTime?
  createdAt  DateTime  @default(now())
  updatedAt  DateTime  @updatedAt
  @@index([projectId])
  @@index([projectId, status])               // guard « un run actif ? »
}
```
+ `runs Run[]` sur `Project`. Migration `add_run_model`. **Gotcha Windows documenté** : `prisma generate`/`migrate` échoue (EPERM) tant que `tsx watch` tient le client → **arrêter le dev server**, migrer, redémarrer.

### 5.2 Nouveau runner *streaming* (seam injectable)
Le `commandRunner` actuel (`execFile`, `maxBuffer 16 Mo`, résout à l'exit) est **inadapté** : un run multi-heures émet un bloc de résidus par itération → dépasse `maxBuffer` (tue le process), épingle la RAM, et bloque la requête HTTP toute la durée. **Aucun output incrémental.**

Nouveau `apps/api/src/lib/streamRunner.ts`, **même forme injectable que `setCommandRunner`** :
```ts
export interface StreamSpec { command; args; cwd; env; logFile; }   // logFile = solver.log absolu
export interface StreamHandle {
  pid: number | null;
  onExit: Promise<{ exitCode: number|null; signal: string|null; spawnError?: string }>;
  stop(signal?: NodeJS.Signals): void;
}
export type StreamRunner = (spec: StreamSpec) => StreamHandle;
export function setStreamRunner(r: StreamRunner | null): void;     // swap tests
export function runStream(spec: StreamSpec): StreamHandle;
```
`realStreamRunner` = `child_process.spawn` (**non détaché** : le run est lié au process API, cf. §5.4), stdout+stderr **pipés vers `solver.log`** (append). **Ne throw jamais** : `'error'` (ENOENT) → `onExit` resolved avec `spawnError`, `pid:null`. La spec est bâtie par **`planOpenfoamCommand(env.SOLVER_BIN, ['-case', caseDir], caseDir)`** → sourcing `OPENFOAM_BASHRC` + argv injection-safe **conservés**. Handles vivants dans une `Map<runId, StreamHandle>` (pour stop/stream) ; **la DB est la source de vérité** entre redémarrages.

### 5.3 Parser de résidus (pur, testable seul)
`apps/api/src/lib/residualParser.ts` — ligne à ligne sur le log :
- Header : `/^Time = (\S+)/` → flush le record en cours, ouvre un nouveau.
- Champ : `/Solving for (\w+),\s+Initial residual = ([\d.eE+-]+)/` → `field → Initial residual` dans le record courant.
- Un record complet = bloc entre deux `Time =`. **Tolérant** au préfixe solveur (`smoothSolver:`/`GAMG:`), capture **dynamique** des champs (pas limité), `nan`/`inf` → flag divergence.
- `RESIDUAL_FIELDS` partagé (Ux/Uy/Uz/p/k/epsilon/omega/nuTilda) sert la **légende/couleurs**, le parser reste tolérant aux autres.
- **`foamLog` rejeté** : c'est un script batch (process en plus, écrit `logs/`) ; un parser ~15 lignes sur le flux qu'on tail déjà est plus simple et sans dépendance. **Même parser** pour le live (tail incrémental) et le catch-up (lecture complète) → le log persistant est la source de vérité.

### 5.4 Cycle de vie + réconciliation
- `queued → running` : insert `queued`, spawn, puis `running` + `pid` + `startedAt`.
- **Terminal** (handler `onExit`) : lire le **tail** du log (~64 Ko) + `exitCode` →
  - `spawnError`/`exitCode≠0` (hors stop) → **failed** ;
  - exit 0 + bannière converged → **converged** ;
  - exit 0 + `endTime` sans bannière → **completed** ;
  - `nan`/`inf`/FPE → **diverged** ;
  - exit initié par stop → **stopped**.
- **Redémarrage API** : le child **n'est pas détaché** → il meurt avec le parent. Au boot, `reconcileOrphanRuns()` (appelé dans `server.ts` avant `listen`) passe tout `running`/`queued` orphelin → **failed**, `reason:'Interrupted by server restart'` (pas de ré-adoption par pid : réutilisation de pid dangereuse). Le `solver.log` est préservé jusqu'où il s'est arrêté. *(Runs survivant au restart = différé : nécessiterait un worker détaché + pid-file.)*

### 5.5 Stop (deux niveaux, gracieux d'abord)
1. **Gracieux OpenFOAM** : écrire `stopAt writeNow;` dans `system/controlDict` (via `writeCaseFile`) — nécessite `runTimeModifiable yes;` (le `startRun` le garantit). Le solveur écrit les champs courants et sort proprement à l'itération suivante → mappé **stopped**.
2. **Fallback** : si encore `running` après `RUN_STOP_GRACE_MS` (30 s), `handle.stop()` → `SIGTERM`, puis `SIGKILL` après court délai.
- Endpoint **idempotent** : stop sur run terminal = no-op 200. Course « converge entre la requête et le SIGTERM » → re-check du statut avant chaque write DB (premier writer gagne).

### 5.6 Stockage
`apps/api/src/lib/runStorage.ts` → `<STORAGE_DIR>/projects/<id>/runs/<runId>/solver.log` (+ place pour `postProcessing/`). **Sibling de `case/`** (comme `viz/`, `cgns/`) → un **reset de cas n'efface pas l'historique des runs** (les logs sont des sorties, pas des entrées). Path-safety via `assertSafeId`/`confineJoin`. `RUN_DIRNAME='runs'`. Le delete projet purge déjà tout le sous-arbre.

### 5.7 Concurrence
**1 run actif par projet.** `startRun` : `prisma.run.count({ where:{ projectId, status:{ in: ACTIVE_RUN_STATUSES } } })` ; si `>0` → `AppError(409,'RUN_IN_PROGRESS')`. SQLite sérialise les écritures (count+insert quasi-atomique mono-process) ; `@@index([projectId,status])` garde ça léger. Empêche deux solveurs sur le même `case/`.

### 5.8 Endpoints (`/projects/:id/...`, `requireAuth` + `assertProjectVisible`)
| Méthode | Chemin | Comportement |
|---|---|---|
| POST | `/:id/runs` | crée + spawn (`{ solver }`). 201 ; 409 `RUN_IN_PROGRESS` ; 409 `NO_MESH` ; 422 `NOT_RUNNABLE` ; **404** étranger. Échec outil **ne throw pas** (run `failed`). |
| GET | `/:id/runs` | liste, plus récents d'abord. |
| GET | `/:id/runs/:runId` | un run (statut, exit, reason, timings). |
| GET | `/:id/runs/:runId/log` | **catch-up** JSON : `{ status, series: ResidualSample[], logBytes, logTail }` (reload sans dépendre du flux live). |
| GET | `/:id/runs/:runId/stream` | flux **NDJSON** live (voir §5.9), `?from=<bytes>`. |
| POST | `/:id/runs/:runId/stop` | stop gracieux→SIGTERM ; idempotent 200. |

`runId` validé appartenant à `:id` (sinon 404, pas de fuite). Controllers fins (comme `mesh.controller`).

### 5.9 Transport du streaming — **fetch + ReadableStream (NDJSON)**, pas EventSource
**Décision réconciliée.** `EventSource` (SSE natif) ne peut **pas** envoyer le header `Authorization: Bearer` (leur access-token est **en mémoire**, refresh single-flight dans `client.ts`). → on utilise **`fetch()` + `response.body.getReader()`** en **NDJSON** (une ligne JSON par event : `{type:'residual', it, r}` / `{type:'status', status, exitCode}`), ce qui :
- **réutilise `apiClient`** (bearer + refresh 401) → posture d'auth intacte ;
- **resume par byte-offset** : le run écrit `solver.log` en continu **même sans client** ; à la (re)connexion le client passe `?from=<bytes>`, le serveur `createReadStream(logPath,{start:offset})` rejoue l'historique (parse au passage) puis tail le live ;
- **borné** : côté serveur on cappe/décime la série (cap ~5000 points, on garde les ~500 derniers bruts, on décime l'historique — les résidus sont lisses en échelle log) ; on stream les **deltas**, le catch-up renvoie la série complète une fois.
- Réglages réponse : `Cache-Control:no-cache`, `X-Accel-Buffering:no` (anti-buffer proxy), keepalive périodique.
*(SSE/EventSource = alternative écartée pour la raison auth ; reconnect manuel trivial via offset.)*

---

## 6. Frontend — onglet « Solver » (conforme charte CLAUDE.md)

> **Étape 0 (build)** : séquence skills obligatoire **avant tout JSX** — `ui-ux-pro-max → frontend-design → design-taste-frontend → web-design-guidelines`. Cette section est la spec qui l'alimente ; **zéro hex en dur**, tout via `apps/web/src/styles/tokens.css`.

### 6.1 Placement + gate
3e onglet dans la bande Radix existante : **Detail | Visualize | Solver** (icône lucide `Play`/`Cpu`, `tabs.tsx` verbatim → actif = soulignement primary-blue + semibold, **jamais orange**). Élargir l'état à `'detail'|'visualize'|'solver'`, `TabsContent` avec le **même** `data-[state=active]:flex lg:min-h-0 lg:flex-1` (piège du panneau inactif qui vole la hauteur, §211/213). Corps **monté seulement si `view==='solver'`** (ouvre un flux).

**Gate** (calculé depuis `useCaseFilesQuery`, miroir de Visualize gaté sur `hasPolyMesh`) : `runnable = hasPolyMesh && controlDict && fvSchemes && fvSolution && transportProperties && turbulenceProperties`. Si non-runnable, `TabsTrigger` désactivé dans le wrapper `<span tabIndex={0}>` + tooltip **nommant le premier manquant** (« Import a polyMesh to enable the solver » / « Apply the simpleFoam template to enable the solver »).

### 6.2 IA + layout
Une surface bordée (`rounded-md border bg-surface shadow-sm`, **pas de carte imbriquée**), 3 zones :
1. **Config** (gauche, lecture seule) : Solver (`controlDict.application`, mono), Condition de fin (« Ends at iteration {endTime} »), Parallel (`1` + badge **Deferred** désactivé), note départ (« Starts from latest (t=…) »). **Le CTA orange `Run solver` est ici.**
2. **Live-run** (droite) : header (badge statut + chrono + itération), **graphe résidus**, **log streaming**, bouton **Stop** (danger outline, **jamais orange**).
3. **Historique** (gauche, sous Config) : `Run[]` desc, badge + durée + exit code + download log, `overflow-auto overscroll-contain`.

**Desktop (`lg+`)** : split `lg:grid lg:grid-cols-[minmax(260px,20rem)_1fr]`, épinglé `lg:min-h-0 lg:flex-1` (AppShell épingle déjà la route à `h-[calc(100dvh-4rem)]`) → **seules les zones internes scrollent**. **Mobile** : colonne unique (config → live → historique), graphe `h-56`, log `max-h-72`, Run/Stop sticky bas.

### 6.3 Graphe résidus
- **Y log** (`1e0`→`1e-8`), ligne tolérance en pointillé (`border-strong`). X = itération (`tabular-nums`).
- **Multi-séries** : 1 ligne/champ, **couleur + glyphe** (cercle/carré/triangle/losange) + label en bout — **jamais la couleur seule**. Palette = famille marque (`--color-primary`, `--color-primary-light`, `--color-cta`, `--color-text-secondary`, `--color-neutral`), AA sur surface.
- **0 point** : placeholder centré (losange + « No residuals yet »), pas d'axe vide.
- **A11y** : SVG `aria-hidden` + **table de données** alternative (disclosure « Show residual values », source de vérité lecteur d'écran) + `aria-describedby` « Residuals by iteration, log scale, lower is better ».
- **Implémentation** : **SVG fait main** (~120 lignes : `yScale = log10`, 1 `<polyline>`/champ, gridlines décades, couleurs lues sur tokens via CSS vars). Pas de lib (cohérent avec la discipline `manualChunks` three/codemirror). Lazy-load avec l'onglet. *(Si zoom/pan un jour : uPlot derrière un chunk lazy.)*

### 6.4 États (copie exacte, **zéro em-dash**)
| État | Affichage | Le CTA orange unique |
|---|---|---|
| Not-runnable | onglet désactivé + tooltip (§6.1) | aucun |
| Idle/ready | config + placeholder graphe + log vide ; « Ready to run. The solver starts from the latest available time. » | **Run solver** |
| Queued | badge « Queued » (`Clock`) + `aria-live` ; graphe placeholder | « Starting… » désactivé ; Stop danger-outline |
| Running | badge « Running » (`Loader2`) + chrono + itération ; graphe + log streament | Run caché ; **Stop run** (danger outline) |
| Converged | bannière `CheckCircle2` « Run converged at iteration N. » | **Run again** |
| Completed | bannière `AlertTriangle` (accent) « Reached endTime without meeting the convergence tolerance. » | **Run again** |
| Diverged | bannière `AlertTriangle` (accent, texte `--color-cta`) « Residuals diverged. The solution did not converge. » | **Run again** + « View log » |
| Failed | bannière `XCircle` (danger, `role="alert"`) « Run failed. See the log for the error. » + exit code | **Run again** |
| Stopped | bannière `MinusCircle` « Run stopped at iteration N. » | **Run again** |

→ **au plus un bouton orange visible** (Run/Run-again ; jamais pendant queued/running où l'action est Stop-outline).

### 6.5 A11y
`aria-live="polite"` sur badge+itération (throttle ~1/s, comme `ConvertToFoamFlow`) ; focus déplacé vers le titre live-run au lancement (`tabIndex={-1}`) ; log = région `tabIndex={0} overflow-auto overscroll-contain focus-visible:ring`, auto-scroll sauf si l'utilisateur a remonté (+ « Jump to latest »), stderr en `--color-danger` ; Stop = vrai `<button aria-label="Stop run">`.

### 6.6 Wireframe (état running)
```
+--------------------------------------------------------------------------------+
| Detail   Visualize   [ Solver ]                                                |
+----------------------------+---------------------------------------------------+
| RUN CONFIG                 | [* Running] elapsed 00:01:42  iter 240   [Stop]   | <- danger outline
|  Solver     simpleFoam     |  Residuals (log scale, lower is better)           |
|  Ends at    iteration 1000 |   1e0 |\___                               o Ux    |
|  Parallel   1  (Deferred)  |  1e-2 |    \____                          # p     |
|  Starts     latest (t=350) |  1e-4 |----------- tol (dashed) ---------- ^ k     |
|  ( Stop run )  danger-out  |  1e-6 |________________\______ ___________ + omega |
|----------------------------|        0     80    160    240 (iteration)         |
| HISTORY                    |  [v Show residual values]   [legend: toggle]      |
|  * #14 running   00:01:42  |---------------------------------------------------|
|  v #13 converged 512 it    | Log                              [Jump to latest] |
|  ! #12 failed    exit 1    |  $ simpleFoam -case .                             |
|  - #11 stopped   300 it    |  Time = 240                                       |
|  (overscroll-contain)      |  smoothSolver: Solving for p, Final res 9.9e-4 …  |
+----------------------------+---------------------------------------------------+
```

---

## 7. `@dive/shared` (source unique)
- `SERVER_ERROR_CODES` += `RUN_IN_PROGRESS`, `NOT_RUNNABLE` (réutiliser `NO_MESH`).
- `RUN_STATUSES`/`RunStatus`, `ACTIVE_RUN_STATUSES=['queued','running']`, `SOLVER_IDS`/`SolverId`, `RESIDUAL_FIELDS`/`ResidualField`, `interface ResidualSample { time:number; values:Partial<Record<ResidualField,number>> }`. Re-exportés par `apps/web/src/lib/api/types.ts` (comme `ConversionStepId`/`MeshManifest`).

## 8. `env.ts` (défauts Linux + caveat Windows)
`SOLVER_BIN` (déf. `simpleFoam`), `SOLVER_MAX_RUNTIME_MS` (6 h), `SOLVER_MAX_CONCURRENT_RUNS` (1), `SOLVER_LOG_MAX_BYTES` (32 Mo), `SOLVER_RESIDUAL_POLL_MS` (1000), `RUN_STOP_GRACE_MS` (30 000), `MPI_BIN` (déf. `mpirun`, **différé**). Miroir `.env.example` + `vitest.config.ts`. Caveat (mots de `MESH_PYTHON_BIN`) : binaire absent sur poste Windows → run `failed` propre (ENOENT), jamais de crash.

## 9. Tests (sans OpenFOAM installé)
`setStreamRunner(fake)` (parallèle de `setCommandRunner`) : le fake écrit des lignes de résidus sur **fake-timers**, puis résout `onExit` avec l'exit voulu (`converge`/`fail`/`diverge`). Suite `apps/api/tests/solver.test.ts` : (1) lifecycle happy → `running` → `converged`, `solver.log` persisté, série lisible ; (2) **réconciliation orphelin au boot** ; (3) **stop** → `stopped` + log partiel ; (4) **guard concurrence** → 409, pas de 2e spawn ; (5) **accès** (404 étranger / membre OK / super-admin) ; (6) **gates** (NO_MESH, NOT_RUNNABLE avant tout spawn) ; (7) `residualParser.test.ts` **pur** (parse `Time=`/`Solving for`, mappe les champs, `nan`→diverged, ignore le bruit). Parité Windows↔Debian : ENOENT → `failed` avec note, **jamais** de rejection non gérée (même classe que `pvpython`/`python3`).

## 10. Normes à respecter (checklist de conformité)
**Design (charte CLAUDE.md)** : séquence skills 1→4 avant tout JSX ; **zéro hex en dur** (tokens only) ; palette **exacte** `#004A99`/`#EE7F00`/`#BCBDBF` + échelle ; **1 CTA orange/zone** (Run), Stop = danger outline ; orange petit texte → `--color-cta` `#A85F00` (4.88:1 AA) ; tous les états (loading/empty/error/hover/focus/disabled) ; statut = **couleur + icône + mot** ; clavier + ARIA ; **zéro em-dash** ; pas de carte imbriquée / side-stripe / dégradé / glass / emoji. **Note token** : la charte n'a **pas de vert** ; `converged` utilise **primary-blue + `CheckCircle2`** (sûr), ou introduire un `--color-success` fonctionnel (comme `--color-danger` existe déjà) **si validé** — défaut = blue, à trancher.
**Code (conventions maison)** : runner **injectable + never-throw** ; argv **injection-safe** + `OPENFOAM_BASHRC` sourcé via `planOpenfoamCommand` ; échec outil = **HTTP 200 `status` terminal**, jamais d'exception (seules les validations throw 404/409/422) ; accès **`assertProjectVisible`** (404 étranger) ; **cross-platform** (forward-slash logique, `node:path` ; cible Debian, dev Windows) ; `@dive/shared` = **source unique** ; storage **sibling de `case/`** ; gates verts (`build:shared` → lint → typecheck → tests API+web → build).
**OpenFOAM (correctness)** : gate runnable réel (maillage + `checkMesh` OK + fichiers turbulence/transport + `application`) ; convergence lue sur la **bannière**, divergence sur `nan`/FPE/exit≠0 ; **stop gracieux** via `stopAt writeNow` (besoin `runTimeModifiable`).

## 11. Rollout en tranches verticales (chacune livrable, gates verts)
- **Slice 0 — Runnabilité** : template intégré « simpleFoam steady (k-omegaSST) » (réutilise le système de templates) + extension du gate `verifyCase`/`runnable`. *(Débloque tout le reste.)*
- **Slice 1 — Cœur du run** : modèle `Run` + `streamRunner` + `solver.log` persisté + réconciliation au boot + `POST/GET /runs`. Tests lifecycle/réconciliation/concurrence/accès/gates/parser.
- **Slice 2 — Live + graphe** : flux NDJSON (fetch+reader, resume offset) + `ResidualChart` SVG log-scale.
- **Slice 3 — Stop + historique** : stop gracieux/SIGTERM + table `Run[]` (badge/durée/exit/download log).
- **Slice 4 — États/polish + a11y** : tous les états, **séquence skills CLAUDE.md §0** puis review `web-design-guidelines`.

## 12. Différé (explicite)
Parallèle/MPI (`decomposePar`/`mpirun`/`reconstructPar`, `MPI_BIN` réservé) ; turbomachine MRF/`cyclicAMI` ; **post-traitement coloré 3D** (pression/vitesse sur le mesh dans Visualize) ; file multi-runs (`SOLVER_MAX_CONCURRENT_RUNS>1`) ; solveurs **transitoires** (`pimpleFoam`) ; runs **survivant au redémarrage** API (worker détaché + pid-file).

## 13. Fichiers touchés (carte d'implémentation)
**API (nouveaux)** : `lib/streamRunner.ts`, `lib/residualParser.ts`, `lib/runStorage.ts`, `modules/projects/runs.{service,controller,schemas}.ts`, `tests/{solver,residualParser}.test.ts`. **API (modifiés)** : `prisma/schema.prisma` (+migration), `config/env.ts`, `.env.example`, `vitest.config.ts`, `modules/projects/projects.routes.ts`, `modules/projects/files.service.ts` (gate runnable), `server.ts` (réconciliation boot). **Shared** : `packages/shared/src/index.ts`. **Web (nouveaux)** : `features/solver/{useRuns.ts,SolverTab.tsx,ResidualChart.tsx,RunHistory.tsx,RunLog.tsx,solver.test.tsx}`, `lib/api/runs.ts`. **Web (modifiés)** : `lib/api/{types.ts,client.ts}` (stream reader), `pages/ProjectDetailPage.tsx` (3e onglet). **Docs** : ce fichier + `PLAN.md` §10 (par slice) + backlog mémoire (à passer « in progress » quand Slice 1 atterrit).

---
*Fin du SOLVER_PLAN.md — à relire avant de commencer l'implémentation. Recommandation : démarrer par la Slice 0 (runnabilité via template), qui débloque tout le reste.*

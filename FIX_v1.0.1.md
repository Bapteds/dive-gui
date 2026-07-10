# Fix log — v1.0.1

> Correctifs des bugs relevés dans `BUG_AUDIT.md`, branche `fix/bugs-v1.0.1` (partie de `main`/v1.0.0).
> Un commit par correctif. Chaque entrée note **ce qui a été fait** et **les fichiers touchés**.

Ordre de correction suivi (recommandation de l'audit) :
1. **C1 + H7 + M16** — même chemin d'export, livre une physique fausse avec une coche verte.
2. **C2, C3, C4** — perte de données à la suppression d'un compte, crash API, fuite de données inter-comptes.
3. HIGH puis le reste par sévérité.

Légende statut : ✅ fait · 🔧 en cours · ⬜ à faire

---

## CRITICAL

### ✅ C1 — Export CGNS : timesteps dans le désordre
Bug : la série `out_<i>.cgns` était triée lexicographiquement (`out_10` avant `out_2`) puis appariée **positionnellement** avec une liste de temps triée numériquement → chaque champ rendu au mauvais temps, avec une coche verte. En prime, les temps étaient re-devinés depuis le dossier de cas et pouvaient se désaligner (t=0, notation scientifique).

Ce qui a été fait :
- Tri de la série par **index numérique** (`out_2` avant `out_10`) avant de la passer au merge.
- `FoamToCgns.py` écrit un sidecar `out.cgns.times` = les vrais `TimestepValues` ParaView, index-alignés avec `out_<i>.cgns`. Le backend lit ce sidecar pour stamper les temps (fallback sur le scan du dossier si absent).
- `listCgnsFiles` trie aussi par index numérique → ordre du zip cohérent.
- Fallback de merge échoué : renvoie la **vraie** dernière frame (dernier après tri numérique), plus `out_9` au lieu de `out_10`.
- Test ajouté (12 frames) verrouillant l'ordre numérique + l'alignement des temps.

Fichiers :
- `apps/api/src/modules/projects/export.service.ts` (helpers `seriesIndex`/`readSeriesTimes`, tri + temps + fallback)
- `apps/api/src/lib/exportStorage.ts` (`listCgnsFiles` tri numérique, helper `cgnsOrder`)
- `apps/api/scripts/FoamToCgns.py` (écriture du sidecar `out.cgns.times`)
- `apps/api/tests/export.test.ts` (test d'ordre C1)

⚠️ À VÉRIFIER sur le serveur de deploy (pvbatch/h5py non exécutables ici) : que `FoamToCgns.py` écrit bien le sidecar et que `CgnsMergeTime` reçoit N temps = N fichiers.

### ✅ M16 — export.service.ts : dossiers de temps en notation scientifique rejetés
Bug : `TIME_DIR_RE = /^\d+(\.\d+)?$/` rejetait `1e-05` / `2.5e-06` (écrits par `timeFormat general` + petit `deltaT`) → un cas résolu affichait « No solved results to export ».
Ce qui a été fait : regex étendue à l'exposant `([eE][+-]?\d+)?`.
Fichiers : `apps/api/src/modules/projects/export.service.ts`.

### ✅ H7 — CgnsMergeTime.py : zones figées sauf la première
Bug : le merge ne construisait la série temporelle que pour la **première zone** de la première base. Or les assemblages gardent volontairement chaque pièce comme zone séparée → dans CFD-Post toutes les zones sauf une restaient figées au pas 0.
Ce qui a été fait :
- Itération sur **toutes** les zones (`find_children(base, "Zone_t")`), pas seulement `[0]`.
- Chaque pas ultérieur copie sa `FlowSolution` dans la zone **correspondante** (appariement par nom, fallback positionnel si les noms diffèrent mais le nombre de zones est identique).
- `ZoneIterativeData`/`FlowSolutionPointers` écrits **par zone** ; `BaseIterativeData` reste unique par base.
- Une zone sans solution (ex. interface de couplage pure) est ignorée sans faire échouer le merge. Comportement mono-zone inchangé.
- `py_compile` OK.

Fichiers : `apps/api/scripts/CgnsMergeTime.py`.

⚠️ À VÉRIFIER sur le serveur de deploy (h5py + vrai CGNS multi-zones non exécutables ici) : merge d'un assemblage ≥2 zones → animation de toutes les zones dans CFD-Post.

### ✅ C2 — Suppression d'un compte : cascade destructrice + storage orphelin
Bug : la cascade DB supprimait les projets possédés mais (a) ne stoppait jamais leurs solveurs en cours (mpirun fantôme brûlant des cœurs, non tuable), (b) ne supprimait jamais leur storage disque (orphelin multi-Go à jamais).
Ce qui a été fait :
- `deleteUser` collecte les projets + templates possédés, **stoppe les solveurs** de chaque projet avant la cascade, puis purge le storage projet **et** template (best-effort).
- Nouveau helper `stopProjectRuns(projectId)` dans `runs.service.ts` (SIGTERM aux handles vivants — mpirun le relaie à ses rangs — + marque les runs `stopped`).
- Test C2 ajouté : la suppression d'un compte retire bien le dossier de storage du projet, pas seulement la ligne DB.

Fichiers : `apps/api/src/modules/users/users.service.ts`, `apps/api/src/modules/projects/runs.service.ts`, `apps/api/tests/users.test.ts`.

⚠️ Décision produit restante : les projets **partagés** possédés par le compte supprimé disparaissent toujours pour leurs collaborateurs (cascade `onDelete: Cascade` sur l'owner). Corriger « proprement » = réassigner l'ownership ou bloquer la suppression → à trancher avec toi (hors correctif de sûreté).

### ✅ C3 — streamRunner : write stream sans listener `error` → crash process
Bug : `createWriteStream(logFile)` sans listener `'error'`. Disque plein / EIO / permissions → erreur non gérée → **tout le process Node meurt** en plein run, tous les users déconnectés, run bloqué `running`.
Ce qui a été fait : listener `out.on('error')` qui débranche les pipes, draine `stdout`/`stderr` (le solveur ne bloque pas sur un buffer plein) et laisse l'enfant finir naturellement ; `finish()` n'appelle plus `end()` sur un stream déjà en erreur.
Fichiers : `apps/api/src/lib/streamRunner.ts`.

### ✅ C4 — Logout : cache React Query jamais vidé
Bug : le logout (et le refresh échoué) ne vidait pas le cache React Query → sur poste partagé, l'utilisateur suivant voyait le dashboard/liste users/projets/meshes du précédent.
Ce qui a été fait : `queryClient.clear()` appelé au logout **et** dans le handler de signal de logout (refresh échoué).
Fichiers : `apps/web/src/features/auth/AuthProvider.tsx`.

---

## MEDIUM

### ✅ M3 — Suppression d'un projet ne stoppe pas son solveur
Corrigé via le même helper : `deleteProject` appelle `stopProjectRuns(id)` avant la suppression.
Fichiers : `apps/api/src/modules/projects/projects.service.ts`.

### ✅ M16 — voir section CRITICAL (corrigé avec C1).

### ✅ M4 — Backup mesh mono-slot : destroy-before-replace + méta périmée → un restore détruit le cas
Bug : `writeBackup` supprimait l'ancien slot **avant** de copier et n'effaçait jamais le `meta.json` périmé en cas d'échec → `backupExists()` mentait (méta présente, copie absente/partielle) ; `restoreBackup` vidait alors le cas **avant** de copier depuis un slot vide/partiel → perte du cas.
Ce qui a été fait :
- `writeBackup` copie d'abord le cas courant dans un dossier **staging**, puis commit (drop méta → remplace le slot depuis la copie locale complète → réécrit la méta **en dernier**). Un échec de copie (disque plein, EIO) laisse l'ancien backup **intact**.
- `backupExists` vérifie désormais **la méta ET une copie de cas non vide** (ne ment plus).
- `restoreBackup` copie le slot dans un staging **à côté** du cas vivant d'abord ; il ne vide le cas qu'une fois une copie complète en main (slot manquant/illisible → throw, cas vivant intact).
- `cp` (pas `rename`) pour matérialiser les dossiers : un rename de dossier fait un EPERM intermittent sous Windows (dev/tests Windows, deploy Linux).
- 3 tests unitaires (`meshBackup.test.ts`) : méta honnête après perte de copie, restore refusé sur slot corrompu sans toucher au cas, round-trip write→restore.
Fichiers : `apps/api/src/lib/meshBackupStorage.ts`, `apps/api/tests/meshBackup.test.ts`.

### ✅ M2 — Un re-merge échoué révertait silencieusement l'assemblage appliqué
Bug : `runMerge` restaurait le backup pré-assemblage (retour au cas pristine) **avant** le staging ; si une étape ultérieure échouait, l'API rapportait « merge failed, case untouched » alors que le cas avait été réverti, et `assembly.json` prétendait toujours qu'un assemblage était appliqué (état incohérent).
Ce qui a été fait : le re-merge (base=cas + assemblage sur registre + backup présent) **stage désormais le master de base directement depuis le backup pristine** au lieu de révertir le cas vivant. Le cas vivant + le registre restent **intacts jusqu'au promote final** : en cas d'échec, tout reste exactement comme avant le re-merge (honnête, non destructif) ; en cas de succès, le promote remplace atomiquement à la fin. Bonus : les BC des patches de base éditées par l'utilisateur sont préservées à travers un re-merge (avant : réinitialisées au pristine). Géométrie identique au comportement précédent en cas de succès. La liste de patches de base est lue depuis la même source que le staging (backup vs cas vivant) pour que la résolution de collisions de noms et la validation d'interfaces correspondent au mesh réellement staged.
- 1 test (`meshes.test.ts`) : un re-merge dont `mergeMeshes` échoue laisse le cas (patches de la pièce ajoutée présents) ET le registre d'assemblage intacts.
Fichiers : `apps/api/src/modules/projects/meshes.service.ts`, `apps/api/src/lib/meshBackupStorage.ts` (export `backupCaseDir`), `apps/api/tests/meshes.test.ts`.

### ✅ M1 — Aucune garde « run actif » sur les mutations destructrices du cas
Bug : reset, merge/promote, restore backup, autoPatch, édition de patches, conversion CGNS, apply BC, scaffold, apply template et move/delete/save de fichiers pouvaient réécrire/supprimer le mesh qu'un solveur lit en direct → mort du run sur un FOAM fatal cryptique ; pire, un run parallèle peut `reconstructPar` ses dossiers processor sur le NOUVEAU mesh (cas corrompu).
Ce qui a été fait : nouveau garde partagé `assertNoActiveRun(projectId)` (`lib/runGuard.ts`, autonome — prisma + `@dive/shared`, sans dépendance circulaire sur runs.service) → **409 RUN_IN_PROGRESS** si un run `queued`/`running` existe. Appelé après `assertProjectVisible` dans chaque mutation publique : `resetCase`, `importCaseFiles`, `saveCaseFileContent`, `createCaseFile`, `deleteCaseFileContent`, `deleteCaseDirContent`, `moveCaseEntry`, `scaffoldCase`, `scaffoldSolver`, `syncBoundaryFields`, `convertCgnsToFoam`, `runMerge`, `renameMeshPatch`, `setPatchType`, `editMeshPatches`, `autoPatchMesh`, `restoreMeshBackup`, `applyBoundaryConditions`, `applyTemplate`, `applyTemplateFiles`. Les 4 helpers partagés (scaffoldCase/scaffoldSolver/syncBoundaryFields/applyTemplate) prennent un flag `skipRunGuard` que leurs appelants internes (déjà gardés à leur entrée) passent, pour éviter un double-check qui throw en plein flux. Les mutations de la **librairie** de meshes (meshes/<id>/) ne sont PAS gardées (le solveur lit le cas, pas la librairie).
- 3 tests (`runGuard.test.ts`) : reset/auto-patch/sync bloqués 409 pendant un run ; édition de fichier bloquée ; un run terminal (completed) ne bloque plus.
Fichiers : `apps/api/src/lib/runGuard.ts` (nouveau), `files.service.ts`, `meshes.service.ts`, `conversion.service.ts`, `boundary.service.ts`, `mesh.service.ts`, `../templates/templates.service.ts`, `apps/api/tests/runGuard.test.ts`.

### ✅ M7 — Apply BC : les patches rotor/6-DoF validés APRÈS mutation du cas
Bug : un patch rotor (`nonRotatingPatches`) ou 6-DoF (`sixDof.patches`) mal orthographié renvoyait 422 « rien appliqué » alors que le boundary ET tous les champs `0/` avaient déjà été réécrits (inlet totalPressure, outlet fixedValue, walls…) — mutation partielle + erreur = état incohérent.
Ce qui a été fait : toutes les références de patches rotor sont validées **en amont**, avec inlet/outlet/walls, AVANT tout write (backup/scaffold/setFieldPatchBc). Les deux boucles de validation tardives (post-mutation) sont supprimées.
- Test renforcé (`boundary.test.ts`) : un patch rotor inexistant → 422 ET le cas reste vierge (`0/U` et `constant/MRFProperties` absents, rien n'a été scaffoldé).
Fichiers : `apps/api/src/modules/projects/boundary.service.ts`, `apps/api/tests/boundary.test.ts`.

### ✅ M8 — CSV → boundaryData écrit une sortie corrompue et sort 0
Bug : `csv_to_boundaryData.py` écrivait un `None` littéral dans `0/U` sur une ligne courte, un fichier 0-point sur un CSV header-only, tracebackait sur un CSV vide, et un BOM Excel cassait la colonne `x` — le tout **en sortant 0** (succès), la corruption ne surfaçant qu'au crash du solveur.
Ce qui a été fait :
- Le script valide et **parse chaque cellule en amont** (helper `num()` : cellule manquante/non numérique → `sys.exit` avec ligne+colonne) → aucune écriture partielle, jamais de `None`.
- `utf-8-sig` à l'ouverture (strip le BOM Excel) ; `reader.fieldnames` vide → sortie propre ; 0 ligne de données → sortie propre. Le service marque alors l'étape `failed` et pousse la note « conversion did not complete » (déjà testée via `csvFailRunner`).
- Frontend : le toast n'affiche plus « applied » en dur — un `csvStep` échoué déclenche un **toast warning** (accent orange de marque, pas l'ambre par défaut de sonner ; classe `warning` ajoutée au Toaster) pointant vers le rapport ci-dessous.
- Script vérifié à la main sur 5 cas (bon, ligne courte, header-only, vide, BOM).
Fichiers : `apps/api/scripts/csv_to_boundaryData.py`, `apps/web/src/features/projects/BoundaryConditionDialog.tsx`, `apps/web/src/components/ui/sonner.tsx`.

### ✅ M10 — `createTemplate` crée la ligne DB avant de valider le fichier
Bug : un create rejeté laissait un template fantôme vide dans le roster de tout le monde (la ligne DB était créée AVANT la validation/écriture du fichier inline).
Ce qui a été fait : le fichier inline est validé (path + taille) **avant** le `prisma.template.create`, et si l'écriture échoue après la création, la ligne (+ storage partiel) est **rollback**. Aucun fantôme sur aucun chemin d'échec.
- 1 test (`templates.test.ts`, niveau service car le cap body 16 Ko HTTP masque le 413 tant que M9 n'est pas fait) : un fichier > 2 Mo → 413 ET `template.count()` inchangé.
Fichiers : `apps/api/src/modules/templates/templates.service.ts`, `apps/api/tests/templates.test.ts`.

---

### ✅ M9 — Limite JSON globale 16 Ko casse la création de templates
Bug : `express.json({limit:'16kb'})` global rejetait en 413 tout body plus gros — or un template inline peut porter un fichier jusqu'à `EDITABLE_FILE_MAX_BYTES` (2 Mo) et un apply jusqu'à 1000 chemins. Coller un vrai dict OpenFOAM dans « create template » → 413 brut.
Ce qui a été fait : le parser 16 Ko reste le défaut (protection mémoire) mais est **contourné pour les seules routes à gros JSON** (`POST /templates` et `POST …/apply-template/:tid[/files]`, matchées par `isLargeJsonRoute`), qui parsent avec leur propre limite (2,5 Mo pour create, 1 Mo pour apply). Le global reste 16 Ko partout ailleurs.
- 1 test (`templates.test.ts`) : un fichier inline de ~35 Ko (> 16 Ko) passe (201) et est relu intact.
Fichiers : `apps/api/src/app.ts`, `apps/api/src/modules/templates/templates.routes.ts`, `apps/api/src/modules/projects/projects.routes.ts`, `apps/api/tests/templates.test.ts`.

### ✅ M12 — Les formulaires de meshing remplacent silencieusement un 0 légitime par le défaut
Bug : `Number(x) || DEFAULT` dans SnappyConfigForm / CfMeshConfigForm coerçait un 0 tapé vers le défaut (margin 0 → 0.1, feature level 0 → 2, feature angle 0 → 45). Le champ affichait 0 mais la config persistée/le mesh différaient.
Ce qui a été fait : helper partagé `numOr(value, fallback)` (`formNumber.ts`) distinguant un champ **vide** (→ défaut) d'un **0 tapé** (→ 0 ; `Number('')` vaut 0, d'où le piège du `||`). Appliqué à margin, featureLevel, featureAngle, nLayers, finalLayerThickness, expansionRatio, thicknessRatio. Aucun changement visuel.
- 4 tests unitaires (`formNumber.test.ts`) : 0 tapé gardé, vide/blanc → défaut, non-numérique → défaut, nombre normal.
Fichiers : `apps/web/src/features/meshing/formNumber.ts` (nouveau) + `.test.ts`, `SnappyConfigForm.tsx`, `CfMeshConfigForm.tsx`.

## HIGH

### ✅ H1 — Solveurs orphelins survivant à un redémarrage de l'API
Bug : au boot, `reconcileOrphanRuns` marquait les runs actifs `failed` mais ne **tuait pas** les process : sous Linux l'enfant est reparenté à init et continue (cœurs brûlés, écriture du cas), non tuable depuis l'UI, et l'utilisateur pouvait lancer un **2e** solveur dans le même cas.
Ce qui a été fait : avant de marquer `failed`, on tue le PID enregistré — **uniquement après** avoir vérifié via `/proc/<pid>/cmdline` que l'argv référence bien ce case dir (garde-fou contre la réutilisation de PID). SIGTERM puis SIGKILL après le délai de grâce. Linux-only (no-op sinon).
Fichiers : `apps/api/src/modules/projects/runs.service.ts`.
⚠️ À VÉRIFIER sur le serveur : `/proc` non dispo ici (Windows). Tester : kill -9 API pendant un run → restart → le mpirun est bien tué.

### ✅ H2 — Deux solveurs dans le même cas (TOCTOU)
Bug : `count(active)` puis `create` sans atomicité → double-clic / deux onglets = deux process OpenFOAM écrivant le même cas (corruption) ; le budget cœurs global avait la même course.
Ce qui a été fait : verrou FIFO in-process (`runExclusive`) rendant atomiques la vérif « un run actif » + budget cœurs + création (le run subsystem est déjà mono-process via la map `handles`). Test : deux `startRun` simultanés → exactement un 201, un 409, un seul run actif.
Fichiers : `apps/api/src/modules/projects/runs.service.ts`, `apps/api/tests/solver.test.ts`.

### ✅ H3 — Logs de run non bornés, relus entièrement en mémoire à chaque poll
Bug : `SOLVER_LOG_MAX_BYTES` (32 Mo) déclaré mais inutilisé ; `getRunLog` lisait tout le fichier depuis l'octet 0 à chaque poll → run multi-heures = centaines de Mo alloués par poll et par viewer, au-delà de ~1 Go `toString` throw → live view en 500.
Ce qui a été fait : `readRunLog` accepte un `maxBytes` et lit la **queue** (les dernières `maxBytes`). `getRunLog` **et** `finalizeRun` passent `SOLVER_LOG_MAX_BYTES`. `logBytes` reporte toujours la taille totale réelle.
Fichiers : `apps/api/src/lib/runStorage.ts`, `apps/api/src/modules/projects/runs.service.ts`.

### ✅ H9 — DoS OOM authentifié via uploads
Bug : (1) multer `memoryStorage()` 1 Go/fichier × 5000 fichiers sans cap **total** ; (2) `extractArchiveAt` sans cap de taille décompressée → un zip-bomb de 50 Mo gonfle en Go en mémoire. L'un ou l'autre tue l'API.
Ce qui a été fait :
- `parseCaseUpload` rejette 413 sur `Content-Length` > `MAX_UPLOAD_TOTAL_MB` **avant** de bufferiser.
- `extractArchiveAt` somme les tailles décompressées déclarées (central directory, borne fiable) et rejette 413 `ARCHIVE_TOO_LARGE` au-delà de `MAX_ARCHIVE_UNCOMPRESSED_MB`, avant d'inflater. Fonction rendue `async` (throw → rejet propre).
- 2 nouveaux env (défaut 2048 Mo chacun). 2 tests (rejet + passage sous le cap).
Fichiers : `apps/api/src/config/env.ts`, `apps/api/src/lib/fileTreeStorage.ts`, `apps/api/src/modules/projects/files.controller.ts`, `apps/api/tests/fileTreeStorage.test.ts`.
Note : les uploads chunked (sans Content-Length) retombent sur les limites par-fichier + nombre de multer ; un cap streaming total reste un suivi.

### ✅ H10 — Fallback terminal crash l'API sur frappe vers un shell mort
Bug : chemin non-pty, `child.stdin.write(data)` sans garde ni listener `error` → EPIPE non géré → process down. C'est le chemin exact utilisé quand node-pty est absent sur le serveur.
Ce qui a été fait : listener `error` sur `child.stdin`, suivi de l'état `exit`, et écriture gardée (`writable` + non exité).
Fichiers : `apps/api/src/lib/terminalSession.ts`.

### ✅ H4 — Autosave éditeur écrase les frappes pendant l'aller-retour de save
Bug : l'effet `[content.data]` réinitialisait le buffer CodeMirror à chaque changement de `content.data` — y compris l'**écho** de notre propre save → tout ce qui était tapé pendant la requête était effacé et le curseur sautait.
Ce qui a été fait : le buffer n'est rechargé que sur **changement de fichier** (ref sur le `path` chargé), pas sur l'écho de save. Appliqué à `FileTreeEditor` (couvre aussi l'éditeur de templates qui le réutilise) **et** à `RawFileEditor` du panneau solveur.
Fichiers : `apps/web/src/features/files/FileTreeEditor.tsx`, `apps/web/src/features/solver/SolverConfigPanel.tsx`.

### ✅ H5 — Le polling live s'arrête définitivement après un fetch échoué
Bug : `refetchInterval` dérivait de `query.state.data` ; si le premier fetch échouait, `data` restait `undefined` → intervalle `false` → plus jamais de retry (chart/log figés sur « Running »).
Ce qui a été fait : `useRunsQuery` et `useRunLogQuery` continuent de poller tant qu'aucun statut **terminal** n'a été vu (pas de data / erreur ⇒ on retente).
Fichiers : `apps/web/src/features/solver/useRuns.ts`.

### ✅ H6 — Visualize/Assembly montrent l'ancien mesh après merge/convert/reset
Bug : `useRunMerge`, `useConvertToFoam`, `useResetCase` ne droppaient pas les caches de rendu (manifest/GLB/edges, TTL 5 min) ni l'enregistrement d'assemblage → Visualize rendait l'ancien mesh, le dialog Boundary Conditions proposait les **anciens** patches, le panneau Disassemble n'apparaissait pas.
Ce qui a été fait : les trois hooks droppent maintenant manifest/geometry/edges et invalident library/plan/assembly (`useRunMerge` réutilise `invalidateAssemblyOutputs`). Import des clés de rendu depuis le module feuille `useMesh` pour éviter le cycle useMeshes↔useCaseFiles.
Fichiers : `apps/web/src/features/projects/useMeshes.ts`, `useConversion.ts`, `useCaseFiles.ts`.

### ✅ H8 — Parseur Foam casse `#include` → Easy mode corrompt les fichiers
Bug : `#include "file"` n'a pas de `;` ; le parseur continuait d'accumuler après le saut de ligne et **avalait l'entrée suivante** dans un leaf corrompu → éditer cette ligne en Easy mode supprimait le voisin.
Ce qui a été fait : une directive `#...` se termine au **saut de ligne** (le premier délimiteur `;` ou newline gagne). Flush aussi en fin de dict `}` et en fin de fichier. 2 tests ajoutés (non-avalement + splice du voisin intact).
Fichiers : `apps/web/src/features/projects/foamModel.ts`, `foamModel.test.ts`.

---

## Reste à faire

**Tous les CRITICAL (C1–C4) et HIGH (H1–H10) sont traités.**
MEDIUM restants : M1–M2, M4–M15, M17–M24 (M3, M16 déjà faits). Tous les LOW. Backlog + ordre dans `BUG_AUDIT.md`.

Vérifs de ce lot : API 4 suites vertes (fileTree/solver/runs), web 128/128, typecheck + lint OK.

Vérifications tests (ce lot) : API 449/449, web 126/126, typecheck + lint OK. À valider sur le serveur de deploy : les chemins Python (C1 sidecar, H7 multi-zones) et le comportement crash-log C3 en conditions réelles.

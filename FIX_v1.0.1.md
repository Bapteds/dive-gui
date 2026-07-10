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

### ✅ M5 — Meshers tués à 16 Mo de sortie et signalés « non installés »
Bug : un dépassement de `maxBuffer` (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) était mappé en `spawnError` (« le binaire n'a pas pu démarrer ») ET faisait passer `timedOut` à true (kill = killed) — un gros run snappy/cartesianMesh verbeux (> 16 Mo) envoyait l'utilisateur débugger une fausse piste « pas installé ».
Ce qui a été fait : `commandRunner` distingue le dépassement de buffer (nouveau flag `outputTruncated`, pas de `spawnError`, `timedOut` exclu) d'un vrai échec de spawn (ENOENT/EACCES). Cap relevé 16 → **128 Mo** (`MAX_BUFFER` exporté + `MAX_BUFFER_MB`), overridable par `spec.maxBuffer`. Les rapports d'étape (meshPipelineRun, meshImport) affichent un message clair « dépassé la limite de capture, résultat peut être incomplet » au lieu de « could not start ».
- 3 tests (`commandRunner.test.ts`, binaire réel node) : overflow → `outputTruncated` sans spawnError ni timeout ; binaire inexistant → spawnError ENOENT ; succès + exit non-zéro normaux.
Fichiers : `apps/api/src/lib/commandRunner.ts`, `meshPipelineRun.ts`, `meshImport.ts`, `apps/api/tests/commandRunner.test.ts`.

### ✅ M6 — SIGKILL au timeout orpheline les rangs MPI
Bug : au timeout, `streamRunner` faisait `child.kill('SIGKILL')` — SIGKILL est non catchable, donc mpirun meurt sans le relayer à ses N rangs → les rangs solveur continuent de calculer et d'écrire le cas après que le run soit marqué timed-out.
Ce qui a été fait : au timeout, **SIGTERM d'abord** (mpirun le relaie à ses rangs pour un arrêt propre), puis **SIGKILL après un délai de grâce** (`spec.killGraceMs`, câblé sur `RUN_STOP_GRACE_MS` aux deux sites `runStream`) seulement si le process est encore vivant.
- 2 tests (`streamRunner.test.ts`, node réel) : un process dépassant son timeout → `timedOut:true` ; (POSIX only) un process ignorant SIGTERM → escaladé en SIGKILL (`signal: 'SIGKILL'`).
Fichiers : `apps/api/src/lib/streamRunner.ts`, `apps/api/src/modules/projects/runs.service.ts`, `apps/api/tests/streamRunner.test.ts`.

### ✅ M17 — STL binaires paddés rejetés comme illisibles
Bug : `stlBounds.ts` / `stlMerge.ts` exigeaient la taille EXACTE `84 + n*50` ; un STL binaire avec padding en fin de fichier (certains exporteurs) tombait dans le parseur ASCII → 0 triangle → l'erreur blâmait le fichier de l'utilisateur.
Ce qui a été fait : détection relâchée à `84 + n*50 <= length` (le payload doit TENIR, padding toléré ; un ASCII ne peut pas satisfaire ça, ses octets 80-83 sont du texte → count énorme) + filet : si une lecture « binaire » ne donne aucun triangle, retomber sur ASCII.
- 1 test (`stlBounds.test.ts`) : un STL binaire + 128 octets de padding est lu correctement.
Fichiers : `apps/api/src/lib/stlBounds.ts`, `apps/api/src/lib/stlMerge.ts`, `apps/api/tests/stlBounds.test.ts`.

### ✅ M19 — `extractPatches.py` charge tout le maillage volumique interne
Bug : `enable_all_patch_arrays()` active AUSSI le pseudo-patch `internalMesh` (le maillage volumique complet), malgré le design « bords seulement » — un rendu synchrone in-request pouvait OOM/timeout sur un maillage de production.
Ce qui a été fait : désactivation de `internalMesh` au niveau VTK (`SetPatchArrayStatus`, robuste aux versions pyvista, en best-effort try/except → dégrade vers l'ancien comportement plutôt que de casser le rendu).
Fichiers : `apps/api/scripts/extractPatches.py`. À VÉRIFIER sur le box (pyvista non exécutable en dev).

### ✅ M24 — Noms de patches à tiret mal indexés dans le manifest
Bug : la regex `(\w+)…type\s+(\w+)` de `parse_boundary_types` capturait `wall-1` comme `1` (le `\w` exclut le tiret) et pouvait matcher `physicalType` — les consommateurs meshing/librairie recevaient de mauvais types (Visualize récupérait via re-enrich côté TS).
Ce qui a été fait : regex `([A-Za-z_][\w-]*)…\btype\s+([\w-]+)` (tirets autorisés dans nom + type, `\btype` ancre la vraie clé). Vérifié en Python : `wall-1`/`inlet-1` + `physical... type ...` parsés correctement.
Fichiers : `apps/api/scripts/extractPatches.py`.

### ✅ M20 (partiel) — Les téléchargements bufferisent tout l'artefact en mémoire
Bug : `out.cgns` (potentiellement plusieurs Go) était lu entièrement en Buffer puis `res.send(bytes)` — pic mémoire API + `res.send` throw au-delà de ~2 Go (limite Buffer Node).
Ce qui a été fait (côté serveur, le risque grave = OOM API partagée) : nouveau `resolveExportArtifact` (visibilité + existence → `{path, size}`) + `streamDownload` qui **`createReadStream(path).pipe(res)`** avec `Content-Length` réel ; le cgns ET le fallback zip sont streamés. Mémoire bornée au high-water mark.
- Test renforcé (`export.test.ts`) : le download cgns renvoie un `Content-Length` correct et les octets exacts.
Fichiers : `apps/api/src/lib/exportStorage.ts` (`exportFileStat`), `export.service.ts` (`resolveExportArtifact`), `export.controller.ts`, `apps/api/tests/export.test.ts`.
RESTE (suivi) : le zip du case (`buildCaseArchive`/`zipTreeAt` via `zip.toBuffer()`) et le `getBlob` client (download navigateur d'un gros fichier) bufferisent encore — le streaming zip demande `archiver`, et le download client streamé bute sur l'auth par header (StreamSaver/File System Access API requis).

### ⏸️ M18 — `buildSolverSpec` : mauvais family/requiredFiles pour les solveurs non-RANS (deferred-by-design)
Constat : interFoam/solidDisplacementFoam… sont décrits avec les fichiers RANS incompressibles (`0/p`, `transportProperties`) au lieu de leurs vrais champs (`0/p_rgh`, `0/alpha.water`). **NON corrigé volontairement** : c'est une décision de conception DÉLIBÉRÉE ET TESTÉE (backlog F4 « tous les solveurs guidés » ; `runnable.test.ts` verrouille explicitement « interFoam gate sur le set incompressible complet » + `runnable:true` après scaffold), avec l'UI qui signale déjà le tier « Base setup » + un hint honnête. La vraie résolution = la feature déjà backloggée « templates par famille pour les familles exotiques (VoF/combustion/…) ». Un fix partiel casserait le design testé pour un gain incomplet ; à traiter comme une feature, hors passe de bugfix.

### ✅ M14 — Apply template ne droppe pas les caches de contenu de fichier
Bug : `useApplyTemplate`/`useApplyTemplateFiles` mettaient à jour l'arbre mais pas les caches de CONTENU — un éditeur ouvert gardait l'ancien contenu et une frappe autosauvait par-dessus le fichier importé.
Fix : les deux hooks font `removeQueries([...caseFilesQueryKey, 'content'])` en succès (même pattern que les autres mutations de cas).
Fichiers : `apps/web/src/features/templates/useTemplates.ts`.

### ✅ M15 — Supprimer un fichier ouvert et dirty le ressuscite
Bug : l'autosave 600 ms armé se déclenchait pendant le round-trip du delete et re-PUTait le fichier.
Fix : `handleConfirmDelete` vide la sélection (`onRemoved`) AVANT le delete → désarme l'autosave (supprimer implique jeter les éditions non sauvées).
Fichiers : `apps/web/src/features/files/FileTreeEditor.tsx`.

### ✅ M11 — L'onglet Export perd le run au changement d'onglet → double export
Bug : `useRunExport` sans `mutationKey` → son état in-flight (component-local) était perdu au démontage de l'onglet ; au retour le bouton se ré-activait → 2e export concurrent sur le même cas.
Fix : `mutationKey` sur la mutation + hook `useIsExporting` (via `useIsMutating`) lu du cache de mutations (survit au démontage) → bouton désactivé/loading tant que l'export tourne.
Fichiers : `apps/web/src/features/export/useExport.ts`, `ExportTab.tsx`.

### ✅ M22 — Dashboard Home : skeletons + badge « Live » vert à vie sur échec API
Bug : `HomePage` ne regardait jamais `isError` → skeletons infinis + badge « Live » mensonger.
Fix : badge conditionnel (« Offline » neutre en erreur) + `ErrorState` partagé (avec retry) quand le premier chargement échoue sans cache ; un blip transitoire AVEC cache garde le dashboard (stale) signalé par le badge.
Fichiers : `apps/web/src/pages/HomePage.tsx`.

### ✅ M13 — Le formulaire Easy solveur perd la 1re de deux éditions rapides
Bug : `commit` splice dans le contenu du CACHE (en retard) ; deux éditions rapides du même fichier lisent la même base → la 2e écrase la 1re côté serveur.
Fix : mise à jour OPTIMISTE du cache de contenu (`setQueryData`) sur chaque commit → la 2e édition part de la 1re (le form Easy n'a pas de draft CodeMirror à écraser).
Fichiers : `apps/web/src/features/solver/SolverConfigPanel.tsx`.

### ✅ M21 — Les champs numériques de placement massacrent la précision
Bug : la value était arrondie à 3 décimales (sous-mm intypable) et un « - » ou « . » intermédiaire (value navigateur = "" → `Number("")` = 0) committait la position 0 → la pièce sautait à l'origine (reposition on).
Fix : nouveau `AxisInput` = `type="text" inputMode="decimal"` avec un draft string local (frappe libre, resync depuis le modèle hors focus), ne committant QU'un nombre fini (`raw !== '' && Number.isFinite`).
Fichiers : `apps/web/src/features/assemble/PlacementPanel.tsx`.

### ✅ M23 — Le retry du viewer d'assemblage ne récupère jamais d'un GLB de pièce corrompu
Bug : le retry ne refetchait QUE la géométrie de base ; un GLB de PIÈCE corrompu restait en cache 5 min → boucle d'erreur.
Fix : le retry invalide TOUTES les géométries (`glb`) du projet (base `mesh` + pièces `meshSource`) via un predicate → la pièce corrompue est re-fetchée.
Fichiers : `apps/web/src/features/assemble/AssemblyWorkspace.tsx`.

## LOW

### ✅ L2 — Oracle temporel au login (énumération d'emails)
Bug : un email inconnu court-circuitait le verify argon2 (401 rapide) alors qu'un email connu le lançait (401 lent) → distinguable au chrono.
Fix : `dummyVerify(password)` (verify contre un hash argon2id fixe valide) exécuté quand l'email est inconnu → même coût temporel. Fichiers : `apps/api/src/lib/password.ts`, `modules/auth/auth.service.ts`.

### ✅ L3 — Les 500 fuitent des codes internes ; les détails de validation n'atteignent pas le client
Bug : un code Prisma (`P2025`) / fs (`ENOENT`) d'une erreur non-AppError passait tel quel sur le fil (`code`), et les `details` field-level d'une erreur de validation étaient droppés du payload.
Fix : le handler ne renvoie code/message QUE pour une `AppError` (de confiance) + ses `details` optionnels ; tout le reste → 500 générique (`INTERNAL_SERVER_ERROR`, message générique), un 4xx framework (body-parser) garde son status mais pas son code interne. +1 test (details présents). Fichiers : `apps/api/src/middleware/errorHandler.ts`, `apps/api/tests/auth.test.ts`.

### ✅ L4 — `revokeRefreshTokens` 500 si l'utilisateur a disparu
Bug : `prisma.user.update` throw P2025 si la ligne n'existe plus, contredisant le contrat « safe if deleted ». Fix : `updateMany` (no-op sur 0 match). +1 test. Fichiers : `apps/api/src/modules/auth/auth.service.ts`, `apps/api/tests/auth.test.ts`.

### ✅ L6 — Override de solveur de `startRun` silencieusement ignoré
Bug : le controlDict gagnait toujours, l'`input.solver` était ignoré sans un mot. Fix : si un `input.solver` DIFFÉRENT du solveur configuré (controlDict) est passé → **409 SOLVER_MISMATCH** explicite (les fichiers du cas sont scaffoldés pour le solveur du controlDict). Fichiers : `apps/api/src/modules/projects/runs.service.ts`.

### ✅ L8 — `fmtFoamNumber` écrase |x| < 5e-7 à 0
Bug : `toFixed(6)` mettait à 0 une composante d'axe rotor / origine minuscule mais réelle dans MRFProperties/dynamicMeshDict. Fix : `toPrecision(12)` (chiffres significatifs, pas décimales fixes ; OpenFOAM lit `3e-7`). Fichiers : `apps/api/src/lib/openfoamCase.ts`.

### ✅ L12 — Le seed réinitialise le mot de passe du super-admin à chaque deploy
Bug : la branche `update` de l'upsert réécrivait `passwordHash` → tout changement de mot de passe fait dans l'app était réverti au prochain seed/deploy. Fix : `passwordHash` n'est plus dans `update` (seulement à la première création). Fichiers : `apps/api/prisma/seed.ts`.

## Reste à faire

**Tous les CRITICAL (C1–C4), HIGH (H1–H10) et MEDIUM (M1–M24) sont traités** — sauf **M18** (deferred-by-design : décision testée « tous les solveurs guidés », vraie résolution = feature templates par famille). Restent les **LOW (L1–L21)**. Backlog + ordre dans `BUG_AUDIT.md`.

Vérifications tests (fin du lot MEDIUM) : **API 466/466** (+1 skip POSIX-only pour l'escalade SIGKILL M6), **web 132/132**, **MCP 25/25**, typecheck + lint (0 erreur) OK.

À VALIDER sur le serveur de deploy (non exécutable en dev Windows) :
- Python : C1 sidecar, H7 multi-zones, **M8** (CSV strict), **M19** (internalMesh désactivé sous pyvista), **M24** (regex tirets).
- OpenFOAM/MPI : **M1** garde run-actif, **M6** SIGTERM→SIGKILL mpirun, **M5** overflow buffer d'un gros mesher.
- Streaming : **M20** download cgns multi-Go réel.

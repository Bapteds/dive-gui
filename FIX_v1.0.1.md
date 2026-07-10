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

## MEDIUM (traités en passant)

### ✅ M3 — Suppression d'un projet ne stoppe pas son solveur
Corrigé via le même helper : `deleteProject` appelle `stopProjectRuns(id)` avant la suppression.
Fichiers : `apps/api/src/modules/projects/projects.service.ts`.

### ✅ M16 — voir section CRITICAL (corrigé avec C1).

---

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

### ⬜ H4 — Autosave éditeur écrase les frappes pendant l'aller-retour de save
### ⬜ H5 — Le polling live s'arrête définitivement après un fetch échoué
### ⬜ H6 — Visualize/Assembly montrent l'ancien mesh après merge/convert/reset
### ⬜ H8 — Parseur Foam casse `#include` → Easy mode corrompt les fichiers
### ⬜ H9 — DoS OOM authentifié via uploads
### ⬜ H10 — Fallback terminal crash l'API sur frappe vers un shell mort

---

## Reste à faire

HIGH restants : H4–H6, H8–H10. MEDIUM restants : M1–M2, M4–M15, M17–M24. Tous les LOW. Backlog complet + ordre suggéré dans `BUG_AUDIT.md`.

Vérifications tests (ce lot) : API 449/449, web 126/126, typecheck + lint OK. À valider sur le serveur de deploy : les chemins Python (C1 sidecar, H7 multi-zones) et le comportement crash-log C3 en conditions réelles.

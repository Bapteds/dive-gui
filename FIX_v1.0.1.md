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

## Reste à faire

HIGH restants : H1–H6, H8–H10. MEDIUM restants : M1–M2, M4–M15, M17–M24. Tous les LOW. Backlog complet + ordre suggéré dans `BUG_AUDIT.md`.

Vérifications tests (ce lot) : API 449/449, web 126/126, typecheck + lint OK. À valider sur le serveur de deploy : les chemins Python (C1 sidecar, H7 multi-zones) et le comportement crash-log C3 en conditions réelles.

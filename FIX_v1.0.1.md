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

### ⬜ C2 — Suppression d'un compte : cascade destructrice + storage orphelin
### ⬜ C3 — streamRunner : write stream sans listener `error` → crash process
### ⬜ C4 — Logout : cache React Query jamais vidé

---

## HIGH / MEDIUM / LOW

Non commencés. Backlog complet dans `BUG_AUDIT.md`.

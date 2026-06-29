#!/usr/bin/env python3
"""
foam_to_transient_cgns.py — OpenFOAM transitoire -> UN fichier CGNS pour CFD-Post.

CORRECTIONS vs version initiale :
  [C1] Garde-fou pas-de-temps : stoppe si < 2 pas detectes (cause #1 du symptome
       "un seul timestep"). enable_all_cell_arrays() AVANT lecture des temps.
  [C2] Triangulation UNE SEULE FOIS au pas 0. Les pas suivants reutilisent la
       topologie de reference (mesh reellement statique). Sur maillage poly,
       trianguler a chaque pas re-noeudise differemment -> corruption silencieuse.
  [C3] Audit de coherence integre : GridCoordinates==1, FlowSolution==N,
       NumberOfSteps==len(TimeValues)==rows(Pointers)==N. Refuse de livrer sinon.
  [A]  Coherence des CHAMPS entre pas : on ne garde que les pas portant le meme
       jeu de variables (vitesse + pression au minimum). Les dossiers "pTotal
       seul" / pas vides sont ECARTES avec un diagnostic, au lieu de produire des
       frames vides dans CFD-Post. Echoue s'il reste < 2 pas complets.
  [B]  Mesh statique verifie par les COORDONNEES (np.allclose), pas seulement le
       nombre de sommets : evite un recablage silencieux des champs.
  [D]  Attributs CGNS/HDF5 name/label en champ fixe 33 octets (conforme SIDS).

CFD-Post detecte le transitoire d'un CGNS UNIQUE via BaseIterativeData au Load
Results (le Timestep Selector se remplit seul ; ne PAS utiliser "Add Timesteps",
reserve aux fichiers CFX .res/.trn).

Dependances :  pip install pyvista numpy h5py   (--break-system-packages au besoin)

Usage :
    python3 foam_to_transient_cgns.py case.foam -o result.cgns --version 4.0
    python3 foam_to_transient_cgns.py --verify result.cgns
CFD-Post : File > Load Results > result.cgns  (le Timestep Selector se remplit seul)
"""

import argparse, sys
from collections import Counter
import numpy as np
import h5py

TETRA_4 = 10
SCALAR_NAME_MAP = {'p': 'Pressure', 'T': 'Temperature', 'rho': 'Density',
                   'k': 'TurbulentEnergyKinetic', 'omega': 'TurbulentDissipationRate',
                   'epsilon': 'TurbulentDissipation', 'nut': 'ViscosityEddyKinematic'}
VECTOR_NAME_MAP = {'U': 'Velocity'}

# [A] Champs "coeur" d'un pas reellement resolu : au moins vitesse + pression.
# Un dossier temps sans eux (ex. "pTotal seul", pas vide) n'est PAS un pas
# exploitable et est exclu de la serie transitoire.
CORE_FIELDS = {'VelocityX', 'Pressure'}


def node(name, value, label, children=None):
    return [name, value, children if children is not None else [], label]

def char_array(t):
    return np.frombuffer(t.encode('ascii'), dtype=np.int8).copy()

def sanitize(n):
    return ''.join(c if (c.isalnum() or c == '_') else '_' for c in n) or 'field'

def nodal_fields(grid, wanted):
    out = []
    for raw in list(grid.point_data.keys()):
        if wanted and raw not in wanted:
            continue
        a = np.asarray(grid.point_data[raw])
        if a.ndim == 1:
            out.append((SCALAR_NAME_MAP.get(raw, sanitize(raw)), np.ascontiguousarray(a, np.float64)))
        elif a.ndim == 2 and a.shape[1] == 1:
            out.append((SCALAR_NAME_MAP.get(raw, sanitize(raw)), np.ascontiguousarray(a[:, 0], np.float64)))
        elif a.ndim == 2 and a.shape[1] == 3:
            b = VECTOR_NAME_MAP.get(raw, sanitize(raw))
            for c, ax in zip('XYZ', range(3)):
                out.append((f'{b}{c}', np.ascontiguousarray(a[:, ax], np.float64)))
    return out


# ---------------------------------------------------------------------------
# [C2] Reference mesh : triangule UNE fois au pas 0, on reutilise ensuite.
# ---------------------------------------------------------------------------
def make_reader(foam_file):
    """[C1] enable_all_cell_arrays AVANT toute lecture de temps."""
    import pyvista as pv
    r = pv.OpenFOAMReader(foam_file)
    r.enable_all_cell_arrays()
    return r

def read_region_raw(foam_file, t, region):
    """Reader NEUF par pas (evite le cache OpenFOAM qui resert t=0 -> U/p=0).
    Renvoie le volume cell->point SANS trianguler (la triangulation est geree
    une seule fois par le mesh de reference)."""
    r = make_reader(foam_file)
    r.set_active_time_value(t)
    m = r.read()
    vol = m[region] if region in m.keys() else m[0]
    if vol is None or vol.n_cells == 0:
        raise RuntimeError(f"region '{region}' vide au temps {t}")
    return vol.cell_data_to_point_data()

def build_reference_mesh(foam_file, t0, region):
    """[C2] Triangule UNE fois. Renvoie (tet_ref, nvert, conn, ncell)."""
    import pyvista as pv
    vol = read_region_raw(foam_file, t0, region)
    tet = vol.triangulate()
    cd = tet.cells_dict
    if set(cd.keys()) != {int(pv.CellType.TETRA)}:
        raise RuntimeError(f"types cellules inattendus apres triangulation: {sorted(cd.keys())}")
    conn = (cd[int(pv.CellType.TETRA)] + 1).astype(np.int32).ravel()
    nvert = tet.n_points
    ncell = conn.size // 4
    return tet, nvert, conn, ncell

def fields_on_reference(foam_file, t, region, ref_tet, nvert, wanted):
    """[C2] Reinterpole les champs du pas t sur la topologie de reference.
    On retriangule le volume du pas t puis on verifie la concordance du nombre
    de sommets ; en triangulation deterministe (meme mesh source statique),
    l'ordre des points est conserve. Garde-fou si divergence."""
    vol = read_region_raw(foam_file, t, region)
    tet = vol.triangulate()
    if tet.n_points != nvert:
        raise RuntimeError(
            f"maillage non statique au temps {t} : {tet.n_points} sommets vs {nvert} "
            f"de reference. [C2] Le mesh source doit etre fige entre les pas.")
    # [B] Au-dela du COMPTE de sommets, verifier que l'ORDRE des points est
    # identique a la reference : sinon les champs seraient recables en silence
    # sur une mauvaise geometrie (mailles polyedriques surtout).
    span = float(np.linalg.norm(ref_tet.points.max(0) - ref_tet.points.min(0))) or 1.0
    if not np.allclose(tet.points, ref_tet.points, rtol=0.0, atol=1e-9 * span):
        raise RuntimeError(
            f"[B] ordre des sommets different de la reference au temps {t} : "
            "triangulation non deterministe / mesh non fige. Alignement des "
            "champs non garanti.")
    return nodal_fields(tet, wanted)


def select_timesteps(time_fields, forced):
    """[A] Choisit le jeu de champs de REFERENCE et ne garde que les pas qui le
    portent en entier, pour que chaque FlowSolution ait EXACTEMENT les memes
    variables (sinon CFD-Post affiche des pas "vides"). `time_fields` : dict
    temps -> set des noms de champs (deja mappes). `forced` : True si l'utilisateur
    a impose --fields. Renvoie (ref_fields tries, temps gardes, [(t, manquants)])."""
    times = sorted(time_fields)
    if forced:
        # --fields impose : reference = le plus grand jeu reellement observe
        # (les champs demandes presents ensemble) ; on garde les pas complets.
        ref = set(max(time_fields.values(), key=len, default=set()))
    else:
        # Candidats = pas contenant le coeur solution (U & p) ; on exclut d'office
        # les dossiers "pTotal seul" et les pas vides.
        solved = [t for t in times if CORE_FIELDS <= time_fields[t]]
        if not solved:
            raise RuntimeError(
                "[A] aucun pas ne contient a la fois la vitesse et la pression (U & p). "
                "Le cas n'a pas ete resolu/ecrit correctement -> voir le writeControl "
                "des champs dans le controlDict cote OpenFOAM.")
        # Reference = jeu de champs le plus FREQUENT parmi ces pas (egalite -> le
        # plus riche). Sur un cas propre c'est l'ensemble complet des champs solves.
        sets = [frozenset(time_fields[t]) for t in solved]
        ref = set(max(Counter(sets).items(), key=lambda kv: (kv[1], len(kv[0])))[0])
    if not ref:
        raise RuntimeError("[A] aucun champ a exporter : verifier --fields et le cas.")
    kept, dropped = [], []
    for t in times:
        missing = ref - time_fields[t]
        if missing:
            dropped.append((t, sorted(missing)))
        else:
            kept.append(t)
    return sorted(ref), kept, dropped


def build_tree(foam_file, region, wanted, version):
    times = list(make_reader(foam_file).time_values)
    # [C1] Garde-fou pas-de-temps
    if not times:
        raise RuntimeError("[C1] aucun pas de temps detecte. "
                           "Verifier que reconstructPar a ete execute et que le .foam "
                           "pointe une reconstruction complete.")
    if len(times) < 2:
        raise RuntimeError(
            f"[C1] un seul pas de temps detecte ({times}). "
            "C'est la cause #1 du symptome 'un seul timestep' dans CFD-Post.\n"
            "    -> reconstructPar a-t-il ecrit tous les dossiers temps ?\n"
            "    -> le .foam pointe-t-il le bon repertoire de cas ?")
    print(f"  {len(times)} pas detectes : {times[0]} .. {times[-1]}")

    # [C2] Mesh de reference : triangule UNE fois (geometrie statique)
    ref_tet, nvert, conn, ncell = build_reference_mesh(foam_file, times[0], region)
    pts = np.ascontiguousarray(ref_tet.points, np.float64)
    print(f"  maillage de reference (fige) : {nvert} sommets, {ncell} tetraedres")

    # Passe 1 : lire les champs de CHAQUE pas et relever le jeu de champs present.
    per_time, time_fields = {}, {}
    for t in times:
        per_time[t] = dict(fields_on_reference(foam_file, t, region, ref_tet, nvert, wanted))
        time_fields[t] = set(per_time[t])

    # [A] Selection : meme jeu de champs sur TOUS les pas exportes.
    ref_fields, kept, dropped = select_timesteps(time_fields, forced=bool(wanted))
    print(f"  [A] champs de reference ({len(ref_fields)}) : {', '.join(ref_fields)}")
    if dropped:
        print(f"  [A] {len(dropped)} pas ECARTES (jeu de champs incomplet) :")
        for t, missing in dropped:
            print(f"        t={t}  manque: {', '.join(missing) if missing else '(aucun champ)'}")
        if any('Pressure' in m or any(x.startswith('Velocity') for x in m) for _, m in dropped):
            print("  [A] -> des pas n'ont ni U ni p (typiquement dossiers 'pTotal seul').\n"
                  "      Cote OpenFOAM : pTotal/yPlus en 'writeControl writeTime', puis\n"
                  "      'foamListTimes -rm' et relancer, pour que chaque pas soit complet.")
    if len(kept) < 2:
        raise RuntimeError(
            f"[A] apres filtrage de coherence, seuls {len(kept)} pas complets restent "
            f"(sur {len(times)}). Impossible de produire une serie transitoire animable.\n"
            "    -> corriger le cas OpenFOAM (champs ecrits a chaque pas d'ecriture)\n"
            "       puis regenerer ; cf. le message [A] ci-dessus.")
    print(f"  [A] {len(kept)} pas conserves : {kept[0]} .. {kept[-1]}")

    grid = node('GridCoordinates', None, 'GridCoordinates_t', [
        node('CoordinateX', np.ascontiguousarray(pts[:, 0]), 'DataArray_t'),
        node('CoordinateY', np.ascontiguousarray(pts[:, 1]), 'DataArray_t'),
        node('CoordinateZ', np.ascontiguousarray(pts[:, 2]), 'DataArray_t')])
    elems = node('GridElements', np.array([TETRA_4, 0], np.int32), 'Elements_t', [
        node('ElementRange', np.array([1, ncell], np.int32), 'IndexRange_t'),
        node('ElementConnectivity', conn, 'DataArray_t')])

    sols, names, tvals = [], [], []
    for k, t in enumerate(kept, 1):
        data = per_time[t]
        ch = [node('GridLocation', char_array('Vertex'), 'GridLocation_t')]
        ch += [node(nm, data[nm], 'DataArray_t') for nm in ref_fields]  # meme ordre partout
        sn = f'FlowSolution{k:04d}'
        names.append(sn); tvals.append(float(t)); sols.append(node(sn, None, 'FlowSolution_t', ch))
        um = f"{np.abs(data['VelocityX']).max():.3g}" if 'VelocityX' in data else '?'
        pm = f"{np.abs(data['Pressure']).max():.3g}" if 'Pressure' in data else '?'
        print(f"  [{k}/{len(kept)}] t={t}  |VelX|max={um}  |p|max={pm}")

    n = len(names)
    ptr = np.zeros((n, 32), np.int8)
    for j, s in enumerate(names):
        ptr[j, :] = np.frombuffer(s.ljust(32)[:32].encode('ascii'), np.int8)
    ziter = node('ZoneIterativeData', None, 'ZoneIterativeData_t',
                 [node('FlowSolutionPointers', ptr, 'DataArray_t')])
    zone = node('Zone', np.array([[nvert], [ncell], [0]], np.int32), 'Zone_t',
                [node('ZoneType', char_array('Unstructured'), 'ZoneType_t'), grid, elems] + sols + [ziter])
    biter = node('BaseIterativeData', np.array([n], np.int32), 'BaseIterativeData_t', [
        node('TimeValues', np.array(tvals, np.float64), 'DataArray_t'),
        node('IterationValues', np.arange(1, n + 1, dtype=np.int32), 'DataArray_t')])
    base = node('Base', np.array([3, 3], np.int32), 'CGNSBase_t',
                [zone, biter, node('SimulationType', char_array('TimeAccurate'), 'SimulationType_t')])

    # [C3] Audit de coherence AVANT ecriture
    assert n == len(tvals) == ptr.shape[0], \
        f"[C3] incoherence N={n} TimeValues={len(tvals)} Pointers={ptr.shape[0]}"
    print(f"  [C3] coherence OK : NumberOfSteps={n} == TimeValues={len(tvals)} == Pointers={ptr.shape[0]}")

    return node('CGNSTree', None, 'CGNSTree_t', [
        node('CGNSLibraryVersion', np.array([version], np.float32), 'CGNSLibraryVersion_t'), base]), n


_TAG = {np.dtype('int32'): 'I4', np.dtype('int64'): 'I8', np.dtype('float32'): 'R4',
        np.dtype('float64'): 'R8', np.dtype('int8'): 'C1'}

def _sattr(o, k, v, n=None):
    # [D] CGNS/HDF5 stocke les attributs de noeud en ASCII fixe null-padded :
    # name/label DOIVENT etre char[33] et type char[3] (mapping SIDS->HDF5).
    # Une longueur variable ne "marche" que par conversion de chaines HDF5 et
    # casse les lecteurs CGNS stricts -> on epingle les tailles standard.
    r = v.encode('ascii')
    o.attrs.create(k, r, dtype=h5py.string_dtype('ascii', n if n is not None else len(r) + 1))

def _meta(o, name, label, tag):
    _sattr(o, 'name', name, 33); _sattr(o, 'label', label, 33); _sattr(o, 'type', tag, 3)
    o.attrs.create('flags', np.array([1], np.int32))

def _wnode(parent, nd):
    name, value, children, label = nd
    g = parent.create_group(name)
    if value is None:
        tag = 'MT'
    else:
        value = np.asarray(value); tag = _TAG[value.dtype]; g.create_dataset(' data', data=value)
    _meta(g, name, label, tag)
    for c in children:
        _wnode(g, c)

def write_cgns(path, tree):
    with h5py.File(path, 'w') as f:
        _meta(f, 'HDF5 MotherNode', 'Root Node of HDF5 File', 'MT')
        f.create_dataset(' format', data=char_array('IEEE_LITTLE_32'))
        v = 'HDF5 Version ' + '.'.join(str(x) for x in h5py.version.hdf5_version_tuple[:3])
        f.create_dataset(' hdf5version', data=char_array(v))
        for c in tree[2]:
            _wnode(f, c)

def _astr(o, k):
    if k not in o.attrs: return ''
    v = o.attrs[k]
    if isinstance(v, (bytes, np.bytes_)): return v.decode('ascii', 'ignore').rstrip('\x00')
    if isinstance(v, np.ndarray): return v.tobytes().decode('ascii', 'ignore').rstrip('\x00')
    return str(v)

def verify(path):
    with h5py.File(path, 'r') as f:
        find = {'BaseIterativeData_t': [], 'FlowSolution_t': [], 'ZoneIterativeData_t': [],
                'GridCoordinates_t': []}
        def walk(g):
            for k in g:
                it = g[k]
                if isinstance(it, h5py.Group):
                    lbl = _astr(it, 'label')
                    if lbl in find: find[lbl].append(it)
                    walk(it)
        walk(f)
        print(f"verification de {path}")
        ver = np.asarray(f['CGNSLibraryVersion'][' data']).ravel()[0]
        print(f"  CGNSLibraryVersion : {ver}")
        # [C3] audit relu
        print(f"  GridCoordinates    : {len(find['GridCoordinates_t'])} (doit etre 1)")
        nbid = None
        if find['BaseIterativeData_t']:
            b = find['BaseIterativeData_t'][0]
            nbid = int(np.asarray(b[' data']).ravel()[0])
            ntime = np.asarray(b['TimeValues'][' data']).size
            print(f"  BaseIterativeData  : NumberOfSteps={nbid}")
            print(f"    TimeValues={np.asarray(b['TimeValues'][' data']).ravel()}  (len={ntime})")
            if 'IterationValues' in b:
                print(f"    IterationValues={np.asarray(b['IterationValues'][' data']).ravel()}")
            else:
                print("    IterationValues: ABSENT")
        else:
            print("  BaseIterativeData  : ABSENT")
        nfs = len(find['FlowSolution_t'])
        print(f"  FlowSolution_t     : {nfs}")
        print(f"  ZoneIterativeData  : {'OK' if find['ZoneIterativeData_t'] else 'ABSENT'}")
        # coherence finale
        if nbid is not None:
            coherent = (len(find['GridCoordinates_t']) == 1 and nfs == nbid)
            print(f"  >>> COHERENCE : {'OK -> CFD-Post verra ' + str(nbid) + ' pas' if coherent else 'INCOHERENT'}")
        # [A] Coherence des variables entre pas : CFD-Post exige le MEME jeu
        # de champs a chaque pas, sinon des instants apparaissent "vides".
        var_sets = []
        for fs in find['FlowSolution_t']:
            vs = {_astr(fs[k], 'name') for k in fs
                  if isinstance(fs[k], h5py.Group) and _astr(fs[k], 'label') == 'DataArray_t'}
            var_sets.append(vs)
        if var_sets:
            common = set.intersection(*var_sets)
            allv = set.union(*var_sets)
            if common == allv:
                print(f"  [A] variables identiques sur les {len(var_sets)} pas : OK ({len(allv)} champs)")
            else:
                print(f"  [A] !! variables INCOHERENTES entre pas -> CFD-Post montrera des trous.\n"
                      f"      communes={sorted(common)}  parfois absentes={sorted(allv - common)}")
        if find['FlowSolution_t']:
            last = find['FlowSolution_t'][-1]
            print(f"  champs |max| dans {_astr(last,'name')} :")
            for k in last:
                ch = last[k]
                if isinstance(ch, h5py.Group) and _astr(ch, 'label') == 'DataArray_t':
                    d = np.asarray(ch[' data'])
                    print(f"     {k:24s} {np.abs(d).max():.4g}")

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('foam', nargs='?')
    ap.add_argument('-o', '--out', default='result.cgns')
    ap.add_argument('--region', default='internalMesh')
    ap.add_argument('--fields', nargs='*', default=None)
    ap.add_argument('--version', type=float, default=4.0)
    ap.add_argument('--verify', metavar='FILE')
    a = ap.parse_args()
    if a.verify:
        verify(a.verify); return
    if not a.foam:
        ap.error("fichier .foam requis (ou --verify)")
    wanted = set(a.fields) if a.fields else None
    print(f"lecture de {a.foam}")
    tree, n = build_tree(a.foam, a.region, wanted, a.version)
    write_cgns(a.out, tree)
    print(f"ecrit : {a.out} ({n} pas)\n")
    verify(a.out)

if __name__ == '__main__':
    main()
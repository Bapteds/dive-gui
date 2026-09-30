#!/usr/bin/env python3
"""
lidkit_fitlid.py — LID ITERATION KIT, step 2: fit the `atmosphere` patch of a flat-lid domain STL to a free-surface
field z_s(x,y) and write the new domain STL (to be re-meshed).  Geometry-agnostic: works on the multi-solid ASCII STL
itself, no parametric builder needed.

Rules (generalised from the 2026-09-09/10 lid iterations of the bigger spiral, the solid cone and the VIE chamber):
  * the lid (`atmosphere`) is re-triangulated as a height field z_s over its own planform (outer loop + holes taken
    from the open edges of the atmosphere solid), boundary edges subdivided to <= SUB, interior Steiner points at
    STEINER spacing kept > CLEAR from the boundary, conformal Delaunay (every boundary edge must be recovered);
  * every vertex of another solid that lies ON the lid plane z = Z_LID follows the lid (z -> z_s(x,y)) — vertical
    walls, shell / cone top rings, plank cut edges — so the walls stay vertex-conformal with the lid; facets that
    share a subdivided lid-boundary edge are split (fan) at the inserted points;
  * vertices that belong to a HORIZONTAL facet lying in the lid plane (a roof, `walls_ceiling`) are FIXED at Z_LID;
    along lid-boundary edges whose solid side stays at Z_LID a vertical UPSTAND (patch --upstand-patch, default
    atmosphere = the surface falling away from the roof edge) closes the gap; at a fixed/movable corner a closing
    triangle in the wall plane is added;
  * horizontal facets of other solids BELOW the lid plane within the planform (a submerged cap / shelf) are kept
    under at least T_MIN of water: z_s is clamped to z_top + T_MIN over their footprint (the exposed-cap / shoreline
    treatment of the bigger-spiral builder is NOT generic and is not implemented — the clamped area is reported);
  * solids that poke THROUGH the lid plane (a plank to z 1.55, a shell through the surface) are CUT AT THE FITTED LID
    (generalised from build_plank(ztop_of) of the 2026-09-09 bigger-spiral builder): their footprint becomes a hole in
    the lid, the vertical faces end at the local lid height with vertices SHARED with the hole, no roof is added (the
    interior above the cut is outside the fluid), facets entirely above the surface are dropped.  Only vertical-walled
    protrusions are supported (prisms, cylinders); a non-vertical facet crossing the surface aborts with a message.
    --no-cut restores the old behaviour (poke-through left to cfMesh; gave open cells at the plank/wall lid corners).
Always build from the ORIGINAL flat-lid STL (never from a previously fitted one): z_s(x,y) is a height field over
the unchanged planform.  A flat field (--flat) must reproduce the input topology (regression test).

usage: lidkit_fitlid.py <base_flat.stl> <out.stl> (--zs zs.npy | --flat) --z-lid 1.485 [--smooth 0.10] [--tmin 0.02]
                        [--sub 0.08] [--steiner 0.07] [--clear 0.08] [--atmosphere atmosphere] [--upstand-patch atmosphere]
                        [--report out.json] [--figure out.png]
zs.npy columns: x, y, z_s, area (from lidkit_surface.py).
"""
import os, sys, json, argparse
from collections import defaultdict
import numpy as np
from scipy.spatial import cKDTree, Delaunay
import shapely
from shapely.geometry import Polygon, MultiPolygon
from shapely.ops import unary_union

KEY_DEC = 7

def key(v): return (round(float(v[0]), KEY_DEC), round(float(v[1]), KEY_DEC), round(float(v[2]), KEY_DEC))
def key2(p): return (round(float(p[0]), KEY_DEC), round(float(p[1]), KEY_DEC))

def load_solids(path):
    """ordered dict name -> np.array (n,3,3)"""
    order, solids, cur, buf = [], {}, None, []
    with open(path) as f:
        for line in f:
            s = line.split()
            if not s: continue
            if s[0] == "solid":
                cur = s[1] if len(s) > 1 else f"solid{len(order)}"; order.append(cur); solids[cur] = []
            elif s[0] == "vertex":
                buf.append((float(s[1]), float(s[2]), float(s[3])))
                if len(buf) == 3: solids[cur].append(buf); buf = []
    return order, {k: np.array(v, float).reshape(-1, 3, 3) for k, v in solids.items()}

def facet_str(t):
    n = np.cross(t[1] - t[0], t[2] - t[0]); L = np.linalg.norm(n); n = n / L if L > 0 else np.array([0.0, 0.0, 1.0])
    return ("  facet normal %.6e %.6e %.6e\n    outer loop\n" % tuple(n) + "".join("      vertex %.9e %.9e %.9e\n" % tuple(v) for v in t) + "    endloop\n  endfacet\n")

def tri_oriented(a, b, c, hint):
    t = np.array([a, b, c], float); n = np.cross(t[1] - t[0], t[2] - t[0])
    return t if np.dot(n, hint) >= 0 else t[[0, 2, 1]]

def audit(facet_lists):
    ec = defaultdict(int)
    for T in facet_lists:
        for t in T:
            for a, b in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
                ka, kb = key(a), key(b); ec[(min(ka, kb), max(ka, kb))] += 1
    return {"open_edges": sum(1 for c in ec.values() if c == 1), "non_manifold_edges": sum(1 for c in ec.values() if c > 2)}

def loops_from_open_edges(T):
    """closed loops (lists of keys) of the open edges of a facet set"""
    ec = defaultdict(int); pts = {}
    for t in T:
        for a, b in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
            ka, kb = key(a), key(b); pts[ka] = a; pts[kb] = b; ec[(min(ka, kb), max(ka, kb))] += 1
    adj = defaultdict(list)
    for (a, b), c in ec.items():
        if c == 1: adj[a].append(b); adj[b].append(a)
    loops, seen = [], set()
    for start in list(adj):
        if start in seen: continue
        loop, prev, cur = [start], None, start
        while True:
            seen.add(cur); nxt = [n for n in adj[cur] if n != prev]
            if not nxt: break
            nxt = nxt[0]
            if nxt == start: break
            loop.append(nxt); prev, cur = cur, nxt
            if len(loop) > len(adj) + 1: raise RuntimeError("loop walk did not close")
        if len(loop) >= 3: loops.append(loop)
    return loops, pts

def signed_area(xy):
    x, y = np.asarray(xy)[:, 0], np.asarray(xy)[:, 1]; return 0.5 * np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y)

class Surface:
    """z_s(x,y) from the lid-face field (x, y, z_s, area); optional Gaussian smoothing (radius R, sigma R/2, area-weighted);
    inverse-distance interpolation on the 6 nearest samples."""
    def __init__(self, npy=None, smooth=0.0, flat=None):
        if flat is not None:
            self.xy = np.array([[0.0, 0.0]]); self.z = np.array([flat]); self.flat = flat; return
        self.flat = None
        d = np.load(npy); self.xy = d[:, :2]; self.z = d[:, 2].copy(); A = d[:, 3]; self.tree = cKDTree(self.xy)
        if smooth > 0:
            zs = np.empty_like(self.z); sig = smooth / 2
            for k, nb in enumerate(self.tree.query_ball_point(self.xy, smooth)):
                nb = np.asarray(nb); w = A[nb] * np.exp(-0.5 * (np.hypot(*(self.xy[nb] - self.xy[k]).T) / sig) ** 2); zs[k] = np.sum(w * self.z[nb]) / w.sum()
            self.z = zs
    def __call__(self, xy):
        xy = np.atleast_2d(np.asarray(xy, float))
        if self.flat is not None: return np.full(len(xy), self.flat)
        dd, ii = self.tree.query(xy, k=min(6, len(self.z))); w = 1.0 / np.maximum(dd, 1e-4) ** 2; return np.sum(w * self.z[ii], axis=1) / w.sum(1)

def subdivide_edge(a, b, maxlen, extra=()):
    """points strictly between a and b: existing 'extra' points on the segment plus uniform fill so that gaps <= maxlen"""
    a, b = np.asarray(a, float), np.asarray(b, float); L = np.hypot(*(b[:2] - a[:2]))
    ts = sorted(set(float(np.dot(np.asarray(p)[:2] - a[:2], b[:2] - a[:2]) / (L * L)) for p in extra if 1e-6 < float(np.dot(np.asarray(p)[:2] - a[:2], b[:2] - a[:2]) / (L * L)) < 1 - 1e-6))
    stations = [0.0] + ts + [1.0]; out = []
    for t0, t1 in zip(stations[:-1], stations[1:]):
        n = max(1, int(np.ceil((t1 - t0) * L / maxlen - 1e-9)))
        for k in range(1, n): out.append(t0 + (t1 - t0) * k / n)
        if t1 < 1.0: out.append(t1)
    return [a + t * (b - a) for t in sorted(set(out))]


# ---------------------------------------------------------------- protruding solids: cut at the fitted lid
def _components_above(T, Z_LID, tol=1e-6):
    """facet-index sets of the connected components (shared vertices) of T that contain a vertex above the lid plane"""
    above = (T[:, :, 2] > Z_LID + tol).any(1)
    if not above.any(): return []
    parent = {}
    def find(a):
        while parent.setdefault(a, a) != a: parent[a] = parent[parent[a]]; a = parent[a]
        return a
    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb: parent[ra] = rb
    vk = [[key(v) for v in t] for t in T]
    for i, ks in enumerate(vk):
        union(("f", i), ks[0]); union(("f", i), ks[1]); union(("f", i), ks[2])
    roots = {}
    for i in range(len(T)): roots.setdefault(find(("f", i)), []).append(i)
    return [np.array(idx) for idx in roots.values() if above[idx].any()]

def _plane_loops(T, z0):
    """closed xy loops (corner-simplified) of the intersection of the facet set T with the plane z = z0"""
    segs = []
    for t in T:
        pts = []
        for i in range(3):
            a, b = t[i], t[(i + 1) % 3]
            if (a[2] - z0) * (b[2] - z0) < 0:
                l = (z0 - a[2]) / (b[2] - a[2]); pts.append(a[:2] + l * (b[:2] - a[:2]))
        if len(pts) == 2 and np.linalg.norm(pts[0] - pts[1]) > 1e-9: segs.append(pts)
    adj = defaultdict(list); P = {}
    for a, b in segs:
        ka, kb = key2(a), key2(b); P[ka] = a; P[kb] = b; adj[ka].append(kb); adj[kb].append(ka)
    loops, seen = [], set()
    for start in list(adj):
        if start in seen: continue
        loop, prev, cur = [start], None, start
        while True:
            seen.add(cur); nxt = [n for n in adj[cur] if n != prev]
            if not nxt: break
            nxt = nxt[0]
            if nxt == start: break
            loop.append(nxt); prev, cur = cur, nxt
            if len(loop) > len(adj) + 1: break
        if len(loop) >= 3 and start in adj[cur]:
            pts = [P[k] for k in loop]
            # drop collinear points (diagonal-edge crossings on a planar face) -> true corners only
            out = list(pts); changed = True
            while changed and len(out) > 3:          # drop points closer than 2e-5 m to the line through their neighbours
                changed = False
                for i in range(len(out)):
                    a, b, c = out[i - 1], out[i], out[(i + 1) % len(out)]; ac = c - a; L = np.linalg.norm(ac)
                    if L > 1e-12 and abs(np.cross(ac, b - a)) / L < 2e-5: out.pop(i); changed = True; break
            if len(out) >= 3: loops.append(np.array(out))
    return loops

def _cross_surface(a, b, z_of, n=40):
    """point on the segment a->b where z crosses the height field z_of(x,y) (bisection; a below, b above or vice versa)"""
    fa = a[2] - z_of(a[:2])[0]; ta, tb = 0.0, 1.0
    for _ in range(n):
        tm = 0.5 * (ta + tb); pm = a + tm * (b - a); fm = pm[2] - z_of(pm[:2])[0]
        if (fm > 0) == (fa > 0): ta, fa = tm, fm
        else: tb = tm
    p = a + 0.5 * (ta + tb) * (b - a); p[2] = z_of(p[:2])[0]; return p

def cut_component(T, idx, z_of, stations_xy, SUB):
    """cut the protruding component T[idx] at the height field: returns (kept facets, list of station xy used, n_dropped, n_cut).
    stations_xy: xy points that MUST be vertices of the cut (footprint corners, planform intersections); more are added so that
    the cut edge is subdivided <= SUB.  Facet edges crossing the surface add their crossing xy as stations too."""
    tol = 1e-9
    comp = T[idx]
    zc = np.array([z_of(t[:, :2]) for t in comp])            # (n,3) surface height at the vertices
    above = comp[:, :, 2] > zc + tol
    n_above = above.sum(1)
    keep = list(comp[n_above == 0]); n_drop = int((n_above == 3).sum())
    crossing = np.where((n_above > 0) & (n_above < 3))[0]
    nrm = np.cross(comp[:, 1] - comp[:, 0], comp[:, 2] - comp[:, 0]); nz = np.abs(nrm[:, 2]) / np.maximum(np.linalg.norm(nrm, axis=1), 1e-30)
    bad = [i for i in crossing if nz[i] > 0.05]
    if bad: raise RuntimeError(f"protruding solid has {len(bad)} NON-VERTICAL facets crossing the fitted lid (only vertical-walled protrusions are supported)")
    # edge crossings (cached per canonical edge -> shared vertices between neighbouring facets)
    xcache = {}
    def xing(a, b):
        ka, kb = key(a), key(b); e = (min(ka, kb), max(ka, kb))
        if e not in xcache: xcache[e] = _cross_surface(a, b, z_of) if ka < kb else _cross_surface(b, a, z_of)
        return xcache[e]
    st = {key2(p): np.asarray(p, float) for p in stations_xy}
    per_facet = []
    for i in crossing:
        t = comp[i]; ab = above[i]; ring = []
        for j in range(3):
            a, b = t[j], t[(j + 1) % 3]
            if not ab[j]: ring.append(("v", a))
            if ab[j] != ab[(j + 1) % 3]: ring.append(("x", xing(a, b)))
        for kind, p in ring:
            if kind == "x": st.setdefault(key2(p), p[:2].copy())
        per_facet.append((i, ring))
    # fill stations along every straight footprint edge so that gaps <= SUB: done by the caller on the loop; here we
    # only make sure each crossing facet's top edge gets the stations lying on its trace between its two crossings
    stations = np.array(list(st.values())) if st else np.zeros((0, 2))
    n_cut = 0
    for i, ring in per_facet:
        t = comp[i]; n0 = nrm[i]
        # trace direction of this vertical facet
        d = None
        for j in range(3):
            v = t[(j + 1) % 3, :2] - t[j, :2]
            if np.linalg.norm(v) > 1e-9: d = v / np.linalg.norm(v); break
        o = t[0, :2]; u = lambda p: float(np.dot(np.asarray(p)[:2] - o, d))
        xs = [k for k, (kind, p) in enumerate(ring) if kind == "x"]
        assert len(xs) == 2, "facet cut is not a single segment"
        A, B = ring[xs[0]][1], ring[xs[1]][1]
        # stations on this trace strictly between A and B (the cut curve passes A -> ... -> B along the above side)
        onl = [p for p in stations if abs(np.cross(d, p - o)) < 1e-6]
        uA, uB = u(A), u(B); lo, hi = min(uA, uB), max(uA, uB)
        mids = sorted([p for p in onl if lo + 1e-9 < u(p) < hi - 1e-9], key=u)
        if uA > uB: mids = mids[::-1]
        # walk: ring order ... A, (mids), B ...  -> insert mids right after A if B follows A cyclically on the above side
        # ring lists below-vertices and crossings in cyclic order; the segment A->B along the surface must connect them
        # in ring order (A is followed by B when the above vertex sits between them in the original triangle)
        kA, kB = xs
        seq = []
        for k in range(len(ring)):
            kind, p = ring[k]; seq.append(p)
            if k == kA and (kB == (kA + 1) % len(ring)):
                seq += [np.array([m[0], m[1], z_of(m)[0]]) for m in mids]
            elif k == kB and (kA == (kB + 1) % len(ring)):
                seq += [np.array([m[0], m[1], z_of(m)[0]]) for m in mids[::-1]]
        # subdivide the cut edge to <= SUB with new stations (also registered for the lid hole)
        seq2 = [seq[0]]
        for k in range(1, len(seq) + 1):
            p_prev, p = seq2[-1], seq[k % len(seq)]
            if k == len(seq): break
            seq2.append(p)
        poly3 = seq2
        # 2D (u, z) triangulation
        P2 = np.array([[u(p), p[2]] for p in poly3]); back = {key2(q): p for q, p in zip(P2, poly3)}
        pg = Polygon(P2)
        if not pg.is_valid or pg.area < 1e-14: continue
        for tri in shapely.get_parts(shapely.constrained_delaunay_triangles(shapely.remove_repeated_points(pg, 1e-12))):
            c = np.array(tri.exterior.coords)[:3]
            q = np.array([back[key2(cc)] for cc in c]); n1 = np.cross(q[1] - q[0], q[2] - q[0])
            if np.linalg.norm(n1) < 1e-16: continue
            keep.append(q if np.dot(n1, n0) > 0 else q[[0, 2, 1]]); n_cut += 1
    return keep, [tuple(p) for p in stations], n_drop, n_cut

def build(base_stl, zs_npy, out_stl, Z_LID, atm="atmosphere", smooth=0.10, T_MIN=0.02, SUB=0.08, STEINER=0.07, CLEAR=0.08,
          upstand_patch="atmosphere", flat=False, report=None, figure=None, zmax_below=0.5, cut=True):
    order, S = load_solids(base_stl)
    assert atm in S, f"no solid '{atm}' in {base_stl}: {order}"
    zs = Surface(zs_npy, smooth) if not flat else Surface(flat=Z_LID)
    rep = {"base_stl": os.path.abspath(base_stl), "zs": None if flat else os.path.abspath(zs_npy), "z_lid": Z_LID, "smooth": smooth, "T_MIN": T_MIN, "SUB": SUB, "STEINER": STEINER, "CLEAR": CLEAR}
    tol = 1e-6
    others = {n: S[n] for n in order if n != atm}
    # ---- horizontal facets of other solids: in the lid plane (fixed roofs) and below it (submerged tops -> T_MIN clamp)
    fixed_keys = set(); sub_tops = []   # (z_top, Polygon)
    for n, T in others.items():
        z = T[:, :, 2]; nrm = np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]); L = np.linalg.norm(nrm, axis=1); horiz = np.abs(nrm[:, 2]) > 0.99 * np.maximum(L, 1e-30)
        in_plane = horiz & (np.abs(z - Z_LID) < tol).all(1)
        for t in T[in_plane]:
            for v in t: fixed_keys.add(key2(v))
        below = horiz & (z.max(1) < Z_LID - tol) & (z.min(1) > Z_LID - zmax_below)
        for t in T[below]:
            p = Polygon(t[:, :2])
            if p.is_valid and p.area > 1e-12: sub_tops.append((float(t[:, 2].mean()), p))
    rep["fixed_lid_plane_vertices"] = len(fixed_keys)
    clamp_polys = {}
    for zt, p in sub_tops: clamp_polys.setdefault(round(zt, 4), []).append(p)
    clamp_polys = {zt: unary_union(ps).buffer(0.5 * STEINER, join_style="mitre") for zt, ps in clamp_polys.items()}   # buffer: lid points ON the footprint edge are clamped too
    rep["submerged_tops"] = {str(zt): float(g.area) for zt, g in clamp_polys.items()}
    n_clamped = [0]; clamped_area = [0.0]
    def z_of(xy):
        """lid height: smoothed z_s, clamped to >= z_top + T_MIN over submerged horizontal tops"""
        xy = np.atleast_2d(np.asarray(xy, float)); z = zs(xy).copy()
        for zt, g in clamp_polys.items():
            inside = shapely.contains_xy(g, xy[:, 0], xy[:, 1]); low = inside & (z < zt + T_MIN)
            n_clamped[0] += int(low.sum()); z[low] = zt + T_MIN
        return z
    # ---- atmosphere planform: loops of the atmosphere open edges
    loops, lp = loops_from_open_edges(S[atm])
    assert loops, "atmosphere has no open edges: cannot find its planform boundary"
    areas = [signed_area([lp[k][:2] for k in lo]) for lo in loops]
    io = int(np.argmax(np.abs(areas))); outer = loops[io]; holes = [lo for i, lo in enumerate(loops) if i != io]
    if areas[io] < 0: outer = outer[::-1]
    holes = [lo[::-1] if signed_area([lp[k][:2] for k in lo]) > 0 else lo for lo in holes]   # holes CW
    rep["planform"] = {"outer_vertices": len(outer), "holes": len(holes), "area_m2": float(abs(areas[io]) - sum(abs(areas[i]) for i in range(len(loops)) if i != io))}
    # ---- protruding solids (cut at the fitted lid): components, footprint loops at the lid plane, planform intersections
    prot = []   # (solid, facet idx array, footprint corner loops)
    if cut:
        for n, T in others.items():
            for idx in _components_above(T, Z_LID):
                fl = _plane_loops(T[idx], Z_LID)
                if not fl: print(f"  WARNING: protruding component in '{n}' ({len(idx)} facets) has no closed footprint at z={Z_LID}: left uncut"); continue
                prot.append((n, idx, fl))
    P0 = Polygon([lp[k][:2] for k in outer], holes=[[lp[k][:2] for k in h] for h in holes])
    extra_on_edge = defaultdict(list)          # original loop edge -> extra split points (footprint x planform boundary)
    foot_polys, foot_stations = [], []         # per component: shapely polygon (from corners) and its required station xy
    for n, idx, fl in prot:
        for loop in fl:
            fp = Polygon(loop)
            if not fp.is_valid: fp = fp.buffer(0)
            X = P0.boundary.intersection(fp.boundary)
            pts = [np.array(g.coords[0]) for g in shapely.get_parts(X) if g.geom_type == "Point"]
            for p in pts:
                for lo in [outer] + holes:
                    for i in range(len(lo)):
                        a, b = lp[lo[i]][:2], lp[lo[(i + 1) % len(lo)]][:2]
                        if shapely.LineString([a, b]).distance(shapely.Point(p)) < 1e-7:
                            extra_on_edge[(min(lo[i], lo[(i + 1) % len(lo)]), max(lo[i], lo[(i + 1) % len(lo)]))].append(np.array([p[0], p[1], Z_LID]))
            foot_polys.append(fp); foot_stations.append([tuple(q) for q in loop] + [tuple(p) for p in pts])
    rep["protruding_components"] = [{"solid": n, "facets": int(len(idx)), "footprint_area_m2": float(sum(Polygon(l).area for l in fl))} for n, idx, fl in prot]
    # ---- all other-solid vertices in the lid plane (T-junction candidates on loop edges)
    plane_pts = {}
    for n, T in others.items():
        for t in T:
            for v in t:
                if abs(v[2] - Z_LID) < tol: plane_pts[key2(v)] = np.array([v[0], v[1], Z_LID])
    plane_xy = np.array(list(plane_pts.values())) if plane_pts else np.zeros((0, 3))
    ptree = cKDTree(plane_xy[:, :2]) if len(plane_xy) else None
    # ---- subdivide loop edges (incl. existing T-junction points), record split points per original edge
    splits = {}   # (ka,kb) sorted key pair -> list of 3D points (z = Z_LID) in order from ka to kb
    new_loops = []
    for lo in [outer] + holes:
        nl = []
        for i in range(len(lo)):
            ka, kb = lo[i], lo[(i + 1) % len(lo)]; a, b = lp[ka], lp[kb]
            extra = []
            if ptree is not None:
                mid = (a[:2] + b[:2]) / 2; L = np.hypot(*(b[:2] - a[:2]))
                for j in ptree.query_ball_point(mid, L / 2 + 1e-6):
                    p = plane_xy[j]; d = b[:2] - a[:2]; t = np.dot(p[:2] - a[:2], d) / (L * L)
                    if 1e-6 < t < 1 - 1e-6 and abs(np.cross(d, p[:2] - a[:2])) / L < 1e-6: extra.append(p)
            e = (min(ka, kb), max(ka, kb)); extra = extra + extra_on_edge.get(e, [])
            pts = subdivide_edge(np.array([a[0], a[1], Z_LID]), np.array([b[0], b[1], Z_LID]), SUB, extra)
            splits[e] = pts if ka < kb else pts[::-1]
            nl.append(np.array([a[0], a[1], Z_LID])); nl += pts
        new_loops.append(nl)
    rep["planform"]["outer_vertices_subdivided"] = len(new_loops[0])
    # ---- fixed / movable for every loop point (original or inserted)
    def is_fixed_pt(p, ka=None, kb=None):
        k2 = key2(p)
        if k2 in fixed_keys: return True
        if ka is not None:   # inserted point: fixed only when BOTH ends of the original edge are fixed (roof edge)
            return key2(lp[ka]) in fixed_keys and key2(lp[kb]) in fixed_keys
        return False
    fixed_of = {}
    for lo in [outer] + holes:
        for i in range(len(lo)):
            ka, kb = lo[i], lo[(i + 1) % len(lo)]
            fixed_of[key2(lp[ka])] = is_fixed_pt(lp[ka])
            e = (min(ka, kb), max(ka, kb))
            for p in splits[e]: fixed_of[key2(p)] = is_fixed_pt(p, ka, kb)
    # ---- split other-solid facets sharing a subdivided loop edge, then move movable lid-plane vertices to z_s
    def zmov(p):
        return float(z_of(p[:2])[0])
    new_others = {}; n_split = 0; n_moved = 0
    for n, T in others.items():
        outT = []
        for t in T:
            ks = [key(v) for v in t]; pieces = [t]
            for i in range(3):
                e = (min(ks[i], ks[(i + 1) % 3]), max(ks[i], ks[(i + 1) % 3]))
                if e in splits and splits[e]:
                    pts = splits[e] if ks[i] < ks[(i + 1) % 3] else splits[e][::-1]
                    c = t[(i + 2) % 3]; chain = [t[i]] + list(pts) + [t[(i + 1) % 3]]
                    pieces = [np.array([c, chain[j], chain[j + 1]]) for j in range(len(chain) - 1)]; n_split += 1
                    break   # a facet shares at most one lid-boundary edge in practice
            for q in pieces:
                q = q.copy()
                for j in range(3):
                    if abs(q[j, 2] - Z_LID) < tol and not fixed_of.get(key2(q[j]), key2(q[j]) in fixed_keys):
                        q[j, 2] = zmov(q[j]); n_moved += 1
                if np.linalg.norm(np.cross(q[1] - q[0], q[2] - q[0])) > 1e-14: outT.append(q)
        new_others[n] = outT
    rep["facets_split"] = n_split; rep["vertices_moved"] = n_moved
    # ---- cut the protruding components at the fitted lid; their (subdivided) footprints become lid holes
    hole_rings = []; n_drop_tot = n_cut_tot = 0
    for (n, idx, fl), fp, stn in zip(prot, foot_polys, foot_stations):
        # stations along the footprint: corners + planform intersections + fill <= SUB (ordered along the corner loop)
        loop = fl[0]; ordered = []
        for i in range(len(loop)):
            a, b = loop[i], loop[(i + 1) % len(loop)]
            on = [np.array(p) for p in stn if shapely.LineString([a, b]).distance(shapely.Point(p)) < 1e-7 and np.linalg.norm(np.array(p) - a) > 1e-9 and np.linalg.norm(np.array(p) - b) > 1e-9]
            ordered.append(a); ordered += [q[:2] for q in subdivide_edge(np.array([a[0], a[1], 0.0]), np.array([b[0], b[1], 0.0]), SUB, [np.array([p[0], p[1], 0.0]) for p in on])]
        kept, used, nd, nc = cut_component(others[n], idx, z_of, ordered, SUB)
        # the component's crossing points became stations too -> final hole ring = all stations ordered along the loop
        allst = {key2(p): np.array(p[:2]) for p in ordered}; allst.update({key2(p): np.array(p) for p in used})
        ring = []
        for i in range(len(loop)):
            a, b = loop[i], loop[(i + 1) % len(loop)]; d = b - a; L2 = float(np.dot(d, d))
            seg = [p for p in allst.values() if shapely.LineString([a, b]).distance(shapely.Point(p)) < 1e-7]
            seg = sorted(seg, key=lambda p: float(np.dot(p - a, d)) / L2); ring += [p for p in seg if np.linalg.norm(p - b) > 1e-9]
        hole_rings.append(np.array(ring))
        rest = [t for j, t in enumerate(others[n]) if j not in set(idx.tolist())]
        # the component facets were already processed in new_others (split/move don't touch them: no vertex on the lid plane) -> replace
        comp_keys = set(key(v) for j in idx for v in others[n][j])
        new_others[n] = [t for t in new_others[n] if not all(key(v) in comp_keys for v in t)] + kept
        n_drop_tot += nd; n_cut_tot += nc
        print(f"  cut '{n}' component: {len(idx)} facets -> {len(kept)} kept ({nd} dropped above the lid, {nc} new cut facets), hole ring {len(ring)} stations")
    rep["cut"] = {"components": len(prot), "facets_dropped": n_drop_tot, "facets_cut": n_cut_tot, "hole_ring_points": [int(len(r)) for r in hole_rings]}
    # ---- lid triangulation (conformal Delaunay with Steiner points)
    rings2d = [[(float(p[0]), float(p[1])) for p in lo] for lo in new_loops]
    L = Polygon(rings2d[0], holes=rings2d[1:]); assert L.is_valid, shapely.is_valid_reason(L)
    for ring in hole_rings:
        L = L.difference(Polygon([tuple(p) for p in ring]))
        assert L.geom_type == "Polygon" and L.is_valid, f"lid minus footprint: {L.geom_type} {shapely.is_valid_reason(L)}"
    # final loops = the rings of L (outer + holes); every vertex must be a known planform point or a station
    known = {key2(p): np.array([p[0], p[1], Z_LID]) for lo in new_loops for p in lo}
    for ring in hole_rings:
        for p in ring: known[key2(p)] = np.array([p[0], p[1], Z_LID]); fixed_of[key2(p)] = False
    def ring_pts(coords):
        out, last = [], None
        for c in coords[:-1]:
            k2 = key2(c); assert k2 in known, f"lid polygon vertex {c} is neither a planform point nor a station"
            if k2 == last: continue
            out.append(known[k2]); last = k2
        if len(out) > 1 and key2(out[0]) == key2(out[-1]): out.pop()
        return out
    ext = ring_pts(list(L.exterior.coords)); 
    if signed_area([p[:2] for p in ext]) < 0: ext = ext[::-1]
    ints = [ring_pts(list(i.coords)) for i in L.interiors]
    ints = [r[::-1] if signed_area([p[:2] for p in r]) > 0 else r for r in ints]
    new_loops = [ext] + ints
    bpts, _seen = [], set()
    for lo in new_loops:
        for p in lo:
            if key2(p) not in _seen: _seen.add(key2(p)); bpts.append(p)
    B2 = np.array([[p[0], p[1]] for p in bpts])
    xmin, ymin, xmax, ymax = L.bounds
    gx = np.arange(xmin, xmax + 1e-9, STEINER); gy = np.arange(ymin, ymax + 1e-9, STEINER); GX, GY = np.meshgrid(gx, gy)
    G = np.c_[GX.ravel(), GY.ravel()]; G = G[shapely.contains_xy(L, G[:, 0], G[:, 1])]
    G = G[shapely.distance(L.boundary, shapely.points(G)) > CLEAR]
    idx = {key2(p): k for k, p in enumerate(bpts)}
    req = set()
    for lo in new_loops:
        ids = [idx[key2(p)] for p in lo]
        for k in range(len(ids)): req.add((min(ids[k], ids[(k + 1) % len(ids)]), max(ids[k], ids[(k + 1) % len(ids)])))
    for attempt in range(4):
        P2 = np.vstack([B2, G]) if len(G) else B2
        tri = Delaunay(P2); q = P2[tri.simplices]; cen = q.mean(1)
        a2 = np.abs((q[:, 1, 0] - q[:, 0, 0]) * (q[:, 2, 1] - q[:, 0, 1]) - (q[:, 2, 0] - q[:, 0, 0]) * (q[:, 1, 1] - q[:, 0, 1]))
        Ssel = tri.simplices[shapely.contains_xy(L, cen[:, 0], cen[:, 1]) & (a2 > 1e-12)]
        edges = set((min(a, b), max(a, b)) for s in Ssel for a, b in ((s[0], s[1]), (s[1], s[2]), (s[2], s[0])))
        missing = [e for e in req if e not in edges]
        if not missing: break
        # drop Steiner points near the missing edges and retry
        segs = [shapely.LineString([B2[a], B2[b]]) for a, b in missing]
        d = np.min([shapely.distance(s, shapely.points(G)) for s in segs], axis=0) if len(G) else np.zeros(0)
        G = G[d > 1.5 * CLEAR]
    else:
        from scipy.spatial import cKDTree as _T
        _t = _T(B2); info = []
        for a, b in missing:
            L_ = float(np.linalg.norm(B2[a] - B2[b])); dn = [_t.query(B2[q], k=2)[0][1] for q in (a, b)]
            info.append(f"edge {B2[a].round(5).tolist()} -> {B2[b].round(5).tolist()} len {L_:.2e}, nearest other pts {dn[0]:.2e}/{dn[1]:.2e}")
        raise RuntimeError("lid triangulation not conformal after retries: %d boundary edges missing:\n  " % len(missing) + "\n  ".join(info))
    rep["lid"] = {"boundary_points": len(bpts), "steiner_points": int(len(G)), "faces": int(len(Ssel)), "attempts": attempt + 1}
    Z = z_of(P2)
    lid = [tri_oriented((*P2[a], Z[a]), (*P2[b], Z[b]), (*P2[c], Z[c]), (0, 0, 1)) for a, b, c in Ssel]
    # ---- upstands / closing triangles along loop edges whose solid side is not at the lid height
    upst = []
    for lo, ring in zip([outer] + holes, new_loops):
        m = len(ring)
        for i in range(m):
            u, v = ring[i], ring[(i + 1) % m]; zu, zv = float(z_of(u[:2])[0]), float(z_of(v[:2])[0])
            Hu = Z_LID if fixed_of[key2(u)] else zu; Hv = Z_LID if fixed_of[key2(v)] else zv
            if abs(Hu - zu) < 1e-9 and abs(Hv - zv) < 1e-9: continue
            poly = [(u[0], u[1], zu), (v[0], v[1], zv), (v[0], v[1], Hv), (u[0], u[1], Hu)]
            poly = [p for k, p in enumerate(poly) if k == 0 or np.linalg.norm(np.subtract(p, poly[k - 1])) > 1e-9]
            if len(poly) >= 3 and np.linalg.norm(np.subtract(poly[0], poly[-1])) < 1e-9: poly = poly[:-1]
            d = v[:2] - u[:2]; hint = (d[1], -d[0], 0.0)   # outward of a CCW outer loop (inward of a CW hole = away from the fluid)
            for k in range(1, len(poly) - 1):
                t = tri_oriented(poly[0], poly[k], poly[k + 1], hint)
                if np.linalg.norm(np.cross(t[1] - t[0], t[2] - t[0])) > 1e-14: upst.append(t)
    rep["upstand_facets"] = len(upst)
    # ---- assemble
    out = {n: new_others[n] for n in order if n != atm}; out[atm] = lid
    if upst:
        out.setdefault(upstand_patch, []); out[upstand_patch] = list(out[upstand_patch]) + upst
        if upstand_patch not in order: order = order + [upstand_patch]
    with open(out_stl, "w") as f:
        for n in order:
            f.write(f"solid {n}\n"); f.writelines(facet_str(t) for t in out[n]); f.write(f"endsolid {n}\n")
    rep["facets"] = {n: len(out[n]) for n in order}
    rep["clamped_lid_points"] = n_clamped[0]
    zl = np.array([t[:, 2] for t in lid]).ravel()
    rep["lid_z_vs_Z_LID_mm"] = {"min": float((zl.min() - Z_LID) * 1000), "max": float((zl.max() - Z_LID) * 1000), "mean": float((zl.mean() - Z_LID) * 1000)}
    rep["audit_all"] = audit([out[n] for n in order]); rep["audit_base_all"] = audit([S[n] for n in S])
    touched = [n for n in others if len(new_others[n]) != len(others[n]) or n == upstand_patch]      # solids the fit modified
    rep["audit_lid_plus_touched_solids"] = audit([out[atm]] + [out[n] for n in touched]); rep["touched_solids"] = touched
    print(json.dumps(rep, indent=1)); print("wrote", out_stl)
    if report: json.dump(rep, open(report, "w"), indent=1)
    if figure: draw_figure(out, atm, Z_LID, figure, upst)
    return rep

def draw_figure(out, atm, Z_LID, png, upst):
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    from matplotlib.collections import PolyCollection
    lid = np.array(out[atm]); fig, ax = plt.subplots(1, 2, figsize=(17, 8))
    pc = PolyCollection(lid[:, :, :2], array=(lid[:, :, 2].mean(1) - Z_LID) * 1000, cmap="viridis", edgecolors="none"); ax[0].add_collection(pc)
    ax[0].autoscale(); ax[0].set_aspect("equal"); fig.colorbar(pc, ax=ax[0], label="lid height vs Z_LID [mm]", shrink=0.8); ax[0].set_title(f"fitted lid: {len(lid)} faces")
    for n, T in out.items():
        if n == atm or not len(T): continue
        T = np.array(T); top = T[(T[:, :, 2].max(1) > Z_LID - 0.3)]
        if len(top): ax[1].add_collection(PolyCollection(top[:, :, :2], facecolors="none", edgecolors="k", linewidths=0.2))
    ax[1].add_collection(PolyCollection(lid[:, :, :2], facecolors="none", edgecolors="tab:blue", linewidths=0.15))
    if upst: ax[1].add_collection(PolyCollection(np.array(upst)[:, :, :2], facecolors="none", edgecolors="r", linewidths=1.0))
    ax[1].autoscale(); ax[1].set_aspect("equal"); ax[1].set_title("lid triangulation (blue), other solids near the lid (black), upstands (red)")
    plt.tight_layout(); plt.savefig(png, dpi=110); print("wrote", png)

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("base_stl", help="ORIGINAL flat-lid domain STL (multi-solid ASCII)"); ap.add_argument("out_stl")
    ap.add_argument("--zs", default=None, help="zs.npy (x, y, z_s, area) from lidkit_surface.py")
    ap.add_argument("--flat", action="store_true", help="regression test: z_s = Z_LID everywhere (reproduces the flat domain)")
    ap.add_argument("--z-lid", type=float, required=True); ap.add_argument("--atmosphere", default="atmosphere"); ap.add_argument("--upstand-patch", default="atmosphere")
    ap.add_argument("--smooth", type=float, default=0.10); ap.add_argument("--tmin", type=float, default=0.02)
    ap.add_argument("--sub", type=float, default=0.08); ap.add_argument("--steiner", type=float, default=0.07); ap.add_argument("--clear", type=float, default=0.08)
    ap.add_argument("--report", default=None); ap.add_argument("--figure", default=None)
    ap.add_argument("--no-cut", action="store_true", help="do not cut protruding solids at the lid (old behaviour)")
    a = ap.parse_args()
    assert a.flat or a.zs, "give --zs zs.npy or --flat"
    build(a.base_stl, a.zs, a.out_stl, a.z_lid, a.atmosphere, a.smooth, a.tmin, a.sub, a.steiner, a.clear, a.upstand_patch, flat=a.flat, report=a.report, figure=a.figure, cut=not a.no_cut)

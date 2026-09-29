#!/usr/bin/env python3
"""
lidkit.py — LID ITERATION KIT driver: free surface for a rigid-lid simpleFoam chamber model by remeshing the lid.

  iteration 0  = the converged flat-lid PARENT run (any BC family: flowRate inlet + p outlet, or totalPressure inlet)
  step k -> k+1:
    surface  z_s = Z_LID + (p_lid - p0_inlet)/g  from iteration k's lidSurfaces export      (lidkit_surface.py)
    fit      base flat STL -> STL with the atmosphere fitted to z_s (walls follow, roof upstand, T_MIN over submerged tops)
                                                                                                 (lidkit_fitlid.py)
    mesh     mesh dir <mesh_root><k+1>: template system/ + meshDict, surfaceFeatureEdges 45 deg, cartesianMesh, checkMesh;
             gate: no negative volumes (optionally improveMeshQuality, then re-check)
    case     <work_dir>/iter<k+1>: clone of the parent case (0.orig, system, constant/*Properties*), kit Allrun,
             system/lidSurfaces with the config patch names
    run      Allrun (renumber, potentialFoam, decompose, simpleFoam, reconstruct, lidSurfaces export), detached
  converged when the lid residual RMS |z_s(new) - z_lid(mesh)| < tol_rms_mm (typically 2 iterations: 34 -> 5 -> 2.6 mm).

usage:
  lidkit.py init  <config.json>            write a config template
  lidkit.py check <config.json>            validate paths, patch names, parent export
  lidkit.py surface <cfg> <k>              z_s from iteration k (0 = parent) -> work_dir/zs_iter<k>.{npy,json}
  lidkit.py fit     <cfg> <k>              STL for iteration k+1 from zs_iter<k>  -> work_dir/geometry/domain_lidIter<k+1>.stl
  lidkit.py mesh    <cfg> <k+1>            build + check the mesh of iteration k+1 (blocking, minutes)
  lidkit.py case    <cfg> <k+1>            set up the case directory of iteration k+1
  lidkit.py run     <cfg> <k+1>            launch Allrun detached
  lidkit.py next    <cfg> <k>              surface -> fit -> mesh -> case -> run for k -> k+1 (detached chain)
  lidkit.py loop    <cfg> [k0]             next, wait, surface, ... until converged or max_iter (detached)
  lidkit.py status  <cfg>                  table of iterations
  lidkit.py post    <cfg> <k>              figure + json for iteration k (lidkit_post.py)
"""
import os, sys, json, glob, shutil, subprocess, re, time
HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable

def load(cfg_path):
    c = json.load(open(cfg_path)); c["_path"] = os.path.abspath(cfg_path)
    for k in ("base_stl", "parent_case", "mesh_template", "work_dir", "mesh_root"):
        c[k] = os.path.abspath(os.path.expanduser(c[k]))
    return c

def sh(cmd, log=None, cwd=None, bashrc=None):
    full = (f"source {bashrc}; " if bashrc else "") + cmd
    if log: full += f" > {log} 2>&1"
    r = subprocess.run(["bash", "-c", full], cwd=cwd)
    return r.returncode

def latest_time_dir(path):
    ds = [d for d in glob.glob(os.path.join(path, "*")) if os.path.isdir(d) and re.fullmatch(r"[0-9.eE+-]+", os.path.basename(d))]
    return max(ds, key=lambda d: float(os.path.basename(d))) if ds else None

def case_dir(c, k): return c["parent_case"] if k == 0 else os.path.join(c["work_dir"], f"iter{k}")
def mesh_dir(c, k): return c["mesh_root"] + str(k)
def stl_path(c, k): return os.path.join(c["work_dir"], "geometry", f"domain_lidIter{k}.stl")

# ------------------------------------------------------------------------------------------------ steps
def cmd_init(path):
    shutil.copy(os.path.join(HERE, "templates", "config_template.json"), path); print("wrote", path, "- edit the paths, then: lidkit.py check", path)

def cmd_check(c):
    ok = True
    def chk(cond, msg):
        nonlocal ok; print(("  ok   " if cond else "  FAIL ") + msg); ok &= bool(cond)
    chk(os.path.isfile(c["base_stl"]), f"base_stl {c['base_stl']}")
    names = [l.split()[1] for l in open(c["base_stl"]) if l.startswith("solid")] if os.path.isfile(c["base_stl"]) else []
    chk(c["atmosphere_patch"] in names, f"atmosphere patch '{c['atmosphere_patch']}' in the STL solids {names}")
    chk(c["inlet_patch"] in names, f"inlet patch '{c['inlet_patch']}' in the STL solids")
    chk(os.path.isdir(os.path.join(c["parent_case"], "0.orig")) and os.path.isdir(os.path.join(c["parent_case"], "system")), f"parent case {c['parent_case']} has 0.orig + system")
    t = latest_time_dir(c["parent_case"]); chk(t is not None and float(os.path.basename(t)) > 0, f"parent case has a converged time dir ({t})")
    ls = glob.glob(os.path.join(c["parent_case"], "postProcessing", "lidSurfaces", "*", "lid.vtk"))
    print(("  ok   " if ls else "  note ") + f"parent lidSurfaces export {'present' if ls else 'missing -> lidkit.py surface 0 will run postProcess -func lidSurfaces in the parent'}")
    for f in ("controlDict", "fvSchemes", "fvSolution", "meshDict"): chk(os.path.isfile(os.path.join(c["mesh_template"], "system", f)), f"mesh_template system/{f}")
    chk(os.path.isfile(c["openfoam_bashrc"]), f"OpenFOAM bashrc {c['openfoam_bashrc']}")
    print("CONFIG OK" if ok else "CONFIG HAS ERRORS"); return ok

def ensure_lidsurfaces(c, case):
    f = os.path.join(case, "system", "lidSurfaces")
    if not os.path.isfile(f):
        t = open(os.path.join(HERE, "templates", "lidSurfaces")).read().replace("@ATMOSPHERE@", c["atmosphere_patch"]).replace("@INLET@", c["inlet_patch"])
        open(f, "w").write(t); print("  wrote", f)

def cmd_surface(c, k):
    case = case_dir(c, k); os.makedirs(c["work_dir"], exist_ok=True)
    exps = glob.glob(os.path.join(case, "postProcessing", "lidSurfaces", "*", "lid.vtk"))
    if not exps:
        ensure_lidsurfaces(c, case); t = latest_time_dir(case)
        print(f"  exporting the lid of {case} @ {os.path.basename(t)} (postProcess -func lidSurfaces)")
        sh(f"postProcess -func lidSurfaces -time {os.path.basename(t)}", log=os.path.join(case, "log.postProcess.lidSurfaces"), cwd=case, bashrc=c["openfoam_bashrc"])
        exps = glob.glob(os.path.join(case, "postProcessing", "lidSurfaces", "*", "lid.vtk")); assert exps, "lid export failed (see log.postProcess.lidSurfaces)"
    d = os.path.dirname(max(exps, key=lambda p: float(p.split("/")[-2])))
    out = os.path.join(c["work_dir"], f"zs_iter{k}.npy")
    args = [PY, os.path.join(HERE, "lidkit_surface.py"), d, out, "--z-lid", str(c["z_lid"])]
    if c.get("axis"): args += ["--axis=" + ",".join(map(str, c["axis"])), "--rings=" + ",".join(f"{a}:{b}" for a, b in c.get("rings", []))]   # '=' form: negative numbers
    if c.get("datum_y") is not None: args += ["--datum-y=" + str(c["datum_y"])]
    r = subprocess.run(args, stdout=open(out.replace(".npy", ".log"), "w"), stderr=subprocess.STDOUT); assert r.returncode == 0, open(out.replace(".npy", ".log")).read()[-2000:]
    j = json.load(open(out.replace(".npy", ".json"))); print(f"  iter{k}: z_s vs Z_LID mean {j['zs_vs_Z_LID_mm']['mean']:.1f} / min {j['zs_vs_Z_LID_mm']['min']:.1f} mm; lid residual RMS {j['lid_residual_mm']['rms']:.1f} mm (max {j['lid_residual_mm']['max_abs']:.0f})")
    return j

def cmd_fit(c, k):
    n = k + 1; os.makedirs(os.path.dirname(stl_path(c, n)), exist_ok=True)
    zs = os.path.join(c["work_dir"], f"zs_iter{k}.npy"); assert os.path.isfile(zs), f"run 'surface {k}' first ({zs})"
    rep = stl_path(c, n).replace(".stl", ".json"); fig = stl_path(c, n).replace(".stl", ".png")
    args = [PY, os.path.join(HERE, "lidkit_fitlid.py"), c["base_stl"], stl_path(c, n), "--zs", zs, "--z-lid", str(c["z_lid"]), "--atmosphere", c["atmosphere_patch"],
            "--upstand-patch", c.get("upstand_patch", "atmosphere"), "--smooth", str(c["smooth"]), "--tmin", str(c["tmin"]), "--sub", str(c["sub"]), "--steiner", str(c["steiner"]), "--clear", str(c["clear"]), "--report", rep, "--figure", fig] + ([] if c.get("cut", True) else ["--no-cut"])
    log = stl_path(c, n).replace(".stl", ".log"); r = subprocess.run(args, stdout=open(log, "w"), stderr=subprocess.STDOUT); assert r.returncode == 0, open(log).read()[-3000:]
    j = json.load(open(rep)); cut = j.get("cut", {}); print(f"  iter{n} STL: lid {j['lid']['faces']} faces, z {j['lid_z_vs_Z_LID_mm']['min']:.0f}..{j['lid_z_vs_Z_LID_mm']['max']:.0f} mm, clamped points {j['clamped_lid_points']}, upstands {j['upstand_facets']}, cut solids {cut.get('components', 0)} ({cut.get('facets_cut', 0)} cut facets), audit open/non-manifold {j['audit_all']['open_edges']}/{j['audit_all']['non_manifold_edges']} (base {j['audit_base_all']['open_edges']}/{j['audit_base_all']['non_manifold_edges']})")
    if j["audit_all"]["open_edges"] > j["audit_base_all"]["open_edges"] and not cut.get("components"):
        raise AssertionError("the fitted STL has MORE open edges than the base — inspect the report")
    if cut.get("components"): print("  note: open edges above the base count are expected = the cut tops of the protruding solids OUTSIDE the fluid (check the report / figure)")
    return j

def mesh_quality(log):
    s = open(log).read() if os.path.isfile(log) else ""
    g = lambda rx: (re.search(rx, s).group(1) if re.search(rx, s) else None)
    return {"cells": g(r"cells:\s+(\d+)"), "regions": g(r"Number of regions: (\d+)"), "negative": bool(re.search(r"negative", s, re.I)), "skew": g(r"Max skewness = ([\d.]+)"),
            "nonOrthoMax": g(r"non-orthogonality Max: ([\d.]+)"), "failed": g(r"Failed (\d+) mesh checks"), "ok": "Mesh OK" in s}

def cmd_mesh(c, n):
    M = mesh_dir(c, n); os.makedirs(os.path.join(M, "system"), exist_ok=True); os.makedirs(os.path.join(M, "constant", "triSurface"), exist_ok=True)
    for f in ("controlDict", "fvSchemes", "fvSolution", "meshDict"): shutil.copy(os.path.join(c["mesh_template"], "system", f), os.path.join(M, "system", f))
    shutil.copy(os.path.join(M, "system", "meshDict"), os.path.join(M, "meshDict")); shutil.copy(stl_path(c, n), os.path.join(M, "constant", "triSurface", "domain.stl"))
    open(os.path.join(M, "open.foam"), "w").close()
    for f in glob.glob(os.path.join(M, "log.*")): os.remove(f)
    shutil.rmtree(os.path.join(M, "constant", "polyMesh"), ignore_errors=True)
    print(f"  meshing iter{n} in {M} ...", flush=True); t0 = time.time()
    sh("surfaceFeatureEdges -angle 45 constant/triSurface/domain.stl constant/triSurface/domain.fms", log="log.surfaceFeatureEdges", cwd=M, bashrc=c["openfoam_bashrc"])
    sh("cartesianMesh", log="log.cartesianMesh", cwd=M, bashrc=c["openfoam_bashrc"]); sh("checkMesh", log="log.checkMesh", cwd=M, bashrc=c["openfoam_bashrc"])
    q = mesh_quality(os.path.join(M, "log.checkMesh")); print(f"  mesh: {q} ({time.time()-t0:.0f} s)")
    if q["negative"] and c.get("improve_mesh_on_fail", True):
        print("  negative volumes -> improveMeshQuality + checkMesh", flush=True)
        shutil.copytree(os.path.join(M, "constant", "polyMesh"), os.path.join(M, "constant", "polyMesh.beforeImprove"), dirs_exist_ok=True); shutil.rmtree(os.path.join(M, "constant", "polyMesh", "sets"), ignore_errors=True)
        sh("improveMeshQuality", log="log.improveMeshQuality", cwd=M, bashrc=c["openfoam_bashrc"]); sh("checkMesh", log="log.checkMesh", cwd=M, bashrc=c["openfoam_bashrc"])
        q = mesh_quality(os.path.join(M, "log.checkMesh")); print(f"  mesh after improve: {q}")
    open(os.path.join(M, "log.checkMesh"), "a").write("\nMESH DONE\n")
    assert q["cells"] and not q["negative"], "MESH GATE FAILED (no cells or negative volumes) — stop"
    return q

def cmd_case(c, n):
    P, C = c["parent_case"], case_dir(c, n); os.makedirs(C, exist_ok=True)
    for d in ("0.orig", "system"):
        shutil.rmtree(os.path.join(C, d), ignore_errors=True); shutil.copytree(os.path.join(P, d), os.path.join(C, d))
    os.makedirs(os.path.join(C, "constant"), exist_ok=True)
    for f in glob.glob(os.path.join(P, "constant", "*")):
        if os.path.isfile(f): shutil.copy(f, os.path.join(C, "constant", os.path.basename(f)))
    for f in ("plotConvergence.py", "plotPdrop.py", "Allclean.sh"):
        if os.path.isfile(os.path.join(P, f)): shutil.copy(os.path.join(P, f), C)
    shutil.copy(os.path.join(HERE, "templates", "Allrun.sh"), os.path.join(C, "Allrun.sh")); os.chmod(os.path.join(C, "Allrun.sh"), 0o755)
    ensure_lidsurfaces(c, C); open(os.path.join(C, f"{c['name']}_iter{n}.foam"), "w").close()
    cd = os.path.join(C, "system", "controlDict"); s = open(cd).read()
    s = re.sub(r"^stopAt\s+\w+;", "stopAt          endTime;", s, flags=re.M); open(cd, "w").write(s)
    open(os.path.join(C, "README_lidkit.md"), "w").write(f"# {c['name']} — lid iteration {n} (LID ITERATION KIT)\n\nCase cloned from `{P}` (0.orig, system, constant), mesh `{mesh_dir(c, n)}`, geometry `{stl_path(c, n)}` fitted to `zs_iter{n-1}`.\nRun: `MESHSRC={mesh_dir(c, n)}/constant/polyMesh ./Allrun.sh`. Config: `{c['_path']}`.\n")
    print(f"  case iter{n} set up in {C}")

def cmd_run(c, n):
    C, M = case_dir(c, n), mesh_dir(c, n)
    chain = os.path.join(C, "Allrun_lidkit.sh")
    open(chain, "w").write(f"#!/bin/bash\ncd {C} && source {c['openfoam_bashrc']} && MESHSRC={M}/constant/polyMesh ./Allrun.sh\n"); os.chmod(chain, 0o755)
    subprocess.Popen(["setsid", "nohup", chain], stdout=open(os.path.join(C, "log.Allrun"), "w"), stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
    print(f"  iter{n} run launched (log {C}/log.Allrun)")

def running(C):
    return os.path.isfile(os.path.join(C, "log.Allrun")) and "Done." not in open(os.path.join(C, "log.Allrun")).read()

def wait_done(C, poll=60):
    while running(C): time.sleep(poll)

def cmd_next(c, k):
    cmd_surface(c, k); cmd_fit(c, k); cmd_mesh(c, k + 1); cmd_case(c, k + 1); cmd_run(c, k + 1)

def cmd_loop(c, k0):
    """detached: for k = k0..: surface(k) -> converged? stop : fit/mesh/case/run(k+1), wait, repeat"""
    script = os.path.join(c["work_dir"], "lidkit_loop.sh"); os.makedirs(c["work_dir"], exist_ok=True)
    open(script, "w").write(f"""#!/bin/bash
# LID ITERATION KIT loop (detached). Stops when the residual RMS < {c['tol_rms_mm']} mm or after iteration {c['max_iter']}.
cd {c['work_dir']}
for k in $(seq {k0} {c['max_iter']}); do
  {PY} {os.path.join(HERE, 'lidkit.py')} surface {c['_path']} $k || exit 1
  rms=$({PY} -c "import json; print(json.load(open('{c['work_dir']}/zs_iter'\"$k\"'.json'))['lid_residual_mm']['rms'])")
  echo "iter $k: lid residual RMS $rms mm"
  if {PY} -c "import sys; sys.exit(0 if float('$rms') < {c['tol_rms_mm']} else 1)"; then echo "CONVERGED at iteration $k (RMS $rms mm < {c['tol_rms_mm']})"; exit 0; fi
  [ $k -ge {c['max_iter']} ] && {{ echo "max_iter {c['max_iter']} reached (RMS $rms mm)"; exit 0; }}
  n=$((k+1))
  {PY} {os.path.join(HERE, 'lidkit.py')} fit {c['_path']} $k || exit 1
  {PY} {os.path.join(HERE, 'lidkit.py')} mesh {c['_path']} $n || exit 1
  {PY} {os.path.join(HERE, 'lidkit.py')} case {c['_path']} $n || exit 1
  cd {c['work_dir']}/iter$n && source {c['openfoam_bashrc']} && MESHSRC={c['mesh_root']}$n/constant/polyMesh ./Allrun.sh > log.Allrun 2>&1; cd {c['work_dir']}
  grep -q "^Done" {c['work_dir']}/iter$n/log.Allrun || {{ echo "iter $n run did not finish (see iter$n/log.Allrun)"; exit 1; }}
  {PY} {os.path.join(HERE, 'lidkit.py')} post {c['_path']} $n || true
done
""")
    os.chmod(script, 0o755)
    subprocess.Popen(["setsid", "nohup", script], stdout=open(os.path.join(c["work_dir"], "log.lidkit_loop"), "w"), stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
    print(f"loop launched from iteration {k0} (log {c['work_dir']}/log.lidkit_loop); follow with: lidkit.py status {c['_path']}")

def dp0(C):
    """flux-weighted dp0 (Pa) from the pressureLossMonitors FOs if present: last value and mean of the last 100"""
    try:
        def rd(fo):
            rows = []
            for f in glob.glob(os.path.join(C, "postProcessing", fo, "*", "surfaceFieldValue.dat")):
                rows += [(float(l.split()[0]), float(l.split()[1])) for l in open(f) if l.strip() and not l.startswith("#")]
            rows.sort(); return dict(rows)
        a, b = rd("inlet_p0_flux"), rd("outlet_p0_flux"); t = sorted(set(a) & set(b)); d = [a[x] - b[x] for x in t]
        return f"{d[-1]:.0f} (mean100 {sum(d[-100:])/len(d[-100:]):.0f})" if d else "n/a"
    except Exception: return "n/a"

def cmd_status(c):
    print(f"{c['name']}  Z_LID {c['z_lid']}  tol {c['tol_rms_mm']} mm  work {c['work_dir']}")
    print(f"{'iter':>4} | {'case':40s} | {'state':10s} | {'last t':>7} | {'dp0 [Pa]':>22} | {'mesh cells':>10} | {'zs min/mean [mm]':>18} | {'residual RMS/max [mm]':>22}")
    for k in range(0, c["max_iter"] + 2):
        C = case_dir(c, k)
        if not os.path.isdir(C): break
        st = "running" if running(C) else ("done" if (k == 0 or os.path.isfile(os.path.join(C, "log.Allrun"))) else "set up")
        t = latest_time_dir(C); q = mesh_quality(os.path.join(mesh_dir(c, k), "log.checkMesh")) if k > 0 else {"cells": "parent"}
        zj = os.path.join(c["work_dir"], f"zs_iter{k}.json"); z = json.load(open(zj)) if os.path.isfile(zj) else None
        zs_s = f"{z['zs_vs_Z_LID_mm']['min']:.0f} / {z['zs_vs_Z_LID_mm']['mean']:.0f}" if z else "-"; rs = f"{z['lid_residual_mm']['rms']:.1f} / {z['lid_residual_mm']['max_abs']:.0f}" if z else "-"
        print(f"{k:>4} | {os.path.basename(C)[:40]:40s} | {st:10s} | {os.path.basename(t) if t else '-':>7} | {dp0(C):>22} | {str(q.get('cells')):>10} | {zs_s:>18} | {rs:>22}")

def cmd_post(c, k):
    r = subprocess.run([PY, os.path.join(HERE, "lidkit_post.py"), c["_path"], str(k)]); return r.returncode

if __name__ == "__main__":
    if len(sys.argv) < 3: print(__doc__); sys.exit(1)
    cmd, cfg = sys.argv[1], sys.argv[2]
    if cmd == "init": cmd_init(cfg); sys.exit(0)
    c = load(cfg); k = int(sys.argv[3]) if len(sys.argv) > 3 else None
    {"check": lambda: cmd_check(c), "surface": lambda: cmd_surface(c, k), "fit": lambda: cmd_fit(c, k), "mesh": lambda: cmd_mesh(c, k), "case": lambda: cmd_case(c, k),
     "run": lambda: cmd_run(c, k), "next": lambda: cmd_next(c, k), "loop": lambda: cmd_loop(c, k if k is not None else 0), "status": lambda: cmd_status(c), "post": lambda: cmd_post(c, k)}[cmd]()

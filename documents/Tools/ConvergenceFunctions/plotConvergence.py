#!/usr/bin/env python3
# -----------------------------------------------------------------------------
# PORTABLE CONVERGENCE PLOT — mirrors the coded convergenceControl FO.
#   panel 1  initial residuals (Ux,Uy,Uz,p,k,omega) + resTol gate line
#   panel 2  total-pressure drop Dp0 = p0_in - p0_out + trailing mean + status
#   panel 3  zoom of Dp0 over the last ZOOM iterations
#   footer   pressure-recovery Cp (actual / ideal / eff / AR / V_in,out / zeta)
#
# HOW TO USE IN ANOTHER MODEL
#   1. copy this file into the case root (next to system/, constant/).
#   2. the case must run the `pressureLossMonitors` FOs (pTotal + the *_p0_flux
#      / *_flux surfaceFieldValues) so postProcessing/ has the data.
#   3. edit the USER CONFIG block below to match your case, then:
#          python3 plotConvergence.py            # this case
#          python3 plotConvergence.py <caseDir>  # or another case
#   writes convergence.png and tries to open it. Needs numpy + matplotlib only.
# -----------------------------------------------------------------------------
import os, sys, re, glob, subprocess
import numpy as np
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt

# ==================== USER CONFIG ====================
APP         = "simpleFoam"      # solver name -> reads log.<APP> for residuals
INLET_MON   = "inlet_p0_flux"   # postProcessing dir names (from pressureLossMonitors)
OUTLET_MON  = "outlet_p0_flux"
OUTLET_FLUX = "outlet_flux"
# convergence criterion -- KEEP IN SYNC with system/convergenceControl:
W, TOLMEAN, K, RESTOL = 100, 50.0, 2, 1e-3
ZOOM = 500                      # iterations shown in the zoom panel
RHO  = 1000.0                   # density for Cp (kinematic p -> Pa)
# ====================================================

CASE = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))

def read_residuals(log):
    times=[]; res={f:[] for f in ("Ux","Uy","Uz","p","k","omega")}
    seen=set(); t=None
    rx=re.compile(r"Solving for (\w+), Initial residual = ([0-9.eE+-]+)")
    for line in open(log, errors="ignore"):
        if line.startswith("Time ="):
            t=int(float(line.split("=")[1])); seen=set(); times.append(t)
            for f in res: res[f].append(np.nan)
        m=rx.search(line)
        if m and t is not None:
            f,v=m.group(1),float(m.group(2))
            if f in res and f not in seen: res[f][-1]=v; seen.add(f)
    return np.array(times), {f:np.array(v) for f,v in res.items()}

def read_series(name, col=1):
    t=[]; y=[]
    for f in glob.glob(os.path.join(CASE,"postProcessing",name,"*","surfaceFieldValue.dat")):
        for l in open(f):
            if l.startswith("#"): continue
            p=l.split()
            if len(p)>col: t.append(float(p[0])); y.append(float(p[col]))
    if not t: return np.array([]), np.array([])
    o=np.argsort(t); return np.array(t)[o], np.array(y)[o]

def read_area(name):
    for f in glob.glob(os.path.join(CASE,"postProcessing",name,"*","surfaceFieldValue.dat")):
        for l in open(f):
            if l.startswith("#") and "Area" in l:
                try: return float(l.split(":")[1])
                except Exception: pass
    return None

log=os.path.join(CASE,"log.%s"%APP)
rt,res = read_residuals(log) if os.path.exists(log) else (np.array([]),{})
ti,p0i = read_series(INLET_MON, 1);  to,p0o = read_series(OUTLET_MON, 1)
_,psi  = read_series(INLET_MON, 2);  _,pso  = read_series(OUTLET_MON, 2)
A_in   = read_area(INLET_MON);       A_out  = read_area(OUTLET_MON)

tc = np.intersect1d(ti,to)
def on(tsrc,ysrc): return np.array([ysrc[tsrc==t][0] for t in tc]) if len(tc) else np.array([])
p0i_c, p0o_c = on(ti,p0i), on(to,p0o)
dp = p0i_c - p0o_c if len(tc) else np.array([])

resfields=[f for f in ("Ux","Uy","Uz","p","k","omega") if f in res and np.isfinite(res[f]).any()]
if resfields and len(rt):
    maxres_rt=np.nanmax(np.vstack([res[f] for f in resfields]),axis=0)
    resmap=dict(zip(rt.astype(int),maxres_rt))
    maxres=np.array([resmap.get(int(t),np.nan) for t in tc])
    lastv=np.nan
    for i in range(len(maxres)):
        if np.isfinite(maxres[i]): lastv=maxres[i]
        elif np.isfinite(lastv):   maxres[i]=lastv
else:
    maxres=np.full(len(tc),np.nan)

def trailing_mean(t,y,w):
    m=np.full_like(y,np.nan,dtype=float)
    for i in range(len(y)):
        sel=(t>t[i]-w)&(t<=t[i]); m[i]=y[sel].mean()
    return m

def detect(dp, maxres, W, tolMean, K, resTol):
    N=len(dp); conv=None; passCount=0; last=None; pos=2*W
    while pos<=N:
        mLast=dp[pos-W:pos].mean(); mPrev=dp[pos-2*W:pos-W].mean()
        slope=np.polyfit(np.arange(W),dp[pos-W:pos],1)[0]
        drift=abs(mLast-mPrev); trend=abs(slope)*(W-1)
        rwin=np.nanmax(maxres[pos-W:pos]) if np.isfinite(maxres[pos-W:pos]).any() else np.inf
        c1=drift<=tolMean; c2=trend<=tolMean; c3=rwin<=resTol
        passCount = passCount+1 if (c1 and c2 and c3) else 0
        last=(drift,trend,rwin,c1,c2,c3,passCount)
        if passCount>=K and conv is None: conv=int(tc[pos-1])
        pos+=W
    return conv, last

conv_iter, last_chk = (None, None)
if len(tc) >= 2*W: conv_iter, last_chk = detect(dp, maxres, W, TOLMEAN, K, RESTOL)
called_iter=int(tc[-1]) if len(tc) else (int(rt[-1]) if len(rt) else None)

cp_txt="Cp: (no p/area data yet)"
if len(tc) and A_in and A_out and len(psi) and len(pso):
    sel=tc>=tc[-1]-W
    p0in=p0i_c[sel].mean(); p0out=p0o_c[sel].mean()
    psin=on(ti,psi)[sel].mean()*RHO; psout=on(to,pso)[sel].mean()*RHO
    dyn_in=p0in-psin
    if dyn_in>1e-9:
        V_in=(2*dyn_in/RHO)**0.5; V_out=(2*max(p0out-psout,0)/RHO)**0.5
        dp0=p0in-p0out; zeta=dp0/dyn_in; Cp=(psout-psin)/dyn_in
        AR=A_out/A_in; Cp_id=1-(A_in/A_out)**2; eff=Cp/Cp_id if Cp_id else float('nan')
        cp_txt=(f"PRESSURE RECOVERY  Cp   (mean of last {W} it)\n"
                f"Cp = {Cp:.3f}    ideal {Cp_id:.3f}    eff η = {eff:.2f}    AR = {AR:.2f}\n"
                f"V_in = {V_in:.2f} m/s    V_out = {V_out:.2f} m/s    ζ = {zeta:.3f}")

INK="#131a22"; MUT="#5b6672"; GRID="#e6eaf0"
plt.rcParams.update({"font.family":"DejaVu Sans","axes.edgecolor":"#c8d0da"})
fig,(ax1,ax2,ax3)=plt.subplots(3,1,figsize=(10,10.5),dpi=120,
                               gridspec_kw={"height_ratios":[1,1,0.9],"hspace":0.33})
colors={"Ux":"#1f9baf","Uy":"#35b7c9","Uz":"#0e8aa3","p":"#c9741a","k":"#5b53c9","omega":"#8a3ffc"}
for f,c in colors.items():
    if f in res and np.isfinite(res[f]).any(): ax1.semilogy(rt,res[f],color=c,lw=1.1,label=f)
ax1.axhline(RESTOL,color="#2fa84f",ls="--",lw=1.3,label=f"resTol {RESTOL:g}")
ax1.set_ylabel("initial residual"); ax1.set_title("Residuals (gate: max eqn ≤ resTol)",fontsize=11,loc="left")
ax1.grid(True,which="both",color=GRID); ax1.legend(ncol=7,fontsize=8,loc="upper right"); ax1.set_xlabel("iteration")

if len(tc):
    mean=trailing_mean(tc,dp,W)
    ax2.plot(tc,dp,color="#0e8aa3",lw=1.4,label="Δp0 = p0_in - p0_out")
    ax2.plot(tc,mean,color="#c9741a",lw=1.6,ls="--",label=f"trailing mean ({W} it)")
    status=(f"CONVERGES @ iter {conv_iter}" if conv_iter is not None
            else (f"not converged (best pass {last_chk[6]}/{K})" if last_chk else "not enough data (<2W)"))
    lines=[status, f"called @ iter {called_iter}   (latest data)"]
    if last_chk is not None:
        d,tr,rw,c1,c2,c3,_=last_chk
        lines.append(f"last check: drift {d:.0f}  trend {tr:.0f}  maxRes {rw:.1e}")
        lines.append(f"  mean:{'y' if c1 else 'n'} slope:{'y' if c2 else 'n'} res:{'y' if c3 else 'n'}"
                     f"   (tolMean {TOLMEAN:.0f} Pa, resTol {RESTOL:g}, K={K})")
    ax2.text(0.015,0.03,"\n".join(lines),transform=ax2.transAxes,fontsize=8.5,family="monospace",
             va="bottom",ha="left",bbox=dict(boxstyle="round",fc="white",ec="#c8d0da"))
ax2.set_ylabel("pressure drop  [Pa]"); ax2.set_xlabel("iteration")
ax2.set_title("Total-pressure drop (convergence target)",fontsize=11,loc="left")
ax2.grid(True,color=GRID); ax2.legend(fontsize=8,loc="upper right")

if len(tc):
    sel=tc>=tc[-1]-ZOOM; tz,dz=tc[sel],dp[sel]; mz=dz.mean()
    ax3.plot(tz,dz,color="#0e8aa3",lw=1.5,label="Δp0")
    ax3.axhline(mz,color="#c9741a",lw=1.6,ls="--",label=f"window mean {mz:.0f} Pa")
    pk=dz.max()-dz.min()
    ax3.text(0.015,0.05,f"last {ZOOM} it:  peak-to-peak {pk:.0f} Pa   mean {mz:.0f} Pa",
             transform=ax3.transAxes,fontsize=9,family="monospace",va="bottom",
             bbox=dict(boxstyle="round",fc="white",ec="#c8d0da"))
ax3.set_ylabel("pressure drop  [Pa]"); ax3.set_xlabel("iteration")
ax3.set_title(f"Δp0 - zoom, last {ZOOM} iterations",fontsize=11,loc="left")
ax3.grid(True,color=GRID); ax3.legend(fontsize=8,loc="upper right")

fig.text(0.015,-0.005,cp_txt,fontsize=9.5,family="monospace",color=INK,va="top",
         bbox=dict(boxstyle="round",fc="#eef4f5",ec="#0e8aa3"))
out=os.path.join(CASE,"convergence.png"); fig.savefig(out,bbox_inches="tight")
print("wrote",out,"| converges @",conv_iter,"| called @",called_iter,"|",cp_txt.split(chr(10))[0])

def try_open(path):
    for cmd in (["wslview",path],["xdg-open",path],["open",path]):
        try: subprocess.Popen(cmd,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); return True
        except FileNotFoundError: continue
    try:
        win=subprocess.check_output(["wslpath","-w",path]).decode().strip()
        subprocess.Popen(["explorer.exe",win],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); return True
    except Exception: return False
try_open(out)

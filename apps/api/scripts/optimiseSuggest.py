"""Suggest the next chamber design of an optimisation study (WS-H, spec §5).

Ask / tell with an IN-MEMORY Optuna study rebuilt from the study's evaluation
history at every call: the API's Evaluation rows stay the single source of truth
(no Optuna RDB storage), so a study resumes after a restart for free.

CLI:
    optimiseSuggest.py <request.json>      (or "-" to read the request on stdin)

Request (JSON):
    {
      "space":   [{"key": "width", "low": 4050, "high": 4850, "step": 50}, ...],
      "sampler": "tpe" | "nsga2" | "random",
      "seed":    int | null,
      "mode":    "weighted" | "pareto",
      "history": [
        {"params": {"width": 4450}, "values": [1.0] | [h, v] | null,
         "state": "COMPLETE" | "FAIL", "feasible": true | false}, ...
      ]
    }
    `values` holds the weighted objective (weighted mode) or the two normalised
    objectives (pareto mode), all minimised. An infeasible design (builder
    refusal, failed mesh checks) is replayed as a COMPLETE trial with a violated
    constraint (feasible false, values null => the worst values seen), so TPE and
    NSGA-II learn the infeasible region through `constraints_func`. A failed
    evaluation is replayed as FAIL (ignored by the samplers). History entries whose
    params fall outside the space (e.g. a baseline off the 50 mm grid) are skipped.

Output:
    stdout  OK: {"params": {"width": 4200, ...}}     exit 0
    stderr  KO: <reason>                             exit 1
    usage error                                      exit 2

Dependencies: optuna (>= 3.0 for constraints_func), under OPTIM_PYTHON_BIN
(default MESH_PYTHON_BIN). Imported inside main().
"""

import json
import sys

# NSGA-II generation size: small, since a study is ~30 evaluations.
NSGA2_POPULATION = 10


def _ko(message):
    sys.stderr.write(f"KO: {message}\n")
    return 1


def _constraints(trial):
    """Optuna constraints_func: <= 0 feasible, > 0 infeasible (read from the replay)."""
    return trial.system_attrs.get("constraints", (0.0,))


def main(argv):
    if len(argv) != 2:
        sys.stderr.write("usage: optimiseSuggest.py <request.json | ->\n")
        return 2
    try:
        if argv[1] == "-":
            raw = sys.stdin.read()
        else:
            with open(argv[1], "r", encoding="utf-8") as handle:
                raw = handle.read()
        req = json.loads(raw)
    except (OSError, ValueError) as err:
        return _ko(f"cannot read the request ({err})")

    try:
        import optuna
        from optuna.distributions import IntDistribution
        from optuna.trial import TrialState, create_trial
    except ImportError:
        return _ko(
            "optuna is not installed for the optimiser interpreter (OPTIM_PYTHON_BIN). "
            "Install it with: pip install optuna"
        )
    optuna.logging.set_verbosity(optuna.logging.WARNING)

    try:
        space = req["space"]
        if not isinstance(space, list) or not space:
            return _ko("the search space is empty")
        dists = {}
        for dim in space:
            low, high, step = int(dim["low"]), int(dim["high"]), int(dim.get("step", 50))
            if step <= 0 or high < low or (high - low) % step:
                return _ko(f"invalid range for {dim['key']}: {low}..{high} step {step}")
            dists[str(dim["key"])] = IntDistribution(low, high, step=step)
        mode = req.get("mode", "weighted")
        n_obj = 2 if mode == "pareto" else 1
        history = req.get("history") or []
        seed = req.get("seed")
        # A fixed seed stays reproducible yet moves on with the history (a fresh
        # sampler is built at every call, so the same seed alone would repeat).
        eff_seed = None if seed is None else int(seed) + len(history)
        name = req.get("sampler", "tpe")
        if name == "tpe":
            sampler = optuna.samplers.TPESampler(
                seed=eff_seed,
                multivariate=True,
                constant_liar=False,
                constraints_func=_constraints,
            )
        elif name == "nsga2":
            sampler = optuna.samplers.NSGAIISampler(
                seed=eff_seed,
                population_size=NSGA2_POPULATION,
                constraints_func=_constraints,
            )
        elif name == "random":
            sampler = optuna.samplers.RandomSampler(seed=eff_seed)
        else:
            return _ko(f"unknown sampler {name!r}")

        study = optuna.create_study(directions=["minimize"] * n_obj, sampler=sampler)

        # Values given to infeasible designs: the worst feasible values seen.
        worst = [1.0] * n_obj
        seen = [h["values"] for h in history if h.get("state") == "COMPLETE" and h.get("values")]
        if seen:
            worst = [max(float(v[i]) for v in seen) for i in range(n_obj)]

        replayed = 0
        for entry in history:
            params = entry.get("params") or {}
            if set(params) != set(dists) or not all(
                dists[k]._contains(dists[k].to_internal_repr(int(params[k]))) for k in dists
            ):
                continue
            params = {k: int(params[k]) for k in dists}
            state = entry.get("state")
            if state == "FAIL":
                trial = create_trial(state=TrialState.FAIL, params=params, distributions=dists)
            elif state == "COMPLETE":
                feasible = entry.get("feasible", True)
                values = entry.get("values") if feasible else None
                values = [float(v) for v in values] if values else list(worst)
                if len(values) != n_obj:
                    return _ko("the history values do not match the objective count")
                attrs = {"constraints": (-1.0,) if feasible else (1.0,)}
                if name == "nsga2":
                    attrs["NSGAIISampler:generation"] = replayed // NSGA2_POPULATION
                trial = create_trial(
                    state=TrialState.COMPLETE,
                    params=params,
                    distributions=dists,
                    values=values,
                    system_attrs=attrs,
                )
            else:
                continue
            study.add_trial(trial)
            replayed += 1

        trial = study.ask(dists)
        suggestion = {k: int(v) for k, v in trial.params.items()}
    except (KeyError, TypeError, ValueError) as err:
        return _ko(f"invalid request ({err})")

    sys.stdout.write("OK: " + json.dumps({"params": suggestion}) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

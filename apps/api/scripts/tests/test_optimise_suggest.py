"""Tests of scripts/optimiseSuggest.py (WS-H spec §5, §9).

Needs optuna in the interpreter running pytest; the module SKIPS without it
(the contract test for a missing optuna cannot run then either). Covers:
  * the OK: / KO: / usage contract;
  * deterministic suggestions with a seed, on the 50 mm grid, inside the space;
  * history replay (COMPLETE, FAIL, infeasible, off-grid entries skipped);
  * the NSGA-II / Pareto mode.
"""

import json
import os
import subprocess
import sys

import pytest

pytest.importorskip("optuna")

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "optimiseSuggest.py")

SPACE = [
    {"key": "width", "low": 4050, "high": 4850, "step": 50},
    {"key": "hMiddle", "low": 550, "high": 650, "step": 50},
]


def _run(request, tmp_path, name="req.json"):
    path = tmp_path / name
    path.write_text(json.dumps(request), encoding="utf-8")
    return subprocess.run(
        [sys.executable, SCRIPT, str(path)], capture_output=True, text=True, timeout=120
    )


def _params(result):
    assert result.returncode == 0, result.stderr
    line = next(l for l in result.stdout.splitlines() if l.startswith("OK: "))
    return json.loads(line[4:])["params"]


def _history(n, feasible=True):
    out = []
    for i in range(n):
        out.append(
            {
                "params": {"width": 4050 + 50 * i, "hMiddle": 600},
                "values": [1.0 - 0.05 * i],
                "state": "COMPLETE",
                "feasible": feasible,
            }
        )
    return out


def test_usage_error_exits_2():
    result = subprocess.run([sys.executable, SCRIPT], capture_output=True, text=True, timeout=60)
    assert result.returncode == 2


def test_bad_request_is_a_ko(tmp_path):
    result = _run({"space": []}, tmp_path)
    assert result.returncode == 1
    assert result.stderr.startswith("KO: ")


def test_suggestion_is_on_the_grid_and_seeded(tmp_path):
    req = {"space": SPACE, "sampler": "tpe", "seed": 7, "mode": "weighted", "history": _history(3)}
    first = _params(_run(req, tmp_path, "a.json"))
    second = _params(_run(req, tmp_path, "b.json"))
    assert first == second
    assert set(first) == {"width", "hMiddle"}
    assert 4050 <= first["width"] <= 4850 and first["width"] % 50 == 0
    assert 550 <= first["hMiddle"] <= 650 and first["hMiddle"] % 50 == 0


def test_history_with_fail_infeasible_and_off_grid_entries(tmp_path):
    history = _history(12)
    history.append({"params": {"width": 4100, "hMiddle": 550}, "values": None, "state": "FAIL"})
    history.append(
        {"params": {"width": 4800, "hMiddle": 650}, "values": None, "state": "COMPLETE", "feasible": False}
    )
    # Baseline off the grid: skipped, not an error.
    history.append({"params": {"width": 4473, "hMiddle": 612}, "values": [1.0], "state": "COMPLETE"})
    req = {"space": SPACE, "sampler": "tpe", "seed": 1, "mode": "weighted", "history": history}
    params = _params(_run(req, tmp_path))
    assert params["width"] % 50 == 0


def test_random_sampler_moves_on_with_the_history(tmp_path):
    base = {"space": SPACE, "sampler": "random", "seed": 3, "mode": "weighted"}
    picks = {
        json.dumps(_params(_run({**base, "history": _history(n)}, tmp_path, f"r{n}.json")))
        for n in range(4)
    }
    assert len(picks) > 1


def test_nsga2_pareto_mode(tmp_path):
    history = [
        {
            "params": {"width": 4050 + 50 * (i % 17), "hMiddle": 550 + 50 * (i % 3)},
            "values": [1.0 + 0.01 * i, 1.0 - 0.01 * i],
            "state": "COMPLETE",
            "feasible": i % 5 != 0,
        }
        for i in range(24)
    ]
    req = {"space": SPACE, "sampler": "nsga2", "seed": 11, "mode": "pareto", "history": history}
    params = _params(_run(req, tmp_path))
    assert 4050 <= params["width"] <= 4850

#!/usr/bin/env python3
"""Merge per-timestep CGNS (HDF5) files into ONE transient CGNS for CFD-Post.
Run with python3 + the h5py wheel.

Usage:
    python3 CgnsMergeTime.py <out.cgns> <t0,t1,...,tN-1> <in_0.cgns> ... <in_N-1.cgns>

Why:
  ParaView's CGNS writer emits one file PER time step (it cannot write a single
  transient file). This assembles them into ONE CGNS with BaseIterativeData /
  ZoneIterativeData / FlowSolutionPointers, so Ansys CFD-Post shows the WHOLE
  time evolution on its time bar instead of a single frozen frame.

How (low-risk):
  Start from the first file (mesh + its FlowSolution), then COPY each later
  file's FlowSolution group verbatim with h5py — this preserves the exact
  CGNS/HDF5 node format ParaView wrote. The only nodes we create by hand are the
  small iterative-data nodes, and we clone the attribute dtypes from an existing
  node so we never hardcode the CGNS/HDF5 byte conventions wrong.

Contract: print "OK: ..." to stdout / exit 0; "KO: ..." to stderr / exit 1.
"""

import os
import shutil
import sys

import numpy as np


def label_of(node):
    """The CGNS SIDS label of an HDF5 node (group), or '' when absent."""
    try:
        v = node.attrs["label"]
    except Exception:  # noqa: BLE001 - not a CGNS node.
        return ""
    if isinstance(v, np.ndarray):
        v = v.tobytes()
    if isinstance(v, (bytes, bytearray)):
        return v.split(b"\x00", 1)[0].decode("ascii", "ignore")
    return str(v)


def find_child(group, label):
    """First child group of `group` whose CGNS label matches, or None."""
    for name in group:
        child = group[name]
        if hasattr(child, "attrs") and label_of(child) == label:
            return child
    return None


def find_children(group, label):
    """All child groups of `group` with the given CGNS label."""
    out = []
    for name in group:
        child = group[name]
        if hasattr(child, "attrs") and label_of(child) == label:
            out.append(child)
    return out


def set_name_attr(node, value, ref):
    """Set a CGNS `name` attribute, cloning the dtype from a reference node."""
    dt = ref.attrs["name"].dtype
    n = dt.itemsize if dt.kind == "S" else 33
    node.attrs.create("name", value.encode().ljust(n, b"\x00")[:n], dtype=dt)


def make_node(parent, name, label, type_code, data, ref):
    """Create a CGNS/HDF5 node, cloning attribute dtypes from a reference node.

    `ref` is any existing CGNS node in the file (e.g. the Zone), used so the new
    node's name/label/type/flags attributes match this file's exact encoding.
    `data` (or None) becomes the node's ` data` dataset.
    """
    g = parent.create_group(name)
    name_dt = ref.attrs["name"].dtype
    label_dt = ref.attrs["label"].dtype
    type_dt = ref.attrs["type"].dtype
    flags_dt = ref.attrs["flags"].dtype if "flags" in ref.attrs else np.dtype("int32")

    g.attrs.create("name", name.encode().ljust(name_dt.itemsize, b"\x00")[: name_dt.itemsize], dtype=name_dt)
    g.attrs.create("label", label.encode().ljust(label_dt.itemsize, b"\x00")[: label_dt.itemsize], dtype=label_dt)
    g.attrs.create("type", type_code.encode().ljust(type_dt.itemsize, b"\x00")[: type_dt.itemsize], dtype=type_dt)
    g.attrs.create("flags", np.array([1], dtype=flags_dt))
    if data is not None:
        g.create_dataset(" data", data=data)
    return g


def main():
    try:
        import h5py
    except ImportError as exc:
        sys.stderr.write(
            "KO: h5py unavailable - run with a python3 that has `pip install h5py`: %s\n" % exc
        )
        sys.exit(1)

    if len(sys.argv) < 4:
        sys.stderr.write("usage: python3 CgnsMergeTime.py <out.cgns> <t0,...> <in_0.cgns> ...\n")
        sys.exit(2)

    out = os.path.abspath(sys.argv[1])
    times = [t for t in sys.argv[2].split(",") if t != ""]
    inputs = [os.path.abspath(p) for p in sys.argv[3:]]
    if len(inputs) == 0:
        sys.stderr.write("KO: no input CGNS files given.\n")
        sys.exit(1)
    for p in inputs:
        if not os.path.isfile(p):
            sys.stderr.write("KO: input not found: %s\n" % p)
            sys.exit(1)

    n_steps = len(inputs)
    # Time values: use the supplied list when it matches, else step indices.
    try:
        time_values = [float(t) for t in times]
    except ValueError:
        time_values = []
    if len(time_values) != n_steps:
        time_values = [float(i) for i in range(n_steps)]

    # Start the transient file from the first time step (mesh + its solution).
    shutil.copyfile(inputs[0], out)

    try:
        merged = h5py.File(out, "r+")
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write("KO: cannot open %s as HDF5 (is it HDF5-CGNS?): %s\n" % (out, exc))
        sys.exit(1)

    try:
        base = find_child(merged, "CGNSBase_t")
        if base is None:
            raise RuntimeError("no CGNSBase_t node")
        zone = find_child(base, "Zone_t")
        if zone is None:
            raise RuntimeError("no Zone_t node")

        sols = find_children(zone, "FlowSolution_t")
        if not sols:
            raise RuntimeError("no FlowSolution_t in the first file")
        # Rename the first file's solution to a clean, indexed name.
        first = sols[0]
        first_name = first.name.rsplit("/", 1)[-1]
        sol_names = ["FlowSolution0"]
        if first_name != "FlowSolution0":
            zone.move(first_name, "FlowSolution0")
        set_name_attr(zone["FlowSolution0"], "FlowSolution0", zone)

        # Copy each later step's FlowSolution into the same zone, indexed.
        for i in range(1, n_steps):
            with h5py.File(inputs[i], "r") as src:
                s_base = find_child(src, "CGNSBase_t")
                s_zone = find_child(s_base, "Zone_t") if s_base is not None else None
                s_sols = find_children(s_zone, "FlowSolution_t") if s_zone is not None else []
                if not s_sols:
                    raise RuntimeError("no FlowSolution_t in %s" % inputs[i])
                target = "FlowSolution%d" % i
                zone.copy(s_sols[0], target)
            set_name_attr(zone[target], target, zone)
            sol_names.append(target)

        # BaseIterativeData: number of steps + the time values.
        bid = make_node(
            base, "BaseIterativeData", "BaseIterativeData_t", "I4",
            np.array([n_steps], dtype="int32"), zone,
        )
        make_node(bid, "TimeValues", "DataArray_t", "R8",
                  np.array(time_values, dtype="float64"), zone)

        # ZoneIterativeData: FlowSolutionPointers, one 32-char name per step.
        # CGNS dimension is [32, n_steps] (Fortran); HDF5 stores it reversed, so
        # the dataset shape is (n_steps, 32), space-padded names.
        pointers = np.full((n_steps, 32), ord(" "), dtype="int8")
        for k, nm in enumerate(sol_names):
            b = nm.encode()[:32]
            pointers[k, : len(b)] = np.frombuffer(b, dtype="int8")
        zid = make_node(zone, "ZoneIterativeData", "ZoneIterativeData_t", "MT", None, zone)
        make_node(zid, "FlowSolutionPointers", "DataArray_t", "C1", pointers, zone)

        # Mark the base as time-accurate (helps some readers pick up the series).
        if find_child(base, "SimulationType_t") is None:
            st = np.frombuffer(b"TimeAccurate", dtype="int8")
            make_node(base, "SimulationType", "SimulationType_t", "C1", st, zone)

        merged.flush()
    except Exception as exc:  # noqa: BLE001 - one-shot CLI: report and fail.
        import traceback

        merged.close()
        sys.stderr.write("KO: merge failed: %s\n%s\n" % (exc, traceback.format_exc()))
        sys.exit(1)
    finally:
        try:
            merged.close()
        except Exception:  # noqa: BLE001
            pass

    sys.stdout.write(
        "OK: transient CGNS written (%d time steps) -> %s\n" % (n_steps, out)
    )
    sys.exit(0)


if __name__ == "__main__":
    main()

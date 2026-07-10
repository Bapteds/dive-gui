#!/usr/bin/env python3
"""Extract OpenFOAM boundary patches into a compact GLB + JSON manifest.

This is the production, fully-English, optimized descendant of the original
German interactive inspector (patch_viewer.py). It preserves the two
data-extraction capabilities of that tool and drops everything else:

  * F1 - read the boundary patches of an OpenFOAM case (geometry).
  * F2 - parse each patch's TYPE from constant/polyMesh/boundary.

All rendering / GUI / server code from the original has been removed. This is a
one-shot CLI meant to be spawned by the backend command runner (execFile, real
argv, no shell), exactly like the existing CGNS->VTK converter (CgnsToVtk.py).
The resulting GLB is consumed by a three.js viewer in the browser; the manifest
describes each patch (name, type, original boundary face count).

CLI usage:
    python extractPatches.py <caseDirOrFoamFile> <out.glb> <out_manifest.json>

Dependencies (runtime): pyvista, trimesh, numpy. These heavy libraries are
imported INSIDE main() (after argument parsing) so that a usage error does not
require them to be installed.

Success/failure contract (mirrors CgnsToVtk.py):
  * On success: print a line starting with "OK:" to stdout and exit 0.
  * On failure: print a line starting with "KO:" to stderr and exit 1.
  * On a usage error (wrong argc): print usage to stderr and exit 2.
"""

import os
import re
import sys


def parse_boundary_types(case_dir):
    """Return {patchName: type} parsed from constant/polyMesh/boundary.

    The patch TYPE is not stored in the geometry blocks, so we read it directly
    from the boundary dictionary (translated regex from the original tool's
    parse_boundary_types). Patches absent from the file simply won't appear here;
    the caller defaults their type to "?".
    """
    bfile = os.path.join(case_dir, "constant", "polyMesh", "boundary")
    types = {}
    if os.path.exists(bfile):
        with open(bfile) as fh:
            txt = fh.read()
        # Match: <name> { ... type <word> ; ... }. The name and type allow hyphens
        # (Fluent zone names like "wall-1"); before the fix `\w+` captured "wall-1"
        # as "1" and could pick up `physicalType`. `\btype` anchors the real key.
        for m in re.finditer(r"([A-Za-z_][\w-]*)\s*\{[^}]*?\btype\s+([\w-]+)\s*;", txt):
            types[m.group(1)] = m.group(2)
        # FoamFile is the dictionary header, not a real patch.
        types.pop("FoamFile", None)
    return types


def extract_edge_vertices(surface):
    """Return the surface's ORIGINAL cell edges as line-segment endpoints.

    Computed from the un-triangulated surface, so it is the true mesh grid (quad
    / polygon cell edges) rather than the noisy triangle wireframe a triangulated
    surface would give. Shape (2K, 3) float32 = K segments, consecutive pairs.
    Returns an empty array on any failure (the viewer then falls back to a
    client-side feature-edge overlay), so edges never break the export.
    """
    import numpy as np

    try:
        wire = surface.extract_all_edges()
        points = np.asarray(wire.points, dtype=np.float32)
        lines = np.asarray(wire.lines)
        if points.size == 0 or lines.size == 0:
            return np.zeros((0, 3), dtype=np.float32)
        # PyVista lines are 2-point cells: a flat [2, i, j, 2, k, l, ...] array.
        conn = lines.reshape(-1, 3)[:, 1:]  # (K, 2) endpoint indices
        return points[conn.reshape(-1)].astype(np.float32)  # (2K, 3)
    except Exception:
        return np.zeros((0, 3), dtype=np.float32)


def main():
    # Validate argc before importing the heavy libraries so a plain usage
    # mistake is cheap and does not require pyvista/trimesh/numpy to be present.
    if len(sys.argv) != 4:
        sys.stderr.write(
            "usage: python extractPatches.py "
            "<caseDirOrFoamFile> <out.glb> <out_manifest.json>\n"
        )
        sys.exit(2)

    arg_case, out_glb, out_manifest = sys.argv[1], sys.argv[2], sys.argv[3]

    try:
        import numpy as np
        import pyvista as pv
        import trimesh

        # 1. Resolve the case directory. If arg1 is a .foam file, the case dir
        #    is its parent; otherwise arg1 is the case dir itself. The backend
        #    has already normalized the layout, so constant/polyMesh is assumed
        #    present here (we do NOT re-implement layout normalization).
        if os.path.isfile(arg_case) and arg_case.lower().endswith(".foam"):
            case_dir = os.path.dirname(os.path.abspath(arg_case)) or "."
        else:
            case_dir = os.path.abspath(arg_case)

        # Ensure a case.foam marker exists inside the case dir and use it as the
        # reader input (pv.OpenFOAMReader reads a .foam pointer file).
        foam = os.path.join(case_dir, "case.foam")
        if not os.path.exists(foam):
            open(foam, "a").close()

        # 2. Read only the boundary block (skip internalMesh) - the big
        #    speed/memory win, mirroring the original load_patches().
        reader = pv.OpenFOAMReader(foam)
        reader.enable_all_patch_arrays()
        # enable_all_patch_arrays() also turns ON the "internalMesh" pseudo-patch,
        # i.e. the full internal VOLUME mesh. We only render boundary surfaces, and
        # loading the internal mesh can OOM / time out on a production case (M19), so
        # disable it. Done at the VTK level for version-robustness; if the API
        # differs, fall back to the prior behaviour rather than failing the render.
        try:
            raw = reader.reader
            for i in range(raw.GetNumberOfPatchArrays()):
                if raw.GetPatchArrayName(i) == "internalMesh":
                    raw.SetPatchArrayStatus("internalMesh", 0)
            raw.Modified()
        except Exception as exc:  # noqa: BLE001 - best-effort optimisation only
            sys.stderr.write(f"[extractPatches] could not disable internalMesh: {exc}\n")
        mesh = reader.read()

        keys = list(mesh.keys()) if mesh is not None else []

        # Build an iterable of (patchName, block) pairs from the boundary group
        # when present, otherwise fall back to top-level blocks (skip
        # internalMesh), exactly as the original did.
        if "boundary" in keys:
            boundary = mesh["boundary"]
            patch_items = [(name, boundary[name]) for name in boundary.keys()]
        else:
            patch_items = [
                (name, mesh[name])
                for name in keys
                if name and name != "internalMesh"
            ]

        # 4. Patch types from constant/polyMesh/boundary.
        types = parse_boundary_types(case_dir)

        scene = trimesh.Scene()
        manifest = []
        # True cell edges, concatenated across patches into one buffer; the
        # manifest records each patch's [vertex offset, vertex count] into it.
        edge_chunks = []
        total_edge_verts = 0

        for name, blk in patch_items:
            # Match the original n_cells > 0 guard: skip empty blocks.
            if blk is None or blk.n_cells <= 0:
                continue

            # 6. Capture the ORIGINAL boundary face count BEFORE triangulation,
            #    so the manifest matches the original table semantics. (.n_cells
            #    of the surface block = the patch's face count.)
            n_faces_original = int(blk.n_cells)

            # 3. Surface (the original polygon cells), then triangulate for the GLB.
            surf = blk.extract_surface(algorithm="dataset_surface")

            # 3b. The true mesh grid: edges of the ORIGINAL cells (no triangulation
            #     diagonals), in the same point space as the triangulated surface.
            edge_verts = extract_edge_vertices(surf)

            tri = surf.triangulate()

            pts = np.asarray(tri.points, dtype=np.float32)

            # PyVista's .faces is a flat array of the form
            # [3, i, j, k, 3, l, m, n, ...] (leading count per face). After
            # triangulate() every face has 3 vertices, so reshape to (n, 4) and
            # drop the leading count column to obtain (n, 3) triangle indices.
            faces_flat = np.asarray(tri.faces)
            if faces_flat.size == 0:
                continue
            tris = faces_flat.reshape(-1, 4)[:, 1:].astype(np.uint32)

            # Skip degenerate patches (0 points or 0 faces after triangulation),
            # matching the original n_cells > 0 spirit.
            if pts.shape[0] == 0 or tris.shape[0] == 0:
                continue

            # 5. Add the patch geometry to the scene under its own node/geom name.
            scene.add_geometry(
                trimesh.Trimesh(vertices=pts, faces=tris, process=False),
                node_name=name,
                geom_name=name,
            )

            edge_count = int(edge_verts.shape[0])
            manifest.append(
                {
                    "name": name,
                    "type": types.get(name, "?"),
                    "nFaces": n_faces_original,
                    # Slice into edges.bin (units = vertices, 3 float32 each).
                    "edgeOffset": total_edge_verts,
                    "edgeCount": edge_count,
                }
            )
            if edge_count:
                edge_chunks.append(edge_verts)
                total_edge_verts += edge_count

        if not manifest:
            sys.stderr.write("KO: no non-empty boundary patches found\n")
            sys.exit(1)

        # Export the GLB (binary glTF). trimesh infers the format from the .glb
        # extension; pass file_type="glb" to be explicit/safe.
        scene.export(out_glb, file_type="glb")

        # Write the cell-edge buffer (raw little-endian float32 endpoint coords)
        # beside the GLB. Best-effort: a failure here just drops the precise grid
        # (the viewer falls back to a client-side overlay), it never fails the run.
        try:
            all_edges = (
                np.concatenate(edge_chunks)
                if edge_chunks
                else np.zeros((0, 3), dtype=np.float32)
            )
            edges_path = os.path.join(os.path.dirname(os.path.abspath(out_glb)), "edges.bin")
            with open(edges_path, "wb") as fh:
                fh.write(all_edges.astype("<f4").tobytes())
        except Exception as edge_err:
            sys.stderr.write("WARN: could not write edges.bin: %s\n" % edge_err)

        import json

        with open(out_manifest, "w") as fh:
            json.dump(manifest, fh)

        sys.stdout.write("OK: %d patches -> %s\n" % (len(manifest), out_glb))
        sys.exit(0)

    except SystemExit:
        # Let our own sys.exit(...) calls propagate unchanged.
        raise
    except Exception as exc:  # noqa: BLE001 - one-shot CLI, report and fail.
        sys.stderr.write("KO: %s\n" % exc)
        sys.exit(1)


if __name__ == "__main__":
    main()

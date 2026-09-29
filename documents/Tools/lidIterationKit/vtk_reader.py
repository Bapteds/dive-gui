"""vtk_reader.py — legacy ASCII VTK polydata reader for OpenFOAM `surfaces` FO exports.

Data contract (task brief + doc §2 "Rules" / §M2 "OpenFOAM/Python"):
input surfaces are OpenFOAM `surfaces` functionObject exports in legacy ASCII
VTK polydata format (POINTS, POLYGONS, CELL_DATA with FIELD data arrays named
U, p, k, omega), one .vtk file per surface, CELL values (``interpolate false``
— doc §2: "Statistics are computed on cell/face data without point
interpolation").

Defensive parsing:
- both "FIELD" and "SCALARS ... / LOOKUP_TABLE" / "VECTORS" / "NORMALS"
  cell-data encodings;
- both classic POLYGONS connectivity ("POLYGONS n size" + count-prefixed
  rows) and the VTK 5.1 legacy layout ("POLYGONS nOffsets nConn" +
  OFFSETS/CONNECTIVITY blocks, written by newer OpenFOAM versions);
- POINT_DATA sections are parsed and stored but NOT used by the metrics
  (no point interpolation anywhere).

numpy only.
"""

import numpy as np

_VTK_DTYPES = {
    "bit", "unsigned_char", "char", "unsigned_short", "short",
    "unsigned_int", "int", "unsigned_long", "long", "float", "double",
    "vtktypeint32", "vtktypeint64", "vtktypeuint32", "vtktypeuint64",
    "vtkidtype",
}


def _tokenize(text):
    """Split body text into tokens (whitespace-separated)."""
    return text.split()


def read_vtk_polydata(path):
    """Read a legacy ASCII VTK polydata file.

    Returns dict with:
      points     (n_pts, 3) float array
      faces      list of int arrays (vertex indices per polygon)
      cell_data  {name: array (n_faces,) or (n_faces, ncomp)}
      point_data {name: array} (parsed, unused by the pipeline)
      header     the title line
    """
    with open(path, "r") as fh:
        lines = fh.read().splitlines()
    if not lines or not lines[0].lstrip().startswith("# vtk DataFile"):
        raise ValueError(f"{path}: not a legacy VTK file (missing '# vtk DataFile' header)")
    title = lines[1] if len(lines) > 1 else ""
    fmt = lines[2].strip().upper() if len(lines) > 2 else ""
    if fmt != "ASCII":
        raise ValueError(f"{path}: only ASCII legacy VTK supported, got '{fmt}'")
    dataset_line = lines[3].split() if len(lines) > 3 else []
    if len(dataset_line) < 2 or dataset_line[0].upper() != "DATASET" \
            or dataset_line[1].upper() != "POLYDATA":
        raise ValueError(f"{path}: DATASET POLYDATA expected, got '{' '.join(dataset_line)}'")

    toks = _tokenize("\n".join(lines[4:]))
    pos = 0
    n_tok = len(toks)

    points = None
    faces = []
    cell_data = {}
    point_data = {}

    def peek():
        return toks[pos] if pos < n_tok else None

    def take(n):
        nonlocal pos
        out = toks[pos:pos + n]
        if len(out) != n:
            raise ValueError(f"{path}: unexpected EOF in VTK body")
        pos += n
        return out

    def read_numbers(n, dtype=float):
        vals = np.array(take(n), dtype=dtype)
        return vals

    def read_field_block(target, n_items):
        """FIELD <name> <numArrays>; arrays: <name> <ncomp> <ntuples> <dtype>."""
        _fieldname, narr_tok = take(2)
        narr = int(narr_tok)
        for _ in range(narr):
            aname, ncomp, ntup, adtype = take(4)
            ncomp, ntup = int(ncomp), int(ntup)
            if adtype.lower() not in _VTK_DTYPES:
                raise ValueError(f"{path}: unknown FIELD dtype '{adtype}'")
            vals = read_numbers(ncomp * ntup)
            if ntup != n_items:
                # tolerate metadata arrays of other lengths; store anyway
                pass
            target[aname] = vals.reshape(ntup, ncomp) if ncomp > 1 else vals

    def read_attribute_section(target, n_items):
        """Parse one CELL_DATA/POINT_DATA attribute; return False if the token
        stream has moved on to a different section."""
        kw = peek()
        if kw is None:
            return False
        kwu = kw.upper()
        nonlocal pos
        if kwu == "FIELD":
            pos += 1
            read_field_block(target, n_items)
            return True
        if kwu == "SCALARS":
            pos += 1
            name, dtype = take(2)
            ncomp = 1
            # optional numComp token (1..4) before LOOKUP_TABLE / data
            nxt = peek()
            if nxt is not None and nxt.upper() != "LOOKUP_TABLE":
                try:
                    maybe = int(nxt)
                    if 1 <= maybe <= 4:
                        ncomp = maybe
                        pos += 1
                except ValueError:
                    pass
            if peek() is not None and peek().upper() == "LOOKUP_TABLE":
                take(2)  # LOOKUP_TABLE <name>
            vals = read_numbers(ncomp * n_items)
            target[name] = vals.reshape(n_items, ncomp) if ncomp > 1 else vals
            return True
        if kwu in ("VECTORS", "NORMALS"):
            pos += 1
            name, _dtype = take(2)
            vals = read_numbers(3 * n_items)
            target[name] = vals.reshape(n_items, 3)
            return True
        if kwu == "LOOKUP_TABLE":
            # standalone lookup table definition: LOOKUP_TABLE name size + 4*size floats
            pos += 1
            _name, size = take(2)
            read_numbers(4 * int(size))
            return True
        return False

    n_faces_declared = None
    while pos < n_tok:
        kw = toks[pos].upper()
        if kw == "POINTS":
            pos += 1
            npts, _dtype = take(2)
            npts = int(npts)
            points = read_numbers(3 * npts).reshape(npts, 3)
        elif kw == "POLYGONS":
            pos += 1
            a, b = int(take(1)[0]), int(take(1)[0])
            if peek() is not None and peek().upper() == "OFFSETS":
                # VTK 5.1 legacy: a = nOffsets, b = nConnectivity
                take(2)  # OFFSETS <dtype>
                offsets = read_numbers(a, dtype=np.int64)
                if peek() is None or peek().upper() != "CONNECTIVITY":
                    raise ValueError(f"{path}: OFFSETS without CONNECTIVITY")
                take(2)  # CONNECTIVITY <dtype>
                conn = read_numbers(b, dtype=np.int64)
                for i in range(a - 1):
                    faces.append(conn[offsets[i]:offsets[i + 1]].astype(np.int64))
            else:
                # classic: a = nPolys, b = total ints
                flat = read_numbers(b, dtype=np.int64)
                i = 0
                for _ in range(a):
                    cnt = int(flat[i])
                    faces.append(flat[i + 1:i + 1 + cnt].copy())
                    i += 1 + cnt
        elif kw in ("VERTICES", "LINES", "TRIANGLE_STRIPS"):
            pos += 1
            a, b = int(take(1)[0]), int(take(1)[0])
            if peek() is not None and peek().upper() == "OFFSETS":
                take(2); read_numbers(a, dtype=np.int64)
                take(2); read_numbers(b, dtype=np.int64)
            else:
                read_numbers(b, dtype=np.int64)
        elif kw == "CELL_DATA":
            pos += 1
            n_items = int(take(1)[0])
            n_faces_declared = n_items
            while read_attribute_section(cell_data, n_items):
                pass
        elif kw == "POINT_DATA":
            pos += 1
            n_items = int(take(1)[0])
            while read_attribute_section(point_data, n_items):
                pass
        elif kw == "FIELD":
            # header-level FIELD block (OpenFOAM writes "FIELD FieldData 1 /
            # TimeValue 1 1 float <t>" before POINTS) — parse and discard
            pos += 1
            take(1)                        # data-set name (e.g. FieldData)
            n_arr = int(take(1)[0])
            for _ in range(n_arr):
                take(1)                    # array name
                ncomp = int(take(1)[0])
                ntup = int(take(1)[0])
                take(1)                    # dtype
                read_numbers(ncomp * ntup)
        elif kw == "METADATA":
            # skip until INFORMATION block ends: crude — skip token pairs until a
            # known section keyword shows up
            pos += 1
            known = {"POINTS", "POLYGONS", "CELL_DATA", "POINT_DATA", "VERTICES",
                     "LINES", "TRIANGLE_STRIPS", "FIELD"}
            while pos < n_tok and toks[pos].upper() not in known:
                pos += 1
        else:
            raise ValueError(f"{path}: unhandled VTK section keyword '{toks[pos]}'")

    if points is None:
        raise ValueError(f"{path}: no POINTS section")
    if n_faces_declared is not None and n_faces_declared != len(faces) and len(faces) > 0:
        raise ValueError(f"{path}: CELL_DATA count {n_faces_declared} != {len(faces)} polygons")
    return {"points": points, "faces": faces, "cell_data": cell_data,
            "point_data": point_data, "header": title}


def face_geometry(points, faces):
    """Per-face centre, scalar area and unit normal.

    Fan triangulation from vertex 0 for polygons with > 3 vertices (task
    brief). Scalar area = sum of triangle areas; normal = normalized sum of
    triangle area vectors; centre = triangle-area-weighted centroid.

    Returns (centres (n,3), areas (n,), normals (n,3)).
    """
    nf = len(faces)
    centres = np.zeros((nf, 3))
    normals = np.zeros((nf, 3))
    areas = np.zeros(nf)
    lens = np.array([len(f) for f in faces], dtype=np.int64)
    if np.any(lens < 3):
        raise ValueError("degenerate polygon with < 3 vertices")
    for L in np.unique(lens):
        idx = np.where(lens == L)[0]
        V = points[np.stack([faces[i] for i in idx])]  # (F, L, 3)
        avec = np.zeros((len(idx), 3))
        cent = np.zeros((len(idx), 3))
        atot = np.zeros(len(idx))
        for i in range(1, L - 1):
            cr = 0.5 * np.cross(V[:, i] - V[:, 0], V[:, i + 1] - V[:, 0])
            ta = np.linalg.norm(cr, axis=1)
            tc = (V[:, 0] + V[:, i] + V[:, i + 1]) / 3.0
            avec += cr
            cent += tc * ta[:, None]
            atot += ta
        areas[idx] = atot
        good = atot > 0
        cent[good] /= atot[good, None]
        cent[~good] = V[~good, 0]
        centres[idx] = cent
        nrm = np.linalg.norm(avec, axis=1)
        nz = nrm > 0
        avec[nz] /= nrm[nz, None]
        normals[idx] = avec
    return centres, areas, normals

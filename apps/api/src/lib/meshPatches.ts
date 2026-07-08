// Discover the boundary patch names of a cfMesh input surface, so the UI can offer
// a per-patch boundary-type editor. Pure parsing, no OpenFOAM toolchain:
//   - FMS: the file starts with the patch list — `<n> ( name type name type … )`.
//   - STL: each `solid <name>` block is one patch (ASCII only; a binary STL has no
//     names, so it yields none and the caller falls back to the file name).
// Best-effort and defensive: malformed input yields an empty list rather than
// throwing, so surfacing the patches never breaks loading a session.

/**
 * Patch names from the header of an FMS surface. The header is
 * `<numPatches> ( name0 type0 name1 type1 … )`; we read the count, then take the
 * patch NAMES (every other token inside the first parenthesised block).
 */
export function parseFmsPatchNames(buffer: Buffer): string[] {
  // The patch block is plain ASCII at the very top even for an otherwise binary FMS.
  const head = buffer.subarray(0, Math.min(buffer.length, 65536)).toString('latin1');
  const m = head.match(/(\d+)\s*\(([\s\S]*?)\)/);
  if (!m) return [];
  const count = Number(m[1]);
  const tokens = m[2].trim().split(/\s+/).filter(Boolean);
  const names: string[] = [];
  for (let i = 0; i + 1 < tokens.length && names.length < count; i += 2) {
    names.push(tokens[i]);
  }
  return names;
}

/** Solid (patch) names of an ASCII STL — each `solid <name>` block is one patch. */
export function parseStlSolidNames(buffer: Buffer): string[] {
  // A binary STL's byte 80 count makes length == 84 + n*50; those have no names.
  if (buffer.length >= 84 && 84 + buffer.readUInt32LE(80) * 50 === buffer.length) return [];
  const text = buffer.toString('utf8');
  const names: string[] = [];
  const re = /^\s*solid\s+(\S+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) names.push(m[1]);
  return names;
}

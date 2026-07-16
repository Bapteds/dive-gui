// Mesh quality rating ("Notation" tab): run `checkMesh -allGeometry` on the
// case mesh, parse the per-criterion figures and grade each one 0-100 + A-E.
//
// This is deliberately separate from checkMeshGate.ts: the gate answers one
// binary question for the sweep ("is a solve possible?"), while the rating
// grades EVERY quality axis for the user. -allGeometry is passed so checkMesh
// also prints face flatness (twisting/folding) and the face volume ratio
// (cell-size uniformity across a face) — neither is in the default output.
// A metric the tool did not print stays null (shown as "not measured"),
// never a fabricated score.
//
// Grading bands follow OpenFOAM's own alarm levels (checkMesh flags skewness
// > 4, non-orthogonality > 70 deg, aspect ratio > 1000, face volume ratio
// < 0.01, face flatness < 0.8): a value at the alarm level lands at the
// bottom of the scale, textbook-good values at the top.
import {
  MESH_QUALITY_CRITERIA,
  type MeshQualityCriterionId,
  type MeshQualityGrade,
  type MeshQualityMetric,
  type MeshQualityResult,
} from '@dive/shared';

/**
 * A float as checkMesh prints it (plain, signed, or exponent form). The decimal
 * part is explicit (`\d+(\.\d+)?`, not `[\d.]+`) so the sentence-ending period
 * after "Total volume = 0.0004." is never captured into the number.
 */
const NUM = String.raw`([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)`;

/** The raw figures parsed out of one checkMesh output (null = not printed). */
export interface CheckMeshFigures {
  points: number | null;
  faces: number | null;
  cells: number | null;
  maxSkewness: number | null;
  highlySkewFaces: number;
  maxNonOrtho: number | null;
  avgNonOrtho: number | null;
  severelyNonOrthoFaces: number;
  minVolume: number | null;
  maxVolume: number | null;
  totalVolume: number | null;
  negativeVolumeCells: number;
  maxAspectRatio: number | null;
  maxOpenness: number | null;
  /** -allGeometry only: min face flatness (1 = flat, 0 = butterfly). */
  minFaceFlatness: number | null;
  avgFaceFlatness: number | null;
  /** -allGeometry only: min adjacent-cell volume ratio across a face (1 = uniform). */
  minFaceVolumeRatio: number | null;
  avgFaceVolumeRatio: number | null;
  /** Faces with wrong-signed pyramid volumes — a folded/inside-out region. */
  pyramidErrorFaces: number;
  meshOk: boolean;
  failedChecks: number;
}

/** First captured group of `re` as a finite number, else null. */
function num(output: string, re: RegExp): number | null {
  const match = output.match(re);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** Like num() but for integer counts that default to 0 when absent. */
function count(output: string, re: RegExp): number {
  const value = num(output, re);
  return value !== null && value >= 0 ? Math.round(value) : 0;
}

/** Parse the figures the rating needs out of raw checkMesh output (pure, testable). */
export function parseCheckMeshFigures(output: string): CheckMeshFigures {
  const volumes = output.match(
    new RegExp(`Min volume = ${NUM}\\. Max volume = ${NUM}\\.\\s*Total volume = ${NUM}`, 'i'),
  );
  const nonOrtho = output.match(new RegExp(`non-orthogonality Max:\\s*${NUM}\\s+average:\\s*${NUM}`, 'i'));
  const flatness = output.match(
    new RegExp(`Face flatness[^:]*:\\s*min = ${NUM}\\s+average = ${NUM}`, 'i'),
  );
  const volumeRatio = output.match(
    new RegExp(`Face volume ratio[^:]*:\\s*minimum:\\s*${NUM}\\s+average:\\s*${NUM}`, 'i'),
  );
  const toNum = (raw: string | undefined): number | null => {
    const value = Number(raw);
    return raw !== undefined && Number.isFinite(value) ? value : null;
  };
  return {
    points: num(output, /^\s*points:\s*(\d+)/im),
    faces: num(output, /^\s*faces:\s*(\d+)/im),
    cells: num(output, /^\s*cells:\s*(\d+)/im),
    maxSkewness: num(output, new RegExp(`Max skewness = ${NUM}`, 'i')),
    highlySkewFaces: count(output, /(\d+)\s+highly skew faces/i),
    maxNonOrtho: toNum(nonOrtho?.[1]),
    avgNonOrtho: toNum(nonOrtho?.[2]),
    severelyNonOrthoFaces: count(output, /severely non-orthogonal[^:]*:\s*(\d+)/i),
    minVolume: toNum(volumes?.[1]),
    maxVolume: toNum(volumes?.[2]),
    totalVolume: toNum(volumes?.[3]),
    negativeVolumeCells: count(output, /negative volume cells:\s*(\d+)/i),
    maxAspectRatio: num(output, new RegExp(`Max aspect ratio = ${NUM}`, 'i')),
    maxOpenness: num(output, new RegExp(`Max cell openness = ${NUM}`, 'i')),
    minFaceFlatness: toNum(flatness?.[1]),
    avgFaceFlatness: toNum(flatness?.[2]),
    minFaceVolumeRatio: toNum(volumeRatio?.[1]),
    avgFaceVolumeRatio: toNum(volumeRatio?.[2]),
    pyramidErrorFaces: count(output, /Error in face pyramids[^\n\d]*(\d+)/i),
    meshOk: /Mesh OK\./.test(output),
    failedChecks: count(output, /Failed\s+(\d+)\s+mesh checks/i),
  };
}

/** Letter grade bands over the 0-100 score. */
export function gradeOf(score: number): MeshQualityGrade {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 50) return 'C';
  if (score >= 30) return 'D';
  return 'E';
}

/** Clamp to [0, 100] and round to the integer the UI displays. */
function clampScore(raw: number): number {
  return Math.round(Math.min(100, Math.max(0, raw)));
}

/** 100 at `best` or better, 0 at `worst` or beyond, linear between (lower = better). */
function linearScore(value: number, best: number, worst: number): number {
  return clampScore(((worst - value) / (worst - best)) * 100);
}

/** Same, but on a log10 axis — for figures that span decades (ratios, volumes). */
function logScore(value: number, best: number, worst: number): number {
  if (value <= 0) return 0;
  const v = Math.log10(value);
  const b = Math.log10(best);
  const w = Math.log10(worst);
  return clampScore(((w - v) / (w - b)) * 100);
}

/** Relative weight of each criterion in the overall rating. */
const WEIGHTS: Record<MeshQualityCriterionId, number> = {
  skewness: 20,
  nonOrthogonality: 20,
  minVolume: 20,
  sizeUniformity: 15,
  twisting: 15,
  aspectRatio: 5,
  openness: 5,
};

/** Build one graded metric (score/grade stay null when the value is null). */
function metric(
  id: MeshQualityCriterionId,
  value: number | null,
  score: number | null,
  detail: string,
  flagged: boolean,
): MeshQualityMetric {
  const bounded = score === null ? null : clampScore(score);
  return { id, value, detail, score: bounded, grade: bounded === null ? null : gradeOf(bounded), flagged };
}

/** Degrees with one decimal, for the non-orthogonality detail line. */
function deg(value: number): string {
  return `${value.toFixed(1)}°`;
}

/**
 * Grade the parsed figures into the full rating (pure, testable). `ranAt` and
 * `command` are threaded through by the caller so this stays deterministic.
 */
export function rateMeshQuality(
  figures: CheckMeshFigures,
  ranAt: string,
  command: string,
  log: string,
): MeshQualityResult {
  const notes: string[] = [];
  const inverted = figures.negativeVolumeCells > 0;
  if (inverted) {
    notes.push(
      `${figures.negativeVolumeCells} negative-volume (inverted) cell(s) — fatal for any solve; the mesh must be rebuilt.`,
    );
  }

  // Skewness: OpenFOAM alarms at 4; below ~1 is textbook-good.
  const skewness = metric(
    'skewness',
    figures.maxSkewness,
    figures.maxSkewness === null ? null : linearScore(figures.maxSkewness, 1, 4),
    figures.highlySkewFaces > 0 ? `${figures.highlySkewFaces} highly skew face(s)` : 'max over all faces',
    figures.highlySkewFaces > 0 || (figures.maxSkewness ?? 0) > 4,
  );

  // Non-orthogonality: alarm at 70 deg; healthy meshes sit below ~40.
  const nonOrthogonality = metric(
    'nonOrthogonality',
    figures.maxNonOrtho,
    figures.maxNonOrtho === null ? null : linearScore(figures.maxNonOrtho, 40, 80),
    [
      figures.avgNonOrtho !== null ? `average ${deg(figures.avgNonOrtho)}` : '',
      figures.severelyNonOrthoFaces > 0 ? `${figures.severelyNonOrthoFaces} face(s) > 70°` : '',
    ]
      .filter(Boolean)
      .join(' · ') || 'max over all internal faces',
    figures.severelyNonOrthoFaces > 0 || (figures.maxNonOrtho ?? 0) > 70,
  );

  // Minimum volume: inverted cells zero it. Otherwise judged RELATIVE to the
  // mean cell volume (an absolute floor would depend on the machine's size):
  // a min cell 100x smaller than the mean is normal grading, 1e8x smaller is a
  // sliver that will wreck the time step.
  const meanVolume =
    figures.totalVolume !== null && figures.cells !== null && figures.cells > 0
      ? figures.totalVolume / figures.cells
      : null;
  let minVolumeScore: number | null = null;
  let minVolumeDetail = 'smallest cell volume';
  if (inverted) {
    minVolumeScore = 0;
    minVolumeDetail = `${figures.negativeVolumeCells} inverted cell(s)`;
  } else if (figures.minVolume !== null && meanVolume !== null && meanVolume > 0) {
    minVolumeScore = logScore(figures.minVolume / meanVolume, 1e-2, 1e-8);
    minVolumeDetail = `${(figures.minVolume / meanVolume).toExponential(1)}× the mean cell volume`;
  } else if (figures.minVolume !== null) {
    // No cell count/total to normalise with — only assert positivity above
    // OpenFOAM's absolute floor (1e-13 m^3 is checkMesh's own limit).
    minVolumeScore = figures.minVolume > 1e-13 ? 85 : 20;
    minVolumeDetail = 'positive (mean cell volume unknown)';
  }
  const minVolume = metric('minVolume', figures.minVolume, minVolumeScore, minVolumeDetail, inverted);

  // Cell-size uniformity: min adjacent-cell volume ratio across a face
  // (1 = perfectly uniform; checkMesh alarms below 0.01). -allGeometry only.
  const sizeUniformity = metric(
    'sizeUniformity',
    figures.minFaceVolumeRatio,
    figures.minFaceVolumeRatio === null ? null : logScore(1 / Math.max(figures.minFaceVolumeRatio, 1e-12), 2, 100),
    figures.avgFaceVolumeRatio !== null
      ? `average ratio ${figures.avgFaceVolumeRatio.toFixed(2)}`
      : 'adjacent-cell volume jump',
    figures.minFaceVolumeRatio !== null && figures.minFaceVolumeRatio < 0.01,
  );

  // Twisting / folding: face flatness (1 = flat, 0 = butterfly) plus the face
  // pyramid check — wrong-signed pyramids ARE a fold, so they zero the score.
  const folded = figures.pyramidErrorFaces > 0 || inverted;
  const twisting = metric(
    'twisting',
    figures.minFaceFlatness,
    folded
      ? 0
      : figures.minFaceFlatness === null
        ? null
        : linearScore(1 - figures.minFaceFlatness, 0.05, 0.5),
    folded
      ? figures.pyramidErrorFaces > 0
        ? `${figures.pyramidErrorFaces} folded face(s) (bad pyramid volume)`
        : 'inverted cells present'
      : figures.avgFaceFlatness !== null
        ? `average flatness ${figures.avgFaceFlatness.toFixed(3)}`
        : 'min face flatness (1 = flat)',
    folded || (figures.minFaceFlatness !== null && figures.minFaceFlatness < 0.8),
  );
  if (folded && figures.pyramidErrorFaces > 0) {
    notes.push(`${figures.pyramidErrorFaces} face(s) failed the pyramid check — a folded/inside-out region.`);
  }

  // Aspect ratio: alarm at 1000; boundary-layer meshes legitimately reach the
  // tens, so the scale is logarithmic from 10 to 1000.
  const aspectRatio = metric(
    'aspectRatio',
    figures.maxAspectRatio,
    figures.maxAspectRatio === null ? null : logScore(Math.max(figures.maxAspectRatio, 1), 10, 1000),
    'max cell aspect ratio',
    (figures.maxAspectRatio ?? 0) > 1000,
  );

  // Cell openness: how far faces are from closing each cell (machine-epsilon
  // on a healthy mesh; checkMesh alarms around 1e-6).
  const openness = metric(
    'openness',
    figures.maxOpenness,
    figures.maxOpenness === null
      ? null
      : figures.maxOpenness <= 0
        ? 100
        : logScore(figures.maxOpenness, 1e-10, 1e-6),
    'max cell openness',
    (figures.maxOpenness ?? 0) > 1e-6,
  );

  const byId: Record<MeshQualityCriterionId, MeshQualityMetric> = {
    skewness,
    nonOrthogonality,
    minVolume,
    sizeUniformity,
    twisting,
    aspectRatio,
    openness,
  };
  const metrics = MESH_QUALITY_CRITERIA.map((id) => byId[id]);

  const missing = metrics.filter((m) => m.score === null);
  if (missing.length > 0 && !inverted) {
    notes.push(
      `Not reported by checkMesh on this mesh: ${missing.map((m) => m.id).join(', ')} (older checkMesh or check not run).`,
    );
  }

  // Overall: weighted mean of the measured criteria — except inverted cells,
  // which make the mesh unusable regardless of every other figure.
  const measured = metrics.filter((m) => m.score !== null);
  let overall: MeshQualityResult['overall'] = { score: null, grade: null };
  if (inverted) {
    overall = { score: 0, grade: 'E' };
  } else if (measured.length > 0) {
    const totalWeight = measured.reduce((sum, m) => sum + WEIGHTS[m.id], 0);
    const score = clampScore(
      measured.reduce((sum, m) => sum + (m.score as number) * WEIGHTS[m.id], 0) / totalWeight,
    );
    overall = { score, grade: gradeOf(score) };
  }

  if (!figures.meshOk && figures.failedChecks > 0 && !inverted) {
    notes.push(`checkMesh flagged ${figures.failedChecks} check(s) — see the log for the exact faces/cells.`);
  }

  return {
    available: true,
    ranAt,
    command,
    meshOk: figures.meshOk,
    failedChecks: figures.failedChecks,
    cells: figures.cells,
    points: figures.points,
    faces: figures.faces,
    negativeVolumeCells: figures.negativeVolumeCells,
    overall,
    metrics,
    notes,
    log,
  };
}

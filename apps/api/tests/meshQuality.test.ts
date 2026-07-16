// Unit tests for the mesh quality rating (lib/meshQuality): the checkMesh
// -allGeometry parser and the per-criterion grading. The invocation is
// OpenFOAM-only; everything graded here is pure.
import { describe, expect, it } from 'vitest';
import { gradeOf, parseCheckMeshFigures, rateMeshQuality } from '../src/lib/meshQuality';

// A realistic, healthy `checkMesh -allGeometry` output (ESI v2406 shapes).
const CLEAN = `
Mesh stats
    points:           125000
    internal points:  0
    faces:            352400
    internal faces:   340000
    cells:            120000
    faces per cell:   6

Checking geometry...
    Overall domain bounding box (0 0 0) (1 0.2 0.2)
    Max cell openness = 2.20675e-16 OK.
    Max aspect ratio = 12.4 OK.
    Minimum face area = 1.9e-06. Maximum face area = 4.5e-06.  Face area magnitudes OK.
    Min volume = 2.5e-09. Max volume = 9.8e-09.  Total volume = 0.0004.  Cell volumes OK.
    Mesh non-orthogonality Max: 38.2 average: 11.4
    Non-orthogonality check OK.
    Face pyramids OK.
    Max skewness = 0.92 OK.
    Face flatness (1 = flat, 0 = butterfly) : min = 0.98  average = 0.999  OK.
    Cell determinant (wellposedness) : minimum: 1.1 average: 4.2
    Cell determinant check OK.
    Face interpolation weight : minimum: 0.41 average: 0.5
    Face interpolation weight check OK.
    Face volume ratio : minimum: 0.62 average: 0.98
    Face volume ratio check OK.

Mesh OK.
`;

// A degraded mesh: high skew/non-ortho, sliver cells, size jumps, near-folds.
const DEGRADED = `
Mesh stats
    points:           50000
    faces:            140000
    cells:            48000

Checking geometry...
    Max cell openness = 3.1e-07 OK.
    Max aspect ratio = 640 OK.
    Min volume = 1e-16. Max volume = 2e-08.  Total volume = 0.0003.  Cell volumes OK.
    Mesh non-orthogonality Max: 74.6 average: 29.8
   *Number of severely non-orthogonal (> 70 degrees) faces: 18.
    Non-orthogonality check OK.
    Face pyramids OK.
 ***Max skewness = 6.2, 4 highly skew faces detected which may impair the quality of the results
    Face flatness (1 = flat, 0 = butterfly) : min = 0.55  average = 0.97  OK.
    Face volume ratio : minimum: 0.008 average: 0.85
   *There are 22 faces with small face volume ratio.

Failed 2 mesh checks.
`;

// Fatal: inverted (negative-volume) cells + folded face pyramids.
const INVERTED = `
Checking geometry...
 ***Zero or negative cell volume detected.  Minimum negative volume: -1.2e-12, Number of negative volume cells: 42
 ***Error in face pyramids: 6 faces are incorrectly oriented.
    Mesh non-orthogonality Max: 88.1 average: 35.0
    Max skewness = 9.4
Failed 3 mesh checks.
`;

describe('parseCheckMeshFigures', () => {
  it('extracts every figure from a clean -allGeometry run', () => {
    const f = parseCheckMeshFigures(CLEAN);
    expect(f.points).toBe(125000);
    expect(f.faces).toBe(352400);
    expect(f.cells).toBe(120000);
    expect(f.maxSkewness).toBeCloseTo(0.92, 5);
    expect(f.maxNonOrtho).toBeCloseTo(38.2, 5);
    expect(f.avgNonOrtho).toBeCloseTo(11.4, 5);
    expect(f.minVolume).toBeCloseTo(2.5e-9, 12);
    expect(f.maxVolume).toBeCloseTo(9.8e-9, 12);
    expect(f.totalVolume).toBeCloseTo(4e-4, 8);
    expect(f.maxAspectRatio).toBeCloseTo(12.4, 5);
    expect(f.maxOpenness).toBeCloseTo(2.20675e-16, 20);
    expect(f.minFaceFlatness).toBeCloseTo(0.98, 5);
    expect(f.avgFaceFlatness).toBeCloseTo(0.999, 5);
    expect(f.minFaceVolumeRatio).toBeCloseTo(0.62, 5);
    expect(f.avgFaceVolumeRatio).toBeCloseTo(0.98, 5);
    expect(f.negativeVolumeCells).toBe(0);
    expect(f.pyramidErrorFaces).toBe(0);
    expect(f.severelyNonOrthoFaces).toBe(0);
    expect(f.highlySkewFaces).toBe(0);
    expect(f.meshOk).toBe(true);
    expect(f.failedChecks).toBe(0);
  });

  it('extracts warning counts and failed checks from a degraded run', () => {
    const f = parseCheckMeshFigures(DEGRADED);
    expect(f.maxSkewness).toBeCloseTo(6.2, 5);
    expect(f.highlySkewFaces).toBe(4);
    expect(f.severelyNonOrthoFaces).toBe(18);
    expect(f.minFaceVolumeRatio).toBeCloseTo(0.008, 6);
    expect(f.meshOk).toBe(false);
    expect(f.failedChecks).toBe(2);
  });

  it('extracts fatal defects (inverted cells, folded pyramids)', () => {
    const f = parseCheckMeshFigures(INVERTED);
    expect(f.negativeVolumeCells).toBe(42);
    expect(f.pyramidErrorFaces).toBe(6);
    expect(f.minVolume).toBeNull(); // the "Min volume = ..." line is not printed on failure
  });

  it('does not misread "Face pyramids OK." followed by later digits as a pyramid error', () => {
    const f = parseCheckMeshFigures('    Face pyramids OK.\n    Max skewness = 1.2 OK.\n');
    expect(f.pyramidErrorFaces).toBe(0);
  });

  it('returns nulls when checkMesh printed nothing useful', () => {
    const f = parseCheckMeshFigures('');
    expect(f.maxSkewness).toBeNull();
    expect(f.maxNonOrtho).toBeNull();
    expect(f.minVolume).toBeNull();
    expect(f.minFaceFlatness).toBeNull();
    expect(f.cells).toBeNull();
  });
});

describe('rateMeshQuality', () => {
  const rate = (raw: string) =>
    rateMeshQuality(parseCheckMeshFigures(raw), '2026-07-16T00:00:00.000Z', 'checkMesh -allGeometry', raw);

  it('grades a clean mesh A overall with every criterion measured', () => {
    const r = rate(CLEAN);
    expect(r.available).toBe(true);
    expect(r.meshOk).toBe(true);
    expect(r.overall.grade).toBe('A');
    expect(r.metrics).toHaveLength(7);
    for (const m of r.metrics) {
      expect(m.score).not.toBeNull();
      expect(m.flagged).toBe(false);
    }
    const ids = r.metrics.map((m) => m.id);
    expect(ids).toEqual([
      'skewness',
      'nonOrthogonality',
      'minVolume',
      'sizeUniformity',
      'twisting',
      'aspectRatio',
      'openness',
    ]);
  });

  it('scores each criterion low and flags it on a degraded mesh', () => {
    const r = rate(DEGRADED);
    const byId = Object.fromEntries(r.metrics.map((m) => [m.id, m]));
    // Skewness 6.2 is beyond OpenFOAM's alarm level of 4 -> floor + flagged.
    expect(byId.skewness.score).toBe(0);
    expect(byId.skewness.flagged).toBe(true);
    // 74.6 deg with 18 severe faces -> low + flagged.
    expect(byId.nonOrthogonality.score).toBeLessThan(30);
    expect(byId.nonOrthogonality.flagged).toBe(true);
    // Min volume 1e-16 vs mean 6.25e-9 -> sliver cells, near the floor.
    expect(byId.minVolume.score).toBeLessThan(15);
    // Face volume ratio 0.008 is under the 0.01 alarm -> floor + flagged.
    expect(byId.sizeUniformity.score).toBe(0);
    expect(byId.sizeUniformity.flagged).toBe(true);
    // Flatness 0.55 is close to the 0.5 floor.
    expect(byId.twisting.score).toBeLessThan(15);
    expect(byId.twisting.flagged).toBe(true);
    expect(r.overall.grade).toBe('E');
    expect(r.failedChecks).toBe(2);
  });

  it('forces the overall grade to E/0 on inverted cells regardless of other figures', () => {
    const r = rate(INVERTED);
    expect(r.negativeVolumeCells).toBe(42);
    expect(r.overall).toEqual({ score: 0, grade: 'E' });
    const byId = Object.fromEntries(r.metrics.map((m) => [m.id, m]));
    expect(byId.minVolume.score).toBe(0);
    expect(byId.minVolume.flagged).toBe(true);
    // Folded pyramids zero the twisting criterion even without a flatness figure.
    expect(byId.twisting.score).toBe(0);
    expect(byId.twisting.flagged).toBe(true);
    expect(r.notes.join(' ')).toMatch(/42 negative-volume/);
    expect(r.notes.join(' ')).toMatch(/6 face\(s\) failed the pyramid check/);
  });

  it('keeps unmeasured criteria null (never fabricates a score) and says so in a note', () => {
    // A default (non -allGeometry) output: no flatness / volume-ratio lines.
    const partial = `
    cells:            1000
    Max cell openness = 1e-16 OK.
    Max aspect ratio = 5 OK.
    Min volume = 1e-09. Max volume = 2e-09.  Total volume = 1.5e-06.  Cell volumes OK.
    Mesh non-orthogonality Max: 30.0 average: 10.0
    Max skewness = 0.5 OK.
Mesh OK.
`;
    const r = rate(partial);
    const byId = Object.fromEntries(r.metrics.map((m) => [m.id, m]));
    expect(byId.sizeUniformity.score).toBeNull();
    expect(byId.sizeUniformity.grade).toBeNull();
    expect(byId.twisting.score).toBeNull();
    expect(r.overall.score).not.toBeNull(); // measured criteria still average
    expect(r.notes.join(' ')).toMatch(/sizeUniformity, twisting/);
  });

  it('rates an empty output with no overall grade at all', () => {
    const r = rate('');
    expect(r.overall).toEqual({ score: null, grade: null });
    expect(r.metrics.every((m) => m.score === null)).toBe(true);
  });
});

describe('gradeOf', () => {
  it('maps the score bands to letters', () => {
    expect(gradeOf(100)).toBe('A');
    expect(gradeOf(85)).toBe('A');
    expect(gradeOf(84)).toBe('B');
    expect(gradeOf(70)).toBe('B');
    expect(gradeOf(69)).toBe('C');
    expect(gradeOf(50)).toBe('C');
    expect(gradeOf(49)).toBe('D');
    expect(gradeOf(30)).toBe('D');
    expect(gradeOf(29)).toBe('E');
    expect(gradeOf(0)).toBe('E');
  });
});

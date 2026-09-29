// Integration tests for the standalone Chamber Creation feature. CadQuery is
// absent in CI / on a dev box, so the command runner is swapped for a fake that
// writes the artifacts the real buildChamber.py would (GLB + manifest + edges +
// exports) into the build's output directory. Exercises auth, the build ->
// hash + 12 outputs response, the render/manifest/edges/export reads, input
// validation, and the clean "builder not found" degradation.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { computeChamberGeneratorDims } from '@dive/shared';
import { app, authHeader, createTestUser, resetDatabase } from './helpers';
import { setCommandRunner, type CommandResult, type CommandRunner } from '../src/lib/commandRunner';
import { storageRoot } from '../src/lib/fileTreeStorage';

/** A valid build body (mid-range inputs; length auto = 2 x width, variant default). */
const BUILD = { x1: 1450, x2: 7.85, x3: 8 };

const MANIFEST = [
  { name: 'inlet', type: 'patch', nFaces: 1, edgeOffset: 0, edgeCount: 0 },
  { name: 'outlet', type: 'patch', nFaces: 1, edgeOffset: 0, edgeCount: 0 },
  { name: 'cylinder_walls', type: 'wall', nFaces: 5, edgeOffset: 0, edgeCount: 0 },
  { name: 'walls', type: 'wall', nFaces: 7, edgeOffset: 0, edgeCount: 0 },
];

function ok(spec: { command: string; args: string[] }): CommandResult {
  return { command: spec.command, args: spec.args, exitCode: 0, stdout: 'OK:', stderr: '', durationMs: 1, timedOut: false };
}

/** Fake builder: writes chamber.glb + manifest.json + edges.bin + exports/*, then succeeds. */
const successRunner: CommandRunner = async (spec) => {
  const outDir = spec.args[2]; // args = [script, paramsJson, outDir]
  const exportsDir = path.join(outDir, 'exports');
  await fs.mkdir(exportsDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'chamber.glb'), Buffer.from('glTF-fake'));
  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(MANIFEST));
  await fs.writeFile(path.join(outDir, 'edges.bin'), Buffer.alloc(0));
  await fs.writeFile(path.join(exportsDir, 'chamber.stl'), 'solid chamber\nendsolid chamber');
  await fs.writeFile(path.join(exportsDir, 'chamber.step'), 'ISO-10303-21;');
  await fs.writeFile(path.join(exportsDir, 'trisurface.zip'), Buffer.from('PK'));
  return ok(spec);
};

/** Fake builder: succeeds like successRunner but emits clamp warnings on both
 * streams, exactly as buildChamber.py does (WARNING: on stdout, WARN: on stderr). */
const warningRunner: CommandRunner = async (spec) => {
  const result = await successRunner(spec);
  return {
    ...result,
    stdout:
      'WARNING: outlet outer radius 0.8400 clamped to 0.6666 (Runner Ø too large for this vane/d_last combination)\nOK: 7 patches\n',
    stderr:
      'WARN: the hollow stack 3.3984 m exceeds H Kammer 2.7000 m; the internal part is scaled to 0.7945 to fit (its heights are reduced to match)\n',
  };
};

/** Fake VANE builder mirroring the real deferred-STEP policy: a plain build
 * writes NO chamber.step and NO build-meta.json; a --step run writes both
 * (stepHasVanes as given, i.e. whether the vane carve succeeded). */
function vaneRunner(stepHasVanes: boolean): CommandRunner {
  return async (spec) => {
    const result = await successRunner(spec);
    const outDir = spec.args[2];
    if (spec.args[3] === '--step') {
      await fs.writeFile(path.join(outDir, 'build-meta.json'), JSON.stringify({ stepHasVanes }));
    } else {
      await fs.rm(path.join(outDir, 'exports', 'chamber.step'), { force: true });
    }
    return result;
  };
}

/** Route builder invocations to `builder` and mirrorStep.py ones to `mirror`
 * (the mirrorer is spawned with args = [script, src.step, dst.step]). */
function withMirrorRunner(builder: CommandRunner, mirror: CommandRunner): CommandRunner {
  return async (spec) =>
    spec.args[0]?.endsWith('mirrorStep.py') ? mirror(spec) : builder(spec);
}

/** Fake mirrorer: writes the destination STEP, then succeeds. */
const mirrorSuccessRunner: CommandRunner = async (spec) => {
  await fs.writeFile(spec.args[2], 'ISO-10303-21; mirrored');
  return ok(spec);
};

/** Fake builder: the interpreter is missing (ENOENT); nothing is written. */
const notFoundRunner: CommandRunner = async (spec) => ({
  command: spec.command,
  args: spec.args,
  exitCode: null,
  stdout: '',
  stderr: '',
  durationMs: 0,
  timedOut: false,
  spawnError: 'ENOENT: command not found',
});

beforeEach(async () => {
  await resetDatabase();
  // Builds are hash-cached on disk; clear them so each test builds fresh (no
  // cross-test cache bleed, e.g. a prior success masking the failure path).
  await fs.rm(path.join(storageRoot(), 'chamber'), { recursive: true, force: true });
  await fs.rm(path.join(storageRoot(), 'chamber-spiral'), { recursive: true, force: true });
});
afterEach(() => setCommandRunner(null));

/** A designSemiSpiral.py result (the stepped-spiral fixture vertices, metres). */
function spiralGeometry(overrides: { widthBinding?: boolean; warnings?: string[] } = {}) {
  const pts: [string, number, number][] = [
    ['V0', -2.7, -2.13664],
    ['V1', -2.7, 0.75],
    ['V2', -1.3, 2.2],
    ['V3', 0.55, 2.2],
    ['V4', 1.7, 1.0],
    ['V5', 1.7, 0.15],
    ['V6', 1.492759, -0.54332],
    ['V7', 1.492759, -0.99332],
    ['V8', 1.7, -1.68664],
    ['V9', 1.7, -2.13664],
  ];
  return {
    inputs: {},
    vertices: pts.map(([id, x, y]) => ({ id, group: 'spiral', x, y, role: 'corner' })),
    dimensions: { width: 4.4, min_x: -2.7, max_x: 1.7, foot_y: -2.13664 },
    quality: {
      worst_area_error_m2: 0.4309,
      at_phi_deg: 219.4,
      width_binding: overrides.widthBinding ?? false,
    },
    algorithm: 'ref-2026-09-22-seed5',
    warnings: overrides.warnings ?? [],
  };
}

/** Route designSemiSpiral.py (args = [script, in.json, out.json]) to a fake that
 * records its inputs and writes `geometry`; everything else goes to `builder`. */
function withSpiralRunner(
  builder: CommandRunner,
  seen: Record<string, unknown>[] = [],
  geometry: object = spiralGeometry(),
  delayMs = 0,
): CommandRunner {
  return async (spec) => {
    if (!spec.args[0]?.endsWith('designSemiSpiral.py')) return builder(spec);
    seen.push(JSON.parse(await fs.readFile(spec.args[1], 'utf8')));
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await fs.writeFile(spec.args[2], JSON.stringify(geometry));
    return ok(spec);
  };
}

/** Records every builder params.json, then succeeds like successRunner. */
function recordingBuilder(seen: Record<string, unknown>[]): CommandRunner {
  return async (spec) => {
    seen.push(JSON.parse(await fs.readFile(spec.args[1], 'utf8')));
    return successRunner(spec);
  };
}

/** A semi-spiral build body (Feet must be off). */
const SPIRAL = { ...BUILD, semiSpiral: true, feetEnabled: false };

describe('Chamber Creation', () => {
  it('requires authentication', async () => {
    await request(app).post('/api/v1/chamber/build').send(BUILD).expect(401);
  });

  it('builds a chamber and returns the hash + twelve outputs', async () => {
    setCommandRunner(successRunner);
    const auth = authHeader(await createTestUser());

    const built = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send(BUILD)
      .expect(200);

    const { hash, outputs } = built.body as { hash: string; outputs: { key: string; final: number }[] };
    expect(hash).toBeTruthy();
    expect(outputs).toHaveLength(12);
    expect(outputs[0].key).toBe('width');
    expect(outputs.every((o) => Number.isFinite(o.final))).toBe(true);

    // Manifest, geometry, edges and an export are all readable for the build.
    const manifest = await request(app)
      .get(`/api/v1/chamber/${hash}/manifest`)
      .set('Authorization', auth)
      .expect(200);
    expect(manifest.body.manifest.patches).toHaveLength(4);
    expect(manifest.body.manifest.patches.map((p: { name: string }) => p.name)).toEqual([
      'inlet',
      'outlet',
      'cylinder_walls',
      'walls',
    ]);

    const geometry = await request(app)
      .get(`/api/v1/chamber/${hash}/geometry`)
      .set('Authorization', auth)
      .expect(200);
    expect(geometry.headers['content-type']).toContain('model/gltf-binary');

    await request(app).get(`/api/v1/chamber/${hash}/edges`).set('Authorization', auth).expect(200);

    const stl = await request(app)
      .get(`/api/v1/chamber/${hash}/export/stl`)
      .set('Authorization', auth)
      .expect(200);
    expect(stl.headers['content-type']).toContain('application/sla');
    // Hash-addressed artifacts are immutable: long-lived private caching.
    expect(stl.headers['cache-control']).toContain('immutable');
    // A clean build reports no warnings (empty list, not undefined).
    expect(built.body.warnings).toEqual([]);
  });

  it('surfaces builder clamp warnings in the response and persists them for cache hits', async () => {
    setCommandRunner(warningRunner);
    const auth = authHeader(await createTestUser());

    const built = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send(BUILD)
      .expect(200);
    // Prefixes are stripped; stderr WARNs come first, then stdout WARNINGs.
    expect(built.body.warnings).toEqual([
      'the hollow stack 3.3984 m exceeds H Kammer 2.7000 m; the internal part is scaled to 0.7945 to fit (its heights are reduced to match)',
      'outlet outer radius 0.8400 clamped to 0.6666 (Runner Ø too large for this vane/d_last combination)',
    ]);

    // The same build again is a cache hit (a failing runner proves the builder is
    // not re-run) — the persisted warnings must still be returned.
    setCommandRunner(notFoundRunner);
    const cached = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send(BUILD)
      .expect(200);
    expect(cached.body.hash).toBe(built.body.hash);
    expect(cached.body.warnings).toEqual(built.body.warnings);
  });

  describe('mirrored STEP (Change rotational direction)', () => {
    const VANES = { ...BUILD, guideVanes: true };

    it('defers the vane STEP: null stepHasVanes at build, meta persisted after generation', async () => {
      const auth = authHeader(await createTestUser());
      setCommandRunner(successRunner);
      const plain = await request(app)
        .post('/api/v1/chamber/build')
        .set('Authorization', auth)
        .send(BUILD)
        .expect(200);
      expect(plain.body.stepHasVanes).toBeNull();

      // A fresh vane build ships no STEP and no meta: stepHasVanes is unknown.
      setCommandRunner(vaneRunner(true));
      const vanes = await request(app)
        .post('/api/v1/chamber/build')
        .set('Authorization', auth)
        .send(VANES)
        .expect(200);
      expect(vanes.body.stepHasVanes).toBeNull();

      // Downloading the STEP re-runs the builder with --step and serves it.
      const step = await request(app)
        .get(`/api/v1/chamber/${vanes.body.hash}/export/step`)
        .set('Authorization', auth)
        .expect(200);
      expect(step.headers['content-disposition']).toContain('chamber.step');

      // Now the meta exists: a cache hit (failing runner proves no re-run)
      // reports stepHasVanes true.
      setCommandRunner(notFoundRunner);
      const cached = await request(app)
        .post('/api/v1/chamber/build')
        .set('Authorization', auth)
        .send(VANES)
        .expect(200);
      expect(cached.body.hash).toBe(vanes.body.hash);
      expect(cached.body.stepHasVanes).toBe(true);
    });

    it('generates the vane STEP once with --step, then serves the cached file', async () => {
      const auth = authHeader(await createTestUser());
      let stepRuns = 0;
      setCommandRunner(
        withMirrorRunner(async (spec) => {
          if (spec.args[3] === '--step') stepRuns += 1;
          return vaneRunner(true)(spec);
        }, mirrorSuccessRunner),
      );
      const built = await request(app)
        .post('/api/v1/chamber/build')
        .set('Authorization', auth)
        .send(VANES)
        .expect(200);
      expect(stepRuns).toBe(0);

      await request(app)
        .get(`/api/v1/chamber/${built.body.hash}/export/step`)
        .set('Authorization', auth)
        .expect(200);
      expect(stepRuns).toBe(1);

      // Second download is served from disk — no new builder run.
      await request(app)
        .get(`/api/v1/chamber/${built.body.hash}/export/step`)
        .set('Authorization', auth)
        .expect(200);
      expect(stepRuns).toBe(1);
    });

    it('one click on the mirrored STEP generates the STEP first, then mirrors, then caches', async () => {
      const auth = authHeader(await createTestUser());
      let stepRuns = 0;
      let mirrorRuns = 0;
      setCommandRunner(
        withMirrorRunner(
          async (spec) => {
            if (spec.args[3] === '--step') stepRuns += 1;
            return vaneRunner(true)(spec);
          },
          async (spec) => {
            mirrorRuns += 1;
            return mirrorSuccessRunner(spec);
          },
        ),
      );
      const built = await request(app)
        .post('/api/v1/chamber/build')
        .set('Authorization', auth)
        .send(VANES)
        .expect(200);

      const first = await request(app)
        .get(`/api/v1/chamber/${built.body.hash}/export/stepMirrored`)
        .set('Authorization', auth)
        .expect(200);
      expect(first.headers['content-type']).toContain('application/step');
      expect(first.headers['content-disposition']).toContain('chamber-mirrored.step');
      expect(stepRuns).toBe(1);
      expect(mirrorRuns).toBe(1);

      // Second download is served from disk — no tool runs again.
      await request(app)
        .get(`/api/v1/chamber/${built.body.hash}/export/stepMirrored`)
        .set('Authorization', auth)
        .expect(200);
      expect(stepRuns).toBe(1);
      expect(mirrorRuns).toBe(1);
    });

    it('merges NEW warnings from the on-demand --step run into the persisted list', async () => {
      const auth = authHeader(await createTestUser());
      const FALLBACK = 'chamber.step falls back to the vane-less solid (no vanes carved)';
      setCommandRunner(
        withMirrorRunner(async (spec) => {
          const result = await vaneRunner(false)(spec);
          // Only the --step re-run discovers the fallback and warns about it.
          return spec.args[3] === '--step' ? { ...result, stderr: `WARN: ${FALLBACK}\n` } : result;
        }, mirrorSuccessRunner),
      );
      const built = await request(app)
        .post('/api/v1/chamber/build')
        .set('Authorization', auth)
        .send(VANES)
        .expect(200);
      expect(built.body.warnings).toEqual([]);

      await request(app)
        .get(`/api/v1/chamber/${built.body.hash}/export/step`)
        .set('Authorization', auth)
        .expect(200);

      // A cache hit now reports the merged warning, exactly once.
      setCommandRunner(notFoundRunner);
      const cached = await request(app)
        .post('/api/v1/chamber/build')
        .set('Authorization', auth)
        .send(VANES)
        .expect(200);
      expect(cached.body.warnings).toEqual([FALLBACK]);
    });

    it('refuses the mirrored STEP for a vane-less fallback or a non-vane build', async () => {
      const auth = authHeader(await createTestUser());
      // The vane carve falls back: the generated STEP downloads fine, but the
      // mirror is refused (meta stepHasVanes false).
      setCommandRunner(withMirrorRunner(vaneRunner(false), mirrorSuccessRunner));
      const fallback = await request(app)
        .post('/api/v1/chamber/build')
        .set('Authorization', auth)
        .send(VANES)
        .expect(200);
      const refused = await request(app)
        .get(`/api/v1/chamber/${fallback.body.hash}/export/stepMirrored`)
        .set('Authorization', auth)
        .expect(409);
      expect(refused.body.error.message).toContain('carries the guide vanes');
      await request(app)
        .get(`/api/v1/chamber/${fallback.body.hash}/export/step`)
        .set('Authorization', auth)
        .expect(200);

      // Non-vane build: STEP exists from build time, mirror refused (no meta).
      setCommandRunner(withMirrorRunner(successRunner, mirrorSuccessRunner));
      const plain = await request(app)
        .post('/api/v1/chamber/build')
        .set('Authorization', auth)
        .send(BUILD)
        .expect(200);
      await request(app)
        .get(`/api/v1/chamber/${plain.body.hash}/export/stepMirrored`)
        .set('Authorization', auth)
        .expect(409);
    });

    it('fails cleanly when the mirrorer errors, and recovers on the next attempt', async () => {
      const auth = authHeader(await createTestUser());
      setCommandRunner(
        withMirrorRunner(vaneRunner(true), async (spec) => ({
          command: spec.command,
          args: spec.args,
          exitCode: 1,
          stdout: '',
          stderr: 'KO: no solids found in chamber.step',
          durationMs: 1,
          timedOut: false,
        })),
      );
      const built = await request(app)
        .post('/api/v1/chamber/build')
        .set('Authorization', auth)
        .send(VANES)
        .expect(200);
      const failed = await request(app)
        .get(`/api/v1/chamber/${built.body.hash}/export/stepMirrored`)
        .set('Authorization', auth)
        .expect(502);
      expect(failed.body.error.message).toBe(
        'Cannot generate the mirrored STEP file. No solids found in chamber.step',
      );

      // The failure left no half-written file: a later attempt regenerates.
      setCommandRunner(withMirrorRunner(vaneRunner(true), mirrorSuccessRunner));
      await request(app)
        .get(`/api/v1/chamber/${built.body.hash}/export/stepMirrored`)
        .set('Authorization', auth)
        .expect(200);
    });
  });

  // The per-hash lock: concurrent work on one build directory must collapse
  // into a single tool run (the second caller re-checks the disk and takes the
  // cache path). The fakes hold the lock across the overlap via a short delay.
  describe('per-hash build lock', () => {
    const VANES = { ...BUILD, guideVanes: true };
    const delay = () => new Promise((resolve) => setTimeout(resolve, 50));

    it('collapses two concurrent identical builds into one builder run', async () => {
      const auth = authHeader(await createTestUser());
      let runs = 0;
      setCommandRunner(async (spec) => {
        runs += 1;
        await delay();
        return successRunner(spec);
      });
      const [a, b] = await Promise.all([
        request(app).post('/api/v1/chamber/build').set('Authorization', auth).send(BUILD),
        request(app).post('/api/v1/chamber/build').set('Authorization', auth).send(BUILD),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body.hash).toBe(b.body.hash);
      expect(runs).toBe(1);
    });

    it('collapses two concurrent first STEP downloads into one --step run', async () => {
      const auth = authHeader(await createTestUser());
      let stepRuns = 0;
      setCommandRunner(
        withMirrorRunner(async (spec) => {
          if (spec.args[3] === '--step') {
            stepRuns += 1;
            await delay();
          }
          return vaneRunner(true)(spec);
        }, mirrorSuccessRunner),
      );
      const built = await request(app)
        .post('/api/v1/chamber/build')
        .set('Authorization', auth)
        .send(VANES)
        .expect(200);
      const url = `/api/v1/chamber/${built.body.hash}/export/step`;
      const [a, b] = await Promise.all([
        request(app).get(url).set('Authorization', auth),
        request(app).get(url).set('Authorization', auth),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(stepRuns).toBe(1);
    });

    it('collapses two concurrent mirrored-STEP downloads into one generation chain', async () => {
      const auth = authHeader(await createTestUser());
      let stepRuns = 0;
      let mirrorRuns = 0;
      setCommandRunner(
        withMirrorRunner(
          async (spec) => {
            if (spec.args[3] === '--step') stepRuns += 1;
            return vaneRunner(true)(spec);
          },
          async (spec) => {
            mirrorRuns += 1;
            await delay();
            return mirrorSuccessRunner(spec);
          },
        ),
      );
      const built = await request(app)
        .post('/api/v1/chamber/build')
        .set('Authorization', auth)
        .send(VANES)
        .expect(200);
      const url = `/api/v1/chamber/${built.body.hash}/export/stepMirrored`;
      const [a, b] = await Promise.all([
        request(app).get(url).set('Authorization', auth),
        request(app).get(url).set('Authorization', auth),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(stepRuns).toBe(1);
      expect(mirrorRuns).toBe(1);
    });
  });

  it('refuses a build whose model finals go non-positive, before any builder run', async () => {
    // The failing runner proves the refusal happens pre-build (else 502).
    setCommandRunner(notFoundRunner);
    const auth = authHeader(await createTestUser());
    const res = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      // Legal inputs whose own H Kammer fit is ≈ -3442 mm with relations off.
      .send({ x1: 700, x2: 1.8, x3: 23, relationsMaster: false })
      .expect(422);
    expect(res.body.error.message).toContain('H Kammer');
    expect(res.body.error.message).toContain('come out at 0 mm or below');
  });

  it('refuses a Closed generator H Kammer below LEB + the Gen Dim height, before any builder run', async () => {
    setCommandRunner(notFoundRunner);
    const auth = authHeader(await createTestUser());
    const res = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, constraints: { height: { exact: 1800 } } })
      .expect(422);
    expect(res.body.error.message).toContain('is too low for the generator');
  });

  it('refuses a Runner case Ø below LE Ø with guide vanes, before any builder run', async () => {
    let calls = 0;
    setCommandRunner(async (spec) => {
      calls += 1;
      return notFoundRunner(spec);
    });
    const auth = authHeader(await createTestUser());
    const res = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, guideVanes: true, dFirst: 1450, constraints: { dLast: { exact: 1600 } } })
      .expect(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain(
      'Runner case Ø (1450 mm) must be at least LE Ø (1600 mm)',
    );
    expect(res.body.error.message).toContain('or turn Guide vanes off.');
    expect(calls).toBe(0);
  });

  it('refuses an inverted Min>Max constraint range, before any builder run', async () => {
    setCommandRunner(notFoundRunner);
    const auth = authHeader(await createTestUser());
    const res = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, constraints: { width: { min: 5000, max: 4000 } } })
      .expect(422);
    expect(res.body.error.message).toContain('B Kammer');
    expect(res.body.error.message).toContain('Min 5000 > Max 4000');
  });

  it('rejects non-positive and absurdly large dimensions at the schema', async () => {
    const auth = authHeader(await createTestUser());
    await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, constraints: { width: { exact: -100 } } })
      .expect(422);
    await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, constraints: { height: { max: 0 } } })
      .expect(422);
    await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, dFirst: 200_000 })
      .expect(422);
  });

  it('applies a Min/Max/Exact constraint to the returned outputs', async () => {
    setCommandRunner(successRunner);
    const auth = authHeader(await createTestUser());
    const built = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, constraints: { width: { exact: 3000 } } })
      .expect(200);
    const width = (built.body.outputs as { key: string; final: number; status: string }[]).find(
      (o) => o.key === 'width',
    )!;
    expect(width.final).toBe(3000);
    expect(width.status).toBe('set exact');
  });

  it('refines a paired output from a partner Exact, and opts out on request', async () => {
    setCommandRunner(successRunner);
    const auth = authHeader(await createTestUser());

    // A known Chamfer-1 side distance (Exact) sharpens Width via interdependency.
    const refined = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, constraints: { distFromSideChamfer1: { exact: 2000 } } })
      .expect(200);
    const rWidth = (refined.body.outputs as { key: string; model: number; refined: boolean }[]).find(
      (o) => o.key === 'width',
    )!;
    expect(rWidth.refined).toBe(true);
    expect(rWidth.model).toBeCloseTo(4249.44, 0);

    // Turning the master relations switch off ignores the partner and falls back
    // to the pure X1/X2/X3 fit.
    const optedOut = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, relationsMaster: false, constraints: { distFromSideChamfer1: { exact: 2000 } } })
      .expect(200);
    const oWidth = (optedOut.body.outputs as { key: string; model: number; refined: boolean }[]).find(
      (o) => o.key === 'width',
    )!;
    expect(oWidth.refined).toBe(false);
    expect(oWidth.model).toBeCloseTo(4444.44, 0);
  });

  it('accepts a foot angle and keys the build on it', async () => {
    setCommandRunner(successRunner);
    const auth = authHeader(await createTestUser());

    const a45 = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, footAngleDeg: 45 })
      .expect(200);
    const a135 = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, footAngleDeg: 135 })
      .expect(200);

    // Different foot orientation => different geometry => different cache key.
    expect(a45.body.hash).not.toBe(a135.body.hash);
  });

  it('keys the build on the guide-vanes flag', async () => {
    setCommandRunner(successRunner);
    const auth = authHeader(await createTestUser());

    const off = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send(BUILD)
      .expect(200);
    const on = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, guideVanes: true })
      .expect(200);

    // Guide vanes change the geometry => a different cache key, same 12 outputs.
    expect(on.body.hash).not.toBe(off.body.hash);
    expect(on.body.outputs).toHaveLength(12);
  });

  it('keys the build on the chamfer-enabled flag, defaulting to on', async () => {
    setCommandRunner(successRunner);
    const auth = authHeader(await createTestUser());

    const enabled = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send(BUILD)
      .expect(200);
    const disabled = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, chamferEnabled: false })
      .expect(200);

    // Disabling the chamfer changes the geometry => a different cache key,
    // but the twelve outputs (the model) are untouched either way.
    expect(enabled.body.hash).not.toBe(disabled.body.hash);
    expect(disabled.body.outputs).toEqual(enabled.body.outputs);
  });

  it('keys the build on the feet-enabled flag, defaulting to on', async () => {
    setCommandRunner(successRunner);
    const auth = authHeader(await createTestUser());

    const enabled = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send(BUILD)
      .expect(200);
    const disabled = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, feetEnabled: false })
      .expect(200);

    // Removing the feet changes the geometry => a different cache key, but the
    // twelve outputs (the model) are untouched either way.
    expect(enabled.body.hash).not.toBe(disabled.body.hash);
    expect(disabled.body.outputs).toEqual(enabled.body.outputs);
  });

  it('accepts an outlet ratio and keys the build on it', async () => {
    setCommandRunner(successRunner);
    const auth = authHeader(await createTestUser());

    const r35 = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, guideVanes: true, outletRatio: 0.35 })
      .expect(200);
    const r50 = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, guideVanes: true, outletRatio: 0.5 })
      .expect(200);

    // Different outlet ratio => different geometry => different cache key.
    expect(r35.body.hash).not.toBe(r50.body.hash);
  });

  it('keys a guide-vane build on the vane count, 16 = omitted', async () => {
    const seen: Record<string, unknown>[] = [];
    setCommandRunner(async (spec) => {
      seen.push(JSON.parse(await fs.readFile(spec.args[1], 'utf8')));
      return successRunner(spec);
    });
    const auth = authHeader(await createTestUser());
    const vanes = { ...BUILD, guideVanes: true };

    const plain = await request(app).post('/api/v1/chamber/build').set('Authorization', auth).send(vanes).expect(200);
    const n16 = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...vanes, vaneCount: 16 })
      .expect(200);
    const n18 = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...vanes, vaneCount: 18 })
      .expect(200);

    // 16 is the asset's own count: no key change, so no existing vane build is rebuilt.
    expect(n16.body.hash).toBe(plain.body.hash);
    expect(n18.body.hash).not.toBe(plain.body.hash);
    expect(n18.body.outputs).toEqual(plain.body.outputs);
    expect(n18.body.outputs).toHaveLength(12);
    // Only the 18-vane build reached the builder (16 was a cache hit) and it carries the count.
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toHaveProperty('vaneCount');
    expect(seen[1].vaneCount).toBe(18);
  });

  it('ignores the vane count without guide vanes', async () => {
    setCommandRunner(successRunner);
    const auth = authHeader(await createTestUser());

    const plain = await request(app).post('/api/v1/chamber/build').set('Authorization', auth).send(BUILD).expect(200);
    const n18 = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, vaneCount: 18 })
      .expect(200);
    expect(n18.body.hash).toBe(plain.body.hash);
  });

  it('rejects a vane count other than 16 or 18', async () => {
    const auth = authHeader(await createTestUser());
    const res = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, guideVanes: true, vaneCount: 17 })
      .expect(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('keys the build on the manual runner-case / guide-vanes diameter overrides', async () => {
    setCommandRunner(successRunner);
    const auth = authHeader(await createTestUser());

    const auto = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send(BUILD)
      .expect(200);
    const dFirst = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, dFirst: 3000 })
      .expect(200);
    const dMiddle = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, dMiddle: 2000 })
      .expect(200);

    // Each override changes the geometry => a distinct cache key, but the twelve
    // model outputs are untouched (these are geometry-only overrides).
    expect(dFirst.body.hash).not.toBe(auto.body.hash);
    expect(dMiddle.body.hash).not.toBe(auto.body.hash);
    expect(dFirst.body.hash).not.toBe(dMiddle.body.hash);
    expect(dFirst.body.outputs).toEqual(auto.body.outputs);
  });

  it('keys the hollow build on the generator diameter / height / dome overrides', async () => {
    setCommandRunner(successRunner);
    const auth = authHeader(await createTestUser());
    const hollow = { ...BUILD, variant: 'hollow', hollowLength: 2000 };

    const auto = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send(hollow)
      .expect(200);
    const overridden = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...hollow, centralDiameter: 900, centralHeight: 1200, domeHeight: 250 })
      .expect(200);

    // The generator/dome overrides reshape the hollow geometry => a different key.
    expect(overridden.body.hash).not.toBe(auto.body.hash);
    expect(overridden.body.outputs).toEqual(auto.body.outputs);
  });

  it('keys the hollow build on x4 (a new frame) but ignores x4 on stepped', async () => {
    setCommandRunner(successRunner);
    const auth = authHeader(await createTestUser());
    const hollow = { ...BUILD, variant: 'hollow', hollowLength: 2000 };

    const auto = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send(hollow)
      .expect(200);
    // BUILD's auto X4 ~ 554 -> frame 62; x4 2000 -> frame 115 -> new generator dims.
    const powered = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...hollow, x4: 2000 })
      .expect(200);
    expect(powered.body.hash).not.toBe(auto.body.hash);
    expect(powered.body.outputs).toEqual(auto.body.outputs);

    // Stepped builds have no generator: x4 must not enter the cache key.
    const stepped = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send(BUILD)
      .expect(200);
    const steppedX4 = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, x4: 2000 })
      .expect(200);
    expect(steppedX4.body.hash).toBe(stepped.body.hash);
  });

  it('keys the hollow build on Simplify Generator and drops the hidden heights from the key', async () => {
    setCommandRunner(successRunner);
    const auth = authHeader(await createTestUser());
    const hollow = { ...BUILD, variant: 'hollow', hollowLength: 2000 };

    const domed = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send(hollow)
      .expect(200);
    const simplified = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...hollow, simplifyGenerator: true })
      .expect(200);
    // The flag reshapes the geometry => a different cache key.
    expect(simplified.body.hash).not.toBe(domed.body.hash);

    // The hidden dome is ignored while the flag is on => the SAME cache key.
    const simplifiedDome = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...hollow, simplifyGenerator: true, domeHeight: 250 })
      .expect(200);
    expect(simplifiedDome.body.hash).toBe(simplified.body.hash);
    // A typed generator height closes the simplified generator => a new key.
    const simplifiedHeight = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...hollow, simplifyGenerator: true, centralHeight: 1200 })
      .expect(200);
    expect(simplifiedHeight.body.hash).not.toBe(simplified.body.hash);

    // With the flag off a height override still re-keys (existing behavior).
    const domedHeights = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...hollow, centralHeight: 1200 })
      .expect(200);
    expect(domedHeights.body.hash).not.toBe(domed.body.hash);

    // Stepped builds have no generator: the flag must not enter the cache key.
    const stepped = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send(BUILD)
      .expect(200);
    const steppedFlag = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, simplifyGenerator: true })
      .expect(200);
    expect(steppedFlag.body.hash).toBe(stepped.body.hash);
  });

  // Cone chamfer (spec 2026-09-29-cone-foot-chamfer): a 45° foot chamfer on the
  // lower outer edge of the LE part, in BOTH designs.
  const CHAMFER_DESIGNS = [
    ['Closed generator', { ...BUILD }],
    ['With cone', { ...BUILD, variant: 'hollow', hollowLength: 2000 }],
  ] as const;

  it.each(CHAMFER_DESIGNS)(
    'keys the %s build on the cone chamfer only when it is on',
    async (_design, base) => {
      const seen: Record<string, unknown>[] = [];
      setCommandRunner(async (spec) => {
        seen.push(JSON.parse(await fs.readFile(spec.args[1], 'utf8')));
        return successRunner(spec);
      });
      const auth = authHeader(await createTestUser());
      const build = (body: object) =>
        request(app).post('/api/v1/chamber/build').set('Authorization', auth).send(body).expect(200);

      const plain = await build(base);
      // Off (any size): no key added, so no existing build is rebuilt.
      const off = await build({ ...base, coneChamferEnabled: false, coneChamferSize: 80 });
      expect(off.body.hash).toBe(plain.body.hash);

      const on50 = await build({ ...base, coneChamferEnabled: true, coneChamferSize: 50 });
      expect(on50.body.hash).not.toBe(plain.body.hash);
      expect(on50.body.outputs).toEqual(plain.body.outputs);
      expect(on50.body.outputs).toHaveLength(12);
      // Only plain and on50 reached the builder; the off request was a cache hit.
      expect(seen).toHaveLength(2);
      expect(seen[0]).not.toHaveProperty('coneChamferEnabled');
      expect(seen[0]).not.toHaveProperty('coneChamferSize');
      expect(seen[1].coneChamferEnabled).toBe(true);
      expect(seen[1].coneChamferSize).toBeCloseTo(0.05, 12);

      // Enabled with a blank size = enabled at the default 50 mm.
      const onBlank = await build({ ...base, coneChamferEnabled: true });
      expect(onBlank.body.hash).toBe(on50.body.hash);
      // A different size is a different build.
      const on30 = await build({ ...base, coneChamferEnabled: true, coneChamferSize: 30 });
      expect(on30.body.hash).not.toBe(on50.body.hash);
    },
  );

  it.each(CHAMFER_DESIGNS)(
    'rejects a non-positive cone chamfer size (%s)',
    async (_design, base) => {
      const auth = authHeader(await createTestUser());
      const res = await request(app)
        .post('/api/v1/chamber/build')
        .set('Authorization', auth)
        .send({ ...base, coneChamferEnabled: true, coneChamferSize: 0 })
        .expect(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
  );

  it('passes a typed Closed generator height to the builder (blank keeps the old key)', async () => {
    const seen: Record<string, unknown>[] = [];
    setCommandRunner(async (spec) => {
      seen.push(JSON.parse(await fs.readFile(spec.args[1], 'utf8')));
      return successRunner(spec);
    });
    const auth = authHeader(await createTestUser());

    const pinned = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send(BUILD)
      .expect(200);
    expect(seen[0]).not.toHaveProperty('centralHeight');

    const closed = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, centralHeight: 1500 })
      .expect(200);
    expect(closed.body.hash).not.toBe(pinned.body.hash);
    expect(seen[1].centralHeight).toBeCloseTo(1.5, 9);
  });

  it('resolves blank generator dims from the shared Gen Dim model', async () => {
    setCommandRunner(successRunner);
    const auth = authHeader(await createTestUser());
    const hollow = { ...BUILD, variant: 'hollow', hollowLength: 2000 };

    const auto = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send(hollow)
      .expect(200);
    // Sending the model's own resolved values EXPLICITLY must land on the same
    // cache key — proof the API resolves blanks through the shared function.
    const gen = computeChamberGeneratorDims({ x1: BUILD.x1, x2: BUILD.x2, x3: BUILD.x3 });
    const explicit = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({
        ...hollow,
        centralDiameter: gen.resolved.centralDiameter,
        centralHeight: gen.resolved.centralHeight,
        domeHeight: gen.resolved.domeHeight,
      })
      .expect(200);
    expect(explicit.body.hash).toBe(auto.body.hash);
  });

  it.each([0, -5, 100_001])('rejects x4 = %s', async (x4) => {
    const auth = authHeader(await createTestUser());
    await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, variant: 'hollow', hollowLength: 2000, x4 })
      .expect(422);
  });

  it('rejects an outlet ratio outside 0.35-0.50', async () => {
    const auth = authHeader(await createTestUser());
    await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, guideVanes: true, outletRatio: 0.6 })
      .expect(422);
  });

  it('rejects a foot angle outside 0–180', async () => {
    const auth = authHeader(await createTestUser());
    await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, footAngleDeg: 200 })
      .expect(422);
  });

  it('builds the hollow variant when a hollow length is given', async () => {
    setCommandRunner(successRunner);
    const auth = authHeader(await createTestUser());
    const res = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, variant: 'hollow', hollowLength: 2000 })
      .expect(200);
    expect(res.body.hash).toBeTruthy();
    expect(res.body.outputs).toHaveLength(12);
  });

  it('rejects the hollow variant without a hollow length', async () => {
    const auth = authHeader(await createTestUser());
    await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, variant: 'hollow' })
      .expect(422);
  });

  it('returns CHAMBER_BUILD_FAILED when the builder cannot run', async () => {
    setCommandRunner(notFoundRunner);
    const auth = authHeader(await createTestUser());
    const res = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send(BUILD)
      .expect(502);
    expect(res.body.error.code).toBe('CHAMBER_BUILD_FAILED');
  });

  it('rejects an out-of-range input', async () => {
    const auth = authHeader(await createTestUser());
    await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, x1: 99999 })
      .expect(422);
  });

  describe('semi-spiral casing (spec 2026-09-29-semi-spiral-casing)', () => {
    const post = (auth: string, body: object) =>
      request(app).post('/api/v1/chamber/build').set('Authorization', auth).send(body);

    it('designs the spiral once, feeds its vertices to the builder and answers the derived values', async () => {
      const spiralRuns: Record<string, unknown>[] = [];
      const params: Record<string, unknown>[] = [];
      setCommandRunner(withSpiralRunner(recordingBuilder(params), spiralRuns));
      const auth = authHeader(await createTestUser());

      const res = await post(auth, SPIRAL).expect(200);
      const outputs = res.body.outputs as { key: string; final: number; status: string }[];
      const final = (k: string) => outputs.find((o) => o.key === k)!.final;

      // The tool inputs (spec section 4): Q_max, H Kammer, 2 x the widest part
      // (auto runner case = 1.14703 x LE), 200 mm, B Kammer, 0.922 m/s, 160 deg.
      expect(spiralRuns).toHaveLength(1);
      expect(spiralRuns[0]).toEqual({
        Q: 8,
        c_flow: 0.922,
        H_ch: final('height') / 1000,
        D_LE: (1.14703 * final('dLast')) / 1000,
        clearance: 0.2,
        max_width: final('width') / 1000,
        phi_start: 160,
      });

      // The builder gets the frozen vertices; the box keys the spiral replaces
      // are left out of its params (and of the build key).
      expect(params).toHaveLength(1);
      const p = params[0];
      expect(p.semiSpiral).toBe(true);
      const spiral = p.spiral as { inputs: object; vertices: { id: string }[]; quality: object };
      expect(spiral.inputs).toEqual(spiralRuns[0]);
      expect(spiral.vertices.map((v) => v.id)).toEqual(
        ['V0', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9'],
      );
      expect(spiral.vertices[0]).toEqual({ id: 'V0', x: -2.7, y: -2.13664 });
      expect(spiral.quality).toEqual({
        worst_area_error_m2: 0.4309,
        at_phi_deg: 219.4,
        width_binding: false,
      });
      for (const key of [
        'length',
        'distFromSideChamfer1',
        'distFromEnd',
        'chamferLength1',
        'chamferWidth1',
        'chamferLength2',
        'chamferWidth2',
        'chamferEnabled',
      ]) {
        expect(p).not.toHaveProperty(key);
      }
      expect(p.width).toBeCloseTo(final('width') / 1000, 12); // the width LIMIT
      expect(p.feetEnabled).toBe(false);

      // The response: spiral quality + the derived box (mm), and the derived
      // rows carry their spiral value with the 'from spiral' status.
      expect(res.body.spiral).toMatchObject({
        widthMm: 4400,
        worstAreaErrorM2: 0.4309,
        atPhiDeg: 219.4,
        widthBinding: false,
      });
      expect(res.body.spiral.boxMm.length).toBeCloseTo(4336.64, 6);
      expect(res.body.spiral.boxMm.distFromEnd).toBeCloseTo(2200, 6);
      const lt = outputs.find((o) => o.key === 'distFromEnd')!;
      expect(lt.status).toBe('from spiral');
      expect(lt.final).toBeCloseTo(2200, 6);
      expect(outputs.find((o) => o.key === 'chamferWidth2')!.final).toBeCloseTo(1150, 6);
      expect(outputs.find((o) => o.key === 'width')!.status).not.toBe('from spiral');
      expect(res.body.warnings).toEqual([]);

      // A change that leaves the spiral inputs alone (the vane angle) reuses
      // the cached spiral: a new build, no new optimisation.
      const angled = await post(auth, { ...SPIRAL, vaneAngleDeg: 52 }).expect(200);
      expect(angled.body.hash).not.toBe(res.body.hash);
      expect(params).toHaveLength(2);
      expect(spiralRuns).toHaveLength(1);
      expect(params[1].spiral).toEqual(p.spiral);

      // A new casing flow velocity is a new spiral (and a new build).
      const slower = await post(auth, { ...SPIRAL, spiralFlowVelocity: 0.7 }).expect(200);
      expect(slower.body.hash).not.toBe(res.body.hash);
      expect(spiralRuns).toHaveLength(2);
      expect(spiralRuns[1].c_flow).toBe(0.7);
    });

    it('leaves every build without the spiral on its old key', async () => {
      const params: Record<string, unknown>[] = [];
      setCommandRunner(withSpiralRunner(recordingBuilder(params)));
      const auth = authHeader(await createTestUser());
      const plain = await post(auth, BUILD).expect(200);
      const off = await post(auth, { ...BUILD, semiSpiral: false, spiralFlowVelocity: 1.5 }).expect(200);
      expect(off.body.hash).toBe(plain.body.hash);
      expect(params).toHaveLength(1);
      expect(params[0]).not.toHaveProperty('semiSpiral');
      expect(params[0]).not.toHaveProperty('spiral');
      expect(plain.body.spiral).toBeNull();
    });

    it('does not re-key on the box values the spiral replaces', async () => {
      const spiralRuns: Record<string, unknown>[] = [];
      setCommandRunner(withSpiralRunner(successRunner, spiralRuns));
      const auth = authHeader(await createTestUser());
      const base = await post(auth, SPIRAL).expect(200);
      const edited = await post(auth, {
        ...SPIRAL,
        lengthOverride: 12000,
        chamferEnabled: false,
        constraints: {
          distFromSideChamfer1: { exact: 1234 },
          distFromEnd: { exact: 2345 },
          chamferLength1: { min: 900, max: 100 }, // inverted: exempt while derived
          chamferWidth2: { exact: 321 },
        },
      }).expect(200);
      expect(edited.body.hash).toBe(base.body.hash);
      expect(spiralRuns).toHaveLength(1);
      // The same inverted range without the spiral is still refused.
      await post(auth, { ...BUILD, constraints: { chamferLength1: { min: 900, max: 100 } } }).expect(422);
    });

    it('refuses Feet on with the spiral, including the API default (on)', async () => {
      setCommandRunner(notFoundRunner);
      const auth = authHeader(await createTestUser());
      for (const body of [{ ...BUILD, semiSpiral: true }, { ...SPIRAL, feetEnabled: true }]) {
        const res = await post(auth, body).expect(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.message).toContain(
          'The semi-spiral casing needs Feet off for now. Uncheck Feet, or uncheck Semi-spiral casing.',
        );
      }
    });

    it('rejects a casing flow velocity outside 0.3-3 m/s', async () => {
      const auth = authHeader(await createTestUser());
      for (const v of [0.2, 3.5, 0]) {
        const res = await post(auth, { ...SPIRAL, spiralFlowVelocity: v }).expect(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('persists and replays the width-limit warning of the spiral step', async () => {
      const warning =
        'The semi-spiral casing is limited by B Kammer (4450 mm): worst cross-section error 0.88 m² at 160°. Raise B Kammer to reduce it.';
      setCommandRunner(
        withSpiralRunner(warningRunner, [], spiralGeometry({ widthBinding: true, warnings: [warning] })),
      );
      const auth = authHeader(await createTestUser());
      const built = await post(auth, SPIRAL).expect(200);
      expect(built.body.warnings[0]).toBe(warning);
      expect(built.body.warnings).toHaveLength(3); // + the two builder warnings
      expect(built.body.spiral.widthBinding).toBe(true);

      setCommandRunner(notFoundRunner);
      const cached = await post(auth, SPIRAL).expect(200);
      expect(cached.body.hash).toBe(built.body.hash);
      expect(cached.body.warnings).toEqual(built.body.warnings);
      expect(cached.body.spiral).toEqual(built.body.spiral);
    });

    it('shows the spiral refusal alone and never runs the builder', async () => {
      let builds = 0;
      setCommandRunner(async (spec) => {
        if (spec.args[0]?.endsWith('designSemiSpiral.py')) {
          return {
            ...ok(spec),
            exitCode: 1,
            stdout: '',
            stderr:
              'KO: The semi-spiral casing does not fit in B Kammer (4450 mm): the narrowest valid spiral for these inputs is 5012 mm wide. Raise B Kammer to at least 5012 mm.\n',
          };
        }
        builds += 1;
        return successRunner(spec);
      });
      const auth = authHeader(await createTestUser());
      const res = await post(auth, SPIRAL).expect(502);
      expect(res.body.error.code).toBe('CHAMBER_BUILD_FAILED');
      expect(res.body.error.message).toBe(
        'Cannot build the chamber. The semi-spiral casing does not fit in B Kammer (4450 mm): the narrowest valid spiral for these inputs is 5012 mm wide. Raise B Kammer to at least 5012 mm.',
      );
      expect(builds).toBe(0);
    });

    it('reports a spiral step that runs out of time in plain words', async () => {
      setCommandRunner(async (spec) =>
        spec.args[0]?.endsWith('designSemiSpiral.py')
          ? { ...ok(spec), exitCode: null, timedOut: true }
          : successRunner(spec),
      );
      const auth = authHeader(await createTestUser());
      const res = await post(auth, SPIRAL).expect(502);
      expect(res.body.error.code).toBe('CHAMBER_BUILD_FAILED');
      expect(res.body.error.message).toContain('semi-spiral');
      expect(res.body.error.message).toContain('CHAMBER_SPIRAL_TIMEOUT_MS');
    });

    it('runs one optimisation for concurrent builds sharing a spiral (per-spiral lock)', async () => {
      const spiralRuns: Record<string, unknown>[] = [];
      setCommandRunner(withSpiralRunner(successRunner, spiralRuns, spiralGeometry(), 50));
      const auth = authHeader(await createTestUser());
      const [a, b] = await Promise.all([
        post(auth, SPIRAL),
        post(auth, { ...SPIRAL, vaneAngleDeg: 52 }),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body.hash).not.toBe(b.body.hash);
      expect(spiralRuns).toHaveLength(1);
    });
  });
});

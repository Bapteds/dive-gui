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
      'WARNING: outlet outer radius 0.8400 clamped to 0.6666 (X1 too large for this vane/d_last combination)\nOK: 7 patches\n',
    stderr:
      'WARN: the hollow stack 3.3984 m exceeds H Kammer 2.7000 m; the internal part is scaled to 0.7945 to fit (its heights are reduced to match)\n',
  };
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
});
afterEach(() => setCommandRunner(null));

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
      'outlet outer radius 0.8400 clamped to 0.6666 (X1 too large for this vane/d_last combination)',
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
});

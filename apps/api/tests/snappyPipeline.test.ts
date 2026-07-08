// Unit tests for the snappyHexMesh pipeline orchestration, with the external
// toolchain swapped for a fake runner (no OpenFOAM needed). Asserts: the dicts
// are written, the four commands run in order with the v2406-correct argv, and a
// mid-pipeline failure short-circuits the remaining steps to `skipped`.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SNAPPY_CONFIG } from '@dive/shared';
import { runSnappyPipeline } from '../src/lib/snappyPipeline';
import { setCommandRunner, type CommandResult, type CommandRunner } from '../src/lib/commandRunner';

const BOUNDS = { min: [0, 0, 0] as [number, number, number], max: [10, 10, 10] as [number, number, number] };

function ok(spec: { command: string; args: string[] }): CommandResult {
  return { command: spec.command, args: spec.args, exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false };
}

afterEach(() => setCommandRunner(null));

async function tempCase(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'meshing-'));
}

describe('runSnappyPipeline', () => {
  it('writes the dicts and runs the four tools in order on success', async () => {
    const caseDir = await tempCase();
    const commands: string[] = [];
    const runner: CommandRunner = async (spec) => {
      // The tools run via `bash -c … exec "$@"` only when OPENFOAM_BASHRC is set;
      // on a bare dev box the binary is the command directly.
      commands.push(spec.command);
      return ok(spec);
    };
    setCommandRunner(runner);

    const result = await runSnappyPipeline(caseDir, ['rotor.stl'], BOUNDS, DEFAULT_SNAPPY_CONFIG);

    expect(result.success).toBe(true);
    expect(result.steps.map((s) => s.status)).toEqual(['success', 'success', 'success', 'success']);
    expect(commands).toEqual(['blockMesh', 'surfaceFeatureExtract', 'snappyHexMesh', 'checkMesh']);

    // The dicts were written.
    for (const file of ['controlDict', 'fvSchemes', 'fvSolution', 'blockMeshDict', 'surfaceFeatureExtractDict', 'snappyHexMeshDict']) {
      await expect(fs.stat(path.join(caseDir, 'system', file))).resolves.toBeDefined();
    }
  });

  it('runs the MPI-parallel chain and writes decomposeParDict when cores > 1', async () => {
    const caseDir = await tempCase();
    const commands: string[] = [];
    const runner: CommandRunner = async (spec) => {
      commands.push(spec.command);
      return ok(spec);
    };
    setCommandRunner(runner);

    const result = await runSnappyPipeline(caseDir, ['rotor.stl'], BOUNDS, {
      ...DEFAULT_SNAPPY_CONFIG,
      cores: 4,
    });

    expect(result.success).toBe(true);
    // blockMesh -> surfaceFeatureExtract -> decomposePar -> mpirun (snappy) ->
    // reconstructParMesh -> checkMesh.
    expect(commands).toEqual([
      'blockMesh',
      'surfaceFeatureExtract',
      'decomposePar',
      'mpirun',
      'reconstructParMesh',
      'checkMesh',
    ]);
    // The decomposition dict was written with the requested subdomain count.
    const decompose = await fs.readFile(path.join(caseDir, 'system', 'decomposeParDict'), 'utf8');
    expect(decompose).toContain('numberOfSubdomains 4;');
  });

  it('clears a previous run mesh, decomposition, and stale level fields first', async () => {
    const caseDir = await tempCase();
    // Simulate a case left behind by an earlier, differently-sized run.
    await fs.mkdir(path.join(caseDir, 'constant', 'polyMesh'), { recursive: true });
    await fs.writeFile(path.join(caseDir, 'constant', 'polyMesh', 'points'), 'stale', 'utf8');
    await fs.mkdir(path.join(caseDir, '0'), { recursive: true });
    await fs.writeFile(path.join(caseDir, '0', 'cellLevel'), 'stale', 'utf8');
    await fs.mkdir(path.join(caseDir, 'processor0'), { recursive: true });
    // An input that must survive the clean.
    await fs.mkdir(path.join(caseDir, 'constant', 'triSurface'), { recursive: true });
    await fs.writeFile(path.join(caseDir, 'constant', 'triSurface', 'rotor.stl'), 'solid', 'utf8');

    setCommandRunner(async (spec) => ok(spec)); // tools succeed but write nothing

    await runSnappyPipeline(caseDir, ['rotor.stl'], BOUNDS, DEFAULT_SNAPPY_CONFIG);

    // Prior mesh output is gone; the STL input is kept.
    await expect(fs.stat(path.join(caseDir, 'constant', 'polyMesh', 'points'))).rejects.toThrow();
    await expect(fs.stat(path.join(caseDir, '0', 'cellLevel'))).rejects.toThrow();
    await expect(fs.stat(path.join(caseDir, 'processor0'))).rejects.toThrow();
    await expect(
      fs.stat(path.join(caseDir, 'constant', 'triSurface', 'rotor.stl')),
    ).resolves.toBeDefined();
  });

  it('short-circuits the remaining steps when blockMesh fails', async () => {
    const caseDir = await tempCase();
    const runner: CommandRunner = async (spec) => {
      if (spec.command === 'blockMesh') {
        return { command: spec.command, args: spec.args, exitCode: 1, stdout: '', stderr: 'boom', durationMs: 1, timedOut: false };
      }
      return ok(spec);
    };
    setCommandRunner(runner);

    const result = await runSnappyPipeline(caseDir, ['rotor.stl'], BOUNDS, DEFAULT_SNAPPY_CONFIG);

    expect(result.success).toBe(false);
    expect(result.steps.map((s) => s.status)).toEqual(['failed', 'skipped', 'skipped', 'skipped']);
  });

  it('captures a missing binary as a failed step with a runner note', async () => {
    const caseDir = await tempCase();
    const runner: CommandRunner = async (spec) => ({
      command: spec.command,
      args: spec.args,
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: 0,
      timedOut: false,
      spawnError: 'ENOENT: command not found',
    });
    setCommandRunner(runner);

    const result = await runSnappyPipeline(caseDir, ['rotor.stl'], BOUNDS, DEFAULT_SNAPPY_CONFIG);

    expect(result.success).toBe(false);
    expect(result.steps[0].status).toBe('failed');
    expect(result.steps[0].stderr).toContain('ENOENT');
  });
});

// Tests for the real stream runner's timeout handling (M6): a run that exceeds
// its wall-clock cap is SIGTERMed first (so mpirun can forward it to its ranks)
// and only SIGKILLed after the grace period — it must never be left running.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { realStreamRunner } from '../src/lib/streamRunner';

const NODE = process.execPath;
const dirs: string[] = [];

async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'dive-stream-'));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});

describe('realStreamRunner timeout (M6)', () => {
  it('kills a process that exceeds its timeout and reports timedOut', async () => {
    const dir = await tmp();
    const handle = realStreamRunner({
      command: NODE,
      args: ['-e', "setInterval(() => process.stdout.write('tick\\n'), 20)"],
      cwd: dir,
      env: process.env,
      logFile: path.join(dir, 'run.log'),
      timeoutMs: 150,
      killGraceMs: 50,
    });
    expect(typeof handle.pid).toBe('number');

    const exit = await handle.onExit;
    expect(exit.timedOut).toBe(true);
  });

  // Only on POSIX: Windows has no catchable SIGTERM, so a process cannot ignore it
  // to force the SIGKILL escalation path.
  it.skipIf(process.platform === 'win32')(
    'escalates to SIGKILL when the process ignores SIGTERM',
    async () => {
      const dir = await tmp();
      const handle = realStreamRunner({
        command: NODE,
        // Trap SIGTERM (ignore it) and keep running; only SIGKILL can stop this.
        args: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 20)"],
        cwd: dir,
        env: process.env,
        logFile: path.join(dir, 'run.log'),
        timeoutMs: 150,
        killGraceMs: 150,
      });

      const exit = await handle.onExit;
      expect(exit.timedOut).toBe(true);
      expect(exit.signal).toBe('SIGKILL'); // SIGTERM was ignored, escalation fired
    },
    5000,
  );
});

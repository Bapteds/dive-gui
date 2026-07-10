// Unit tests for the real command runner's outcome classification (M5): a
// maxBuffer overflow means the tool RAN and was too chatty, and must NOT be
// reported as a spawn failure ("not installed") or a timeout.
import { describe, expect, it } from 'vitest';
import { realCommandRunner } from '../src/lib/commandRunner';

const NODE = process.execPath; // a real, cross-platform binary that's always present

describe('realCommandRunner outcome classification (M5)', () => {
  it('reports outputTruncated (not a spawn error, not a timeout) on a buffer overflow', async () => {
    // Print far more than the tiny cap so Node kills the child with
    // ERR_CHILD_PROCESS_STDIO_MAXBUFFER.
    const res = await realCommandRunner({
      command: NODE,
      args: ['-e', "process.stdout.write('x'.repeat(100000))"],
      maxBuffer: 1000,
    });
    expect(res.outputTruncated).toBe(true);
    expect(res.spawnError).toBeUndefined(); // the bug: this used to be set -> "not installed"
    expect(res.timedOut).toBe(false); // the maxBuffer kill must not look like a timeout
  });

  it('still reports a real spawn error when the binary does not exist', async () => {
    const res = await realCommandRunner({
      command: 'dive-definitely-not-a-real-binary-xyz',
      args: [],
    });
    expect(res.spawnError).toBeTruthy();
    expect(res.spawnError).toMatch(/ENOENT/);
    expect(res.outputTruncated).toBeUndefined();
  });

  it('passes through a normal success and a non-zero exit', async () => {
    const ok = await realCommandRunner({ command: NODE, args: ['-e', "process.stdout.write('ok')"] });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toBe('ok');
    expect(ok.spawnError).toBeUndefined();

    const fail = await realCommandRunner({ command: NODE, args: ['-e', 'process.exit(3)'] });
    expect(fail.exitCode).toBe(3);
    expect(fail.spawnError).toBeUndefined();
    expect(fail.outputTruncated).toBeUndefined();
  });
});

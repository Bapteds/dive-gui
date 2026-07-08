// The machine's core budget for parallel OpenFOAM jobs (solver runs and meshing
// runs alike). SOLVER_TOTAL_CORES caps it when set (> 0); otherwise the host's
// logical core count is the ceiling. One source of truth so every parallel path
// (runs.service, meshing.service) offers and enforces the same maximum.
import os from 'node:os';
import { env } from '../config/env';

/** Max cores any single job may use on this host. */
export function coreBudget(): number {
  return env.SOLVER_TOTAL_CORES > 0 ? env.SOLVER_TOTAL_CORES : os.cpus().length;
}

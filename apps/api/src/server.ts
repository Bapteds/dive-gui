// Server bootstrap: builds the Express app and starts listening.
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { reconcileOrphanRuns } from './modules/projects/runs.service';
import { reconcileOrphanMeshingRuns } from './modules/meshing/meshing.service';
import { attachTerminalGateway } from './modules/projects/terminal.gateway';

const app = createApp();

// A solver run is tied to this process; any run still marked active in the DB
// belongs to a previous, now-dead process. Mark such orphans as failed on boot.
reconcileOrphanRuns()
  .then((count) => {
    if (count > 0) logger.warn(`Reconciled ${count} interrupted run(s) to failed`);
  })
  .catch((err) => logger.error('Run reconciliation failed', err));

// The same applies to meshing runs (file-backed status.json instead of DB rows):
// a status left 'running' by a dead process can never finish, so mark it failed.
reconcileOrphanMeshingRuns()
  .then((count) => {
    if (count > 0) logger.warn(`Reconciled ${count} interrupted mesh run(s) to failed`);
  })
  .catch((err) => logger.error('Mesh run reconciliation failed', err));

const server = app.listen(env.PORT, () => {
  logger.info(`API listening on http://localhost:${env.PORT}`);
});

// The project terminal (opt-in via TERMINAL_ENABLED) attaches to the HTTP server's
// upgrade event; a no-op when disabled. Lives here, not in createApp, so supertest
// (which imports createApp without listening) is unaffected.
attachTerminalGateway(server);

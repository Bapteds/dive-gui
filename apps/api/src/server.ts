// Server bootstrap: builds the Express app and starts listening.
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { reconcileOrphanRuns } from './modules/projects/runs.service';

const app = createApp();

// A solver run is tied to this process; any run still marked active in the DB
// belongs to a previous, now-dead process. Mark such orphans as failed on boot.
reconcileOrphanRuns()
  .then((count) => {
    if (count > 0) logger.warn(`Reconciled ${count} interrupted run(s) to failed`);
  })
  .catch((err) => logger.error('Run reconciliation failed', err));

app.listen(env.PORT, () => {
  logger.info(`API listening on http://localhost:${env.PORT}`);
});

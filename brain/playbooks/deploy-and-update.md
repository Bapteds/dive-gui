# Playbook: Deploy and update the production server

> When to use: shipping a new version of `main` to the Debian 12 server (app in `/home/app`, service `dive-api`, nginx), or rolling one back · Related: `brain/operations/installation.md` (first install, sections 3 to 7), `brain/architecture/overview.md` §7, `brain/architecture/configuration.md`, `brain/known-issues.md` · Updated: 2026-09-28

> **The live server departs from this recipe (checked 2026-10-01)**: there is no `dive-api` systemd unit; the app runs by hand with `npm run dev` from a miniforge-activated shell. Read `brain/STATUS.md` §3 (Production server row) before following the `systemctl` steps below.

## Before you start
- Deploying is an action on shared infrastructure: only on explicit request from the user, who runs the commands (as root) or confirms each one.
- Paths below follow the installation guide: code `/home/app`, DB `DATABASE_URL=file:/var/lib/dive/prod.db`, storage `STORAGE_DIR=/var/lib/dive/storage`, OpenFOAM `/usr/lib/openfoam/openfoam2406`, mesh venv `/opt/dive-venv`. Check the real values in `/home/app/apps/api/.env` first.
- **Pre-deploy checklist**:
  - [ ] Target commit is on `main` and CI is green (jobs `verify` and `geometry` in `.github/workflows/ci.yml`).
  - [ ] Note the running commit for rollback: `git -C /home/app rev-parse --short HEAD`.
  - [ ] Read every changelog entry since that commit (`brain/changelog/YYYY-MM.md`) and list: new or changed env vars, new migrations (`apps/api/prisma/migrations/`), changes to `apps/api/scripts/buildChamber.py`, new Python dependencies, "to validate on the Debian server" items.
  - [ ] Collect the open server validations from `brain/known-issues.md` (status ⚠️): C1 (transient CGNS order, `out.cgns.times` sidecar), C3 (`streamRunner` stream error listener), H1 (orphan solver kill via `/proc/<pid>/cmdline`), H7 (multi-zone CGNS in CFD-Post), plus the Assemble `cyclicAMI` coupling (§8). Test the ones the release touches.
  - [ ] No active solver run or meshing session: a restart marks them `failed` on boot (`reconcileOrphanRuns`, `reconcileOrphanMeshingRuns` in `apps/api/src/server.ts`), and a still-running mesher is not killed (K38). Check the dashboard ("active runs") or ask the users.

## Steps

### Update
1. **Back up the database** (Prisma has no down-migration):
   ```bash
   systemctl stop dive-api
   cp /var/lib/dive/prod.db /var/lib/dive/prod.db.bak-$(date +%Y%m%d-%H%M)
   ```
   (Stopping first gives a consistent SQLite copy; the service stays down only for the next few steps.)
2. **Get the code**:
   ```bash
   cd /home/app
   git status            # must be clean; local edits block the pull
   git pull --ff-only
   ```
3. **Install dependencies**: `npm ci` (exact lockfile; the API `postinstall` runs `prisma generate`). The installation guide uses `npm install` for updates; prefer `npm ci` so the server matches CI.
4. **Python dependencies**, only if the requirement files changed (`git diff --name-only <old>..HEAD -- apps/api/scripts/`):
   - `/opt/dive-venv/bin/pip install -r apps/api/scripts/requirements.txt` (mesh, CGNS, export interpreter);
   - `<chamber venv>/bin/pip install -r apps/api/scripts/requirements-geometry.txt` for the interpreter in `CHAMBER_PYTHON_BIN` (CadQuery; its venv is not described in the installation guide, read its path from `.env`).
5. **Configuration**: `git diff <old>..HEAD -- apps/api/.env.example apps/web/.env.example`; add any new variable the release needs to `/home/app/apps/api/.env`. `apps/web/.env` must hold an absolute `VITE_API_URL` (e.g. `https://dive.your-domain.de/api/v1`) before building: it is baked into the bundle and the terminal WebSocket URL is derived from it.
6. **Build**: `npm run build` (shared, then API `prisma generate && tsc`, then web `tsc -b && vite build` into `apps/web/dist`).
7. **Migrations**: `npm start` (the service command) runs `prisma migrate deploy` before `node dist/server.js`. To see migration errors before starting, run `npm run db:deploy -w @dive/api`. Never run `db:migrate` (`prisma migrate dev`) or `db:reset` in production.
8. **Chamber cache**: if `buildChamber.py` changed, purge the builds (keyed on parameters, not on code): `rm -rf "$STORAGE_DIR"/chamber/*`. The installation guide uses `/var/lib/dive/storage`, but the live server (checked 2026-09-29) has `STORAGE_DIR="./storage"`, relative to the service working directory (probably `/home/app/apps/api/storage/chamber`): check `.env` and `systemctl cat dive-api` first. Saved chamber configurations are in the DB and survive; they rebuild on next open.
9. **Start**: `systemctl start dive-api` (or `systemctl restart dive-api` if you skipped step 1), then `systemctl status dive-api` must show `active (running)`. Follow the boot with `journalctl -u dive-api -f`: look for `API listening on`, for `Invalid environment configuration:` (fix `.env`), and for migration errors.
10. **nginx**: static files are served straight from `apps/web/dist`, so no reload is needed for a normal update. Only if `/etc/nginx/sites-available/dive` changed: `nginx -t && systemctl reload nginx`.

### Rollback
1. `systemctl stop dive-api`.
2. `cd /home/app && git checkout <previous sha>` (detached HEAD is fine), `npm ci`, `npm run build`.
3. If the release applied a migration: restore the backup (`cp /var/lib/dive/prod.db.bak-<stamp> /var/lib/dive/prod.db`). Data written since the deploy is lost: confirm with the user first.
4. If `buildChamber.py` differs between the two versions: purge `$STORAGE_DIR/chamber/*` again (see step 8 for the real path).
5. `systemctl start dive-api`, then run the Verify section below. Return to `main` later with `git checkout main`.

## Verify
- Liveness (the health route is `/health`, outside `/api/v1`, and nginx only proxies `/api/`): `curl -s http://127.0.0.1:4000/health` returns `{"status":"ok"}`.
- Through nginx: `curl -k https://dive.your-domain.de/api/v1/config` returns `{"terminalEnabled":false}` (or `true`). Note: `/api/v1/health`, cited in the installation guide §5.5, is not a route and answers 404 `NOT_FOUND`.
- In the browser (hard refresh to drop the cached `index.html`): log in, open a project, then run one CFD action the release touches, e.g. a mesh conversion (every step green), a chamber build, or an export. Any "not found" step means a binary, venv or `OPENFOAM_BASHRC` path is wrong in `.env`.
- Record the outcome in the changelog (which server validations passed) and update `brain/known-issues.md` statuses (⚠️ to ✅) for the items verified.

## Update the brain
- [ ] Changelog entry (`Chore` or `Docs`): deployed commit, migrations applied, cache purged or not, server validations done, anything that failed.
- [ ] `brain/STATUS.md`: deployed version and verification state.
- [ ] `brain/known-issues.md`: ⚠️ items validated or newly found on the server.
- [ ] `brain/operations/installation.md` if a server step changed (new package, venv, `.env` line, nginx block).

## Pitfalls
- `systemctl restart` during a run kills it: the run and any meshing session end `failed` on boot.
- The refresh cookie is `Secure` when `NODE_ENV=production`: over plain HTTP, logins do not stick. Serve HTTPS (`apps/mcp/.env.example` still shows an `http://192.168.5.51/api/v1` base).
- The service runs from `WorkingDirectory=/home/app/apps/api`: relative `DATABASE_URL` (relative to `prisma/`) and `STORAGE_DIR` (relative to the cwd) point inside the clone, not `/var/lib/dive`. Keep them absolute in production.
- Production refuses to boot on short, equal or placeholder JWT secrets or on the placeholder `SEED_ADMIN_PASSWORD` (`superRefine` in `env.ts`); `SEED_ADMIN_*` are required even to start.
- The OpenFOAM environment comes from `ExecStart=... source /usr/lib/openfoam/openfoam2406/etc/bashrc && npm start` and/or `OPENFOAM_BASHRC`; a tool "not found" only on the server usually means one of them is missing or points to another version.
- One API instance only (in-memory locks and process handles): never start a second `npm start` next to the service (`EADDRINUSE`, or worse on another port).

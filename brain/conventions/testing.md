# Testing conventions

> Operational guide for an agent that adds, modifies or runs tests in the DIVE Turbinen monorepo. Sources read: `apps/api/vitest.config.ts`, `apps/api/tests/**`, `apps/web/vitest.config.ts`, `apps/web/src/test/setup.ts`, representative web tests, `apps/api/scripts/tests/conftest.py`, `apps/api/scripts/tests/test_build_chamber.py`, `.github/workflows/ci.yml`, the three `package.json` files, the old handover and the old log (now `brain/STATUS.md` and `brain/changelog/`). Updated: 2026-09-28.
> File-by-file details of the API tests: `brain/codemap/api-tests.md`.

## 1. The three families

| Family | Location | Tools | Environment | What is real / simulated |
|---|---|---|---|---|
| API | `apps/api/tests/*.test.ts` (34 files) | vitest 2 + supertest | `node`, isolated SQLite `prisma/test.db`, storage `./test-storage` | Express, Prisma, argon2, JWT, file system are real. OpenFOAM, Python, ParaView, mpirun always simulated by injected runners. |
| Web | `apps/web/src/**/*.test.{ts,tsx}` (32 files) | vitest 2 + Testing Library (`@testing-library/react`, `user-event`, `jest-dom`) | `jsdom`, `globals: true`, `css: false`, alias `@` → `src` | Real React components. API client, auth context and three.js viewers mocked with `vi.mock`. |
| Geometry | `apps/api/scripts/tests/` (`conftest.py`, `test_build_chamber.py`, `params/*.json`) | pytest | Python 3.12 + `apps/api/scripts/requirements-geometry.txt` (CadQuery/OCC, trimesh) | `buildChamber.py` actually executed, without mocks. |

Split of responsibilities for the chamber: `chamber.test.ts` (API) locks the HTTP contract, the per-hash cache and the validations with a fake builder; `chamberModel.test.ts` locks the empirical model of `@dive/shared`; only the pytest tests verify the geometry (watertightness, patches, reference volumes, overflow refusal).

## 2. Environment isolation

### API (vitest + supertest)
- **Env variables**: injected through `test.env` in `apps/api/vitest.config.ts`. They win over `apps/api/.env` because `dotenv/config` does not overwrite an already defined variable. Variables missing from `test.env` (notably `OPENFOAM_BASHRC`, `TERMINAL_ENABLED`, Python binaries) **are read from `.env`** if they appear there.
- **Database**: `tests/globalSetup.ts` runs `npx prisma db push --force-reset --skip-generate --accept-data-loss` once on `file:./test.db`. The Prisma client must therefore already be generated. `fileParallelism: false`: files run one after the other on this single database.
- **Per test**: `beforeEach(resetDatabase)` (deletes `auditLog`, `run`, `template`, `chamberSave`, `project`, `user` in that order); suites that touch files add `await fs.rm('./test-storage', { recursive: true, force: true })` in `beforeEach` and in `afterAll`; `afterAll(() => prisma.$disconnect())`. `chamber.test.ts` only purges `path.join(storageRoot(), 'chamber')`.
- **Users and tokens**: `createTestUser` / `createProtectedAdmin` write directly to the database with a real argon2 hash (`DEFAULT_PASSWORD = 'Sup3rSecret!'`); `authHeader(user)` signs an access token without going through the login. Fixture emails in `@dive-turbinen.test` or `@x.test`.
- **External tools**: two injection points.
  - `setCommandRunner(runner | null)` (`src/lib/commandRunner.ts`) for one-shot commands. A `CommandRunner` receives `{ command, args, … }` and returns a `CommandResult` `{ command, args, exitCode, stdout, stderr, durationMs, timedOut, spawnError? }`.
  - `setStreamRunner(runner | null)` (`src/lib/streamRunner.ts`) for long-running processes (solver, meshing run). A `StreamRunner` receives a `StreamSpec` (including `logFile`) and returns `{ pid, onExit: Promise<StreamExit>, stop }`.
  - The fake **writes to disk what the real tool would produce** (GLB + `manifest.json` + `edges.bin`, `constant/polyMesh/*`, VTK, CGNS…) because the service checks the artifacts, not just the exit code.
  - A missing binary is simulated with `exitCode: null` + `spawnError: 'ENOENT: …'`.
  - Always restore in `afterEach(() => setCommandRunner(null))` (and/or `setStreamRunner(null)`).
  - For any OpenFOAM tool, switch on `logicalCommand(spec).command` (helpers), never on `spec.command`: when `OPENFOAM_BASHRC` is defined, `planOpenfoamCommand` wraps the call in `bash -c 'source "$OPENFOAM_BASHRC" && exec "$@"' bash <bin> <args…>`.
- **Python scripts**: `CGNS_TO_VTK_SCRIPT` and `EXTRACT_PATCHES_SCRIPT` point to the stubs in `apps/api/tests/fixtures/` (existence check only; never executed).
- **Multipart with relative paths**: superagent's `.attach()` truncates the file name to its basename. For a folder import, build the body by hand (`buildMultipart` in `projectFiles.test.ts` / `meshes.test.ts`) and send it with `.set('Content-Type', contentType).send(body)`.
- **Binary bodies**: supertest does not buffer binary by default; use `.buffer().parse(binaryParser)` (collects the chunks into a `Buffer`).
- **Asynchronous pipelines**: runs (meshing, solver) answer 202/201 then run in the background; tests poll the status endpoint (`pollMeshLog`: 15 s, 15 ms step; `waitForTerminal`: 3 s, 20 ms step). A "hang" fake only resolves `onExit` on `stop()`, to test 409 and stopping.

### Web (vitest + Testing Library + jsdom)
- `apps/web/vitest.config.ts`: React plugin, alias `@`, `environment: 'jsdom'`, `globals: true`, `setupFiles: ['./src/test/setup.ts']`, `include: ['src/**/*.test.{ts,tsx}']`, `css: false`.
- `src/test/setup.ts`: `@testing-library/jest-dom/vitest` matchers, `cleanup()` after each test, stub of `window.matchMedia` (probed by Radix and sonner, absent from jsdom).
- Usual mocks (see `ProjectDetailPage.test.tsx`): `vi.mock('@/lib/api/<module>', () => ({ fn: vi.fn() }))` then `vi.mocked(api.fn).mockResolvedValue(...)` in `beforeEach` after `vi.clearAllMocks()`; `vi.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ user: … }) }))`; heavy components (three.js viewer without WebGL, side sections) replaced by stubs with a `data-testid`.
- Providers: `QueryClient` with `defaultOptions: { queries: { retry: false } }`, `createMemoryRouter` + `RouterProvider` for a routed page, `TooltipProvider` (`@/components/ui/tooltip`) as soon as a Radix tooltip is rendered.
- No network, no backend: everything goes through the mocked API modules.

### Geometry (pytest + real CadQuery)
- `conftest.py`: if `cadquery` or `trimesh` cannot be imported, `pytest_collection_modifyitems` **marks the whole folder as skipped** (message pointing to `requirements-geometry.txt`); the suite stays green without the environment, CI is authoritative.
- `session`-scoped `build` fixture: runs `python buildChamber.py <params.json> <outDir> [--step]` exactly like the API, only once per combination (name, `params_override`, `step`), in `tmp_path_factory`. 600 s timeout per build. `BuildResult` exposes `manifest`, `build_meta`, `export_path(...)`, `load_stl()`.
- Parameters in `params/*.json` (real production configurations: `stepped`, `stepped-feet-off`, `stepped-vanes`, `hollow-vanes`, `hollow-vanes-overrides`). Reference volumes in `GOLDEN` with `VOL_RTOL = 5e-3`, tied to the pinned environment: a CadQuery/OCP bump can shift them; they are refreshed in the same commit as the bump.

## 3. Commands

Common prerequisites: `npm ci` (the API `postinstall` runs `prisma generate`); `npm run build:shared` whenever `packages/shared` has changed (API and web resolve `@dive/shared` from its `dist`).

| Need | Command |
|---|---|
| Everything (shared + API + web) | `npm test` at the root (= `build:shared` then `test -w @dive/api` then `test -w @dive/web`) |
| Full API | `npm test -w @dive/api` (= `vitest run` in `apps/api`) |
| Full web | `npm test -w @dive/web` |
| Targeted API file(s) | in `apps/api`: `npx vitest run tests/chamber.test.ts tests/chamberModel.test.ts`; from the root: `npm test -w @dive/api -- tests/chamber.test.ts` |
| Targeted web folder or file | in `apps/web`: `npx vitest run src/features/chamber` or `npx vitest run src/pages/ProjectDetailPage.test.tsx` |
| A single case (by name) | add `-t "per-hash build lock"` to the vitest command |
| Full geometry | `pytest apps/api/scripts/tests -v` (Python with `requirements-geometry.txt`) |
| One geometry case | `pytest apps/api/scripts/tests/test_build_chamber.py -k hollow_overflow -q` |
| Typecheck | `npm run typecheck` at the root (rebuilds shared then `tsc --noEmit` for API and web) |
| Lint | `npm run lint` |

Co-developer's machine (WSL, see `brain/STATUS.md` §3): `node`/`npm` only exist in **WSL**; so run `wsl bash -lc 'cd /mnt/c/…/dive-gui/apps/api && npx vitest run tests/…'`. The Windows Python does not have CadQuery; the geometry suite runs with the WSL venv (`/home/hristo/cadquery-env/bin/python -m pytest tests/test_build_chamber.py -q` from `apps/api/scripts`, 29 collected tests (19 functions, some parametrized) and about 5 min as of 2026-09-04). Exact paths depend on the machine: check them before use. `globalSetup.ts` passes `shell: true` so that `npx` (a `.cmd` shim) also works on native Windows.

## 4. CI (`.github/workflows/ci.yml`)
Triggered on push to `main` and on every pull request; superfluous runs on the same ref are canceled (`concurrency`).
- **`verify` job** (ubuntu, Node 20): `npm ci` → `npm run prisma:generate -w @dive/api` → `npm run build:shared` → `npm run lint` → `npm run typecheck` → `npm test` → `npm run build` (with `VITE_API_URL=http://localhost:4000/api/v1`). No `OPENFOAM_BASHRC`: fakes switching on `spec.command` pass there.
- **`geometry` job** (ubuntu, Python 3.12, pip cache on `requirements-geometry.txt`): `pip install -r apps/api/scripts/requirements-geometry.txt` then `pytest apps/api/scripts/tests -v`. Separate job so as not to delay `verify` (about 3 min of real builds according to the workflow comment).

## 5. Suites known to fail outside the Linux server / CI
- **`apps/api/tests/conversion.test.ts` and `apps/api/tests/meshes.test.ts`**: fail (21 tests, finding from the 2026-08-12 changelog) when `apps/api/.env` defines `OPENFOAM_BASHRC`. Cause: their fakes compare the raw `spec.command` (`python3`, `vtkUnstructuredToFoam`, `mergeMeshes`, `stitchMesh`, `checkMesh`…) whereas the real command becomes `bash`. No product bug; the fix (going through `logicalCommand`) has been identified but left pending. Green in CI.
- `export.test.ts` also switches `checkMesh` on `spec.command`: impact under `OPENFOAM_BASHRC` undocumented, to verify.
- `mesh.test.ts` and `snappyPipeline.test.ts` were fixed (2026-08-12) and pass in both configurations.
- Geometry: always "skipped" without CadQuery (native Windows); this is not a success.
- The full API suite is slow (argon2, disk I/O, file serialization): run **targeted suites**.
- `dashboard.test.ts` reads the host machine's metrics (bounds assertions only).

## 6. House rules
- **Workflow** (`brain/conventions/workflow.md`): brainstorming, spec committed **before** implementation, then **test-first**: write the test, watch it fail for the right reason, implement, watch it pass. Changelog entries record "red first" and the gates passed.
- **Changelog**: one entry at the top of `brain/changelog/YYYY-MM.md` for every code change (see `brain/changelog/README.md`), with the **Tests** line: gates run (suites, number of tests, typecheck, lint).
- **Targeted suites**: run the touched files and their direct neighbors rather than the whole API; for a flake, repeat the targeted suite several times (changelog precedent: 10 consecutive passes to validate a flake fix).
- **`@dive/shared`**: after any change to `packages/shared`, `npm run build:shared` before typecheck and before `npm test -w …` (only the root `npm test` does it automatically). Otherwise API and web test the old `dist`.
- **Chamber cache**: after **any** change to `apps/api/scripts/buildChamber.py`, purge the dev cache `rm -rf apps/api/storage/chamber/*`: builds are hashed on the parameters, not on the code. (`chamber.test.ts` already purges `test-storage/chamber` and never runs the script.)
- **Geometry**: any change to `buildChamber.py` is validated with the real pytest suite; reference volumes only move with an environment bump or an intended geometry change, in the same commit.
- **Gen Dim model**: if the workbook `documents/Gen Dim v3 …xlsx` changes, `computeChamberGeneratorDims`, the parity tests of `chamberModel.test.ts` and the hints of `chamberForm.test.ts` move together.
- **Error contracts**: API tests check `res.status` **and** `res.body.error.code` (often `res.body.error.message` for user-facing messages).
- **Access**: for any project resource, cover 401 without auth, 404 (not 403) for a stranger so as not to reveal existence, and the authorized super-admin.

## 7. Template: new API test
Follow the structure of `mesh.test.ts` / `export.test.ts`. Skeleton for a feature that calls an OpenFOAM tool:

```ts
// Integration tests for <feature>. The OpenFOAM toolchain is absent in CI / on a
// dev box, so the command runner is swapped for a fake that writes the artifacts
// the real tool would.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, authHeader, createTestUser, logicalCommand, resetDatabase } from './helpers';
import { prisma } from '../src/lib/prisma';
import { setCommandRunner, type CommandResult, type CommandRunner } from '../src/lib/commandRunner';
import { readCaseFile, writeCaseFile } from '../src/lib/caseStorage';

function ok(spec: { command: string; args: string[] }, stdout = ''): CommandResult {
  return { command: spec.command, args: spec.args, exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false };
}

let runCount = 0;
const successRunner: CommandRunner = async (spec) => {
  runCount += 1;
  const { command, args } = logicalCommand(spec); // sees through OPENFOAM_BASHRC
  if (command === 'someFoamTool') {
    const caseDir = args[args.indexOf('-case') + 1];
    await fs.writeFile(path.join(caseDir, 'constant', 'polyMesh', 'boundary'), '…');
    return ok(spec, 'End\n');
  }
  return ok(spec);
};

async function makeProject(email: string): Promise<{ auth: string; id: string }> {
  const user = await createTestUser({ email });
  const project = await prisma.project.create({ data: { title: 'Case', ownerId: user.id } });
  return { auth: authHeader(user), id: project.id };
}

beforeEach(async () => {
  await resetDatabase();
  await fs.rm('./test-storage', { recursive: true, force: true });
  runCount = 0;
  setCommandRunner(successRunner);
});
afterEach(() => setCommandRunner(null));
afterAll(async () => {
  await prisma.$disconnect();
  await fs.rm('./test-storage', { recursive: true, force: true });
});

describe('POST /projects/:id/<feature>', () => {
  it('requires authentication', async () => {
    const { id } = await makeProject('feat-auth@dive-turbinen.test');
    expect((await request(app).post(`/api/v1/projects/${id}/<feature>`)).status).toBe(401);
  });

  it('returns 404 for a project the viewer cannot see', async () => {
    const { id } = await makeProject('feat-owner@dive-turbinen.test');
    const stranger = await createTestUser({ email: 'feat-stranger@dive-turbinen.test' });
    const res = await request(app).post(`/api/v1/projects/${id}/<feature>`).set('Authorization', authHeader(stranger));
    expect(res.status).toBe(404);
  });

  it('reports a missing binary as a failed step', async () => {
    setCommandRunner(async (spec) => ({ ...ok(spec), exitCode: null, spawnError: 'ENOENT: command not found' }));
    // … arrange the case with writeCaseFile, call the endpoint, assert result.success === false
  });
});
```

Points to respect:
- A distinct fixture email per test (readable, prefixed with the feature).
- Arrange the disk state with `writeCaseFile` (or the import API) and check with `readCaseFile` or the read endpoint; do not guess the storage's internal paths.
- Cover: success, tool failure (non-zero exit), missing binary (`spawnError`), short-circuit of the following steps (`skipped`), 422 validation, 409 gate (`NO_MESH` etc.), 401 and stranger 404.
- For a cache: an execution counter, then a failing runner (`notFoundRunner`) to prove that a second call does not rerun the tool.
- For a concurrency lock: a fake that waits 50 ms and two requests in `Promise.all`.
- For a long-running process: `setStreamRunner` with a fake that writes `spec.logFile` and resolves `onExit`, then a status poll with a deadline.
- Purely unit test (renderer, parser): import directly from `../src/lib/<module>` or `@dive/shared`, without `app` or `resetDatabase`.

## 8. Template: new web test
Colocate `<Component>.test.tsx` next to the component. Query by accessible role and label (`getByRole('button', { name: … })`, `getByLabelText(…)`): the tests also validate accessibility.

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * <Component> tests. The API module is mocked; the component logic is real.
 */
vi.mock('@/lib/api/<module>', () => ({ getThing: vi.fn() }));
vi.mock('@/features/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'USER' } }),
}));

import * as api from '@/lib/api/<module>';
import { MyComponent } from './MyComponent';

function renderComponent() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <MyComponent />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getThing).mockResolvedValue({ id: 't1', name: 'Thing' });
});

describe('MyComponent', () => {
  it('shows the loaded data', async () => {
    renderComponent();
    expect(await screen.findByText('Thing')).toBeInTheDocument();
  });

  it('enables the action once data is loaded', async () => {
    renderComponent();
    await waitFor(() => expect(screen.getByRole('button', { name: /save/i })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
  });
});
```

Observed patterns to reuse:
- **Presentational form component** (react-hook-form owned by the parent): a local `Harness` that calls `useForm({ resolver: zodResolver(schema), defaultValues })` and passes `register`, `errors`, `onSubmit={handleSubmit(onValid)}`; `onValid = vi.fn()` then `waitFor(() => expect(onValid).toHaveBeenCalledTimes(1))` and read `onValid.mock.calls[0][0]` (see `ChamberInputsForm.test.tsx`). `useForm` only reads `defaultValues` on mount: to change the defaults, mount afresh rather than `rerender`.
- **Routed page**: `createMemoryRouter([{ path: '/projects/:id', element: <Page /> }], { initialEntries: ['/projects/p1'] })` inside `QueryClientProvider` + `TooltipProvider`.
- **Radix Tabs**: click with `userEvent.click` (focus + pointer) and not `fireEvent.click`, otherwise automatic activation does not trigger; re-query the element after loading (a disabled trigger wrapped in a tooltip is replaced by another node).
- **Guarded actions**: forbidden buttons carry `aria-disabled="true"` (and not `disabled`) so they stay reachable by keyboard and expose their tooltip; check `toHaveAttribute('aria-disabled', 'true')`, `not.toBeDisabled()` and that the handler was not called (see `UsersTable.test.tsx`).
- **three.js / WebGL**: always mock the viewer (`MeshViewer` etc.) with a `data-testid` stub.
- Fixture data typed with the types from `@/lib/api/types`; fixture emails in `@dive-turbinen.de`.
- Client/server parity: some fixtures are deliberately shared between web and API (90° quaternion around +Z and translation (1,2,3) in `features/assemble/placement.test.ts` and `apps/api/tests/meshTransform.test.ts` / `meshes.test.ts`). Change both sides together.

## 9. Common pitfalls
- OpenFOAM fake that tests `spec.command` instead of `logicalCommand(spec).command`: passes in CI, breaks locally as soon as `.env` defines `OPENFOAM_BASHRC`.
- Fake that returns `exitCode: 0` without writing the artifacts: the service concludes failure (manifest missing, `edges.bin` missing so render considered stale, polyMesh missing).
- Forgetting `setCommandRunner(null)` / `setStreamRunner(null)`: the fake leaks into the following files (serial execution, same process).
- Forgetting to purge the chamber cache or `test-storage`: an earlier cache hides the failure path under test.
- Forgetting `npm run build:shared` after a change to `packages/shared`: tests and typecheck use the old `dist`.
- Forgetting `prisma generate`: `globalSetup` uses `--skip-generate`.
- Overly tight timing assertions on background runs: the WSL disk (`/mnt/c`) and CI are slow; keep generous deadlines well below `testTimeout` (20 s).
- Reading a binary body without `.buffer().parse(...)`: supertest returns an empty or text body.
- Using `.attach()` for a folder import: the relative path is lost.

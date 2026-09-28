# Feature · MCP server (`apps/mcp`)

> **Status**: experimental (developer tooling, outside the web application) · **Updated**: 2026-09-28
> **Specs**: none; usage documentation in `apps/mcp/README.md` · **Codemaps**: `brain/codemap/root-shared-mcp.md` (`apps/mcp/src/{client,config,server}.ts`, `apps/mcp/.env.example`, `apps/mcp/README.md`, `apps/mcp/package.json`, `.mcp.json`)
> **See also**: `brain/features/auth-and-accounts.md` (login, tokens), `brain/features/projects.md` (visibility), CFD workflow sheets (`case-files.md`, `solver-and-runs.md`, `merge-and-assembly.md`, `boundary-conditions.md`, `export-cfdpost.md`) and codemap `api-projects.md` for the semantics of each called route

## 1. Purpose
Exposes the DIVE REST API (`/api/v1`) as Model Context Protocol tools so that a Claude agent (Claude Code, Claude Desktop…) can drive the same operations as the front end: browse projects, read and write case files, prepare and launch runs, follow logs and residuals, convert and merge meshes, apply boundary conditions, export to CFD-Post. It is a thin HTTP layer: no business logic, no direct access to the API's database or disk. It acts with the rights of a DIVE **service account**.

## 2. User journey
- **Setup** (developer or operator):
  1. create a dedicated service account in `/admin` (role `USER` is enough, except for the `list_users` tool which requires `SUPER_ADMIN`);
  2. copy `apps/mcp/.env.example` to `apps/mcp/.env` and fill in `DIVE_API_URL`, `DIVE_MCP_EMAIL`, `DIVE_MCP_PASSWORD` (and `DIVE_MCP_TIMEOUT_MS` if needed);
  3. `npm install` at the root;
  4. start the API (`npm run dev`), then Claude Code from the repository root: `.mcp.json` declares the `dive` server (`npx tsx apps/mcp/src/server.ts`). Standalone test: `npm run start -w @dive/mcp`.
- **Usage**: the agent calls the tools; each result is indented JSON in a text content (`(empty response)` if empty). An API error becomes an `isError` result: `API error <status> [<code>]: <message>`. Tools marked destructive additionally go through the Claude Code permission prompt.
- **Startup failure**: without `apps/mcp/.env` (or with an empty required variable), the process stops at module load with "`<VAR>` is not set. Copy apps/mcp/.env.example to apps/mcp/.env and fill it in." (on stderr); Claude Code then shows the `dive` server as failing to connect.

## 3. Business rules and invariants
- **Rights**: those of the service account, enforced by the API (project visibility, `canManage`, `SUPER_ADMIN`). The MCP bypasses nothing. Consequences:
  - with a `USER` account, the agent only sees projects owned by the service account or where it is a collaborator; projects created via `create_project` belong to the service account and stay invisible to humans (except super-admins) until they are added as collaborators, which no MCP tool allows;
  - with a `SUPER_ADMIN` account, the agent sees and can delete every project on the platform.
- **Authentication**: lazy login on the first tool call (`POST /auth/login`), access token kept in memory and sent as `Authorization: Bearer`. No cookie and no refresh: on **401**, the client drops the token, logs in again **only once** (single-flight login shared between concurrent calls) and replays the request once; a second failure surfaces as an error. A refused login raises `Login failed: <message>`.
- **Side effects on the API**: each (re)login writes a `LOGIN` audit entry, updates `lastLoginAt` and consumes the login rate limit (10 per 15 min per IP, see L1). Changing the service account password or disabling it breaks the MCP at the next 401.
- **Timeout**: `DIVE_MCP_TIMEOUT_MS` per request (60000 by default, positive integer or error at startup), via `AbortController` ⇒ `TIMEOUT` error (status 0). The operation continues on the API if it has started (conversion, merge, export): check the state with the read tools before relaunching.
- **Errors**: `ApiError(status, code, message)` read from the `{ error: { code, message } }` envelope; synthetic codes `TIMEOUT`, `NETWORK_ERROR` (status 0), `UNKNOWN` (non-JSON body).
- **MCP annotations**: `readOnlyHint` inferred from the name prefix (`list_`, `get_`, `read_`, `verify_`); `destructiveHint` set explicitly on 9 tools: `delete_project`, `write_case_file`, `delete_case_file`, `start_run`, `stop_run`, `merge_meshes`, `auto_patch_mesh`, `apply_boundary_conditions`, `run_export`. `get_mesh_manifest` is marked read-only although it builds the 3D render on demand.
- **Uploaded files**: `import_case_zip` (multipart field `archive`) and the optional CSV of `apply_boundary_conditions` read a **local path on the machine running the MCP server**, not a file on the API server.

### Tools (32)
| Group | Tools (called route) |
|---|---|
| Projects | `list_projects` (`GET /projects`), `get_project` (`GET /projects/:id`), `create_project` (`POST /projects`), `delete_project`* |
| Dashboard | `get_dashboard` (`GET /dashboard`) |
| Case files | `list_case_files`, `read_case_file` (`GET /files/content?path=`), `write_case_file`* (`PUT` text `/files/content?path=`), `create_case_file` (`POST /files/content` `{ path }`, empty file), `delete_case_file`*, `import_case_zip`, `verify_case`, `scaffold_case`, `sync_boundaries` |
| Solver | `get_runnable`, `scaffold_solver` (`{ solver?, turbulence? }`), `start_run`* (`cores` sent only if > 1), `stop_run`*, `list_runs`, `get_run`, `get_run_log` (log + residuals) |
| Meshes | `list_meshes`, `get_mesh_manifest`, `merge_meshes`* (raw plan), `auto_patch_mesh`* (`{ featureAngle }`) |
| CGNS and export | `list_cgns`, `convert_cgns` (`{ cgnsFile, templateId }`), `get_export_status`, `run_export`* |
| Boundary conditions | `apply_boundary_conditions`* (multipart: text field `payload` JSON + optional `csv` file) |
| Other | `list_templates` (`GET /templates`), `list_users` (`GET /users`, `SUPER_ADMIN`) |

`*` = destructive. Project routes are prefixed with `/projects/:id`. Not covered: Chamber Creation, Meshing sessions, template writes, collaborators, renaming, mesh backups, audit log, assembly.

## 4. Technical flow
- **Startup**: `.mcp.json` → `npx tsx apps/mcp/src/server.ts` → `config.loadConfig()` (loads `apps/mcp/.env` through a path resolved from the file, hence independent of the current directory) → `new DiveClient(config)` → registration of the 32 tools via the helper `tool(name, meta, handler)` (wraps `server.registerTool`, annotations, `ok` / `fail`) → `server.connect(new StdioServerTransport())`. Logs on stderr only (stdout = MCP channel). Announced name and version: `dive-mcp` 0.1.0.
- **Tool call**: zod-typed handler → `DiveClient.get|post|put|delete|putText|postForm` → `request()` (`ensureToken` → `rawFetch` with timeout → on 401 re-login + replay → `ApiError` if not OK) → `decode()` (tolerates 204 and empty body) → `ok(value)`.
- **Multipart**: `postForm` reads each local file (`readFile`) and attaches it as a `Blob` to a native Node `FormData`.
- **API side**: the usual routes and services (see codemaps `api-projects.md`, `api-core.md`); no route is MCP-specific.

## 5. Data and storage
- No persistence of its own: only the access token lives in the process memory.
- `apps/mcp/.env` contains plaintext credentials: ignored by git (`.gitignore`), never commit it; only `.env.example` is versioned.
- All writes (projects, case files, runs, meshes) are done by the API under `STORAGE_DIR`, on behalf of the service account.

## 6. Configuration and external dependencies
- `apps/mcp/.env`: `DIVE_API_URL` (required, **includes** `/api/v1`, trailing slashes removed; deployed example `http://192.168.5.51/api/v1` behind the reverse proxy, or `http://localhost:4000/api/v1` in dev), `DIVE_MCP_EMAIL`, `DIVE_MCP_PASSWORD` (required), `DIVE_MCP_TIMEOUT_MS` (optional, 60000).
- Package `@dive/mcp` (ESM, `module` `NodeNext`, imports suffixed `.js`): `@modelcontextprotocol/sdk ^1.12.0`, `dotenv`, `zod`; run via `tsx`. Requires global `fetch`, `FormData` and `Blob` (Node ≥ 18; the repo targets Node ≥ 20). Does not depend on `@dive/shared`: payload shapes (`MergePlan`, boundary conditions payload) are not typed on the MCP side.
- The API must be running and reachable from the MCP server machine; no CFD binary is required locally.

## 7. Tests
- No automated tests. The root scripts `typecheck`, `test` and `build` do not include `@dive/mcp` (so CI does not compile it); only `eslint .` covers it, with the base rules (no dedicated section in `eslint.config.js`). Manual verification: `npm run typecheck -w @dive/mcp` and `npm run start -w @dive/mcp`.

## 8. History
- 2026-07-09: creation of the MCP server wrapping the API (`e63f2b4`); `.env.example` pointed at the API deployed behind the port 80 proxy (`4d04af9`). Sources: `git log -- apps/mcp .mcp.json`; no dedicated entry in `brain/changelog/2026-07.md` as of writing.

## 9. Known limits and bugs
- `brain/known-issues.md`: **L1** (the login rate limit counts the service account's re-logins, shared per IP), **M9** (global JSON limit of 16 KB: a large `merge_meshes` plan gets a raw 413), **K1** (`create_case_file` cannot provide content; consistent with the route, which ignores `content`), **L3** (only the first validation message surfaces, without `details`), **K31** (a single API instance).
- Reading findings (not reproduced):
  - the `merge_meshes` description talks about "couples/patchPairs" whereas `MergePlan` expects `order`, `interfaces`, `transforms` (and legacy `stitches`): the agent must refer to the real schema (`packages/shared`, `meshes.schemas.ts`);
  - the internal `LoginResponse` interface declares `user.displayName?` instead of `fullName` (no effect, unused field);
  - a client timeout leaves the operation running on the API: risk of a double launch if the agent blindly retries (export, conversion, merge);
  - `get_mesh_manifest` has a side effect (building the render) despite `readOnlyHint`.
- Environment: `apps/mcp/.env` is missing on this workstation as of 2026-09-28, which prevents the `dive` server from starting (observed: MCP connection closed at session start).

## 10. Changing this feature
- **New tool**: `tool('<verb>_<object>', { title, description, inputSchema, destructive? }, handler)` in `server.ts`. The prefix `list_` / `get_` / `read_` / `verify_` makes the tool "read-only" in the eyes of the MCP client: only use it for side-effect-free calls; mark `destructive: true` any irreversible or costly write.
- Reuse the real API payload shapes (read the route's zod schema) and describe the fields precisely in `describe()`: the MCP does not import `@dive/shared`.
- Any change to an API route or contract called by a tool must update `server.ts` in the same change (no test will flag it).
- Logs go to stderr (`console.error`): never write to stdout, which carries the MCP protocol.
- Update `apps/mcp/README.md` (list of tools and destructive tools), the `root-shared-mcp.md` codemap and `brain/changelog/`.
- Consider adding `@dive/mcp` to the root `typecheck` / `build` scripts so that CI compiles it.

# @dive/mcp — MCP server for the DIVE Turbinen API

Exposes the DIVE backend REST API (`/api/v1`) as [Model Context Protocol](https://modelcontextprotocol.io)
tools so Claude (Claude Code, Claude Desktop, …) can drive the same operations the
React front performs — browse projects, read/write case files, run and monitor
solvers, convert/merge meshes, apply boundary conditions and export to CFD-Post.

It is a **thin wrapper over the existing API**: every tool is an authenticated
HTTP call. No backend change is required.

## How it works

- Logs in once with a **service account** and attaches `Authorization: Bearer <token>`
  to every request (`src/client.ts`).
- The access token lives 15 minutes; on any `401` the client **re-logs in once**
  and retries — so a long-lived session never goes stale. (The browser refreshes
  via an httpOnly cookie; a headless server re-logs in instead.)
- **Transient failures** (a dropped connection, a timeout, a 502/503/504 from a
  restarting proxy) are retried with backoff — but only for idempotent `GET`s and
  login, so a merge or a solver start can never fire twice.
- Exposes **tools**, **resources** and **prompts** over stdio. The server is
  assembled in `src/factory.ts` (`createServer(api)`); `src/server.ts` only loads
  config, builds the client, and connects the transport.

## Setup

1. **Create a dedicated service account** in the app (ideally not a personal one).
   Give it only the role it needs — `SUPER_ADMIN` is required only for the
   `list_users` tool.

2. **Configure credentials:**

   ```sh
   cp apps/mcp/.env.example apps/mcp/.env
   # then edit apps/mcp/.env
   ```

   | Var | Meaning |
   |-----|---------|
   | `DIVE_API_URL` | API base URL **including** `/api/v1` (e.g. `http://localhost:4000/api/v1`). |
   | `DIVE_MCP_EMAIL` / `DIVE_MCP_PASSWORD` | Service-account credentials. |
   | `DIVE_MCP_TIMEOUT_MS` | Per-request timeout for ordinary calls (default 60000). |
   | `DIVE_MCP_SLOW_TIMEOUT_MS` | Longer timeout (default 600000) for slow tools: merge, conversion, export, meshing runs, up/downloads. |
   | `DIVE_MCP_RETRIES` | Transient-failure retries for GET/login (default 2; 0 disables). |

   `.env` is gitignored — never commit real credentials.

3. **Install deps** (from the repo root):

   ```sh
   npm install
   ```

4. The server is registered for Claude Code in the repo-root **`.mcp.json`**.
   Make sure the API is running (`npm run dev`), then start Claude Code in the
   repo — it launches the server via `npx tsx apps/mcp/src/server.ts`.

   To test it standalone:

   ```sh
   npm run start -w @dive/mcp
   ```

## Tools

~90 tools cover the API surface. Registration is grouped by domain under
`src/tools/` (`projects`, `mesh`, `runs`, `templates`, `meshing`, `admin`).

- **Projects & case files** — `list_projects`, `get_project`, `create_project`,
  `delete_project`, `get_dashboard`, `add_collaborator`, `remove_collaborator`,
  `list_case_files`, `read_case_file`, `write_case_file`, `create_case_file`,
  `delete_case_file`, `delete_case_dir`, `move_case_entry`, `reset_case`,
  `import_case_zip`, `download_case`, `verify_case`, `scaffold_case`,
  `preview_apply_template`, `apply_template`, `apply_template_files`.
- **Mesh, CGNS & merge** — `get_mesh_manifest`, `rebuild_mesh`,
  `rename_mesh_patch`, `set_mesh_patch_type`, `edit_mesh_patches`,
  `auto_patch_mesh`, `get/save/restore_mesh_backup`, `list_cgns`, **`upload_cgns`**,
  `delete_cgns`, `convert_cgns`, `list_meshes`, **`import_mesh`**, `delete_mesh`,
  `get_mesh_source_patches`, `get_mesh_source_manifest`, `auto_patch_mesh_source`,
  `rename_mesh_source_patch`, `edit_mesh_source_patches`, `merge_meshes`,
  `get_merge_plan`, `save_merge_plan`, `get_assembly`.
- **Runs & export** — `get_runnable`, `scaffold_solver`, `sync_boundaries`,
  `apply_boundary_conditions`, `list_runs`, `get_run`, `get_run_log` (residuals),
  `start_run`, `stop_run`, `get_export_status`, `run_export`,
  `download_export_artifact`.
- **Templates** — `list_templates`, `get_template`, `create_template`,
  `update_template`, `delete_template`, and the template file tree
  (`list/read/write/create/delete` + `delete_template_dir`, `move_template_entry`,
  `import_template_files`).
- **Meshing sessions** (snappyHexMesh / cfMesh) — `list/get/create/delete_meshing_session`,
  `upload_stl`, `delete_stl`, `save_meshing_config`, `run_meshing`,
  `get_meshing_manifest`, `download_meshing_session`.
- **Admin** — `list/get/create/update/delete_user`, `list_audit_logs`,
  `get_server_config` (also a quick connectivity check).

Mutating/irreversible tools are flagged with the MCP `destructiveHint` (and
`download_*` tools with `readOnlyHint: false`, since they write to local disk), so
they still go through Claude Code's per-call permission prompt. Every result also
carries `structuredContent` for clients that consume machine-readable output.

## Resources

Read-only context a client can attach without a tool call:

- `dive://projects`, `dive://dashboard` — the project list and dashboard stats.
- `dive://project/{projectId}/files` — a project's case-file tree (one enumerable
  resource per project).
- `dive://project/{projectId}/run/{runId}/log` — a run record + residuals + log tail.

## Prompts

Parameterised, multi-step workflows (ids are pre-substituted):

- `diagnose_run` — investigate why a run failed / is not converging.
- `prepare_runnable_case` — verify → scaffold → sync → runnability loop.
- `convert_cgns_workflow` — upload (if needed) → convert a CGNS mesh.
- `set_up_assembly` — import → patch → couple → merge a multi-part mesh.

## Notes

- File uploads (`upload_cgns`, `import_mesh`, `import_case_zip`, `upload_stl`,
  `import_template_files`, `apply_boundary_conditions`'s CSV) and downloads
  (`download_case`, `download_export_artifact`, `download_meshing_session`) read/write a
  **local file path on the machine running this server**, not a browser upload.
- `merge_meshes` / `save_merge_plan`, `apply_boundary_conditions`, and the meshing
  `config` take the plan/payload/config as a JSON object — the same shape the
  corresponding web dialog sends.

## Development

```sh
npm run typecheck -w @dive/mcp   # tsc --noEmit
npm run test -w @dive/mcp        # vitest (config, client, server integration)
```

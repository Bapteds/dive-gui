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
- Talks to the API over stdio as an MCP server (`src/server.ts`).

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
   | `DIVE_MCP_TIMEOUT_MS` | Per-request timeout (default 60000). Raise for slow mesh/export steps. |

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

**Read** — `list_projects`, `get_project`, `get_dashboard`, `list_case_files`,
`read_case_file`, `verify_case`, `get_runnable`, `list_runs`, `get_run`,
`get_run_log` (includes residuals), `list_meshes`, `get_mesh_manifest`,
`list_cgns`, `get_export_status`, `list_templates`, `list_users`.

**Actions** — `create_project`, `delete_project`, `write_case_file`,
`create_case_file`, `delete_case_file`, `import_case_zip`, `scaffold_case`,
`scaffold_solver`, `sync_boundaries`, `start_run`, `stop_run`, `convert_cgns`,
`merge_meshes`, `auto_patch_mesh`, `apply_boundary_conditions`, `run_export`.

Destructive tools (`delete_*`, `start_run`, `stop_run`, `merge_meshes`,
`auto_patch_mesh`, `apply_boundary_conditions`, `run_export`, `write_case_file`)
are flagged with the MCP `destructiveHint` and still go through Claude Code's
per-call permission prompt.

## Notes

- File uploads (`import_case_zip`, `apply_boundary_conditions`'s CSV) read a
  **local file path on the machine running this server**, not a browser upload.
- `merge_meshes` and `apply_boundary_conditions` take the plan/payload as a JSON
  object — the same shape the corresponding web dialog sends.

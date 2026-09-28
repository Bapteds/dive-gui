# Feature · Project terminal (WebSocket shell)

> **Status**: experimental, disabled by default (`TERMINAL_ENABLED=false`); not verified end to end at delivery (see changelog) · **Updated**: 2026-09-28
> **Specs**: no dedicated spec (entry of 2026-07-03 in `brain/changelog/2026-07.md`) · **Codemaps**: `brain/codemap/api-projects.md` (`terminal.gateway.ts`), `brain/codemap/api-lib.md` (`terminalSession.ts`, `caseStorage.ensureProjectDir` / `projectDirAbsolute`), `brain/codemap/api-core.md` (`app.ts`: `GET /api/v1/config`; `server.ts`: `attachTerminalGateway`), `brain/codemap/web-features-platform.md` (`features/terminal`), `brain/codemap/web-core.md` (`lib/api/config.ts`)
> **See also**: `brain/architecture/storage-layout.md` (external processes, "Project terminal" item), `brain/features/projects.md`, `brain/features/auth-and-accounts.md`

## 1. Purpose
Opens, from any tab of a project, an interactive shell whose working directory is the project's storage folder (`projects/<id>/`: `case/`, `meshes/`, `runs/`…), to navigate, inspect files or manually run OpenFOAM tools. It is the **only shell execution surface** of the application (the rest of the API only executes argv commands, confined to storage). Available to any project member (owner, collaborator, super-admin) when the operator has enabled it on the server.

## 2. User journey
- **Button visibility**: `ProjectTerminalButton` (header of `/projects/:id`, left of the gear menu) queries `GET /api/v1/config`; it is only rendered if `terminalEnabled` is `true`. Label `Terminal`, `aria-label` "Open a terminal in this project's directory".
- **Opening**: large Radix `Dialog` (title `Terminal` + description); `TerminalView` (xterm.js) is loaded `lazy` with a `role="status"` loading state. Closing the dialog unmounts the view and closes the socket (the shell is killed server-side).
- **States** (`StatusPill`, `aria-live`): `Connecting…`, `Connected`, `Disconnected`, `Connection error`; displayed reasons: "Could not open a connection.", "Connection error. The terminal may be disabled or unreachable.", "Connection closed unexpectedly." (code 1006). `Reconnect` button that recreates the terminal and socket.
- **Messages in the terminal**: if the server has no PTY, a gray line `[basic shell: no PTY on this server - cd/ls/cat work, line editing and full-screen apps do not]`; when the shell ends (exit, inactivity), `[session ended]`.
- **CFD tools**: the OpenFOAM environment is not loaded automatically; the user types `source $OPENFOAM_BASHRC` (variable exported into the shell if configured on the API).
- Deliberately dark surface (tokens `--terminal-*`, cursor `--color-accent`) in a light application: an intentional exception for ANSI readability.

## 3. Business rules and invariants
- **Opt-in**: if `TERMINAL_ENABLED` is not exactly `'true'`, `attachTerminalGateway` sets no `upgrade` listener (info log) and `GET /config` returns `{ terminalEnabled: false }`: nothing is exposed and the button is hidden. When enabled, the API logs a warning at startup.
- **Entry point**: WebSocket upgrade on the exact path `^/api/v1/projects/<id>/terminal$` (id `[A-Za-z0-9_-]+`). Any other upgrade gets 404 (the listener catches all upgrades of the HTTP server).
- **Guards, in order**, before any `handleUpgrade`:
  1. path (404);
  2. `Origin`: if the header is present and differs from `CORS_ORIGIN` ⇒ 403 (the CORS middleware does not cover upgrades). A client without an `Origin` header (non-browser) passes this guard;
  3. global cap: `sessionCount >= TERMINAL_MAX_SESSIONS` (20 by default) ⇒ 503 "Terminal capacity reached";
  4. authentication: access token read as the value following `bearer` in `Sec-WebSocket-Protocol` (the browser cannot set `Authorization` on a WebSocket), `verifyAccessToken`, user reloaded from the database (missing, disabled or invalid role ⇒ refusal), then `assertProjectVisible` ⇒ 401 on failure;
  5. unexpected exception ⇒ 500.
  The server selects the `bearer` subprotocol: the token is never echoed in the response.
- **Auth scope**: checked only once at upgrade. An open session survives access token expiry, account disabling or removal as collaborator, until it is closed or times out.
- **Inactivity**: `TERMINAL_IDLE_TIMEOUT_MS` (15 min by default). The timer is only re-armed by client messages (keystrokes, resize), not by shell output: a long command without keystrokes is killed after the delay. The server then sends `{ type: 'exit', code: null, reason: 'idle-timeout' }` and kills the shell.
- **Shell**: `TERMINAL_SHELL` if defined, otherwise `powershell.exe -NoLogo` on Windows, otherwise `bash -i` (interactive shell, not a login shell). Environment = that of the API process + `OPENFOAM_BASHRC` (if defined, exported but not sourced) + `TERM=xterm-256color`. It runs as the API system user and is **not confined** to the project folder (full access to the machine and to other projects for anyone who knows how to navigate).
- **PTY**: `node-pty` (optional dependency) provides a real terminal (line editing, colors, full-screen applications, resize). Missing or not compiled: fallback to a piped shell (`child_process`) without line editing or resize; an `error` listener on stdin prevents an EPIPE after the shell dies from crashing the API (H10).
- **Directory**: `ensureProjectDir(projectId)` creates `projects/<id>/` if needed (falls back to the computed path if creation fails).
- **JSON protocol**: client ⇒ server `{ type: 'input', data }`, `{ type: 'resize', cols, rows }` (clamped to a minimum of 1 on the PTY side); server ⇒ client `{ type: 'ready', pty }`, `{ type: 'output', data }`, `{ type: 'exit', code, reason? }`. Non-JSON messages ignored. Initial size 80 × 24, then `fit` on the client.

## 4. Technical flow

### 4.1 Discovery
`ProjectTerminalButton` → `useQuery(['server-config'])` (`staleTime: Infinity`, `retry: false`) → `lib/api/config.getServerConfig` → `GET /api/v1/config` (public, no auth, declared in `app.ts`) → `{ terminalEnabled }`.

### 4.2 Connection
`TerminalView` creates an xterm `Terminal` (13 px mono font, `scrollback` 5000) + `FitAddon`, reads the current token via `getAccessToken()` (no prior refresh), then `new WebSocket(<VITE_API_URL with http replaced by ws>/projects/<id>/terminal, ['bearer', token])`. Server side: `server.ts` → `attachTerminalGateway(server)` → `upgrade` listener → guards (§3) → `WebSocketServer({ noServer: true }).handleUpgrade` → `bridge(ws, projectId)`.

### 4.3 Bridge
`bridge`: `sessionCount += 1`, `ensureProjectDir`, `createTerminalSession({ cwd, cols: 80, rows: 24, extraEnv })` (`lib/terminalSession.ts`), wiring `onData` ⇒ `output`, `onExit` ⇒ `exit` + cleanup, sending `ready`, arming the inactivity timer. Incoming messages: `input` ⇒ `session.write`, `resize` ⇒ `session.resize`. Socket `close` or `error` ⇒ `cleanup` (counter decrement, `session.kill()`, close). On the client, a `ResizeObserver` re-runs `fit()` and sends `resize`.

## 5. Data and storage
- No database data. No session history persisted.
- The shell freely reads and writes under `STORAGE_DIR/projects/<id>/` (and beyond): any case change made in the terminal bypasses the application caches (3D renders, file contents cached in TanStack, mesh backups) and the in-memory locks (runs). Reload the page or use the UI actions that rebuild the caches.
- In-memory state: global counter `sessionCount` (process-local).

## 6. Configuration and external dependencies
- API: `TERMINAL_ENABLED` (`'false'` by default), `TERMINAL_SHELL` (empty = platform default), `TERMINAL_IDLE_TIMEOUT_MS` (900000), `TERMINAL_MAX_SESSIONS` (20), `CORS_ORIGIN` (origin check), `OPENFOAM_BASHRC` (exported into the shell), `JWT_ACCESS_SECRET` (token verification).
- Web: `VITE_API_URL` (required; its `http`/`https` scheme becomes `ws`/`wss`).
- Dependencies: `ws` (API), `node-pty` in `optionalDependencies` (native compilation: `build-essential` + `python3` on Linux, otherwise piped fallback without breaking `npm install`), `@xterm/xterm` and `@xterm/addon-fit` (web, loaded on demand).
- Reverse proxy: nginx must forward the upgrade (`proxy_set_header Upgrade $http_upgrade; Connection "upgrade"`, long `proxy_read_timeout`), see `README.md` §5.7.

## 7. Tests
- `apps/api/tests/appConfig.test.ts`: `GET /api/v1/config` without auth returns exactly `{ terminalEnabled: false }` (default value).
- No test for the gateway, `terminalSession`, `ProjectTerminalButton` or `TerminalView` (K30). The manual verification procedure before enabling is in the 2026-07-03 changelog entry (connection, PTY banner, refusal without token / other origin / non-member, `source $OPENFOAM_BASHRC`).

## 8. History
- 2026-07-03: creation, WebSocket gateway + xterm, disabled by default because it is an arbitrary execution surface (`020a28a`, `brain/changelog/2026-07.md`).
- 2026-07-10: H10, EPIPE guard on the piped shell's stdin (`bac537d`); dark palette moved into `tokens.css` (`a939869`, visual polish pass). `brain/changelog/2026-07.md`.

## 9. Known limits and bugs
- `brain/known-issues.md`: **K31** (full shell not confined to the project; in-memory locks and counters ⇒ a single API instance), **L21** (session cap checked before the asynchronous authentication while the counter is only incremented in `bridge`: concurrent upgrades can exceed `TERMINAL_MAX_SESSIONS`), **K28** (`TerminalView` does not go back to `connecting` after `Reconnect`: the old state stays displayed until the socket opens), **K30** (no tests), **H10** ✅. The "Verified sound" section of `known-issues.md` confirms the WebSocket auth.
- Reading findings (not reproduced):
  - no token refresh before opening: after 15 min without an API request, the upgrade fails with 401 and the UI only shows a generic connection error (a `Reconnect` after any action that refreshes the token works);
  - the `idle-timeout` reason sent by the server is not displayed distinctly (only `[session ended]`);
  - no per-user cap, only global;
  - the session is not cut when the account is disabled or removed from the project.
- Doc drift: `README.md` §6 describes the terminal as "a login shell" whereas the default is `bash -i` (interactive, not login).

## 10. Changing this feature
- Never enable `TERMINAL_ENABLED=true` on a multi-tenant or exposed host: it is shell access as the API system user for any member of any project.
- Any new guard goes BEFORE `wss.handleUpgrade` (respond with `rejectUpgrade` and a raw HTTP status). Keep the check aligned with `requireAuth` (user reloaded, `isActive`) and `assertProjectVisible`; if revocation via `tokenVersion` is ever added to `requireAuth`, add it here too.
- To bound sessions correctly (L21), reserve the slot in the counter before the asynchronous authentication and release it on failure.
- `createApp()` does not know about the terminal (it is attached in `server.ts`): supertest tests cannot exercise it as is; an integration test must start a real `http.Server`.
- The JSON protocol is implicitly shared between `terminal.gateway.ts` and `TerminalView.tsx` (no type in `packages/shared`): change them together.
- Terminal colors: only through the `--terminal-*` tokens in `apps/web/src/styles/tokens.css`. UI: skill sequence `CLAUDE.md` §0; changelog in the same change.

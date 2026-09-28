# Feature · Authentication and self-service account

> **Status**: in production · **Updated**: 2026-09-28
> **Specs**: no dedicated spec (history in `brain/changelog/2026-06.md`) · **Codemaps**: `brain/codemap/api-core.md` (modules `auth`, middlewares `requireAuth`, `requireRole`, `rateLimit`), `brain/codemap/api-lib.md` (`jwt`, `password`, `serializeUser`, `role`, `audit`), `brain/codemap/web-core.md` (`lib/api/client.ts`, `lib/api/auth.ts`, `app/guards.tsx`, `LoginPage`, `AccountPage`, `UserMenu`), `brain/codemap/web-features-platform.md` (`features/auth`, `features/account`)
> **See also**: `brain/architecture/frontend.md` §4 (client-side session), `brain/features/admin-and-audit.md` (deactivation, account management by the super-admin)

## 1. Purpose
Grants platform access to internal accounts created by a super-admin (no public sign-up). A user signs in with email + password, keeps the session across reloads thanks to an httpOnly refresh cookie, signs out from the user menu, and manages their own display name and password on `/account`. All active accounts have access to it, whatever their role (`USER` or `SUPER_ADMIN`).

## 2. User journey
- **Sign-in** (`/login`, outside the shell): centered card, `Email` field (autofocus) and `Password` field (show/hide toggle), a single orange `Sign in` CTA. While submitting, the button is in loading state. Messages in an always-present `role="alert"` region:
  - `INVALID_CREDENTIALS`: `Invalid email or password.` + danger borders on both fields (cleared on typing);
  - `ACCOUNT_DISABLED`: `This account has been disabled. Contact your administrator.` (no borders);
  - `NETWORK_ERROR`: `Unable to reach the server. Check your connection and try again.`;
  - any other code (including `RATE_LIMITED`): `Something went wrong. Please try again.`
  Success: return to `location.state.from` (the page requested before the redirect) or `/`.
- **Reload / new tab**: `FullPageLoader` during bootstrap (`POST /auth/refresh`), then the app or a redirect to `/login` (with `state.from`). An already signed-in user who opens `/login` is sent back to `state.from` or `/`.
- **Session expired during use**: transparent (automatic refresh on 401). If the refresh fails, the state becomes unauthenticated, the cache is cleared and the guards redirect to `/login` (API message `Your session has expired. Please sign in again.`).
- **Sign-out**: avatar menu (`UserMenu`, top right) then `Log out`. A network error shows the toast `Could not reach the server, but you have been signed out.`; the local session is cleared in every case.
- **My account** (`/account`, via `UserMenu` > `Account settings`, not in the side nav):
  - `Profile` section: email and role read-only (managed by the back office), editable name; `Save changes` disabled until the name has changed; toast `Profile updated.`;
  - `Password` section: current, new, confirmation; validation on blur (8 characters minimum, match, different from the current one); a help line warns that other devices will be signed out; wrong current password ⇒ field error `That password is incorrect.`; success ⇒ fields cleared + toast `Password updated.`;
  - `UnsavedChangesPrompt` exit guard if either section is modified and not saved.

## 3. Business rules and invariants
- **Access token**: JWT `{ sub, role, type: 'access' }` signed with `JWT_ACCESS_SECRET`, lifetime `ACCESS_TOKEN_TTL` (15 min by default). On the client it lives only in module memory (`lib/api/client.ts`), never in `localStorage`, and is sent as `Authorization: Bearer`.
- **Refresh token**: JWT `{ sub, tokenVersion, type: 'refresh' }` signed with `JWT_REFRESH_SECRET` (separate secret), lifetime `REFRESH_TOKEN_TTL_DAYS` days (7 by default), in the `refresh_token` cookie: `httpOnly`, `SameSite=Lax`, `Secure` in production, `path=/api/v1/auth` (sent only to the auth routes). The `type` field prevents using one in place of the other.
- **Rotation**: every successful `POST /auth/refresh` sets a new cookie (same `tokenVersion`, new expiry).
- **Revocation via `tokenVersion`** (integer per user): a refresh whose version differs from the one in the database is refused (401). The version is incremented by: logout (revokes **all** of the user's sessions, not just the current device), self-service password change, and on the admin side by an effective role change, a password reset or a deactivation.
- **Actual scope of revocation**: `requireAuth` does not compare `tokenVersion`; an already issued access token therefore stays valid until it expires (at most `ACCESS_TOKEN_TTL`) after a logout or a password change on another device. Only deactivation cuts access immediately, because `requireAuth` re-reads `isActive` from the database on every request.
- **Per-request check**: `requireAuth` reloads the user from the database on every request (deleted or deactivated account ⇒ 401 `UNAUTHENTICATED`); `requireRole('SUPER_ADMIN')` reads the role from the database, not from the token: a role change applies on the next request.
- **Anti-enumeration**: unknown email and wrong password return the same 401 `INVALID_CREDENTIALS` (`Invalid email or password`). The disabled status is revealed (403 `ACCOUNT_DISABLED`) only after the password has been verified. Limit: timing oracle (see L2).
- **Emails**: compared and stored in lowercase after `trim`.
- **Rate limit**: `POST /auth/login` only, 10 attempts per 15-min window per IP (1000 with `NODE_ENV=test`), successes included; exceeding it ⇒ 429 `RATE_LIMITED`. The IP seen depends on `TRUST_PROXY`. Counter in process memory.
- **Passwords**: argon2id (`lib/password.ts`), never stored or logged in clear text. Length `PASSWORD_MIN_LENGTH` (8) to `PASSWORD_MAX_LENGTH` (200) for a new password; login only requires a non-empty field.
- **Self-service profile**: only `fullName` is editable (1 to `FULL_NAME_MAX_LENGTH` = 120, trim). The `email` and `role` keys sent to `PATCH /auth/me` are stripped by zod validation (no privilege escalation).
- **Password change**: requires the current password (400 `INVALID_PASSWORD` otherwise), increments `tokenVersion`, returns a new access token and resets the cookie at the new version: the current device stays signed in, the others lose their refresh.
- **Login**: updates `lastLoginAt`.
- **Client cache**: `queryClient.clear()` on explicit logout AND on refresh failure (fix C4), so that a subsequent user on the same machine never sees the previous user's data.
- **Audit** (best-effort, never blocking): `LOGIN` (successes only, failures are not logged), `LOGOUT`, `PROFILE_UPDATED`, `PASSWORD_CHANGED`. See `admin-and-audit.md`.
- **Production**: `config/env.ts` refuses to start if the JWT secrets are shorter than 32 characters, identical to each other or equal to the example placeholders, or if `SEED_ADMIN_PASSWORD` is the placeholder.

## 4. Technical flow

### 4.1 Sign-in
`LoginPage` (react-hook-form + local zod, `mode: 'onSubmit'`) → `useAuth().login(email, password)` (`AuthProvider`) → `lib/api/auth.login` → `POST /api/v1/auth/login` with `credentials: 'include'` and `skipRefresh` → `loginRateLimiter` → `validate({ body: loginSchema })` → `loginController` → `auth.service.login` (Prisma `user.findUnique`, `verifyPassword`, `isActive` check, `user.update({ lastLoginAt })`, `signAccessToken` + `signRefreshToken`) → `setRefreshCookie` → `recordAudit(LOGIN)` → `200 { accessToken, user }`. The client stores the token in memory (`setAccessToken`); `AuthProvider` switches to `authenticated`.

### 4.2 Session bootstrap
When `AuthProvider` mounts (in `app/providers.tsx`, under the `QueryClientProvider`): `authApi.refresh()` → `POST /auth/refresh` (cookie) → `refreshController` → `auth.service.refresh` (checks signature, type, existence, `tokenVersion`, `isActive`) → new cookie + `200 { accessToken, user }`. No `GET /auth/me` call (removed for performance). Failure ⇒ `unauthenticated`. The `RequireAuth` / `RedirectIfAuthenticated` guards show `FullPageLoader` while `status === 'loading'`.

### 4.3 Transparent refresh on 401
`apiClient` (`lib/api/client.ts`): any request outside `AUTH_PATHS` (`/auth/login`, `/auth/refresh`, `/auth/logout`) and without `skipRefresh` that receives a 401 calls `refreshAccessToken()`. A single `refreshPromise` is shared between concurrent 401s (single-flight), then the request is replayed once. Failure: token cleared, `onLogout()` (registered by `AuthProvider` via `setLogoutHandler`) resets the state and clears the cache, then `ApiError('UNAUTHORIZED', …, 401)`.

### 4.4 Sign-out
`UserMenu` → `useAuth().logout()` → `lib/api/auth.logout` → `POST /auth/logout` (`requireAuth`) → `revokeRefreshTokens` (increments `tokenVersion`) → `clearRefreshCookie` (same options as when setting it) → `recordAudit(LOGOUT)` → 204. On the client, `finally`: token cleared, `user = null`, `status = 'unauthenticated'`, `queryClient.clear()`.

### 4.5 Profile
`ProfileSection` → `useUpdateProfile` (`features/account/useAccount.ts`) → `updateMe` → `PATCH /auth/me` (`requireAuth`, `updateMeSchema`) → `updateOwnProfile` → `recordAudit(PROFILE_UPDATED)` → `200 { user }` → `useAuth().setUser(user)` (avatar and menu updated). No query key: synchronization goes through the auth context.

### 4.6 Password change
`ChangePasswordSection` → `useChangePassword` → `lib/api/auth.changePassword` (with `credentials: 'include'` to receive the new cookie; replaces the in-memory token) → `POST /auth/change-password` (`requireAuth`, `changePasswordSchema`) → `auth.service.changePassword` (re-verification, `hashPassword`, `tokenVersion` increment, new pair) → `setRefreshCookie` → `recordAudit(PASSWORD_CHANGED)` → `200 { accessToken, user }` → `setUser`. Error mapping: `INVALID_PASSWORD` on `currentPassword`, `VALIDATION_ERROR` on `newPassword`, the rest as a toast.

### 4.7 Other auth consumers
- Project terminal: the access token is passed as a WebSocket subprotocol (see `terminal.md`).
- MCP server: no cookie, re-login on 401 (see `mcp-server.md`).

## 5. Data and storage
- **Prisma `User`**: `email` (unique, lowercase), `fullName`, `passwordHash` (argon2id), `role` (`'SUPER_ADMIN' | 'USER'`, string validated by zod), `isProtected`, `isActive`, `tokenVersion`, `lastLoginAt`, timestamps. Public shape `PublicUser` (`lib/serializeUser.ts`) without `passwordHash` or `tokenVersion`. Details: `brain/architecture/data-model.md`.
- **`AuditLog`**: one row per event (see `admin-and-audit.md`).
- **No disk storage** under `STORAGE_DIR`.
- **Client**: token in module memory; httpOnly cookie managed by the browser; TanStack cache cleared on every session exit.

## 6. Configuration and external dependencies
- API (`apps/api/.env`, validated by `src/config/env.ts`): `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` (required), `ACCESS_TOKEN_TTL` (default `15m`), `REFRESH_TOKEN_TTL_DAYS` (default 7), `CORS_ORIGIN` (single origin allowed with credentials, default `http://localhost:5173`), `TRUST_PROXY` (default 0: set to 1 behind nginx, otherwise all requests share the proxy IP for the rate limit), `NODE_ENV` (`Secure` cookie and secret checks in `production`), `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` / `SEED_ADMIN_NAME` (required even just to start).
- Web: `VITE_API_URL` (read lazily; missing ⇒ explicit error on the first request).
- Dependencies: `jsonwebtoken`, `argon2` (native module), `cookie-parser`, `express-rate-limit` (in-memory store by default).
- HTTPS required in production for the `Secure` cookie to be sent.

## 7. Tests
- `apps/api/tests/auth.test.ts`: login (`HttpOnly` cookie + `Path=/api/v1/auth`, no serialized secrets), identical message for unknown email and wrong password, 422 malformed body, `/auth/me`, refresh with and without cookie, logout (204, `tokenVersion` incremented, old refresh refused).
- `apps/api/tests/account.test.ts`: `PATCH /auth/me` (no escalation via `role`/`email`, 422 blank name), `POST /auth/change-password` (new token, old password refused, 400 `INVALID_PASSWORD`, 422 too short, session A kept and session B revoked).
- `apps/api/tests/accountStatus.test.ts`: effects of deactivation on login, refresh and a still-valid access token; `lastLoginAt` stamped.
- `apps/api/tests/audit.test.ts`: `LOGIN` entry.
- Web: `features/account/{ChangePasswordSection,ProfileSection}.test.tsx`, `features/account/schemas.test.ts`, `components/common/UnsavedChangesPrompt.test.tsx`.
- Not covered: `AuthProvider`, `lib/api/client.ts` (single-flight refresh), `LoginPage`, `guards.tsx`, rate limit (neutralized in tests).

## 8. History
- 2026-06-19: backend foundation (JWT access + refresh revocable via `tokenVersion`, path-scoped cookie, middlewares, super-admin seed); frontend foundation (API client with single-flight refresh, in-memory session, guards, `LoginPage`); removal of the redundant `me()` at bootstrap; self-service account `/account` with revocation of other sessions. See `brain/changelog/2026-06.md` (entries of 2026-06-19: Lot 1+2, Lot 3, code-splitting and lighter bootstrap, self-service account). Grouped commit `179b55e`.
- 2026-06-22: `isActive` / `lastLoginAt`, 403 `ACCOUNT_DISABLED` refusal after password verification, hardening (`trust proxy`, 16 KB JSON limit, production secrets), audit log, `UnsavedChangesPrompt` guard on `/account` (`brain/changelog/2026-06.md`, "App web" batch entry).
- 2026-07-10: C4, `queryClient.clear()` on logout and on refresh failure (`eefd54b`, `brain/changelog/2026-07.md`).

## 9. Known limits and bugs
- `brain/known-issues.md`: **L1** (rate limit that also counts successes, based on `req.ip` with `TRUST_PROXY=0` by default ⇒ lockout behind a NAT or a misconfigured proxy), **L2** (timing oracle: no argon2 verification for an unknown email), **L3** (validation `details` do not reach the client; internal codes exposed on 500), **L4** (`revokeRefreshTokens` ⇒ 500 if the user has disappeared, despite the "safe" comment), **L12** (the seed rewrites the super-admin password on every run), **K28** (focus on the first invalid field uncertain in `ChangePasswordSection`), **K30** (no `AuthProvider` test), **K31** (a single API instance supported: the rate-limit counter is in memory). **C4** fixed.
- Findings from code reading (not reproduced):
  - after a logout or a password change, the access tokens of other sessions stay valid for up to 15 min (`requireAuth` ignores `tokenVersion`);
  - logout signs out all of the user's devices, without the UI saying so;
  - `RATE_LIMITED` has no dedicated message on `LoginPage` (generic message);
  - a super-admin who changes their own password via the back office (instead of `/account`) increments `tokenVersion` without receiving a new cookie: they will be signed out on the next refresh (to verify at runtime);
  - in dev, `StrictMode` replays the bootstrap: two `POST /auth/refresh` are sent, and the bootstrap `refresh()` does not use the client's single-flight promise (see `brain/architecture/frontend.md` §4);
  - the header comment of `AuthProvider` still describes a `me()` call at bootstrap, which no longer exists;
  - `/auth/change-password` is not in `AUTH_PATHS`: a 401 on this route triggers the refresh + retry cycle.

## 10. Changing this feature
- Shared constants (`PASSWORD_MIN_LENGTH`, `PASSWORD_MAX_LENGTH`, `FULL_NAME_MAX_LENGTH`, `ROLES`, error codes `SERVER_ERROR_CODES`): in `packages/shared/src/index.ts`; run `npm run build:shared` afterwards (the API and the tests consume `dist/`).
- Any new route that must receive the cookie must live under `/api/v1/auth` (the cookie path) and be sent with `credentials: 'include'`; add it to `AUTH_PATHS` if it must never trigger the refresh cycle.
- Setting and clearing the cookie must keep the same options (`auth.cookies.ts`), otherwise the browser does not clear it.
- New exposed user field: `lib/serializeUser.ts`, the `User` type in `apps/web/src/lib/api/types.ts`, web test fixtures that build a complete `User`.
- If a revocation must become immediate, add `tokenVersion` to the access token and check it in `requireAuth` (and in `terminal.gateway.ts`, which duplicates the check).
- New audit code: `AuditAction` in `lib/audit.ts` (see `admin-and-audit.md`).
- Any client-side session exit must go through `AuthProvider` (which clears the cache); never call `setAccessToken(null)` alone.
- UI: follow the skill sequence of `brain/conventions/frontend.md` §1 and `brain/design/design-system.md` §7.1; update `brain/changelog/` in the same change.

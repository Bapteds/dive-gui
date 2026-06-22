/**
 * API contract types - mirror the DIVE backend (`/api/v1`).
 *
 * These are the shapes exchanged with the Express + Prisma backend. They are
 * the single typed contract consumed by the API client, the auth feature, and
 * (later) the admin screens.
 */

import type { Role, ServerErrorCode } from '@dive/shared';

/** User roles. The super-admin is permanent and cannot be removed or downgraded. */
export type { Role };

/** A platform account as returned by the backend. */
export interface User {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  /** true for the permanent super-admin account (cannot be deleted/downgraded). */
  isProtected: boolean;
  /** false for a disabled account: it cannot log in until re-enabled. */
  isActive: boolean;
  /** ISO 8601 timestamp of the last successful login, or null if never. */
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Normalised error body: `{ error: { code, message } }`. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

/**
 * Error codes the UI may surface to the user: every code the server can emit
 * (from the shared contract) plus the transport-only codes the client adds when
 * a request never reaches a normalized response.
 */
export type ApiErrorCode = ServerErrorCode | 'UNAUTHORIZED' | 'NETWORK_ERROR' | 'UNKNOWN';

// ---- Auth responses ----

/** `POST /auth/login` and `POST /auth/refresh` response. */
export interface AuthResponse {
  accessToken: string;
  user: User;
}

/** `GET /auth/me` response. */
export interface MeResponse {
  user: User;
}

// ---- Users responses ----

/** `GET /users` response. */
export interface ListUsersResponse {
  users: User[];
}

/** Response shape for endpoints returning a single user. */
export interface UserResponse {
  user: User;
}

/** Payload for `POST /users`. */
export interface CreateUserInput {
  fullName: string;
  email: string;
  password: string;
  role: Role;
}

/** Payload for `PATCH /users/:id` (all fields optional). */
export interface UpdateUserInput {
  fullName?: string;
  email?: string;
  password?: string;
  role?: Role;
  /** Enable (true) or disable (false) the account. */
  isActive?: boolean;
}

// ---- Projects ----

/** Minimal public user shape embedded in a project (owner / collaborators). */
export interface UserSummary {
  id: string;
  fullName: string;
  email: string;
}

/** A project the current user owns or collaborates on (or any, for super-admin). */
export interface Project {
  id: string;
  title: string;
  owner: UserSummary;
  collaborators: UserSummary[];
  createdAt: string;
  updatedAt: string;
}

/** Payload for `POST /projects`. */
export interface CreateProjectInput {
  title: string;
}

/** `GET /projects` response. */
export interface ListProjectsResponse {
  projects: Project[];
}

/** Response shape for endpoints returning a single project. */
export interface ProjectResponse {
  project: Project;
}

// ---- Project case files (OpenFOAM) ----

/** A node in a project's case tree. */
export interface CaseEntry {
  /** Forward-slash relative path from the case root. */
  path: string;
  type: 'file' | 'directory';
  /** Size in bytes (0 for directories). */
  size: number;
}

/** Report of which mandatory files a case has (the "Verify" check). */
export interface CaseVerification {
  /** All five constant/polyMesh/ mesh files are present. */
  hasMesh: boolean;
  /** Mesh files still absent (come from the import, cannot be generated). */
  missingMesh: string[];
  /** Scaffoldable base files already present. */
  presentBase: string[];
  /** Scaffoldable base files still absent (what "create them" would generate). */
  missingBase: string[];
  /** No base files are missing. */
  complete: boolean;
  /** At least one base file is missing, so scaffolding has something to do. */
  canScaffold: boolean;
}

/** `GET /projects/:id/files` response. */
export interface CaseFilesResponse {
  entries: CaseEntry[];
}

/** `GET /projects/:id/files/verify` response. */
export interface VerifyCaseResponse {
  verification: CaseVerification;
}

/** `POST /projects/:id/files/import` response. */
export interface ImportCaseResponse {
  written: string[];
  entries: CaseEntry[];
}

/** `POST /projects/:id/files/scaffold` response. */
export interface ScaffoldCaseResponse {
  created: string[];
  verification: CaseVerification;
  entries: CaseEntry[];
}

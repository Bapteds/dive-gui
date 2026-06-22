// Shared API contract for DIVE Turbinen.
//
// Single source of truth for the constants and enums that both the backend
// (@dive/api) and the web client (@dive/web) must agree on. Keeping these here
// removes the latent drift that arises when, e.g., the password length is typed
// as `8` independently on each side.
import { z } from 'zod';

/** Account roles. The super-admin is permanent and cannot be removed or downgraded. */
export const ROLES = ['SUPER_ADMIN', 'USER'] as const;
export type Role = (typeof ROLES)[number];
/** Zod enum for a role, reused by request schemas on both sides. */
export const roleSchema = z.enum(ROLES);

/** Password policy shared by every create / update / change-password path. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

/** Maximum length of a user's display name. */
export const FULL_NAME_MAX_LENGTH = 120;

/** Maximum length of a project title. */
export const PROJECT_TITLE_MAX_LENGTH = 120;

/**
 * Maximum total size accepted for a single case-file import request (folder or
 * archive). Mesh files (notably `points`) can be large, so this is generous;
 * it exists to reject pathological payloads, not to constrain legitimate meshes.
 */
export const CASE_UPLOAD_MAX_BYTES = 200 * 1024 * 1024; // 200 MB

/**
 * Machine-readable error codes the API may emit in its `{ error: { code } }`
 * envelope. The web client maps these to user-facing messages; it adds its own
 * transport-only codes (network failures, unknown) on top of this set.
 */
export const SERVER_ERROR_CODES = [
  'INVALID_CREDENTIALS',
  'INVALID_PASSWORD',
  'ACCOUNT_DISABLED',
  'EMAIL_TAKEN',
  'PROTECTED_ACCOUNT',
  'PROTECTED_ROLE',
  'SELF_DELETE_FORBIDDEN',
  'SELF_DISABLE_FORBIDDEN',
  'USER_NOT_FOUND',
  'COLLABORATOR_EXISTS',
  'NO_FILES_UPLOADED',
  'INVALID_ARCHIVE',
  'PAYLOAD_TOO_LARGE',
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'RATE_LIMITED',
] as const;
export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number];

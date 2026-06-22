// Audit trail helper.
// Records security-relevant admin and auth actions into the append-only
// AuditLog table. Writes are best-effort: a logging failure is reported to the
// logger but never propagates, so audit logging can never break the action it
// describes. Actor and target are denormalized (id + email) so the trail stays
// readable after an account is renamed or deleted.
import { prisma } from './prisma';
import { logger } from './logger';
import type { PublicUser } from './serializeUser';

/** Stable set of audited action codes. Keep in sync with any reader/UI labels. */
export const AuditAction = {
  LOGIN: 'LOGIN',
  LOGOUT: 'LOGOUT',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  PROFILE_UPDATED: 'PROFILE_UPDATED',
  USER_CREATED: 'USER_CREATED',
  USER_UPDATED: 'USER_UPDATED',
  USER_DELETED: 'USER_DELETED',
  USER_DISABLED: 'USER_DISABLED',
  USER_ENABLED: 'USER_ENABLED',
} as const;

/** Union of valid audit action codes. */
export type AuditActionCode = (typeof AuditAction)[keyof typeof AuditAction];

/** Minimal identity shape needed to attribute an action to an actor/target. */
interface AuditPrincipal {
  id: string;
  email: string;
}

/** Input for recording one audit entry. */
interface RecordAuditInput {
  action: AuditActionCode;
  /** Who performed the action (omit for unauthenticated/system events). */
  actor?: AuditPrincipal | null;
  /** The account the action affected, if any. */
  target?: AuditPrincipal | null;
  /** Optional extra context; serialized to a JSON string for storage. */
  metadata?: Record<string, unknown>;
}

/** Narrow a user-like value to the principal fields the audit log stores. */
export function toAuditPrincipal(user: Pick<PublicUser, 'id' | 'email'>): AuditPrincipal {
  return { id: user.id, email: user.email };
}

/**
 * Record a single audit entry. Never throws: on failure it logs and returns,
 * so callers can `await recordAudit(...)` without guarding the request path.
 * @param input The action, actor, target, and optional metadata.
 */
export async function recordAudit(input: RecordAuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: input.action,
        actorId: input.actor?.id ?? null,
        actorEmail: input.actor?.email ?? null,
        targetId: input.target?.id ?? null,
        targetEmail: input.target?.email ?? null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      },
    });
  } catch (err) {
    // An audit write must never break the action it describes.
    logger.error(`Failed to record audit entry (${input.action}):`, err);
  }
}

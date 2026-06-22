// Audit-log read logic. The audit trail is append-only; this module only lists
// the most recent entries for the super-admin activity view.
import type { AuditLog } from '@prisma/client';
import { prisma } from '../../lib/prisma';

/** Public, wire-safe representation of an audit entry (metadata parsed to JSON). */
export interface PublicAuditLog {
  id: string;
  action: string;
  actorEmail: string | null;
  targetEmail: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/** Safely parse the stored metadata JSON string back into an object. */
function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Convert a Prisma AuditLog record into its public representation. */
function toPublicAuditLog(entry: AuditLog): PublicAuditLog {
  return {
    id: entry.id,
    action: entry.action,
    actorEmail: entry.actorEmail,
    targetEmail: entry.targetEmail,
    metadata: parseMetadata(entry.metadata),
    createdAt: entry.createdAt.toISOString(),
  };
}

/**
 * List the most recent audit entries, newest first.
 * @param limit Maximum number of entries to return (already validated/clamped).
 * @returns The public audit entries in reverse-chronological order.
 */
export async function listAuditLogs(limit: number): Promise<PublicAuditLog[]> {
  const entries = await prisma.auditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return entries.map(toPublicAuditLog);
}

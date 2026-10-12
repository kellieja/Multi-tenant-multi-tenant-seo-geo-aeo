import { prisma } from "@/lib/db/client";

/** Append-only security/audit trail. Never pass secrets in metadata. */
export async function writeAuditLog(entry: {
  organizationId?: string | null;
  userId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}) {
  try {
    await prisma.auditLog.create({
      data: {
        organizationId: entry.organizationId ?? null,
        userId: entry.userId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        metadata: (entry.metadata ?? {}) as object,
        ip: entry.ip ?? null,
      },
    });
  } catch (err) {
    console.error("audit log write failed", err);
  }
}

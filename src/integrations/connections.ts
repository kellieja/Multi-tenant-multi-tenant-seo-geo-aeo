import type { IntegrationConnection, IntegrationProvider, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

/** Server-only access to decrypted credentials. Never pass the result to a client component. */
export function readSecret<T = Record<string, string>>(conn: IntegrationConnection): T {
  if (!conn.encryptedSecret) throw new Error(`${conn.provider} connection has no stored credentials`);
  return decryptSecret<T>(conn.encryptedSecret);
}

export async function saveSecret(connId: string, secret: unknown) {
  await prisma.integrationConnection.update({ where: { id: connId }, data: { encryptedSecret: encryptSecret(secret) } });
}

/** Finds the connection to use for a website: site-level first, then workspace-level. */
export async function findConnection(organizationId: string, provider: IntegrationProvider, websiteId?: string | null) {
  if (websiteId) {
    const site = await prisma.integrationConnection.findFirst({ where: { organizationId, provider, websiteId, status: { in: ["CONNECTED", "ERROR"] } }, orderBy: { updatedAt: "desc" } });
    if (site) return site;
  }
  return prisma.integrationConnection.findFirst({ where: { organizationId, provider, websiteId: null, status: { in: ["CONNECTED", "ERROR"] } }, orderBy: { updatedAt: "desc" } });
}

export class IntegrationError extends Error {
  constructor(message: string, public provider: IntegrationProvider, public status?: number, public retryable = false) {
    super(message);
    this.name = "IntegrationError";
  }
}

/** Wraps a sync operation with a SyncLog row and connection health updates. */
export async function withSyncLog<T extends { items?: number; cost?: number; message?: string }>(
  conn: IntegrationConnection,
  operation: string,
  websiteId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const log = await prisma.syncLog.create({ data: { organizationId: conn.organizationId, connectionId: conn.id, websiteId, operation, status: "RUNNING" } });
  try {
    const res = await fn();
    await prisma.syncLog.update({ where: { id: log.id }, data: { status: "SUCCEEDED", itemsProcessed: res.items ?? 0, quotaUsed: res.cost ?? null, message: res.message?.slice(0, 1000), finishedAt: new Date() } });
    await prisma.integrationConnection.update({ where: { id: conn.id }, data: { status: "CONNECTED", lastSyncAt: new Date(), lastError: null } });
    return res;
  } catch (err) {
    const message = (err as Error).message.slice(0, 1000);
    await prisma.syncLog.update({ where: { id: log.id }, data: { status: "FAILED", message, finishedAt: new Date() } });
    const authProblem = err instanceof IntegrationError && (err.status === 401 || err.status === 403);
    await prisma.integrationConnection.update({ where: { id: conn.id }, data: { status: "ERROR", lastError: authProblem ? `${message} — reconnect or check permissions.` : message } });
    throw err;
  }
}

export type { IntegrationConnection, Prisma };

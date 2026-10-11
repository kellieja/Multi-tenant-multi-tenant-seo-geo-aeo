import { prisma } from "@/lib/db/client";
import { redis } from "@/lib/redis";
import { enqueueJob } from "@/lib/jobs/queue";

/** Retention policy. Documented in docs/OPERATIONS.md. */
export const RETENTION_DAYS = {
  jobs: 90,
  syncLogs: 90,
  readNotifications: 90,
  auditLogs: 365,
  gscQueryRows: 490,
  workflowExecutions: 180,
  pageSpeedResults: 365,
};

export async function processMaintenance() {
  const ago = (d: number) => new Date(Date.now() - d * 86400_000);
  const r = await prisma.$transaction([
    prisma.job.deleteMany({ where: { finishedAt: { lt: ago(RETENTION_DAYS.jobs) } } }),
    prisma.syncLog.deleteMany({ where: { startedAt: { lt: ago(RETENTION_DAYS.syncLogs) } } }),
    prisma.notification.deleteMany({ where: { readAt: { lt: ago(RETENTION_DAYS.readNotifications) } } }),
    prisma.auditLog.deleteMany({ where: { createdAt: { lt: ago(RETENTION_DAYS.auditLogs) } } }),
    prisma.searchConsoleQuery.deleteMany({ where: { date: { lt: ago(RETENTION_DAYS.gscQueryRows) } } }),
    prisma.workflowExecution.deleteMany({ where: { createdAt: { lt: ago(RETENTION_DAYS.workflowExecutions) } } }),
    prisma.pageSpeedResult.deleteMany({ where: { fetchedAt: { lt: ago(RETENTION_DAYS.pageSpeedResults) } } }),
    prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
  ]);
  return { deleted: r.map((x) => x.count) };
}

/** Scheduler: one maintenance run per day (global, not per org). */
export async function scheduleMaintenance(now: Date) {
  const key = `maintenance:${now.toISOString().slice(0, 10)}`;
  const first = await redis().set(key, "1", "EX", 86400 * 2, "NX");
  if (!first) return 0;
  const org = await prisma.organization.findFirst({ select: { id: true } });
  if (!org) return 0;
  // Job rows require an org id; maintenance is attributed to the oldest org but affects all.
  await enqueueJob({ organizationId: org.id, type: "maintenance" });
  return 1;
}

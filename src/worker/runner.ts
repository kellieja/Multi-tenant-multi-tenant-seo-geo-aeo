import type { Job as BullJob } from "bullmq";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { JobContext } from "@/lib/jobs/context";
import { JOB_TYPES, type JobType, type QueuePayload } from "@/lib/jobs/types";
import { notify } from "@/server/notifications";
import { HANDLERS } from "./handlers";

/**
 * Executes one durable Job row. The DB row is the source of truth for the UI:
 * status, progress, error and attempts are written here, never inferred.
 */
export async function runJob(bull: BullJob<QueuePayload>) {
  const row = await prisma.job.findUnique({ where: { id: bull.data.jobId } });
  if (!row) return { skipped: "job row missing" };
  if (row.status === "CANCELLED" || row.status === "SUCCEEDED") return { skipped: row.status };
  const handler = HANDLERS[row.type as JobType];
  const attempt = bull.attemptsMade + 1;
  const maxAttempts = bull.opts.attempts ?? 1;

  await prisma.job.update({ where: { id: row.id }, data: { status: "RUNNING", startedAt: new Date(), attempts: attempt, error: null } });
  let lastWrite = 0;
  const jc: JobContext = {
    job: row,
    progress: async (pct, message) => {
      const now = Date.now();
      if (now - lastWrite < 750 && pct < 100) return;
      lastWrite = now;
      await prisma.job.update({ where: { id: row.id }, data: { progress: Math.max(0, Math.min(100, Math.round(pct))), progressMessage: message?.slice(0, 300) } });
      await bull.updateProgress(pct).catch(() => undefined);
    },
    isCancelled: async () => (await prisma.job.findUnique({ where: { id: row.id }, select: { status: true } }))?.status === "CANCELLED",
    log: (m, d) => console.log(`[job ${row.type} ${row.id}] ${m}`, d ?? ""),
  };

  try {
    if (!handler) throw new Error(`No worker handler is registered for job type "${row.type}"`);
    const result = await handler(jc);
    const cancelled = await jc.isCancelled();
    await prisma.job.update({
      where: { id: row.id },
      data: cancelled
        ? { finishedAt: new Date() }
        : { status: "SUCCEEDED", progress: 100, finishedAt: new Date(), result: (result ?? {}) as Prisma.InputJsonValue },
    });
    return result;
  } catch (err) {
    const message = (err as Error).message?.slice(0, 1000) ?? String(err);
    const final = attempt >= maxAttempts;
    await prisma.job.update({
      where: { id: row.id },
      data: final
        ? { status: "FAILED", error: message, finishedAt: new Date() }
        : { status: "QUEUED", error: `Attempt ${attempt}/${maxAttempts} failed: ${message}. Retrying with backoff.`, progressMessage: "Waiting to retry" },
    });
    if (final) {
      await notify({
        organizationId: row.organizationId,
        websiteId: row.websiteId,
        type: "job_failed",
        severity: "warning",
        title: `${JOB_TYPES[row.type as JobType]?.label ?? row.type} failed`,
        body: message,
        link: `/automation?tab=jobs`,
      });
    }
    throw err;
  }
}

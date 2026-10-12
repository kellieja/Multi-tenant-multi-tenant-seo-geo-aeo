import { Queue } from "bullmq";
import type { Job as JobRow, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { redis } from "@/lib/redis";
import { JOB_TYPES, type JobType, type QueueName, type QueuePayload } from "./types";

const g = globalThis as unknown as { queues?: Map<QueueName, Queue<QueuePayload>> };

export function getQueue(name: QueueName): Queue<QueuePayload> {
  g.queues ??= new Map();
  let q = g.queues.get(name);
  if (!q) {
    q = new Queue<QueuePayload>(name, {
      connection: redis(),
      defaultJobOptions: { removeOnComplete: { age: 7 * 24 * 3600, count: 5000 }, removeOnFail: { age: 30 * 24 * 3600 } },
    });
    g.queues.set(name, q);
  }
  return q;
}

export class QueueUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Background job queue is unavailable (is Redis running at REDIS_URL?): ${(cause as Error)?.message ?? cause}`);
    this.name = "QueueUnavailableError";
  }
}

export interface EnqueueInput {
  organizationId: string;
  type: JobType;
  websiteId?: string | null;
  payload?: Record<string, unknown>;
  createdById?: string | null;
  /** If a QUEUED/RUNNING job of this type already exists for the website, return it instead. */
  dedupe?: boolean;
  delayMs?: number;
  /** Overrides the job type's default attempt count (e.g. workflow maxRetries + 1). */
  attempts?: number;
}

/**
 * Creates a durable Job row (the source of truth for status/progress shown in
 * the UI) and hands its id to BullMQ. If Redis is down the row is marked
 * FAILED with an actionable message rather than silently lost.
 */
export async function enqueueJob(input: EnqueueInput): Promise<{ job: JobRow; deduped: boolean }> {
  const def = JOB_TYPES[input.type];
  if (input.dedupe) {
    const existing = await prisma.job.findFirst({
      where: {
        organizationId: input.organizationId,
        type: input.type,
        websiteId: input.websiteId ?? null,
        status: { in: ["QUEUED", "RUNNING"] },
      },
    });
    if (existing) return { job: existing, deduped: true };
  }
  const job = await prisma.job.create({
    data: {
      organizationId: input.organizationId,
      websiteId: input.websiteId ?? null,
      type: input.type,
      payload: (input.payload ?? {}) as Prisma.InputJsonValue,
      createdById: input.createdById ?? null,
    },
  });
  try {
    await getQueue(def.queue).add(
      input.type,
      { jobId: job.id },
      {
        jobId: job.id,
        attempts: input.attempts ?? def.attempts,
        backoff: { type: "exponential", delay: 30_000 },
        delay: input.delayMs,
      },
    );
  } catch (err) {
    const failed = await prisma.job.update({
      where: { id: job.id },
      data: { status: "FAILED", error: new QueueUnavailableError(err).message, finishedAt: new Date() },
    });
    return { job: failed, deduped: false };
  }
  return { job, deduped: false };
}

export async function cancelJob(organizationId: string, jobId: string) {
  const job = await prisma.job.findFirst({ where: { id: jobId, organizationId } });
  if (!job || (job.status !== "QUEUED" && job.status !== "RUNNING")) return false;
  try {
    const bull = await getQueue(JOB_TYPES[job.type as JobType]?.queue ?? "default").getJob(jobId);
    if (bull && (await bull.isWaiting() || await bull.isDelayed())) await bull.remove();
  } catch {
    /* queue down: still mark cancelled; the worker checks status before running */
  }
  await prisma.job.update({
    where: { id: jobId },
    data: { status: "CANCELLED", finishedAt: new Date(), progressMessage: "Cancelled by user" },
  });
  return true;
}

/**
 * Repairs drift between Job rows (source of truth) and BullMQ (e.g. after Redis data loss or a
 * restore): QUEUED rows with no queue entry are re-queued; RUNNING rows whose queue entry is gone
 * are marked failed so they stop blocking de-duplication. Runs from the scheduler tick.
 */
export async function recoverOrphanedJobs(now = new Date()) {
  const rows = await prisma.job.findMany({
    where: { OR: [{ status: "QUEUED", queuedAt: { lt: new Date(now.getTime() - 10 * 60_000) } }, { status: "RUNNING", startedAt: { lt: new Date(now.getTime() - 15 * 60_000) } }] },
    take: 500,
  });
  let repaired = 0;
  for (const row of rows) {
    const def = JOB_TYPES[row.type as JobType];
    if (!def) continue;
    const q = getQueue(def.queue);
    if (await q.getJob(row.id)) continue;
    if (row.status === "QUEUED") {
      await q.add(row.type, { jobId: row.id }, { jobId: row.id, attempts: def.attempts, backoff: { type: "exponential", delay: 30_000 } });
    } else {
      await prisma.job.update({ where: { id: row.id }, data: { status: "FAILED", error: "The queue lost track of this job (worker or Redis restart). Run it again.", finishedAt: now } });
      if (row.type === "crawl") await prisma.crawl.updateMany({ where: { jobId: row.id, status: "RUNNING" }, data: { status: "FAILED", finishedAt: now } });
    }
    repaired++;
  }
  return repaired;
}

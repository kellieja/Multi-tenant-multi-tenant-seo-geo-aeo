/**
 * Background worker. Run separately from the web app:  pnpm worker
 * Processes BullMQ queues and a once-a-minute scheduler tick.
 */
import { Worker, type Job } from "bullmq";
import { redis } from "@/lib/redis";
import { prisma } from "@/lib/db/client";
import { getQueue } from "@/lib/jobs/queue";
import type { QueuePayload } from "@/lib/jobs/types";
import { runJob } from "./runner";
import { tick } from "./scheduler";
import "./register";

const concurrency = { crawl: Number(process.env.CRAWL_CONCURRENCY ?? 2), default: Number(process.env.WORKER_CONCURRENCY ?? 5) };

async function main() {
  const connection = redis();
  const processor = async (job: Job<QueuePayload>) => (job.name === "scheduler-tick" ? tick() : runJob(job));
  const workers = [
    new Worker<QueuePayload>("crawl", processor, { connection, concurrency: concurrency.crawl, lockDuration: 120_000 }),
    new Worker<QueuePayload>("default", processor, { connection, concurrency: concurrency.default, lockDuration: 120_000 }),
  ];
  for (const w of workers) {
    w.on("failed", (job, err) => console.error(`[worker:${w.name}] ${job?.name} ${job?.id} failed: ${err.message}`));
    w.on("error", (err) => console.error(`[worker:${w.name}]`, err.message));
  }
  await getQueue("default").upsertJobScheduler("scheduler-tick", { every: 60_000 }, { name: "scheduler-tick", data: { jobId: "" }, opts: { removeOnComplete: 100, removeOnFail: 100 } });

  // Recover rows orphaned by a crash: RUNNING rows with no live BullMQ job are marked failed.
  const stale = await prisma.job.findMany({ where: { status: "RUNNING", startedAt: { lt: new Date(Date.now() - 6 * 3600_000) } } });
  for (const j of stale) {
    await prisma.job.update({ where: { id: j.id }, data: { status: "FAILED", error: "Worker stopped while this job was running (recovered on restart).", finishedAt: new Date() } });
    if (j.type === "crawl") await prisma.crawl.updateMany({ where: { jobId: j.id, status: "RUNNING" }, data: { status: "FAILED", finishedAt: new Date() } });
  }

  console.log(`[worker] started (crawl×${concurrency.crawl}, default×${concurrency.default})`);
  const shutdown = async (sig: string) => {
    console.log(`[worker] ${sig}: draining…`);
    await Promise.all(workers.map((w) => w.close()));
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});

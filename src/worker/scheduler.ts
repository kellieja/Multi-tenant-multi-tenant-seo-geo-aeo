import { prisma } from "@/lib/db/client";
import { redis } from "@/lib/redis";
import { readSettings } from "@/server/websites";
import { queueCrawl } from "@/server/crawls";

export { nextCronRun } from "@/lib/cron";
import { nextCronRun } from "@/lib/cron";

type TickTask = { name: string; run: (now: Date) => Promise<number> };

/** Extra tick tasks are registered by later modules (workflows, reports, GEO, syncs). */
export const TICK_TASKS: TickTask[] = [];

export function registerTickTask(t: TickTask) {
  if (!TICK_TASKS.some((x) => x.name === t.name)) TICK_TASKS.push(t);
}

/** Queues crawls whose per-site cron schedule is due. */
async function scheduledCrawls(now: Date) {
  const sites = await prisma.website.findMany({ where: { status: "ACTIVE" }, select: { id: true, organizationId: true, settings: true, createdAt: true } });
  let queued = 0;
  for (const s of sites) {
    const settings = readSettings(s.settings);
    if (!settings.crawlSchedule) continue;
    const last = await prisma.crawl.findFirst({ where: { websiteId: s.id, summary: { path: ["triggeredBy"], equals: "schedule" } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    let due: Date;
    try { due = nextCronRun(settings.crawlSchedule, last?.createdAt ?? s.createdAt); } catch { continue; }
    if (due <= now) {
      try {
        const r = await queueCrawl(s.organizationId, s.id, settings.crawlMode, null, "schedule");
        if (!r.deduped) queued++;
      } catch (err) {
        console.error("[scheduler] crawl", s.id, (err as Error).message);
      }
    }
  }
  return queued;
}
registerTickTask({ name: "scheduled-crawls", run: scheduledCrawls });

/** Runs once per minute across all workers (Redis lock prevents duplicate ticks). */
export async function tick() {
  const got = await redis().set("scheduler:tick-lock", String(process.pid), "EX", 55, "NX");
  if (!got) return { skipped: "another worker holds the tick lock" };
  const now = new Date();
  const results: Record<string, number | string> = {};
  for (const t of TICK_TASKS) {
    try {
      results[t.name] = await t.run(now);
    } catch (err) {
      results[t.name] = `error: ${(err as Error).message}`;
      console.error(`[scheduler] ${t.name}`, err);
    }
  }
  return results;
}

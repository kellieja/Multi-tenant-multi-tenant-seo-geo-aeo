import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/client";
import { processCrawlJob, setFindingStatus, createTaskFromFinding } from "@/server/crawls";
import { createWebsite, updateWebsiteSettings } from "@/server/websites";
import type { JobContext } from "@/lib/jobs/context";
import { fixtureSite } from "./fixtures/site";
import { makeContext } from "./helpers";

const site = fixtureSite();
beforeAll(async () => { process.env.ALLOW_PRIVATE_NETWORK_FETCH = "true"; await site.start(); });
afterAll(async () => { await site.stop(); process.env.ALLOW_PRIVATE_NETWORK_FETCH = "false"; });

async function runCrawl(orgId: string, websiteId: string) {
  const w = await prisma.website.findUniqueOrThrow({ where: { id: websiteId } });
  const crawl = await prisma.crawl.create({ data: { organizationId: orgId, websiteId, settings: w.settings as object, summary: { triggeredBy: "test" } } });
  const job = await prisma.job.create({ data: { organizationId: orgId, websiteId, type: "crawl", payload: { crawlId: crawl.id } } });
  const progress: number[] = [];
  const jc: JobContext = { job, progress: async (p) => { progress.push(p); }, isCancelled: async () => false, log: () => undefined };
  const result = await processCrawlJob(jc);
  return { crawl: await prisma.crawl.findUniqueOrThrow({ where: { id: crawl.id } }), result, progress };
}

describe("crawl job end-to-end", () => {
  it("persists pages/findings with scores, then resolves and regresses findings across crawls", async () => {
    site.state.fixed = false;
    const ctx = await makeContext("OWNER");
    const w = await createWebsite(ctx, { name: "Fixture", url: site.origin });
    await updateWebsiteSettings(ctx, w.id, { crawlDelayMs: 100, checkExternalLinks: false });

    const first = await runCrawl(ctx.org.id, w.id);
    expect(first.crawl.status).toBe("SUCCEEDED");
    expect(first.crawl.healthScore).toBeGreaterThan(0);
    expect(first.progress.at(-1)).toBe(100);
    const pages = await prisma.crawledPage.count({ where: { crawlId: first.crawl.id } });
    expect(pages).toBeGreaterThan(5);
    const meta = await ctx.db.auditFinding.findFirstOrThrow({ where: { websiteId: w.id, issueType: "missing_meta_description", url: `${site.origin}/about` } });
    expect(meta.status).toBe("OPEN");
    expect(meta.priorityScore).toBeGreaterThan(0);
    expect((meta.priorityFactors as { key: string }[]).map((f) => f.key)).toContain("severity");
    expect(meta.recommendation.length).toBeGreaterThan(10);

    // Manual workflow: task creation moves finding to IN_PROGRESS and records history
    const task = await createTaskFromFinding(ctx, meta.id);
    expect(task.findingId).toBe(meta.id);
    expect((await ctx.db.auditFinding.findUniqueOrThrow({ where: { id: meta.id } })).status).toBe("IN_PROGRESS");

    // Fix the site → finding resolves on next crawl
    site.state.fixed = true;
    const second = await runCrawl(ctx.org.id, w.id);
    expect((second.result as { resolved: number }).resolved).toBeGreaterThan(0);
    const after = await ctx.db.auditFinding.findUniqueOrThrow({ where: { id: meta.id } });
    expect(after.status).toBe("RESOLVED");
    expect((await ctx.db.auditFinding.findFirstOrThrow({ where: { websiteId: w.id, issueType: "http_4xx", url: `${site.origin}/missing` } })).status).toBe("RESOLVED");

    // Break it again → REGRESSED with event history
    site.state.fixed = false;
    await runCrawl(ctx.org.id, w.id);
    const regressed = await ctx.db.auditFinding.findUniqueOrThrow({ where: { id: meta.id }, include: { events: { orderBy: { createdAt: "asc" } } } });
    expect(regressed.status).toBe("REGRESSED");
    expect(regressed.events.map((e) => e.toStatus)).toEqual(["OPEN", "IN_PROGRESS", "RESOLVED", "REGRESSED"]);

    // Ignored findings stay ignored
    await setFindingStatus(ctx, regressed.id, "IGNORED", "Intentional");
    await runCrawl(ctx.org.id, w.id);
    expect((await ctx.db.auditFinding.findUniqueOrThrow({ where: { id: meta.id } })).status).toBe("IGNORED");
  });

  it("incremental crawl carries forward unchanged pages", async () => {
    site.state.fixed = false;
    const ctx = await makeContext("OWNER");
    const w = await createWebsite(ctx, { name: "Inc", url: `${site.origin}/` });
    await updateWebsiteSettings(ctx, w.id, { crawlDelayMs: 100, checkExternalLinks: false });
    const full = await runCrawl(ctx.org.id, w.id);
    await updateWebsiteSettings(ctx, w.id, { crawlMode: "INCREMENTAL" });
    // Only /about has open problems; everything else is acknowledged.
    await ctx.db.auditFinding.updateMany({ where: { websiteId: w.id, url: { not: `${site.origin}/about` } }, data: { status: "IGNORED" } });
    const before = site.state.requests.length;
    await prisma.website.update({ where: { id: w.id }, data: {} });
    const w2 = await prisma.website.findUniqueOrThrow({ where: { id: w.id } });
    const crawl = await prisma.crawl.create({ data: { organizationId: ctx.org.id, websiteId: w.id, mode: "INCREMENTAL", settings: w2.settings as object, summary: {} } });
    const job = await prisma.job.create({ data: { organizationId: ctx.org.id, websiteId: w.id, type: "crawl", payload: { crawlId: crawl.id } } });
    await processCrawlJob({ job, progress: async () => undefined, isCancelled: async () => false, log: () => undefined });
    const inc = await prisma.crawl.findUniqueOrThrow({ where: { id: crawl.id } });
    expect(inc.status).toBe("SUCCEEDED");
    const total = await prisma.crawledPage.count({ where: { crawlId: inc.id } });
    const fullTotal = await prisma.crawledPage.count({ where: { crawlId: full.crawl.id } });
    expect(total).toBe(fullTotal);
    expect((inc.summary as { carriedForward: number }).carriedForward).toBeGreaterThan(3);
    const fetched = site.state.requests.slice(before).filter((r) => !r.startsWith("/img") && r !== "/robots.txt" && r !== "/sitemap.xml");
    expect(new Set(fetched)).toEqual(new Set(["/", "/about"]));
  });
});

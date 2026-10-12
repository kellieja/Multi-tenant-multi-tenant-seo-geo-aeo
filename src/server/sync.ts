import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { JobContext } from "@/lib/jobs/context";
import { enqueueJob } from "@/lib/jobs/queue";
import { findConnection, withSyncLog, readSecret } from "@/integrations/connections";
import { gscQuery, ga4Report } from "@/integrations/google";
import { runPageSpeed } from "@/integrations/pagespeed";
import { readSettings } from "./websites";
import { fingerprintOf } from "./crawls";
import { ISSUES } from "@/audit/catalog";
import { normalizeUrl } from "@/lib/url";
import { scoreFinding } from "@/audit/priority";

const DAY = 86400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const utcDay = (s: string) => new Date(`${s}T00:00:00Z`);

async function siteFor(jc: JobContext) {
  if (!jc.job.websiteId) throw new Error("Job has no website");
  return prisma.website.findUniqueOrThrow({ where: { id: jc.job.websiteId } });
}

/**
 * Search Console sync. First run backfills 16 months of daily totals and 28 days of
 * query×page rows; later runs re-pull the last 10 days (GSC data finalises after ~3 days).
 */
export async function processGscSync(jc: JobContext) {
  const site = await siteFor(jc);
  const conn = await findConnection(site.organizationId, "GOOGLE_SEARCH_CONSOLE", site.id);
  if (!conn) throw new Error("Search Console is not connected for this website");
  const property = (conn.config as { property?: string }).property ?? readSettings(site.settings).gscPropertyUrl;
  if (!property) throw new Error("No Search Console property selected. Choose one in Integrations.");

  return withSyncLog(conn, "gsc.searchAnalytics", site.id, async () => {
    const hasData = await prisma.searchConsoleDaily.count({ where: { websiteId: site.id } });
    const full = Boolean((jc.job.payload as { full?: boolean }).full) || hasData === 0;
    const end = new Date(Date.now() - DAY);
    const totalsStart = new Date(end.getTime() - (full ? 485 : 10) * DAY);
    const detailStart = new Date(end.getTime() - (full ? 28 : 10) * DAY);

    await jc.progress(10, "Fetching daily totals");
    const totals = await gscQuery(conn, property, { startDate: iso(totalsStart), endDate: iso(end), dimensions: ["date"], dataState: "all" });
    for (const r of totals.rows) {
      const date = utcDay(r.keys[0]);
      await prisma.searchConsoleDaily.upsert({
        where: { websiteId_date: { websiteId: site.id, date } },
        create: { organizationId: site.organizationId, websiteId: site.id, date, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position },
        update: { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position, fetchedAt: new Date() },
      });
    }

    await jc.progress(45, "Fetching query and page rows");
    const detail = await gscQuery(conn, property, { startDate: iso(detailStart), endDate: iso(end), dimensions: ["date", "query", "page"], dataState: "all" });
    // Replace the window atomically so re-pulled days don't duplicate.
    await prisma.$transaction([
      prisma.searchConsoleQuery.deleteMany({ where: { websiteId: site.id, date: { gte: detailStart, lte: end } } }),
      prisma.searchConsoleQuery.createMany({
        data: detail.rows.map((r) => ({ organizationId: site.organizationId, websiteId: site.id, date: utcDay(r.keys[0]), query: r.keys[1].slice(0, 500), page: r.keys[2].slice(0, 2000), clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
        skipDuplicates: true,
      }),
    ]);
    await jc.progress(100, `Synced ${totals.rows.length} days and ${detail.rows.length} query/page rows`);
    const { emitEvent } = await import("./workflows");
    await emitEvent(site.organizationId, "gsc.synced", site.id);
    return { items: totals.rows.length + detail.rows.length, cost: totals.calls + detail.calls, message: `${totals.rows.length} daily rows, ${detail.rows.length} query/page rows (${property})` };
  });
}

/** GA4 sync: daily sessions/users/key events plus Organic Search sessions. */
export async function processGa4Sync(jc: JobContext) {
  const site = await siteFor(jc);
  const conn = await findConnection(site.organizationId, "GOOGLE_ANALYTICS_4", site.id);
  if (!conn) throw new Error("Google Analytics is not connected for this website");
  const propertyId = (conn.config as { propertyId?: string }).propertyId ?? readSettings(site.settings).ga4PropertyId;
  if (!propertyId) throw new Error("No GA4 property selected. Choose one in Integrations.");

  return withSyncLog(conn, "ga4.runReport", site.id, async () => {
    const hasData = await prisma.analyticsDaily.count({ where: { websiteId: site.id } });
    const days = hasData ? 10 : 480;
    const dateRanges = [{ startDate: `${days}daysAgo`, endDate: "yesterday" }];
    await jc.progress(10, "Fetching sessions");
    const all = await ga4Report(conn, propertyId, { dateRanges, dimensions: [{ name: "date" }], metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "keyEvents" }], limit: 100000 });
    await jc.progress(50, "Fetching organic search sessions");
    const organic = await ga4Report(conn, propertyId, {
      dateRanges, dimensions: [{ name: "date" }], metrics: [{ name: "sessions" }], limit: 100000,
      dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { value: "Organic Search" } } },
    });
    const organicBy = new Map((organic.rows ?? []).map((r) => [r.dimensionValues[0].value, Number(r.metricValues[0].value)]));
    for (const r of all.rows ?? []) {
      const d = r.dimensionValues[0].value; // YYYYMMDD
      const date = utcDay(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);
      const data = { sessions: Number(r.metricValues[0].value), users: Number(r.metricValues[1].value), conversions: Number(r.metricValues[2].value), organicSessions: organicBy.get(d) ?? 0, fetchedAt: new Date() };
      await prisma.analyticsDaily.upsert({ where: { websiteId_date: { websiteId: site.id, date } }, create: { organizationId: site.organizationId, websiteId: site.id, date, ...data }, update: data });
    }
    await jc.progress(100, `Synced ${all.rows?.length ?? 0} days`);
    return { items: all.rows?.length ?? 0, cost: 2, message: `${all.rows?.length ?? 0} days from property ${propertyId}` };
  });
}

/**
 * PageSpeed Insights for the homepage and the most important pages (by GSC clicks,
 * else internal inlinks). Stores lab + field metrics and maintains CWV findings.
 */
export async function processPsiCheck(jc: JobContext) {
  const site = await siteFor(jc);
  const conn = await findConnection(site.organizationId, "PAGESPEED_INSIGHTS", null);
  const apiKey = conn?.encryptedSecret ? readSecret<{ apiKey?: string }>(conn).apiKey : process.env.PAGESPEED_API_KEY || undefined;
  const payload = jc.job.payload as { urls?: string[]; limit?: number };
  let urls = payload.urls ?? [];
  if (!urls.length) {
    const top = await prisma.searchConsoleQuery.groupBy({ by: ["page"], where: { websiteId: site.id, date: { gte: new Date(Date.now() - 28 * DAY) } }, _sum: { clicks: true }, orderBy: { _sum: { clicks: "desc" } }, take: payload.limit ?? 5 });
    urls = top.map((t) => t.page);
    if (!urls.length) {
      const crawl = await prisma.crawl.findFirst({ where: { websiteId: site.id, status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" } });
      if (crawl) urls = (await prisma.crawledPage.findMany({ where: { crawlId: crawl.id, indexable: true }, orderBy: { inlinks: "desc" }, take: payload.limit ?? 5, select: { url: true } })).map((p) => p.url);
    }
    urls = [...new Set([site.baseUrl, ...urls])].slice(0, (payload.limit ?? 5) + 1);
  }

  const run = async () => {
    let done = 0;
    const results = [];
    for (const url of urls) {
      for (const strategy of ["mobile", "desktop"] as const) {
        await jc.progress(Math.round((done / (urls.length * 2)) * 95), `PageSpeed ${strategy}: ${url}`);
        const r = await runPageSpeed(url, strategy, apiKey);
        await prisma.pageSpeedResult.create({ data: { organizationId: site.organizationId, websiteId: site.id, url, strategy, ...r.metrics, raw: r.raw as Prisma.InputJsonValue } });
        results.push({ url, strategy, ...r.metrics });
        done++;
      }
    }
    await upsertCwvFindings(site.id, site.organizationId, results);
    return { items: results.length, cost: results.length, message: `${results.length} PageSpeed runs` };
  };
  return conn ? withSyncLog(conn, "pagespeed.runPagespeed", site.id, run) : run();
}

type PsiRow = { url: string; strategy: string; performanceScore: number | null; fieldLcpMs: number | null; fieldInpMs: number | null; fieldCls: number | null; fieldCategory: string | null };

async function upsertCwvFindings(websiteId: string, organizationId: string, rows: PsiRow[]) {
  const now = new Date();
  for (const r of rows) {
    const url = normalizeUrl(r.url) ?? r.url;
    const failing: string[] = [];
    if (r.fieldLcpMs != null && r.fieldLcpMs > 2500) failing.push(`LCP ${(r.fieldLcpMs / 1000).toFixed(1)}s (> 2.5s)`);
    if (r.fieldInpMs != null && r.fieldInpMs > 200) failing.push(`INP ${Math.round(r.fieldInpMs)}ms (> 200ms)`);
    if (r.fieldCls != null && r.fieldCls > 0.1) failing.push(`CLS ${r.fieldCls.toFixed(2)} (> 0.1)`);
    const checks: [keyof typeof ISSUES, boolean, Record<string, unknown>][] = [
      ["cwv_poor", failing.length > 0, { strategy: r.strategy, failing, fieldCategory: r.fieldCategory, source: "Chrome UX Report via PageSpeed Insights" }],
      ["lab_performance_poor", r.performanceScore != null && r.performanceScore < 0.5, { strategy: r.strategy, performanceScore: r.performanceScore, source: "Lighthouse lab test via PageSpeed Insights" }],
    ];
    for (const [issueType, failingNow, evidence] of checks) {
      const fp = fingerprintOf(websiteId, { issueType, url, key: r.strategy });
      const existing = await prisma.auditFinding.findUnique({ where: { websiteId_fingerprint: { websiteId, fingerprint: fp } } });
      const def = ISSUES[issueType];
      if (failingNow) {
        const { score, factors } = scoreFinding({ issueType, affectedPages: 1, impressions: null, depth: null, inlinks: null, isHomepage: false });
        const data = { severity: def.severity, url, title: `${def.title} (${r.strategy})`, description: def.description, evidence: evidence as Prisma.InputJsonValue, recommendation: def.recommendation, implementation: def.implementation, automatable: false, requiresApproval: true, priorityScore: score, priorityFactors: factors as unknown as Prisma.InputJsonValue, lastSeenAt: now, category: def.category, issueType };
        if (!existing) {
          const f = await prisma.auditFinding.create({ data: { ...data, organizationId, websiteId, fingerprint: fp, status: "OPEN" } });
          await prisma.findingEvent.create({ data: { organizationId, findingId: f.id, toStatus: "OPEN", note: "Detected by PageSpeed Insights" } });
        } else {
          const status = existing.status === "RESOLVED" ? "REGRESSED" : existing.status;
          await prisma.auditFinding.update({ where: { id: existing.id }, data: { ...data, status, resolvedAt: status === "REGRESSED" ? null : existing.resolvedAt } });
          if (status !== existing.status) await prisma.findingEvent.create({ data: { organizationId, findingId: existing.id, fromStatus: existing.status, toStatus: status, note: "Detected again by PageSpeed Insights" } });
        }
      } else if (existing && ["OPEN", "IN_PROGRESS", "REGRESSED"].includes(existing.status)) {
        await prisma.auditFinding.update({ where: { id: existing.id }, data: { status: "RESOLVED", resolvedAt: now } });
        await prisma.findingEvent.create({ data: { organizationId, findingId: existing.id, fromStatus: existing.status, toStatus: "RESOLVED", note: "Passing in latest PageSpeed run" } });
      }
    }
  }
}

/** Scheduler: daily GSC/GA4 refresh for connected, active websites. */
export async function scheduleDailySyncs(now: Date) {
  const conns = await prisma.integrationConnection.findMany({
    where: { provider: { in: ["GOOGLE_SEARCH_CONSOLE", "GOOGLE_ANALYTICS_4"] }, status: "CONNECTED", websiteId: { not: null }, OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: new Date(now.getTime() - 20 * 3600_000) } }] },
    include: { website: { select: { status: true } } },
  });
  let n = 0;
  for (const c of conns) {
    if (c.website?.status !== "ACTIVE") continue;
    const failedRecently = await prisma.job.findFirst({ where: { websiteId: c.websiteId, type: c.provider === "GOOGLE_SEARCH_CONSOLE" ? "gsc-sync" : "ga4-sync", status: "FAILED", finishedAt: { gt: new Date(now.getTime() - 6 * 3600_000) } } });
    if (failedRecently) continue; // back off for 6h after a failure
    const r = await enqueueJob({ organizationId: c.organizationId, websiteId: c.websiteId, type: c.provider === "GOOGLE_SEARCH_CONSOLE" ? "gsc-sync" : "ga4-sync", dedupe: true });
    if (!r.deduped) n++;
  }
  return n;
}

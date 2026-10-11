import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { OrgContext } from "@/lib/auth/context";

export const dashboardFilterSchema = z.object({
  range: z.enum(["7d", "28d", "90d", "180d", "365d", "custom"]).default("28d"),
  from: z.string().optional(),
  to: z.string().optional(),
  websiteId: z.string().optional(),
  clientId: z.string().optional(),
});
export type DashboardFilter = z.infer<typeof dashboardFilterSchema>;

const DAY = 86400_000;
const startOfDayUTC = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export function resolvePeriod(f: DashboardFilter) {
  const today = startOfDayUTC(new Date());
  let to = today;
  let from: Date;
  if (f.range === "custom" && f.from && f.to) {
    from = startOfDayUTC(new Date(f.from));
    to = startOfDayUTC(new Date(f.to));
    if (!(from <= to)) [from, to] = [to, from];
  } else {
    const days = { "7d": 7, "28d": 28, "90d": 90, "180d": 180, "365d": 365, custom: 28 }[f.range];
    from = new Date(today.getTime() - (days - 1) * DAY);
  }
  const days = Math.round((to.getTime() - from.getTime()) / DAY) + 1;
  const prevTo = new Date(from.getTime() - DAY);
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * DAY);
  return { from, to, prevFrom, prevTo, days };
}

/** Website ids visible to the member after applying website/client filters. */
export async function scopedWebsiteIds(ctx: OrgContext, f: Pick<DashboardFilter, "websiteId" | "clientId">) {
  const where: Prisma.WebsiteWhereInput = {
    status: { not: "ARCHIVED" },
    ...(ctx.websiteScope ? { id: { in: ctx.websiteScope } } : {}),
    ...(f.clientId ? { clientId: f.clientId } : {}),
  };
  if (f.websiteId) where.id = ctx.websiteScope && !ctx.websiteScope.includes(f.websiteId) ? "__none__" : f.websiteId;
  const sites = await ctx.db.website.findMany({ where, select: { id: true, name: true, domain: true }, orderBy: { name: "asc" } });
  return sites;
}

interface Totals { clicks: number; impressions: number; ctr: number | null; position: number | null }

function gscTotals(rows: { clicks: number; impressions: number; position: number }[]): Totals | null {
  if (!rows.length) return null;
  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  const impressions = rows.reduce((s, r) => s + r.impressions, 0);
  // Impression-weighted average position, matching how GSC aggregates.
  const posWeighted = rows.reduce((s, r) => s + r.position * r.impressions, 0);
  return { clicks, impressions, ctr: impressions ? clicks / impressions : null, position: impressions ? posWeighted / impressions : null };
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export async function getDashboard(ctx: OrgContext, raw: unknown) {
  const f = dashboardFilterSchema.parse(raw ?? {});
  const p = resolvePeriod(f);
  const sites = await scopedWebsiteIds(ctx, f);
  const ids = sites.map((s) => s.id);
  const inSites = { websiteId: { in: ids } };
  const cur = { gte: p.from, lte: p.to };
  const prev = { gte: p.prevFrom, lte: p.prevTo };
  const curEnd = new Date(p.to.getTime() + DAY);

  const [
    gscCur, gscPrev, gscLatest, ga4Cur, ga4Prev, ga4Latest, keywords, latestCrawls, findingsBySeverity,
    tasksDone, tasksDonePrev, blGained, blLost, blGainedPrev, blLostPrev, refDomains, blVelocity,
    contentApplied, siteChangesApplied, execs, aeo, geo, geoLatest, rankLatestTime,
  ] = await Promise.all([
    ctx.db.searchConsoleDaily.findMany({ where: { ...inSites, date: cur }, select: { websiteId: true, date: true, clicks: true, impressions: true, position: true } }),
    ctx.db.searchConsoleDaily.findMany({ where: { ...inSites, date: prev }, select: { date: true, clicks: true, impressions: true, position: true } }),
    ctx.db.searchConsoleDaily.aggregate({ where: inSites, _max: { fetchedAt: true, date: true } }),
    ctx.db.analyticsDaily.findMany({ where: { ...inSites, date: cur }, select: { date: true, organicSessions: true, sessions: true } }),
    ctx.db.analyticsDaily.aggregate({ where: { ...inSites, date: prev }, _sum: { organicSessions: true } }),
    ctx.db.analyticsDaily.aggregate({ where: inSites, _max: { fetchedAt: true } }),
    ctx.db.keyword.findMany({
      where: inSites,
      select: {
        id: true,
        observations: { orderBy: { observedAt: "desc" }, take: 1, select: { position: true, observedAt: true } },
      },
    }),
    ctx.db.crawl.findMany({ where: { ...inSites, status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" }, distinct: ["websiteId"], select: { websiteId: true, healthScore: true, finishedAt: true, pagesCrawled: true, summary: true } }),
    ctx.db.auditFinding.groupBy({ by: ["severity"], where: { ...inSites, status: { in: ["OPEN", "REGRESSED"] } }, _count: true }),
    ctx.db.task.count({ where: { ...inSites, status: "DONE", completedAt: { gte: p.from, lt: curEnd } } }),
    ctx.db.task.count({ where: { ...inSites, status: "DONE", completedAt: { gte: p.prevFrom, lt: p.from } } }),
    ctx.db.backlink.count({ where: { ...inSites, firstSeenAt: { gte: p.from, lt: curEnd } } }),
    ctx.db.backlink.count({ where: { ...inSites, lostAt: { gte: p.from, lt: curEnd } } }),
    ctx.db.backlink.count({ where: { ...inSites, firstSeenAt: { gte: p.prevFrom, lt: p.from } } }),
    ctx.db.backlink.count({ where: { ...inSites, lostAt: { gte: p.prevFrom, lt: p.from } } }),
    ctx.db.referringDomain.findMany({ where: { ...inSites, lostAt: null }, select: { providerRank: true, rankSource: true } }),
    ctx.db.backlink.findMany({ where: { ...inSites, OR: [{ firstSeenAt: { gte: p.from, lt: curEnd } }, { lostAt: { gte: p.from, lt: curEnd } }] }, select: { firstSeenAt: true, lostAt: true } }),
    ctx.db.contentSuggestion.count({ where: { ...inSites, status: { in: ["APPROVED", "APPLIED"] }, updatedAt: { gte: p.from, lt: curEnd } } }),
    ctx.db.siteChange.count({ where: { ...inSites, status: "APPLIED", appliedAt: { gte: p.from, lt: curEnd } } }),
    ctx.db.workflowExecution.groupBy({ by: ["status"], where: { createdAt: { gte: p.from, lt: curEnd }, OR: [{ websiteId: null }, inSites] }, _count: true }),
    ctx.db.aeoAssessment.findMany({ where: inSites, orderBy: { assessedAt: "desc" }, distinct: ["websiteId", "url"], select: { score: true, assessedAt: true }, take: 2000 }),
    ctx.db.geoObservation.findMany({ where: { ...inSites, observedAt: { gte: p.from, lt: curEnd } }, select: { brandMentioned: true, brandCited: true, observedAt: true, platform: true } }),
    ctx.db.geoObservation.aggregate({ where: inSites, _max: { observedAt: true } }),
    ctx.db.rankObservation.aggregate({ where: inSites, _max: { observedAt: true } }),
  ]);

  // Search Console
  const gscNow = gscTotals(gscCur);
  const gscBefore = gscTotals(gscPrev);
  const byDay = new Map<string, { clicks: number; impressions: number; pw: number }>();
  const prevByOffset = new Map<number, number>();
  for (const r of gscCur) {
    const k = isoDay(r.date);
    const e = byDay.get(k) ?? { clicks: 0, impressions: 0, pw: 0 };
    e.clicks += r.clicks; e.impressions += r.impressions; e.pw += r.position * r.impressions;
    byDay.set(k, e);
  }
  for (const r of gscPrev) {
    const off = Math.round((r.date.getTime() - p.prevFrom.getTime()) / DAY);
    prevByOffset.set(off, (prevByOffset.get(off) ?? 0) + r.clicks);
  }
  const series = Array.from({ length: p.days }, (_, i) => {
    const d = new Date(p.from.getTime() + i * DAY);
    const e = byDay.get(isoDay(d));
    return {
      date: isoDay(d),
      clicks: e?.clicks ?? null,
      impressions: e?.impressions ?? null,
      ctr: e && e.impressions ? e.clicks / e.impressions : null,
      position: e && e.impressions ? e.pw / e.impressions : null,
      prevClicks: prevByOffset.get(i) ?? null,
    };
  });
  const clicksBySite = new Map<string, number>();
  for (const r of gscCur) clicksBySite.set(r.websiteId, (clicksBySite.get(r.websiteId) ?? 0) + r.clicks);

  // Rankings (latest observation per keyword)
  const latest = keywords.map((k) => k.observations[0]).filter(Boolean);
  const buckets = [
    { label: "1–3", min: 1, max: 3 }, { label: "4–10", min: 4, max: 10 }, { label: "11–20", min: 11, max: 20 },
    { label: "21–50", min: 21, max: 50 }, { label: "51–100", min: 51, max: 100 },
  ].map((b) => ({ ...b, count: latest.filter((o) => o.position != null && o.position >= b.min && o.position <= b.max).length }));
  const notRanking = latest.filter((o) => o.position == null).length;

  // Keyword movement: compare latest position to last observation before period start.
  let gained = 0, lost = 0, improved = 0, declined = 0;
  if (latest.length) {
    const baseline = await ctx.db.rankObservation.findMany({
      where: { keywordId: { in: keywords.map((k) => k.id) }, observedAt: { lt: p.from } },
      orderBy: { observedAt: "desc" },
      distinct: ["keywordId"],
      select: { keywordId: true, position: true },
    });
    const baseBy = new Map(baseline.map((b) => [b.keywordId, b.position]));
    for (const k of keywords) {
      const now = k.observations[0];
      if (!now || !baseBy.has(k.id)) continue;
      const before = baseBy.get(k.id) ?? null;
      const inTop = (x: number | null) => x != null && x <= 100;
      if (!inTop(before) && inTop(now.position)) gained++;
      else if (inTop(before) && !inTop(now.position)) lost++;
      else if (before != null && now.position != null) {
        if (now.position < before) improved++;
        else if (now.position > before) declined++;
      }
    }
  }

  // Technical health
  const healthVals = latestCrawls.map((c) => c.healthScore).filter((v): v is number => v != null);
  const crawlErrors = latestCrawls.reduce((s, c) => s + Number((c.summary as { errorPages?: number } | null)?.errorPages ?? 0), 0);
  const indexable = latestCrawls.reduce((s, c) => s + Number((c.summary as { indexablePages?: number } | null)?.indexablePages ?? 0), 0);

  // Backlink velocity
  const vel = new Map<string, { gained: number; lost: number }>();
  for (const b of blVelocity) {
    if (b.firstSeenAt >= p.from) { const k = isoDay(b.firstSeenAt); const e = vel.get(k) ?? { gained: 0, lost: 0 }; e.gained++; vel.set(k, e); }
    if (b.lostAt && b.lostAt >= p.from) { const k = isoDay(b.lostAt); const e = vel.get(k) ?? { gained: 0, lost: 0 }; e.lost++; vel.set(k, e); }
  }
  const velocity = Array.from({ length: p.days }, (_, i) => {
    const k = isoDay(new Date(p.from.getTime() + i * DAY));
    return { date: k, gained: vel.get(k)?.gained ?? 0, lost: -(vel.get(k)?.lost ?? 0) };
  });
  const rankedDomains = refDomains.filter((d) => d.providerRank != null);

  // Automation
  const execCount = (s: string) => execs.find((e) => e.status === s)?._count ?? 0;
  const execTotal = execs.reduce((s, e) => s + e._count, 0);

  // GEO
  const geoPlatforms = [...new Set(geo.map((g) => g.platform))];

  return {
    filter: f,
    period: p,
    sites,
    searchConsole: {
      available: gscNow != null,
      lastSync: gscLatest._max.fetchedAt,
      lastDate: gscLatest._max.date,
      totals: gscNow,
      previous: gscBefore,
      series,
      bySite: sites.map((s) => ({ id: s.id, name: s.name, clicks: clicksBySite.get(s.id) ?? null })).filter((s) => s.clicks != null).sort((a, b) => (b.clicks ?? 0) - (a.clicks ?? 0)),
    },
    analytics: {
      available: ga4Cur.length > 0,
      lastSync: ga4Latest._max.fetchedAt,
      organicSessions: ga4Cur.reduce((s, r) => s + r.organicSessions, 0),
      previous: ga4Prev._sum.organicSessions,
    },
    rankings: {
      available: latest.length > 0,
      tracked: keywords.length,
      lastObserved: rankLatestTime._max.observedAt,
      distribution: [...buckets.map((b) => ({ label: b.label, count: b.count })), { label: "Not in top 100", count: notRanking }],
      gained, lost, improved, declined,
    },
    technical: {
      available: latestCrawls.length > 0,
      crawledSites: latestCrawls.length,
      lastCrawl: latestCrawls.reduce<Date | null>((m, c) => (c.finishedAt && (!m || c.finishedAt > m) ? c.finishedAt : m), null),
      avgHealth: healthVals.length ? healthVals.reduce((s, v) => s + v, 0) / healthVals.length : null,
      crawlErrors,
      indexablePages: indexable,
      findings: ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].map((s) => ({ severity: s, count: findingsBySeverity.find((x) => x.severity === s)?._count ?? 0 })),
    },
    backlinks: {
      available: refDomains.length > 0 || blGained + blLost > 0,
      referringDomains: refDomains.length,
      gained: blGained, lost: blLost, gainedPrev: blGainedPrev, lostPrev: blLostPrev,
      velocity,
      quality: rankedDomains.length
        ? {
            source: rankedDomains[0].rankSource ?? "provider",
            high: rankedDomains.filter((d) => (d.providerRank ?? 0) >= 500).length,
            mid: rankedDomains.filter((d) => (d.providerRank ?? 0) >= 200 && (d.providerRank ?? 0) < 500).length,
            low: rankedDomains.filter((d) => (d.providerRank ?? 0) < 200).length,
          }
        : null,
    },
    work: { tasksDone, tasksDonePrev, contentApplied, siteChangesApplied },
    automation: { total: execTotal, succeeded: execCount("SUCCEEDED"), failed: execCount("FAILED"), running: execCount("RUNNING") + execCount("QUEUED") },
    aeo: { available: aeo.length > 0, pages: aeo.length, avgScore: aeo.length ? aeo.reduce((s, a) => s + a.score, 0) / aeo.length : null },
    geo: {
      available: geo.length > 0,
      observations: geo.length,
      platforms: geoPlatforms,
      mentionRate: geo.length ? geo.filter((g) => g.brandMentioned).length / geo.length : null,
      citationRate: geo.length ? geo.filter((g) => g.brandCited).length / geo.length : null,
      lastObserved: geoLatest._max.observedAt,
    },
  };
}

export type DashboardData = Awaited<ReturnType<typeof getDashboard>>;

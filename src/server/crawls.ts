import type { Crawl, CrawledPage, Prisma, FindingStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { OrgContext } from "@/lib/auth/context";
import { assertWebsiteAccess } from "@/lib/auth/context";
import { enqueueJob } from "@/lib/jobs/queue";
import type { JobContext } from "@/lib/jobs/context";
import { sha256 } from "@/lib/crypto";
import { UserError } from "@/lib/errors";
import { normalizeUrl } from "@/lib/url";
import { crawlSite, type CrawledPageRecord, type CrawlLinkRecord, type CrawlResult } from "@/crawler/crawl";
import { runAudit, healthScore, indexabilityReason, HEALTH_FORMULA, type RawFinding } from "@/audit/rules";
import { ISSUES, type IssueType } from "@/audit/catalog";
import { scoreFinding } from "@/audit/priority";
import { readSettings } from "./websites";
import { notify } from "./notifications";
import { writeAuditLog } from "@/lib/audit-log";

const KEEP_CRAWL_DETAILS = 5;
const EXTERNAL_ISSUE_TYPES = new Set(["cwv_poor", "lab_performance_poor"]);

export async function startCrawl(ctx: OrgContext, websiteId: string, mode?: "FULL" | "INCREMENTAL", triggeredBy = "manual") {
  ctx.assert("audits:run");
  const site = await assertWebsiteAccess(ctx, websiteId);
  return queueCrawl(ctx.org.id, site.id, mode ?? readSettings(site.settings).crawlMode, ctx.userId, triggeredBy);
}

/** Also used by the scheduler and automations (no user context). */
export async function queueCrawl(organizationId: string, websiteId: string, mode: "FULL" | "INCREMENTAL", createdById: string | null, triggeredBy: string) {
  const site = await prisma.website.findFirst({ where: { id: websiteId, organizationId } });
  if (!site) throw new UserError("Website not found");
  if (site.status !== "ACTIVE") throw new UserError(`${site.domain} is ${site.status.toLowerCase()}; resume it to crawl`);
  const existing = await prisma.crawl.findFirst({ where: { websiteId, status: { in: ["QUEUED", "RUNNING"] } } });
  if (existing) return { crawl: existing, deduped: true };
  let effectiveMode = mode;
  if (mode === "INCREMENTAL" && !(await prisma.crawl.findFirst({ where: { websiteId, status: "SUCCEEDED" } }))) effectiveMode = "FULL";
  const crawl = await prisma.crawl.create({
    data: { organizationId, websiteId, mode: effectiveMode, settings: site.settings as Prisma.InputJsonValue, summary: { triggeredBy } },
  });
  const { job } = await enqueueJob({ organizationId, websiteId, type: "crawl", payload: { crawlId: crawl.id }, createdById });
  const updated = await prisma.crawl.update({
    where: { id: crawl.id },
    data: { jobId: job.id, ...(job.status === "FAILED" ? { status: "FAILED", finishedAt: new Date(), summary: { triggeredBy, error: job.error } } : {}) },
  });
  return { crawl: updated, deduped: false };
}

function recordFromRow(row: CrawledPage): CrawledPageRecord {
  const x = (row.extra ?? {}) as Record<string, unknown>;
  return {
    url: row.url, finalUrl: row.finalUrl, finalStatus: (x.finalStatus as number) ?? null, statusCode: row.statusCode, contentType: row.contentType,
    redirectChain: row.redirectChain as never, responseTimeMs: row.responseTimeMs, bytes: row.bytes, depth: row.depth,
    blockedByRobots: row.blockedByRobots, robotsRule: x.robotsRule as string | undefined, xRobotsTag: row.xRobotsTag, error: row.error,
    inSitemap: row.inSitemap, isHtml: /html/i.test(row.contentType ?? ""), title: row.title, titleCount: (x.titleCount as number) ?? (row.title ? 1 : 0),
    metaDescription: row.metaDescription, metaDescriptionCount: (x.metaDescriptionCount as number) ?? (row.metaDescription ? 1 : 0),
    robotsMeta: row.robotsMeta, canonical: row.canonical, canonicalCount: (x.canonicalCount as number) ?? (row.canonical ? 1 : 0),
    lang: row.lang, hasViewport: row.hasViewport, headings: row.headings as never, h1: row.h1, images: row.images as never,
    hreflang: row.hreflang as never, relNext: (x.relNext as string) ?? null, relPrev: (x.relPrev as string) ?? null,
    structuredData: row.structuredData as never, mixedContent: row.mixedContent, wordCount: row.wordCount, textSample: row.textSample ?? "",
    contentHash: row.contentHash, simhash: row.simhash, scriptCount: (x.scriptCount as number) ?? 0, outlinks: row.outlinks, inlinks: row.inlinks,
  };
}

/** Worker entry point for "crawl" jobs. */
export async function processCrawlJob(jc: JobContext) {
  const { crawlId } = jc.job.payload as { crawlId: string };
  const crawl = await prisma.crawl.findUniqueOrThrow({ where: { id: crawlId } });
  const site = await prisma.website.findUniqueOrThrow({ where: { id: crawl.websiteId } });
  const settings = readSettings(crawl.settings);
  await prisma.crawl.update({ where: { id: crawl.id }, data: { status: "RUNNING", startedAt: new Date() } });

  try {
    // Incremental: re-fetch changed/new/problem URLs, carry the rest forward from the last crawl.
    let previous: Crawl | null = null;
    let seeds: string[] | undefined;
    if (crawl.mode === "INCREMENTAL") {
      previous = await prisma.crawl.findFirst({ where: { websiteId: site.id, status: "SUCCEEDED", id: { not: crawl.id } }, orderBy: { finishedAt: "desc" } });
      if (previous) seeds = await incrementalSeeds(site.id, previous);
    }

    await jc.progress(2, "Reading robots.txt and sitemaps");
    const result = await crawlSite({
      baseUrl: site.baseUrl,
      maxPages: settings.maxPages,
      maxDepth: settings.maxDepth,
      delayMs: settings.crawlDelayMs,
      concurrency: settings.concurrency,
      includePatterns: settings.includePatterns,
      excludePatterns: settings.excludePatterns,
      userAgent: process.env.CRAWLER_USER_AGENT ?? "SearchOpsBot/1.0",
      checkExternalLinks: settings.checkExternalLinks,
      incrementalSeeds: seeds,
      isCancelled: jc.isCancelled,
      onProgress: async (p) => {
        const pct = Math.min(85, 3 + Math.round((p.crawled / Math.max(1, Math.min(p.discovered, settings.maxPages))) * 80));
        await jc.progress(pct, p.message);
        await prisma.crawl.update({ where: { id: crawl.id }, data: { pagesCrawled: p.crawled, pagesDiscovered: p.discovered } });
      },
    });
    if (result.cancelled) {
      await prisma.crawl.update({ where: { id: crawl.id }, data: { status: "CANCELLED", finishedAt: new Date() } });
      return { cancelled: true };
    }

    let carried = 0;
    if (previous && seeds) carried = await mergePrevious(result, previous.id, new Set(result.pages.map((p) => p.url)));

    await jc.progress(88, "Analysing pages");
    const raw = runAudit(result);
    const htmlPages = result.pages.filter((p) => p.isHtml && p.statusCode === 200).length;
    const score = healthScore(raw, result.pages.filter((p) => p.isHtml && p.statusCode === 200).map((p) => p.url));

    await jc.progress(92, "Saving pages and links");
    await persistPages(crawl, result, carried > 0 ? new Set(seeds) : null);

    await jc.progress(96, "Updating findings");
    const lifecycle = await reconcileFindings(crawl, result, raw);

    const counts: Record<string, number> = {};
    for (const f of raw) counts[f.issueType] = (counts[f.issueType] ?? 0) + 1;
    const summary = {
      ...(crawl.summary as object),
      htmlPages,
      totalUrls: result.pages.length,
      indexablePages: result.pages.filter((p) => !indexabilityReason(p)).length,
      errorPages: result.pages.filter((p) => (p.statusCode ?? 0) >= 400 || p.error).length,
      redirects: result.pages.filter((p) => p.redirectChain.length).length,
      blockedByRobots: result.pages.filter((p) => p.blockedByRobots).length,
      carriedForward: carried,
      limitReached: result.limitReached,
      robotsStatus: result.robots.status,
      sitemaps: result.sitemap.sitemaps,
      sitemapUrls: result.sitemap.urls.length,
      externalLinksChecked: result.externalChecks.size,
      imagesChecked: result.imageChecks.size,
      issueCounts: counts,
      bySeverity: raw.reduce<Record<string, number>>((m, f) => { const s = ISSUES[f.issueType].severity; m[s] = (m[s] ?? 0) + 1; return m; }, {}),
      ...lifecycle,
      healthFormula: HEALTH_FORMULA,
    };
    const prevScore = await prisma.crawl.findFirst({ where: { websiteId: site.id, status: "SUCCEEDED", id: { not: crawl.id } }, orderBy: { finishedAt: "desc" }, select: { healthScore: true } });
    await prisma.crawl.update({
      where: { id: crawl.id },
      data: { status: "SUCCEEDED", finishedAt: new Date(), healthScore: score, pagesCrawled: result.pages.length - carried, pagesDiscovered: result.pages.length, errorsCount: summary.errorPages, summary: summary as Prisma.InputJsonValue },
    });

    if (prevScore?.healthScore != null && prevScore.healthScore - score >= settings.alertHealthDrop) {
      await notify({ organizationId: site.organizationId, websiteId: site.id, type: "health_drop", severity: "warning", title: `${site.domain}: health dropped ${Math.round(prevScore.healthScore - score)} points`, body: `Internal health score fell from ${Math.round(prevScore.healthScore)} to ${Math.round(score)}. ${lifecycle.newFindings} new and ${lifecycle.regressed} regressed issues.`, link: `/audits/${crawl.id}` });
    }
    const newCritical = await prisma.auditFinding.count({ where: { websiteId: site.id, crawlId: crawl.id, severity: "CRITICAL", status: { in: ["OPEN", "REGRESSED"] }, firstSeenAt: { gte: crawl.createdAt } } });
    if (newCritical) {
      await notify({ organizationId: site.organizationId, websiteId: site.id, type: "critical_issue", severity: "critical", title: `${site.domain}: ${newCritical} new critical issue${newCritical > 1 ? "s" : ""}`, link: `/audits?websiteId=${site.id}&severity=CRITICAL` });
    }
    await pruneOldCrawlDetails(site.id);
    const { emitEvent } = await import("./workflows");
    await emitEvent(site.organizationId, "crawl.completed", site.id, { crawlId: crawl.id, healthScore: score });
    if (newCritical) await emitEvent(site.organizationId, "finding.critical", site.id, { count: newCritical });
    if (prevScore?.healthScore != null && prevScore.healthScore - score >= settings.alertHealthDrop) await emitEvent(site.organizationId, "health.dropped", site.id, { from: prevScore.healthScore, to: score });
    await jc.progress(100, `Crawl complete: ${result.pages.length} URLs, health ${Math.round(score)}`);
    return { healthScore: score, pages: result.pages.length, findings: raw.length, ...lifecycle };
  } catch (err) {
    await prisma.crawl.update({ where: { id: crawl.id }, data: { status: "FAILED", finishedAt: new Date(), summary: { ...(crawl.summary as object), error: (err as Error).message } } });
    throw err;
  }
}

async function incrementalSeeds(websiteId: string, previous: Crawl): Promise<string[]> {
  const [problemPages, prevPages] = await Promise.all([
    prisma.auditFinding.findMany({ where: { websiteId, status: { in: ["OPEN", "IN_PROGRESS", "REGRESSED"] } }, select: { url: true, issueType: true, status: true } }),
    prisma.crawledPage.findMany({ where: { crawlId: previous.id }, select: { url: true, inSitemap: true } }),
  ]);
  const site = await prisma.website.findUniqueOrThrow({ where: { id: websiteId } });
  const seeds = new Set<string>([normalizeUrl(site.baseUrl)!]);
  // Re-check pages with open problems. Template-wide issue types (affecting many pages) are
  // sampled, otherwise one site-wide issue would turn every incremental crawl into a full crawl.
  const byType = new Map<string, typeof problemPages>();
  for (const f of problemPages) byType.set(f.issueType, [...(byType.get(f.issueType) ?? []), f]);
  const templateWide = Math.max(5, Math.floor(prevPages.length * 0.5));
  for (const list of byType.values()) {
    const sample = list.length >= templateWide ? list.filter((f) => f.status === "IN_PROGRESS").concat(list.slice(0, 3)) : list;
    for (const f of sample) { const n = normalizeUrl(f.url); if (n) seeds.add(n); }
  }
  // New or updated sitemap URLs
  const { loadSitemaps } = await import("@/crawler/sitemap");
  const origin = new URL(site.baseUrl).origin;
  const sm = await loadSitemaps([`${origin}/sitemap.xml`], { maxUrls: 50_000 });
  const known = new Set(prevPages.map((p) => p.url));
  const since = previous.finishedAt ?? previous.createdAt;
  for (const u of sm.urls) {
    const n = normalizeUrl(u.loc);
    if (!n) continue;
    if (!known.has(n) || (u.lastmod && new Date(u.lastmod) > since)) seeds.add(n);
  }
  return [...seeds];
}

async function mergePrevious(result: CrawlResult, previousCrawlId: string, refetched: Set<string>): Promise<number> {
  const [rows, links] = await Promise.all([
    prisma.crawledPage.findMany({ where: { crawlId: previousCrawlId } }),
    prisma.crawledLink.findMany({ where: { crawlId: previousCrawlId } }),
  ]);
  let carried = 0;
  for (const row of rows) {
    if (refetched.has(row.url)) continue;
    result.pages.push(recordFromRow(row));
    carried++;
  }
  for (const l of links) if (!refetched.has(l.fromUrl)) result.links.push({ fromUrl: l.fromUrl, toUrl: l.toUrl, anchor: l.anchor ?? "", rel: l.rel ?? "", isInternal: l.isInternal, statusCode: l.statusCode });
  // Recompute inlinks over the merged graph.
  const sources = new Map<string, Set<string>>();
  for (const l of result.links) if (l.isInternal && l.fromUrl !== l.toUrl) { const s = sources.get(l.toUrl) ?? new Set(); s.add(l.fromUrl); sources.set(l.toUrl, s); }
  const status = new Map(result.pages.map((p) => [p.url, p.statusCode]));
  for (const p of result.pages) p.inlinks = sources.get(p.url)?.size ?? 0;
  for (const l of result.links) if (l.isInternal) l.statusCode = status.get(l.toUrl) ?? l.statusCode ?? null;
  return carried;
}

async function persistPages(crawl: Crawl, result: CrawlResult, refetched: Set<string> | null) {
  const pageRows: Prisma.CrawledPageCreateManyInput[] = result.pages.map((p) => ({
    organizationId: crawl.organizationId, crawlId: crawl.id, websiteId: crawl.websiteId, url: p.url.slice(0, 2000), finalUrl: p.finalUrl,
    statusCode: p.statusCode, contentType: p.contentType?.slice(0, 200), redirectChain: p.redirectChain as unknown as Prisma.InputJsonValue,
    title: p.title?.slice(0, 1000), metaDescription: p.metaDescription?.slice(0, 2000), h1: p.h1.slice(0, 10), headings: p.headings.slice(0, 100) as unknown as Prisma.InputJsonValue,
    canonical: p.canonical, robotsMeta: p.robotsMeta, xRobotsTag: p.xRobotsTag, indexable: !indexabilityReason(p), indexabilityReason: indexabilityReason(p),
    inSitemap: p.inSitemap, blockedByRobots: p.blockedByRobots, wordCount: p.wordCount, contentHash: p.contentHash, simhash: p.simhash,
    textSample: p.textSample, inlinks: p.inlinks, outlinks: p.outlinks, depth: p.depth, responseTimeMs: p.responseTimeMs, bytes: p.bytes, lang: p.lang,
    hreflang: p.hreflang as unknown as Prisma.InputJsonValue, structuredData: p.structuredData as unknown as Prisma.InputJsonValue,
    images: p.images.slice(0, 100) as unknown as Prisma.InputJsonValue, mixedContent: p.mixedContent, hasViewport: p.hasViewport, error: p.error,
    extra: { titleCount: p.titleCount, metaDescriptionCount: p.metaDescriptionCount, canonicalCount: p.canonicalCount, relNext: p.relNext, relPrev: p.relPrev, scriptCount: p.scriptCount, finalStatus: p.finalStatus ?? null, robotsRule: p.robotsRule ?? null },
    carriedForward: refetched ? !refetched.has(p.url) : false,
  }));
  for (let i = 0; i < pageRows.length; i += 500) await prisma.crawledPage.createMany({ data: pageRows.slice(i, i + 500), skipDuplicates: true });
  const linkRows: Prisma.CrawledLinkCreateManyInput[] = dedupeLinks(result.links).map((l) => ({
    organizationId: crawl.organizationId, crawlId: crawl.id, fromUrl: l.fromUrl.slice(0, 2000), toUrl: l.toUrl.slice(0, 2000), anchor: l.anchor.slice(0, 300), rel: l.rel.slice(0, 100) || null, isInternal: l.isInternal, statusCode: l.statusCode ?? null,
  }));
  for (let i = 0; i < linkRows.length; i += 2000) await prisma.crawledLink.createMany({ data: linkRows.slice(i, i + 2000) });
}

function dedupeLinks(links: CrawlLinkRecord[]) {
  const seen = new Set<string>();
  return links.filter((l) => { const k = `${l.fromUrl}|${l.toUrl}|${l.anchor}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export const fingerprintOf = (websiteId: string, f: Pick<RawFinding, "issueType" | "url" | "key">) => sha256(`${websiteId}|${f.issueType}|${f.url}|${f.key ?? ""}`);

/**
 * Upserts findings by stable fingerprint and records lifecycle events:
 * new → OPEN, previously RESOLVED → REGRESSED, no longer detected → RESOLVED.
 * IGNORED findings stay ignored.
 */
async function reconcileFindings(crawl: Crawl, result: CrawlResult, raw: RawFinding[]) {
  const websiteId = crawl.websiteId;
  const orgId = crawl.organizationId;
  const home = normalizeUrl(result.baseUrl);
  const pageBy = new Map(result.pages.map((p) => [p.url, p]));
  const typeCounts = new Map<string, number>();
  for (const f of raw) typeCounts.set(f.issueType, (typeCounts.get(f.issueType) ?? 0) + 1);

  // GSC impressions per page (last 28 days) for prioritisation, if synced.
  const since = new Date(Date.now() - 28 * 86400_000);
  const gsc = await prisma.searchConsoleQuery.groupBy({ by: ["page"], where: { websiteId, date: { gte: since } }, _sum: { impressions: true } });
  const hasGsc = gsc.length > 0;
  const impressions = new Map(gsc.map((g) => [normalizeUrl(g.page) ?? g.page, g._sum.impressions ?? 0]));

  const existing = await prisma.auditFinding.findMany({ where: { websiteId }, select: { id: true, fingerprint: true, status: true, issueType: true } });
  const byFp = new Map(existing.map((e) => [e.fingerprint, e]));
  const seen = new Set<string>();
  let newFindings = 0, regressed = 0, resolved = 0;
  const now = new Date();
  const events: Prisma.FindingEventCreateManyInput[] = [];

  for (const f of raw) {
    const fp = fingerprintOf(websiteId, f);
    if (seen.has(fp)) continue;
    seen.add(fp);
    const def = ISSUES[f.issueType as IssueType];
    const page = pageBy.get(f.url);
    const { score, factors } = scoreFinding({
      issueType: f.issueType, affectedPages: typeCounts.get(f.issueType) ?? 1, impressions: hasGsc ? impressions.get(f.url) ?? 0 : null,
      depth: page?.depth ?? null, inlinks: page?.inlinks ?? null, isHomepage: f.url === home,
    });
    const common = {
      crawlId: crawl.id, issueType: f.issueType, category: def.category, severity: def.severity, url: f.url.slice(0, 2000), title: def.title,
      description: def.description, evidence: f.evidence as Prisma.InputJsonValue, recommendation: def.recommendation, implementation: def.implementation,
      automatable: def.automatable, requiresApproval: def.requiresApproval, priorityScore: score, priorityFactors: factors as unknown as Prisma.InputJsonValue, lastSeenAt: now,
    };
    const prev = byFp.get(fp);
    if (!prev) {
      const created = await prisma.auditFinding.create({ data: { ...common, organizationId: orgId, websiteId, fingerprint: fp, status: "OPEN", firstSeenAt: now } });
      events.push({ organizationId: orgId, findingId: created.id, fromStatus: null, toStatus: "OPEN", crawlId: crawl.id, note: "Detected" });
      newFindings++;
    } else {
      let status: FindingStatus = prev.status;
      if (prev.status === "RESOLVED") {
        status = "REGRESSED";
        regressed++;
        events.push({ organizationId: orgId, findingId: prev.id, fromStatus: "RESOLVED", toStatus: "REGRESSED", crawlId: crawl.id, note: "Detected again after being resolved" });
      }
      await prisma.auditFinding.update({ where: { id: prev.id }, data: { ...common, status, resolvedAt: status === "REGRESSED" ? null : undefined } });
    }
  }

  // Findings owned by other detectors (e.g. PageSpeed) are reconciled by those jobs, not the crawl.
  const toResolve = existing.filter((e) => !seen.has(e.fingerprint) && !EXTERNAL_ISSUE_TYPES.has(e.issueType) && ["OPEN", "IN_PROGRESS", "REGRESSED"].includes(e.status));
  if (toResolve.length) {
    await prisma.auditFinding.updateMany({ where: { id: { in: toResolve.map((e) => e.id) } }, data: { status: "RESOLVED", resolvedAt: now } });
    for (const e of toResolve) events.push({ organizationId: orgId, findingId: e.id, fromStatus: e.status, toStatus: "RESOLVED", crawlId: crawl.id, note: "No longer detected" });
    resolved = toResolve.length;
  }
  for (let i = 0; i < events.length; i += 1000) await prisma.findingEvent.createMany({ data: events.slice(i, i + 1000) });
  return { newFindings, regressed, resolved };
}

async function pruneOldCrawlDetails(websiteId: string) {
  const old = await prisma.crawl.findMany({ where: { websiteId, status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" }, skip: KEEP_CRAWL_DETAILS, select: { id: true } });
  if (!old.length) return;
  const ids = old.map((c) => c.id);
  await prisma.crawledLink.deleteMany({ where: { crawlId: { in: ids } } });
  await prisma.crawledPage.deleteMany({ where: { crawlId: { in: ids } } });
}

// ───────────── Finding workflow (manual status changes, tasks)

export async function setFindingStatus(ctx: OrgContext, findingId: string, status: FindingStatus, note?: string) {
  ctx.assert("findings:write");
  const f = await ctx.db.auditFinding.findUnique({ where: { id: findingId } });
  if (!f) throw new UserError("Finding not found");
  await assertWebsiteAccess(ctx, f.websiteId);
  if (f.status === status) return f;
  const updated = await ctx.db.auditFinding.update({ where: { id: findingId }, data: { status, resolvedAt: status === "RESOLVED" ? new Date() : null } });
  await ctx.db.findingEvent.create({ data: { organizationId: ctx.org.id, findingId, fromStatus: f.status, toStatus: status, note: note?.slice(0, 1000) || null, userId: ctx.userId } });
  await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: "finding.status", entityType: "AuditFinding", entityId: findingId, metadata: { from: f.status, to: status } });
  return updated;
}

export async function createTaskFromFinding(ctx: OrgContext, findingId: string, assigneeId?: string | null) {
  ctx.assert("tasks:write");
  const f = await ctx.db.auditFinding.findUnique({ where: { id: findingId } });
  if (!f) throw new UserError("Finding not found");
  const open = await ctx.db.task.findFirst({ where: { findingId, status: { in: ["TODO", "IN_PROGRESS"] } } });
  if (open) return open;
  const task = await ctx.db.task.create({
    data: { organizationId: ctx.org.id, websiteId: f.websiteId, findingId, title: `${f.title}: ${f.url}`.slice(0, 300), description: `${f.recommendation}\n\n${f.implementation}`, priority: Math.round(f.priorityScore), source: "audit", assigneeId: assigneeId ?? null },
  });
  if (f.status === "OPEN" || f.status === "REGRESSED") await setFindingStatus(ctx, findingId, "IN_PROGRESS", "Task created");
  return task;
}

import Papa from "papaparse";
import { z } from "zod";
import type { Prisma, SearchIntent } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { OrgContext } from "@/lib/auth/context";
import { assertWebsiteAccess } from "@/lib/auth/context";
import type { JobContext } from "@/lib/jobs/context";
import { enqueueJob } from "@/lib/jobs/queue";
import { UserError } from "@/lib/errors";
import { normalizeUrl, isSameSite } from "@/lib/url";
import { findConnection, withSyncLog } from "@/integrations/connections";
import { DataForSeoClient } from "@/integrations/dataforseo";
import { readSettings } from "./websites";
import { notify } from "./notifications";

// ───────────── Intent

const RULES: [SearchIntent, RegExp][] = [
  ["TRANSACTIONAL", /\b(buy|order|price|pricing|cost|cheap|deal|discount|coupon|for sale|hire|book|quote|subscribe|near me|shop)\b/i],
  ["COMMERCIAL", /\b(best|top \d*|vs\.?|versus|review|reviews|compare|comparison|alternative|alternatives|recommended)\b/i],
  ["INFORMATIONAL", /^(how|what|why|when|where|who|which|can|does|do|is|are|should|guide|tutorial|ideas|examples|tips)\b|\b(how to|what is|meaning|definition|guide|tutorial|examples)\b/i],
  ["NAVIGATIONAL", /\b(login|log in|sign in|account|official site|website|contact|support|careers)\b/i],
];

/** Rule-based fallback classifier. Labelled as "rules" so it isn't mistaken for provider data. */
export function classifyIntent(phrase: string, brandTerms: string[] = []): SearchIntent {
  if (brandTerms.some((b) => b && phrase.toLowerCase().includes(b.toLowerCase()))) return "NAVIGATIONAL";
  for (const [intent, re] of RULES) if (re.test(phrase)) return intent;
  return "UNKNOWN";
}

// ───────────── CRUD

export const keywordInputSchema = z.object({
  phrase: z.string().trim().toLowerCase().min(1).max(200),
  group: z.string().trim().max(80).optional().nullable(),
  tags: z.array(z.string().trim().max(40)).max(20).default([]),
  targetUrl: z.string().trim().url().optional().nullable().or(z.literal("").transform(() => null)),
  device: z.enum(["desktop", "mobile"]).default("desktop"),
  locationCode: z.coerce.number().int().optional(),
});

export async function addKeywords(ctx: OrgContext, websiteId: string, rows: z.input<typeof keywordInputSchema>[]) {
  ctx.assert("keywords:write");
  const site = await assertWebsiteAccess(ctx, websiteId);
  const settings = readSettings(site.settings);
  if (rows.length > 5000) throw new UserError("Add at most 5,000 keywords at a time");
  let added = 0, skipped = 0;
  for (const raw of rows) {
    const parsed = keywordInputSchema.safeParse(raw);
    if (!parsed.success) { skipped++; continue; }
    const k = parsed.data;
    try {
      await ctx.db.keyword.create({
        data: {
          organizationId: ctx.org.id, websiteId, phrase: k.phrase, group: k.group || null, tags: k.tags, targetUrl: k.targetUrl ?? null, device: k.device,
          locationCode: k.locationCode ?? settings.rankLocationCode, languageCode: settings.rankLanguageCode,
          intent: classifyIntent(k.phrase, site.brandTerms), intentSource: "rules",
        },
      });
      added++;
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") skipped++;
      else throw err;
    }
  }
  return { added, skipped };
}

/** Parses "phrase" per line or CSV with columns phrase,group,tags,target_url,device. */
export function parseKeywordInput(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const firstLine = trimmed.split(/\r?\n/)[0].toLowerCase();
  if (firstLine.includes("phrase") || firstLine.includes("keyword")) {
    const p = Papa.parse<Record<string, string>>(trimmed, { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim().toLowerCase() });
    return p.data.map((r) => ({
      phrase: r.phrase ?? r.keyword ?? "",
      group: r.group || null,
      tags: (r.tags ?? "").split(/[;|]/).map((t) => t.trim()).filter(Boolean),
      targetUrl: r.target_url || r.url || null,
      device: (r.device === "mobile" ? "mobile" : "desktop") as "mobile" | "desktop",
    }));
  }
  return trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((phrase) => ({ phrase, group: null as string | null, tags: [] as string[], targetUrl: null as string | null, device: "desktop" as "desktop" | "mobile" }));
}

export async function updateKeyword(ctx: OrgContext, id: string, data: { group?: string | null; tags?: string[]; targetUrl?: string | null }) {
  ctx.assert("keywords:write");
  const k = await ctx.db.keyword.findUnique({ where: { id } });
  if (!k) throw new UserError("Keyword not found");
  if (data.targetUrl) z.string().url().parse(data.targetUrl);
  return ctx.db.keyword.update({ where: { id }, data });
}

export async function deleteKeywords(ctx: OrgContext, ids: string[]) {
  ctx.assert("keywords:write");
  await ctx.db.rankObservation.deleteMany({ where: { keywordId: { in: ids } } });
  const r = await ctx.db.keyword.deleteMany({ where: { id: { in: ids } } });
  return r.count;
}

// ───────────── Rank tracking job

/** Finds the domain's best organic position in a SERP. */
export function findRanking(items: { type: string; rank_group?: number; url?: string; domain?: string }[], domain: string) {
  const organic = items.filter((i) => i.type === "organic" && i.url);
  const hit = organic.find((i) => isSameSite(i.url!, domain));
  const features = [...new Set(items.filter((i) => i.type !== "organic").map((i) => i.type))];
  return { position: hit?.rank_group ?? null, url: hit?.url ?? null, features };
}

export async function processRankCheck(jc: JobContext) {
  const websiteId = jc.job.websiteId!;
  const site = await prisma.website.findUniqueOrThrow({ where: { id: websiteId } });
  const conn = await findConnection(site.organizationId, "DATAFORSEO", null);
  if (!conn) throw new Error("Rank tracking needs a connected DataForSEO account (Integrations). No rankings were checked.");
  const settings = readSettings(site.settings);
  const keywords = await prisma.keyword.findMany({ where: { websiteId, ...(Array.isArray((jc.job.payload as { keywordIds?: string[] }).keywordIds) ? { id: { in: (jc.job.payload as { keywordIds: string[] }).keywordIds } } : {}) } });
  if (!keywords.length) return { checked: 0, message: "No keywords to check" };
  const dfs = new DataForSeoClient(conn);

  return withSyncLog(conn, "serp.rank_check", websiteId, async () => {
    const drops: { phrase: string; from: number | null; to: number | null }[] = [];
    let done = 0;
    await pool(keywords, 3, async (k) => {
      const items = await dfs.serp(k.phrase, { locationCode: k.locationCode, languageCode: k.languageCode, device: k.device, depth: 100 });
      const r = findRanking(items, site.domain);
      const prev = await prisma.rankObservation.findFirst({ where: { keywordId: k.id }, orderBy: { observedAt: "desc" } });
      await prisma.rankObservation.create({ data: { organizationId: site.organizationId, websiteId, keywordId: k.id, position: r.position, url: r.url, serpFeatures: r.features, source: "dataforseo", checkedDepth: 100 } });
      if (prev) {
        const before = prev.position ?? 101, now = r.position ?? 101;
        if (now - before >= settings.alertRankDrop) drops.push({ phrase: k.phrase, from: prev.position, to: r.position });
      }
      done++;
      await jc.progress(Math.round((done / keywords.length) * 95), `Checked ${done}/${keywords.length} keywords`);
    });
    if (drops.length) {
      await notify({ organizationId: site.organizationId, websiteId, type: "rank_drop", severity: "warning", title: `${site.domain}: ${drops.length} keyword${drops.length > 1 ? "s" : ""} dropped ≥ ${settings.alertRankDrop} positions`, body: drops.slice(0, 8).map((d) => `${d.phrase}: ${d.from ?? ">100"} → ${d.to ?? ">100"}`).join("\n"), link: `/keywords?websiteId=${websiteId}&sort=change` });
      const { emitEvent } = await import("./workflows");
      await emitEvent(site.organizationId, "ranking.dropped", websiteId, { count: drops.length });
    }
    return { items: keywords.length, cost: dfs.cost, message: `${keywords.length} keywords checked, ${drops.length} drops` };
  });
}

/** Refreshes search volume and intent from DataForSEO for all keywords of a site. */
export async function processKeywordMetrics(jc: JobContext) {
  const websiteId = jc.job.websiteId!;
  const site = await prisma.website.findUniqueOrThrow({ where: { id: websiteId } });
  const conn = await findConnection(site.organizationId, "DATAFORSEO", null);
  if (!conn) throw new Error("Keyword metrics need a connected DataForSEO account");
  const settings = readSettings(site.settings);
  const keywords = await prisma.keyword.findMany({ where: { websiteId } });
  const dfs = new DataForSeoClient(conn);
  return withSyncLog(conn, "keywords.metrics", websiteId, async () => {
    const phrases = [...new Set(keywords.map((k) => k.phrase))];
    for (let i = 0; i < phrases.length; i += 700) {
      const chunk = phrases.slice(i, i + 700);
      const [vol, intent] = await Promise.all([dfs.searchVolume(chunk, settings.rankLocationCode, settings.rankLanguageCode), dfs.searchIntent(chunk, settings.rankLanguageCode)]);
      const volBy = new Map(vol.map((v) => [v.keyword.toLowerCase(), v]));
      const intentBy = new Map(intent.map((v) => [v.keyword.toLowerCase(), v.keyword_intent?.label?.toUpperCase()]));
      for (const k of keywords.filter((x) => chunk.includes(x.phrase))) {
        const v = volBy.get(k.phrase);
        const it = intentBy.get(k.phrase);
        await prisma.keyword.update({
          where: { id: k.id },
          data: {
            ...(v ? { searchVolume: v.search_volume, volumeSource: "Google Ads via DataForSEO (estimate)", volumeUpdatedAt: new Date() } : {}),
            ...(it && ["INFORMATIONAL", "NAVIGATIONAL", "COMMERCIAL", "TRANSACTIONAL"].includes(it) ? { intent: it as SearchIntent, intentSource: "dataforseo" } : {}),
          },
        });
      }
      await jc.progress(Math.round(((i + chunk.length) / phrases.length) * 95));
    }
    return { items: phrases.length, cost: dfs.cost };
  });
}

// ───────────── Queries & insights

export const keywordFilterSchema = z.object({
  websiteId: z.string(),
  q: z.string().trim().max(100).optional(),
  group: z.string().optional(),
  intent: z.enum(["INFORMATIONAL", "NAVIGATIONAL", "COMMERCIAL", "TRANSACTIONAL", "UNKNOWN"]).optional(),
  tag: z.string().optional(),
  sort: z.enum(["phrase", "position", "change", "volume"]).default("position"),
  page: z.coerce.number().int().min(1).default(1),
});

export async function listKeywords(ctx: OrgContext, raw: unknown) {
  const f = keywordFilterSchema.parse(raw);
  await assertWebsiteAccess(ctx, f.websiteId);
  const where: Prisma.KeywordWhereInput = {
    websiteId: f.websiteId,
    ...(f.q ? { phrase: { contains: f.q.toLowerCase() } } : {}),
    ...(f.group ? { group: f.group } : {}),
    ...(f.intent ? { intent: f.intent } : {}),
    ...(f.tag ? { tags: { has: f.tag } } : {}),
  };
  const all = await ctx.db.keyword.findMany({ where, include: { observations: { orderBy: { observedAt: "desc" }, take: 2 } } });
  const rows = all.map((k) => {
    const [cur, prev] = k.observations;
    const change = cur && prev ? (prev.position ?? 101) - (cur.position ?? 101) : null;
    const mismatch = Boolean(k.targetUrl && cur?.url && normalizeUrl(k.targetUrl) !== normalizeUrl(cur.url));
    return { ...k, current: cur ?? null, previous: prev ?? null, change, mismatch };
  });
  const sorters: Record<string, (a: (typeof rows)[number], b: (typeof rows)[number]) => number> = {
    phrase: (a, b) => a.phrase.localeCompare(b.phrase),
    position: (a, b) => (a.current?.position ?? 999) - (b.current?.position ?? 999),
    change: (a, b) => (a.change ?? 0) - (b.change ?? 0),
    volume: (a, b) => (b.searchVolume ?? -1) - (a.searchVolume ?? -1),
  };
  rows.sort(sorters[f.sort]);
  const pageSize = 100;
  const groups = [...new Set((await ctx.db.keyword.findMany({ where: { websiteId: f.websiteId }, select: { group: true }, distinct: ["group"] })).map((g) => g.group).filter(Boolean) as string[])];
  return { filter: f, total: rows.length, rows: rows.slice((f.page - 1) * pageSize, f.page * pageSize), pages: Math.max(1, Math.ceil(rows.length / pageSize)), pageSize, groups };
}

/** First-party Search Console insights: striking distance, declines, cannibalization. */
export async function searchConsoleInsights(ctx: OrgContext, websiteId: string) {
  await assertWebsiteAccess(ctx, websiteId);
  const DAY = 86400_000;
  const latest = await ctx.db.searchConsoleQuery.aggregate({ where: { websiteId }, _max: { date: true } });
  if (!latest._max.date) return null;
  const end = latest._max.date;
  const start = new Date(end.getTime() - 27 * DAY);
  const prevStart = new Date(start.getTime() - 28 * DAY);
  const [cur, prevRows] = await Promise.all([
    ctx.db.searchConsoleQuery.groupBy({ by: ["query", "page"], where: { websiteId, date: { gte: start, lte: end } }, _sum: { clicks: true, impressions: true }, _avg: { position: true } }),
    ctx.db.searchConsoleQuery.groupBy({ by: ["query"], where: { websiteId, date: { gte: prevStart, lt: start } }, _sum: { clicks: true, impressions: true } }),
  ]);
  // Aggregate per query
  const byQuery = new Map<string, { query: string; clicks: number; impressions: number; posWeighted: number; pages: { page: string; impressions: number; clicks: number; position: number }[] }>();
  for (const r of cur) {
    const e = byQuery.get(r.query) ?? { query: r.query, clicks: 0, impressions: 0, posWeighted: 0, pages: [] };
    const imp = r._sum.impressions ?? 0;
    e.clicks += r._sum.clicks ?? 0;
    e.impressions += imp;
    e.posWeighted += (r._avg.position ?? 0) * imp;
    e.pages.push({ page: r.page, impressions: imp, clicks: r._sum.clicks ?? 0, position: r._avg.position ?? 0 });
    byQuery.set(r.query, e);
  }
  const queries = [...byQuery.values()].map((q) => ({ ...q, position: q.impressions ? q.posWeighted / q.impressions : null, ctr: q.impressions ? q.clicks / q.impressions : 0 }));
  const prevBy = new Map(prevRows.map((p) => [p.query, p._sum.clicks ?? 0]));

  const strikingDistance = queries.filter((q) => q.position != null && q.position >= 4 && q.position <= 20 && q.impressions >= 20).sort((a, b) => b.impressions - a.impressions).slice(0, 50);
  const declining = queries.map((q) => ({ ...q, prevClicks: prevBy.get(q.query) ?? 0 })).filter((q) => q.prevClicks >= 5 && q.clicks < q.prevClicks * 0.7).sort((a, b) => b.prevClicks - b.clicks - (a.prevClicks - a.clicks)).slice(0, 50);
  const cannibalization = queries
    .filter((q) => q.impressions >= 30)
    .map((q) => ({ ...q, competing: q.pages.filter((p) => p.impressions / q.impressions >= 0.15).sort((a, b) => b.impressions - a.impressions) }))
    .filter((q) => q.competing.length >= 2)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 50);
  const top = [...queries].sort((a, b) => b.clicks - a.clicks).slice(0, 100);
  return { period: { start, end }, strikingDistance, declining, cannibalization, top, totalQueries: queries.length };
}

export async function trackGscQueries(ctx: OrgContext, websiteId: string, phrases: string[]) {
  return addKeywords(ctx, websiteId, phrases.map((p) => ({ phrase: p, tags: ["from-gsc"] })));
}

export async function queueRankCheck(ctx: OrgContext, websiteId: string) {
  ctx.assert("keywords:write");
  await assertWebsiteAccess(ctx, websiteId);
  const { job, deduped } = await enqueueJob({ organizationId: ctx.org.id, websiteId, type: "rank-check", createdById: ctx.userId, dedupe: true });
  return { job, deduped };
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<unknown>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

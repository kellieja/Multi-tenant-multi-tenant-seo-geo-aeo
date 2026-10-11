import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { OrgContext } from "@/lib/auth/context";
import { assertWebsiteAccess } from "@/lib/auth/context";
import type { JobContext } from "@/lib/jobs/context";
import { UserError } from "@/lib/errors";
import { normalizeSiteUrl } from "@/lib/url";
import { findConnection, withSyncLog } from "@/integrations/connections";
import { DataForSeoClient } from "@/integrations/dataforseo";
import { readSettings } from "./websites";

export async function addCompetitor(ctx: OrgContext, websiteId: string, input: { domain: string; name?: string; brandTerms?: string }) {
  ctx.assert("keywords:write");
  const site = await assertWebsiteAccess(ctx, websiteId);
  const { domain } = normalizeSiteUrl(input.domain);
  if (domain === site.domain) throw new UserError("That's this website's own domain");
  const brandTerms = (input.brandTerms ?? "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 10);
  try {
    return await ctx.db.competitor.create({ data: { organizationId: ctx.org.id, websiteId, domain, name: z.string().trim().max(120).optional().parse(input.name) || domain, brandTerms: brandTerms.length ? brandTerms : [input.name || domain.split(".")[0]] } });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new UserError(`${domain} is already a competitor`);
    throw err;
  }
}

export async function removeCompetitor(ctx: OrgContext, id: string) {
  ctx.assert("keywords:write");
  await ctx.db.competitor.delete({ where: { id } });
}

/** Live suggestion of organic competitors from DataForSEO (costs a request; not stored). */
export async function suggestCompetitors(ctx: OrgContext, websiteId: string) {
  const site = await assertWebsiteAccess(ctx, websiteId);
  const conn = await findConnection(ctx.org.id, "DATAFORSEO", null);
  if (!conn) throw new UserError("Competitor suggestions need DataForSEO. You can add competitors manually.");
  const s = readSettings(site.settings);
  const dfs = new DataForSeoClient(conn);
  const items = await withSyncLog(conn, "labs.competitors_domain", websiteId, async () => {
    const r = await dfs.competitorDomains(site.domain, s.rankLocationCode, s.rankLanguageCode, 20);
    return Object.assign(r, { items: r.length, cost: dfs.cost });
  });
  const existing = new Set((await ctx.db.competitor.findMany({ where: { websiteId } })).map((c) => c.domain));
  return [...items].filter((i) => i.domain !== site.domain && !existing.has(i.domain)).map((i) => ({ domain: i.domain, sharedKeywords: i.intersections ?? null, avgPosition: i.avg_position ?? null }));
}

export interface GapAnalysis {
  computedAt: string;
  cost: number;
  source: string;
  competitorKeywords: number;
  ourKeywords: number;
  /** Keywords the competitor ranks for (top 20) where we don't rank in the top 100. */
  missing: { keyword: string; volume: number | null; theirPosition: number | null; theirUrl: string | null }[];
  /** Both rank, competitor ahead. */
  behind: { keyword: string; volume: number | null; theirPosition: number | null; ourPosition: number | null; ourUrl: string | null }[];
}

/** Worker: keyword gap between this site and one competitor (DataForSEO ranked keywords). */
export async function processCompetitorGap(jc: JobContext) {
  const { competitorId } = jc.job.payload as { competitorId: string };
  const comp = await prisma.competitor.findUniqueOrThrow({ where: { id: competitorId } });
  const site = await prisma.website.findUniqueOrThrow({ where: { id: comp.websiteId } });
  const conn = await findConnection(site.organizationId, "DATAFORSEO", null);
  if (!conn) throw new Error("Keyword gap analysis needs DataForSEO");
  const s = readSettings(site.settings);
  const dfs = new DataForSeoClient(conn);
  return withSyncLog(conn, "labs.keyword_gap", site.id, async () => {
    await jc.progress(10, `Fetching keywords for ${comp.domain}`);
    const theirs = await dfs.rankedKeywords(comp.domain, s.rankLocationCode, s.rankLanguageCode, 1000);
    await jc.progress(55, `Fetching keywords for ${site.domain}`);
    const ours = await dfs.rankedKeywords(site.domain, s.rankLocationCode, s.rankLanguageCode, 1000);
    const ourBy = new Map(ours.map((o) => [o.keyword.toLowerCase(), o]));
    const missing: GapAnalysis["missing"] = [];
    const behind: GapAnalysis["behind"] = [];
    for (const t of theirs) {
      if (t.position == null || t.position > 20) continue;
      const o = ourBy.get(t.keyword.toLowerCase());
      if (!o) missing.push({ keyword: t.keyword, volume: t.volume, theirPosition: t.position, theirUrl: t.url });
      else if (o.position != null && o.position > t.position) behind.push({ keyword: t.keyword, volume: t.volume, theirPosition: t.position, ourPosition: o.position, ourUrl: o.url });
    }
    const byVol = (a: { volume: number | null }, b: { volume: number | null }) => (b.volume ?? 0) - (a.volume ?? 0);
    const analysis: GapAnalysis = { computedAt: new Date().toISOString(), cost: dfs.cost, source: "DataForSEO Labs ranked keywords (estimates)", competitorKeywords: theirs.length, ourKeywords: ours.length, missing: missing.sort(byVol).slice(0, 300), behind: behind.sort(byVol).slice(0, 300) };
    await prisma.competitor.update({ where: { id: comp.id }, data: { analysis: analysis as unknown as Prisma.InputJsonValue, analyzedAt: new Date() } });
    return { items: theirs.length + ours.length, cost: dfs.cost, message: `${missing.length} missing, ${behind.length} behind` };
  });
}

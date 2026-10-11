import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { OrgContext } from "@/lib/auth/context";
import { assertWebsiteAccess } from "@/lib/auth/context";
import type { JobContext } from "@/lib/jobs/context";
import { enqueueJob } from "@/lib/jobs/queue";
import { UserError } from "@/lib/errors";
import { randomToken } from "@/lib/crypto";
import { nextCronRun } from "@/lib/cron";
import { hostOf, isSameSite } from "@/lib/url";
import { AI_PROVIDERS, getAiClientFor, type AiProviderId, type AiResponse } from "@/integrations/ai";

export const PLATFORM_LABEL: Record<AiProviderId, string> = {
  ANTHROPIC: "Claude (API + web search)",
  OPENAI: "OpenAI (API + web search)",
  GEMINI: "Gemini (API + Google Search grounding)",
  PERPLEXITY: "Perplexity Sonar (API)",
};

export const promptSetSchema = z.object({
  name: z.string().trim().min(1).max(120),
  market: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Use a 2-letter country code, e.g. US").default("US"),
  language: z.string().trim().max(10).default("en"),
  platforms: z.array(z.enum(AI_PROVIDERS as [AiProviderId, ...AiProviderId[]])).min(1, "Choose at least one platform"),
  competitorTerms: z.array(z.string().trim().max(80)).max(20).default([]),
  prompts: z.array(z.string().trim().min(5, "Prompts must be at least 5 characters").max(500)).min(1, "Add at least one prompt").max(100),
  schedule: z.string().trim().max(100).optional().nullable().transform((v) => v || null),
});

export async function savePromptSet(ctx: OrgContext, websiteId: string, input: z.input<typeof promptSetSchema>, id?: string) {
  ctx.assert("geo:write");
  await assertWebsiteAccess(ctx, websiteId);
  const d = promptSetSchema.parse(input);
  if (d.schedule) { try { nextCronRun(d.schedule, new Date()); } catch { throw new UserError("Schedule must be a valid cron expression"); } }
  const data = { name: d.name, market: d.market, language: d.language, platforms: d.platforms, competitorTerms: d.competitorTerms, schedule: d.schedule };
  const set = id
    ? await ctx.db.geoPromptSet.update({ where: { id }, data })
    : await ctx.db.geoPromptSet.create({ data: { ...data, organizationId: ctx.org.id, websiteId } });
  // Keep prompts that still exist (preserves their observation history); add new ones.
  const existing = await ctx.db.geoPrompt.findMany({ where: { promptSetId: set.id } });
  const wanted = new Set(d.prompts);
  await ctx.db.geoPrompt.deleteMany({ where: { promptSetId: set.id, text: { notIn: d.prompts } } });
  for (const text of wanted) if (!existing.some((e) => e.text === text)) await ctx.db.geoPrompt.create({ data: { organizationId: ctx.org.id, promptSetId: set.id, text } });
  return set;
}

export async function runPromptSetNow(ctx: OrgContext, promptSetId: string) {
  ctx.assert("geo:write");
  const set = await ctx.db.geoPromptSet.findUnique({ where: { id: promptSetId }, include: { prompts: true } });
  if (!set) throw new UserError("Prompt set not found");
  for (const p of set.platforms) if (!(await getAiClientFor(ctx.org.id, p as AiProviderId))) throw new UserError(`${PLATFORM_LABEL[p as AiProviderId]} is not connected. Add its API key in Integrations or remove it from the set.`);
  const { job } = await enqueueJob({ organizationId: ctx.org.id, websiteId: set.websiteId, type: "geo-run", payload: { promptSetId }, createdById: ctx.userId });
  return { job, calls: set.prompts.length * set.platforms.length };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text: string, terms: string[]) => terms.filter(Boolean).some((t) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}($|[^\\p{L}\\p{N}])`, "iu").test(text));

const POS = /\b(best|excellent|great|leading|trusted|reliable|recommended|top|popular|well[- ]regarded|high[- ]quality|praised|favorite|strong)\b/i;
const NEG = /\b(avoid|poor|bad|worst|complaints?|unreliable|expensive|overpriced|scam|lawsuit|issues?|problems?|criticized|negative|slow)\b/i;

/** Lexicon sentiment over sentences that mention the brand. Labelled as such; null when not mentioned. */
export function brandSentiment(text: string, terms: string[]): "positive" | "neutral" | "negative" | null {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => mentions(s, terms));
  if (!sentences.length) return null;
  let score = 0;
  for (const s of sentences) score += (POS.test(s) ? 1 : 0) - (NEG.test(s) ? 1 : 0);
  return score > 0 ? "positive" : score < 0 ? "negative" : "neutral";
}

/** Pure analysis of one answer: brand/competitor mentions and citations. */
export function analyzeAnswer(res: Pick<AiResponse, "text" | "citations">, site: { domain: string; brandTerms: string[] }, competitors: { name: string; domain?: string; terms: string[] }[]) {
  const brandMentioned = mentions(res.text, site.brandTerms.length ? site.brandTerms : [site.domain]);
  const citedOwnUrls = res.citations.filter((c) => isSameSite(c.url, site.domain)).map((c) => c.url);
  const competitorMentions: Record<string, { mentioned: boolean; cited: boolean }> = {};
  for (const c of competitors) {
    competitorMentions[c.name] = {
      mentioned: mentions(res.text, c.terms.length ? c.terms : [c.name]),
      cited: c.domain ? res.citations.some((x) => isSameSite(x.url, c.domain!)) : false,
    };
  }
  return { brandMentioned, brandCited: citedOwnUrls.length > 0, citedOwnUrls, competitorMentions, sentiment: brandSentiment(res.text, site.brandTerms) };
}

// A neutral system prompt: we never steer the model toward (or away from) the brand.
const NEUTRAL_SYSTEM = "Answer the user's question helpfully and accurately, as you would for any user. Use web search when it helps and cite your sources.";

/** Worker: runs every prompt of a set on every chosen platform and stores evidence-rich observations. */
export async function processGeoRun(jc: JobContext) {
  const { promptSetId } = jc.job.payload as { promptSetId: string };
  const set = await prisma.geoPromptSet.findUniqueOrThrow({ where: { id: promptSetId }, include: { prompts: true } });
  const site = await prisma.website.findUniqueOrThrow({ where: { id: set.websiteId } });
  const comps = await prisma.competitor.findMany({ where: { websiteId: site.id } });
  const competitors = [
    ...comps.map((c) => ({ name: c.name ?? c.domain, domain: c.domain, terms: c.brandTerms })),
    ...set.competitorTerms.filter((t) => !comps.some((c) => c.brandTerms.includes(t) || c.name === t)).map((t) => ({ name: t, terms: [t] })),
  ];
  const runId = randomToken(8);
  const total = set.prompts.length * set.platforms.length;
  let done = 0, failed = 0;
  const errors: string[] = [];
  for (const platform of set.platforms as AiProviderId[]) {
    const ai = await getAiClientFor(site.organizationId, platform);
    if (!ai) { errors.push(`${platform}: not connected`); failed += set.prompts.length; continue; }
    for (const prompt of set.prompts) {
      try {
        const res = await ai.complete({ system: NEUTRAL_SYSTEM, prompt: prompt.text, webSearch: true, country: set.market, maxTokens: 4000 });
        const a = analyzeAnswer(res, site, competitors);
        await prisma.geoObservation.create({
          data: {
            organizationId: site.organizationId, websiteId: site.id, promptId: prompt.id, runId, platform, model: res.model, query: prompt.text,
            responseText: res.refusal ? `[Declined] ${res.refusal}` : res.text.slice(0, 30000),
            citations: res.citations.map((c) => ({ ...c, domain: hostOf(c.url) })) as unknown as Prisma.InputJsonValue,
            brandMentioned: a.brandMentioned, brandCited: a.brandCited, citedOwnUrls: a.citedOwnUrls,
            competitorMentions: a.competitorMentions as Prisma.InputJsonValue, sentiment: a.sentiment, sentimentMethod: a.sentiment ? "lexicon over sentences mentioning the brand" : null,
            methodology: `One ${PLATFORM_LABEL[platform]} API call (model ${res.model}) with web search ${res.webSearchUsed ? "enabled" : "unavailable"}, market ${set.market}, neutral system prompt, ${new Date().toISOString()}. API answers can differ from the consumer apps and vary by time, location and session; this is a single sample.`,
            market: set.market,
          },
        });
      } catch (err) {
        failed++;
        errors.push(`${platform}: ${(err as Error).message.slice(0, 200)}`);
      }
      done++;
      await jc.progress(Math.round((done / total) * 100), `${done}/${total} prompt checks`);
    }
  }
  if (failed === total) throw new Error(`All GEO checks failed: ${[...new Set(errors)].slice(0, 3).join("; ")}`);
  return { runId, checks: total - failed, failed, errors: [...new Set(errors)].slice(0, 5) };
}

/** Scheduler: prompt sets with a cron schedule. */
export async function scheduleGeoRuns(now: Date) {
  const sets = await prisma.geoPromptSet.findMany({ where: { enabled: true, schedule: { not: null } } });
  let n = 0;
  for (const s of sets) {
    const last = await prisma.job.findFirst({ where: { type: "geo-run", websiteId: s.websiteId, payload: { path: ["promptSetId"], equals: s.id } }, orderBy: { queuedAt: "desc" } });
    let due: Date;
    try { due = nextCronRun(s.schedule!, last?.queuedAt ?? s.createdAt); } catch { continue; }
    if (due <= now) { await enqueueJob({ organizationId: s.organizationId, websiteId: s.websiteId, type: "geo-run", payload: { promptSetId: s.id } }); n++; }
  }
  return n;
}

/** Aggregates observations into visibility metrics. Every number is labelled as a sample. */
export async function geoSummary(ctx: OrgContext, websiteId: string, days = 90) {
  const site = await assertWebsiteAccess(ctx, websiteId);
  const since = new Date(Date.now() - days * 86400_000);
  const obs = await ctx.db.geoObservation.findMany({ where: { websiteId, observedAt: { gte: since } }, orderBy: { observedAt: "asc" } });
  const valid = obs.filter((o) => !o.responseText.startsWith("[Declined]"));
  const rate = (f: (o: (typeof valid)[number]) => boolean) => (valid.length ? valid.filter(f).length / valid.length : null);
  // Weekly trend
  const weeks = new Map<string, { n: number; mentioned: number; cited: number }>();
  for (const o of valid) {
    const d = new Date(o.observedAt);
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    const k = d.toISOString().slice(0, 10);
    const e = weeks.get(k) ?? { n: 0, mentioned: 0, cited: 0 };
    e.n++; if (o.brandMentioned) e.mentioned++; if (o.brandCited) e.cited++;
    weeks.set(k, e);
  }
  const trend = [...weeks].map(([date, e]) => ({ date, mentionRate: e.mentioned / e.n, citationRate: e.cited / e.n, samples: e.n }));
  // Share of voice
  const sov = new Map<string, number>([[site.name, valid.filter((o) => o.brandMentioned).length]]);
  for (const o of valid) for (const [name, v] of Object.entries(o.competitorMentions as Record<string, { mentioned: boolean }>)) if (v.mentioned) sov.set(name, (sov.get(name) ?? 0) + 1);
  // Citations
  const domainCounts = new Map<string, number>();
  const ownPages = new Map<string, number>();
  for (const o of valid) {
    for (const c of o.citations as { url: string; domain: string }[]) domainCounts.set(c.domain, (domainCounts.get(c.domain) ?? 0) + 1);
    for (const u of o.citedOwnUrls) ownPages.set(u, (ownPages.get(u) ?? 0) + 1);
  }
  // Per platform
  const platforms = [...new Set(valid.map((o) => o.platform))].map((p) => {
    const sub = valid.filter((o) => o.platform === p);
    return { platform: p, label: PLATFORM_LABEL[p as AiProviderId] ?? p, samples: sub.length, mentionRate: sub.filter((o) => o.brandMentioned).length / sub.length, citationRate: sub.filter((o) => o.brandCited).length / sub.length };
  });
  // Unanswered prompts = brand never mentioned in recent samples → content opportunities
  const byPrompt = new Map<string, { query: string; n: number; mentioned: number; competitors: Set<string> }>();
  for (const o of valid) {
    const e = byPrompt.get(o.promptId) ?? { query: o.query, n: 0, mentioned: 0, competitors: new Set<string>() };
    e.n++; if (o.brandMentioned) e.mentioned++;
    for (const [name, v] of Object.entries(o.competitorMentions as Record<string, { mentioned: boolean }>)) if (v.mentioned) e.competitors.add(name);
    byPrompt.set(o.promptId, e);
  }
  const gaps = [...byPrompt.values()].filter((p) => p.mentioned === 0).map((p) => ({ query: p.query, samples: p.n, competitorsMentioned: [...p.competitors] }));
  const sentiment = { positive: valid.filter((o) => o.sentiment === "positive").length, neutral: valid.filter((o) => o.sentiment === "neutral").length, negative: valid.filter((o) => o.sentiment === "negative").length };
  return {
    samples: valid.length, declined: obs.length - valid.length, mentionRate: rate((o) => o.brandMentioned), citationRate: rate((o) => o.brandCited),
    trend, platforms, sentiment,
    shareOfVoice: [...sov].map(([name, count]) => ({ name, count, own: name === site.name })).sort((a, b) => b.count - a.count),
    topCitedDomains: [...domainCounts].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([label, value]) => ({ label, value })),
    ownCitedPages: [...ownPages].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([label, value]) => ({ label, value })),
    gaps, lastObserved: obs.at(-1)?.observedAt ?? null,
  };
}

/** Entity consistency: compares the homepage Organization markup and site brand terms. */
export async function entityAudit(ctx: OrgContext, websiteId: string) {
  const site = await assertWebsiteAccess(ctx, websiteId);
  const crawl = await ctx.db.crawl.findFirst({ where: { websiteId, status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" } });
  if (!crawl) return null;
  const pages = await ctx.db.crawledPage.findMany({ where: { crawlId: crawl.id }, select: { url: true, structuredData: true } });
  const orgs: { url: string; name?: string; sameAs: string[]; logo: boolean; contact: boolean }[] = [];
  for (const p of pages) {
    for (const sd of p.structuredData as { data?: unknown }[]) {
      const walk = (n: unknown) => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (n && typeof n === "object") {
          const o = n as Record<string, unknown>;
          const t = ([] as unknown[]).concat(o["@type"] ?? []).map(String);
          if (t.some((x) => ["Organization", "LocalBusiness", "Corporation"].includes(x) || x.endsWith("Business"))) {
            orgs.push({ url: p.url, name: typeof o.name === "string" ? o.name : undefined, sameAs: ([] as unknown[]).concat(o.sameAs ?? []).map(String), logo: Boolean(o.logo), contact: Boolean(o.contactPoint || o.telephone || o.email) });
          }
          if (Array.isArray(o["@graph"])) walk(o["@graph"]);
        }
      };
      walk(sd.data);
    }
  }
  const names = [...new Set(orgs.map((o) => o.name).filter(Boolean) as string[])];
  const checks = [
    { label: "Organization markup present", pass: orgs.length > 0, detail: orgs.length ? `On ${new Set(orgs.map((o) => o.url)).size} page(s)` : "No Organization/LocalBusiness JSON-LD found in the latest crawl." },
    { label: "One consistent entity name", pass: names.length === 1, detail: names.length ? `Names used: ${names.join(" | ")}` : "No name found" },
    { label: "Name matches brand terms", pass: names.length > 0 && names.every((n) => site.brandTerms.some((b) => n.toLowerCase().includes(b.toLowerCase()))), detail: `Brand terms: ${site.brandTerms.join(", ") || "(set them on the website)"}` },
    { label: "sameAs links to official profiles", pass: orgs.some((o) => o.sameAs.length > 0), detail: [...new Set(orgs.flatMap((o) => o.sameAs))].slice(0, 6).join(", ") || "None. Link official social/Wikidata/Crunchbase profiles you control." },
    { label: "Logo and contact information", pass: orgs.some((o) => o.logo) && orgs.some((o) => o.contact), detail: `${orgs.some((o) => o.logo) ? "logo ✓" : "no logo"} · ${orgs.some((o) => o.contact) ? "contact ✓" : "no contact point"}` },
  ];
  return { crawlId: crawl.id, checks };
}

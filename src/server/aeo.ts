import * as cheerio from "cheerio";
import type { Prisma, SearchIntent } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { OrgContext } from "@/lib/auth/context";
import { assertWebsiteAccess } from "@/lib/auth/context";
import type { JobContext } from "@/lib/jobs/context";
import { UserError } from "@/lib/errors";
import { safeFetch } from "@/lib/net/safe-fetch";
import { isSameSite, normalizeUrl } from "@/lib/url";
import { sha256 } from "@/lib/crypto";
import { validateStructuredData } from "@/audit/schema";
import { findConnection, withSyncLog } from "@/integrations/connections";
import { DataForSeoClient } from "@/integrations/dataforseo";
import { getAiClient, NoAiProviderError } from "@/integrations/ai";
import { classifyIntent } from "./keywords";
import { readSettings } from "./websites";
import { openSitePageFetcher } from "./page-fetch";
import { parseJsonLoose, FACT_GUARDRAIL } from "./ai-json";

export interface AeoCheck { key: string; label: string; pass: boolean; weight: number; detail: string; applicable: boolean }

const QUESTION_RE = /^(how|what|why|when|where|who|which|can|does|do|is|are|should|will|could|would)\b|\?\s*$/i;
const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

function jsonLd($: cheerio.CheerioAPI) {
  const out: unknown[] = [];
  $('script[type="application/ld+json" i]').each((_, el) => { try { out.push(JSON.parse($(el).contents().text())); } catch { /* invalid JSON is an audit finding */ } });
  return out;
}

function typesOf(data: unknown[]): string[] {
  const t: string[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === "object") {
      const o = n as Record<string, unknown>;
      const ty = o["@type"];
      if (typeof ty === "string") t.push(ty); else if (Array.isArray(ty)) t.push(...(ty as string[]));
      if (Array.isArray(o["@graph"])) walk(o["@graph"]);
    }
  };
  data.forEach(walk);
  return t;
}

/**
 * Answer-engine readiness assessment for one page's HTML. Each check is transparent,
 * weighted and explained; checks that don't apply to the page type are excluded.
 * The resulting score is internal, not a Google or AI-platform metric.
 */
export function assessHtml(html: string, url: string, ctx: { domain: string; brandTerms: string[]; isHomepage: boolean }) {
  const $ = cheerio.load(html);
  const ld = jsonLd($);
  const types = typesOf(ld);
  const main = $("main, article, [role=main]").first();
  const scope = main.length ? main : $("body");
  const headings = scope.find("h2, h3").map((_, el) => $(el).text().replace(/\s+/g, " ").trim()).get();
  const questionHeadings = headings.filter((h) => QUESTION_RE.test(h));
  const bodyText = scope.text().replace(/\s+/g, " ").trim();
  const wc = words(bodyText);
  const isArticleLike = !ctx.isHomepage && wc >= 150;

  // Concise answer passage: first paragraph after a question heading (or after the H1) of 25–75 words.
  let answerPassage: string | null = null;
  scope.find("h1, h2, h3").each((_, h) => {
    if (answerPassage) return;
    const ht = $(h).text().trim();
    if (h.tagName !== "h1" && !QUESTION_RE.test(ht)) return;
    const p = $(h).nextAll("p").first().text().replace(/\s+/g, " ").trim();
    if (p && words(p) >= 25 && words(p) <= 75) answerPassage = p;
  });
  const definition = scope.find("p").map((_, p) => $(p).text().trim()).get().slice(0, 6).find((p) => /\b(is|are|refers to|means)\b (a|an|the)\b/i.test(p) && words(p) <= 80) ?? null;
  const lists = scope.find("ol, ul").filter((_, el) => $(el).find("li").length >= 3 && !$(el).closest("nav, header, footer").length).length;
  const tables = scope.find("table").length;
  const internal = new Set<string>(), external = new Set<string>();
  scope.find("a[href]").each((_, a) => {
    if ($(a).closest("nav, header, footer").length) return;
    const href = normalizeUrl($(a).attr("href")!, url);
    if (!href) return;
    (isSameSite(href, ctx.domain) ? internal : external).add(href);
  });
  const byline = $('[rel="author"], .author, .byline, [itemprop="author"], meta[name="author" i]').length > 0 || ld.some((d) => JSON.stringify(d).includes('"author"'));
  const dated = $("time[datetime], meta[property='article:modified_time'], meta[property='article:published_time']").length > 0 || /dateModified|datePublished/.test(JSON.stringify(ld));
  const h1s = $("h1").length;
  const schemaErrors = ld.flatMap((d) => validateStructuredData(d)).filter((e) => e.severity === "error");
  const orgNode = JSON.stringify(ld).match(/"@type"\s*:\s*"(Organization|LocalBusiness|Corporation)"[^}]*?"name"\s*:\s*"([^"]+)"/);
  const orgName = orgNode?.[2] ?? null;
  const sameAs = /"sameAs"/.test(JSON.stringify(ld));
  const hasFaqContent = questionHeadings.length >= 2;

  const checks: AeoCheck[] = [
    { key: "question_headings", label: "Question-based headings", weight: 2, applicable: isArticleLike, pass: questionHeadings.length >= 1, detail: questionHeadings.length ? `${questionHeadings.length} question heading(s), e.g. “${questionHeadings[0]}”` : "No H2/H3 phrased as a question. Answer engines match questions to headings." },
    { key: "answer_passage", label: "Concise answer passage (25–75 words)", weight: 3, applicable: isArticleLike, pass: Boolean(answerPassage), detail: answerPassage ? `“${(answerPassage as string).slice(0, 140)}…”` : "No short, self-contained answer directly under the H1 or a question heading." },
    { key: "definition", label: "Clear definition/explanation sentence", weight: 1, applicable: isArticleLike, pass: Boolean(definition), detail: definition ? `“${definition.slice(0, 140)}”` : "No “X is a…” style definition near the top of the content." },
    { key: "structured_lists", label: "Lists or tables for steps/comparisons", weight: 1, applicable: isArticleLike, pass: lists + tables > 0, detail: `${lists} content list(s), ${tables} table(s)` },
    { key: "completeness", label: "Substantive content (≥ 300 words)", weight: 1, applicable: isArticleLike, pass: wc >= 300, detail: `${wc} words in main content. Length alone isn't quality, but very short pages rarely answer fully.` },
    { key: "author", label: "Author / byline information", weight: 2, applicable: isArticleLike, pass: byline, detail: byline ? "Author signal found (byline, rel=author or schema author)." : "No author signal. Add a byline linking to an author bio with real credentials." },
    { key: "freshness", label: "Published/updated date", weight: 1, applicable: isArticleLike, pass: dated, detail: dated ? "Date found in markup." : "No machine-readable date (time element, article meta or schema)." },
    { key: "sources", label: "Cites external sources", weight: 1, applicable: isArticleLike, pass: external.size >= 1, detail: `${external.size} external link(s) in main content` },
    { key: "internal_support", label: "Links to supporting internal content", weight: 1, applicable: !ctx.isHomepage, pass: internal.size >= 3, detail: `${internal.size} contextual internal link(s)` },
    { key: "semantic_html", label: "Semantic structure (main/article, one H1)", weight: 1, applicable: true, pass: Boolean(main.length) && h1s === 1, detail: `${main.length ? "<main>/<article> present" : "no <main>/<article>"}; ${h1s} H1` },
    { key: "schema_valid", label: "Structured data valid", weight: 2, applicable: ld.length > 0, pass: schemaErrors.length === 0, detail: schemaErrors.length ? schemaErrors.slice(0, 3).map((e) => e.message).join("; ") : `Types: ${[...new Set(types)].join(", ")}` },
    { key: "faq_schema", label: "FAQ/QA markup matches visible Q&A", weight: 1, applicable: hasFaqContent, pass: types.some((t) => ["FAQPage", "QAPage"].includes(t)), detail: "Page has several question headings. FAQPage markup is appropriate only if they're genuine FAQs answered on the page. Google limits FAQ rich results, so treat markup as clarity, not a guaranteed feature." },
    { key: "article_schema", label: "Article schema with author & date", weight: 1, applicable: isArticleLike, pass: types.some((t) => /Article|BlogPosting/.test(t)) && /"author"/.test(JSON.stringify(ld)), detail: types.length ? `Found: ${[...new Set(types)].join(", ")}` : "No JSON-LD found" },
    { key: "organization", label: "Organization entity markup", weight: 2, applicable: ctx.isHomepage, pass: Boolean(orgName), detail: orgName ? `Organization “${orgName}”${sameAs ? " with sameAs profiles" : " (no sameAs links to official profiles)"}` : "Homepage has no Organization/LocalBusiness markup describing the entity." },
    { key: "entity_name", label: "Entity name consistent with brand", weight: 1, applicable: ctx.isHomepage && Boolean(orgName), pass: !orgName || ctx.brandTerms.some((b) => orgName.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(orgName.toLowerCase())), detail: `Schema name “${orgName}” vs brand terms: ${ctx.brandTerms.join(", ") || "(none set)"}` },
  ];
  const applicable = checks.filter((c) => c.applicable);
  const total = applicable.reduce((s, c) => s + c.weight, 0);
  const score = total ? Math.round((applicable.filter((c) => c.pass).reduce((s, c) => s + c.weight, 0) / total) * 100) : 0;
  return { score, checks, questionHeadings, answerPassage: answerPassage as string | null, wordCount: wc, types };
}

/** Worker: assesses the most important pages (GSC clicks, else inlinks) of a site. */
export async function processAeoAssess(jc: JobContext) {
  const websiteId = jc.job.websiteId!;
  const site = await prisma.website.findUniqueOrThrow({ where: { id: websiteId } });
  const crawl = await prisma.crawl.findFirst({ where: { websiteId, status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" } });
  if (!crawl) throw new Error("Run a crawl first; AEO assessment uses crawled, indexable pages");
  const p = jc.job.payload as { urls?: string[]; limit?: number };
  let urls = p.urls ?? [];
  if (!urls.length) {
    const gsc = await prisma.searchConsoleQuery.groupBy({ by: ["page"], where: { websiteId, date: { gte: new Date(Date.now() - 28 * 86400_000) } }, _sum: { clicks: true }, orderBy: { _sum: { clicks: "desc" } }, take: p.limit ?? 30 });
    urls = gsc.map((g) => g.page);
    if (urls.length < (p.limit ?? 30)) {
      const pages = await prisma.crawledPage.findMany({ where: { crawlId: crawl.id, indexable: true }, orderBy: { inlinks: "desc" }, take: p.limit ?? 30, select: { url: true } });
      urls = [...new Set([...urls, ...pages.map((x) => x.url)])].slice(0, p.limit ?? 30);
    }
  }
  const home = normalizeUrl(site.baseUrl);
  let done = 0;
  // Robots-aware, and renders JavaScript on sites whose latest crawl needed it.
  const fetcher = await openSitePageFetcher(websiteId);
  try {
  for (const url of urls) {
    try {
      const res = await fetcher.get(url);
      const a = assessHtml(res.html, res.finalUrl, { domain: site.domain, brandTerms: site.brandTerms, isHomepage: normalizeUrl(url) === home });
      await prisma.aeoAssessment.create({ data: { organizationId: site.organizationId, websiteId, crawlId: crawl.id, url, score: a.score, checks: { checks: a.checks, questionHeadings: a.questionHeadings, answerPassage: a.answerPassage, wordCount: a.wordCount, types: a.types } as unknown as Prisma.InputJsonValue } });
    } catch (err) {
      jc.log(`skip ${url}: ${(err as Error).message}`);
    }
    done++;
    await jc.progress(Math.round((done / urls.length) * 95), `Assessed ${done}/${urls.length}`);
    await new Promise((r) => setTimeout(r, readSettings(site.settings).crawlDelayMs));
  }
  } finally {
    await fetcher.close();
  }
  return { assessed: done };
}

// ───────────── Question opportunities

const FORMAT_RULES: [RegExp, string][] = [
  [/^how (to|do|can|does)\b/i, "Numbered steps (ordered list), each step one action; a 1–2 sentence summary first"],
  [/^(what is|what are|what does|define|meaning of)\b/i, "40–60 word definition paragraph directly under a matching heading, then detail"],
  [/\b(vs\.?|versus|compare|comparison|difference between)\b/i, "Comparison table with consistent criteria, plus a short verdict paragraph"],
  [/^(best|top)\b/i, "Ranked list with selection criteria stated up front"],
  [/^(can|does|do|is|are|should|will)\b/i, "Direct yes/no answer in the first sentence, followed by the conditions/explanation"],
  [/^why\b/i, "Short explanation paragraph, then supporting reasons as a list"],
  [/\b(cost|price|how much)\b/i, "Price/cost range table only if you have real pricing data to publish; otherwise explain the cost factors"],
];
export const recommendFormat = (q: string) => FORMAT_RULES.find(([re]) => re.test(q))?.[1] ?? "Concise answer paragraph under a heading that matches the question";
const isQuestion = (q: string) => QUESTION_RE.test(q.trim()) || /\b(how to|what is|vs|best)\b/i.test(q);

/** Builds/refreshes AEO opportunities from GSC questions, tracked keywords and (optionally) People Also Ask. */
export async function processAeoOpportunities(jc: JobContext) {
  const websiteId = jc.job.websiteId!;
  const site = await prisma.website.findUniqueOrThrow({ where: { id: websiteId } });
  const since = new Date(Date.now() - 28 * 86400_000);
  type Cand = { question: string; source: string; rankingUrl: string | null; evidence: Record<string, unknown> };
  const cands = new Map<string, Cand>();

  const gsc = await prisma.searchConsoleQuery.groupBy({ by: ["query", "page"], where: { websiteId, date: { gte: since } }, _sum: { clicks: true, impressions: true }, _avg: { position: true } });
  const byQ = new Map<string, { impressions: number; clicks: number; best: { page: string; impressions: number; position: number } }>();
  for (const r of gsc) {
    if (!isQuestion(r.query)) continue;
    const imp = r._sum.impressions ?? 0;
    const e = byQ.get(r.query) ?? { impressions: 0, clicks: 0, best: { page: r.page, impressions: -1, position: 0 } };
    e.impressions += imp; e.clicks += r._sum.clicks ?? 0;
    if (imp > e.best.impressions) e.best = { page: r.page, impressions: imp, position: r._avg.position ?? 0 };
    byQ.set(r.query, e);
  }
  for (const [q, e] of [...byQ].sort((a, b) => b[1].impressions - a[1].impressions).slice(0, 100)) {
    cands.set(q.toLowerCase(), { question: q, source: "Google Search Console", rankingUrl: e.best.page, evidence: { impressions: e.impressions, clicks: e.clicks, avgPosition: Math.round(e.best.position * 10) / 10, period: "last 28 days", measured: true } });
  }

  const kws = await prisma.keyword.findMany({ where: { websiteId }, include: { observations: { orderBy: { observedAt: "desc" }, take: 1 } } });
  for (const k of kws) {
    if (!isQuestion(k.phrase) || cands.has(k.phrase)) continue;
    cands.set(k.phrase, { question: k.phrase, source: "Tracked keyword", rankingUrl: k.observations[0]?.url ?? k.targetUrl ?? null, evidence: { position: k.observations[0]?.position ?? null, searchVolumeEstimate: k.searchVolume, volumeSource: k.volumeSource } });
  }

  const conn = await findConnection(site.organizationId, "DATAFORSEO", null);
  if (conn && (jc.job.payload as { paa?: boolean }).paa) {
    const dfs = new DataForSeoClient(conn);
    const s = readSettings(site.settings);
    const seeds = kws.filter((k) => k.intent === "INFORMATIONAL").slice(0, 15);
    await withSyncLog(conn, "serp.people_also_ask", websiteId, async () => {
      for (const k of seeds) {
        const items = (await dfs.serp(k.phrase, { locationCode: k.locationCode, languageCode: k.languageCode, device: k.device, depth: 20 })) as unknown as { type: string; items?: { title?: string }[] }[];
        for (const paa of items.filter((i) => i.type === "people_also_ask").flatMap((i) => i.items ?? [])) {
          const q = paa.title?.trim();
          if (q && !cands.has(q.toLowerCase())) cands.set(q.toLowerCase(), { question: q, source: "People Also Ask (DataForSEO SERP)", rankingUrl: null, evidence: { seedKeyword: k.phrase } });
        }
      }
      return { items: seeds.length, cost: dfs.cost };
    });
  }

  // Gap analysis against the latest assessment of the ranking URL.
  let n = 0;
  for (const c of cands.values()) {
    const assessment = c.rankingUrl ? await prisma.aeoAssessment.findFirst({ where: { websiteId, url: c.rankingUrl }, orderBy: { assessedAt: "desc" } }) : null;
    const data = assessment?.checks as { checks?: AeoCheck[]; questionHeadings?: string[] } | undefined;
    const gaps: string[] = [];
    if (!c.rankingUrl) gaps.push("No page currently ranks for this question. Consider a dedicated section or page.");
    if (data?.questionHeadings && !data.questionHeadings.some((h) => overlap(h, c.question) >= 0.5)) gaps.push("No heading on the ranking page matches this question.");
    for (const ch of data?.checks ?? []) if (ch.applicable && !ch.pass && ["answer_passage", "definition", "structured_lists", "author", "freshness"].includes(ch.key)) gaps.push(`${ch.label}: ${ch.detail}`);
    if (c.rankingUrl && !assessment) gaps.push("Ranking page not assessed yet. Run an AEO assessment for evidence-based gaps.");
    const format = recommendFormat(c.question);
    const intent: SearchIntent = classifyIntent(c.question, site.brandTerms);
    await prisma.aeoOpportunity.upsert({
      where: { websiteId_question: { websiteId, question: c.question } },
      create: { organizationId: site.organizationId, websiteId, question: c.question, intent, rankingUrl: c.rankingUrl, recommendedFormat: format, contentGaps: gaps, suggestedChanges: `Add an H2 that mirrors the question, answer it in the first sentence(s) using this format: ${format}. Support with internal links and cite sources for any facts.`, source: c.source, evidence: c.evidence as Prisma.InputJsonValue },
      update: { rankingUrl: c.rankingUrl, contentGaps: gaps, evidence: c.evidence as Prisma.InputJsonValue, recommendedFormat: format },
    });
    n++;
  }
  return { opportunities: n };
}

function overlap(a: string, b: string) {
  const A = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  const B = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  if (!A.size || !B.size) return 0;
  return [...A].filter((w) => B.has(w)).length / Math.min(A.size, B.size);
}

/** AI-drafted answer section grounded only in the ranking page's own content. Stored as a suggestion. */
export async function draftAnswer(ctx: OrgContext, opportunityId: string) {
  ctx.assert("content:write");
  const opp = await ctx.db.aeoOpportunity.findUnique({ where: { id: opportunityId } });
  if (!opp) throw new UserError("Opportunity not found");
  await assertWebsiteAccess(ctx, opp.websiteId);
  const ai = await getAiClient(ctx.org.id);
  if (!ai) throw new NoAiProviderError();
  let pageText = "";
  if (opp.rankingUrl) {
    const crawl = await ctx.db.crawl.findFirst({ where: { websiteId: opp.websiteId, status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" } });
    const page = crawl ? await ctx.db.crawledPage.findFirst({ where: { crawlId: crawl.id, url: normalizeUrl(opp.rankingUrl) ?? opp.rankingUrl } }) : null;
    pageText = page?.textSample ?? "";
  }
  if (!pageText) throw new UserError("No crawled content for the ranking page. Drafts must be grounded in your existing content; crawl the site or write this section manually.");
  const prompt = `Draft an answer section for the question below using ONLY the facts in the source content.

Question: ${opp.question}
Recommended format: ${opp.recommendedFormat}

Source content from ${opp.rankingUrl}:
"""
${pageText.slice(0, 8000)}
"""

${FACT_GUARDRAIL}
If the source content does not contain enough information to answer, say so in "gaps" and keep "answer" minimal.
Respond with JSON only: {"heading": "...", "answer": "markdown answer section", "gaps": ["facts the page is missing to answer fully"]}`;
  const res = await ai.complete({ system: "You are an editor improving content for answer engines. You never invent facts.", prompt, maxTokens: 3000 });
  if (res.refusal) throw new UserError(`The model declined: ${res.refusal}`);
  const out = parseJsonLoose<{ heading?: string; answer?: string; gaps?: string[] }>(res.text);
  if (!out?.answer) throw new UserError("The model did not return a usable draft. Try again.");
  return ctx.db.contentSuggestion.create({
    data: { organizationId: ctx.org.id, websiteId: opp.websiteId, url: opp.rankingUrl, kind: "AEO_ANSWER", input: { opportunityId: opp.id, question: opp.question } as Prisma.InputJsonValue, output: JSON.stringify(out), provider: res.provider, model: res.model, promptHash: sha256(prompt).slice(0, 16), createdById: ctx.userId },
  });
}

export { isQuestion };

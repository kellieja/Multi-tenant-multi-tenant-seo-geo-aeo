import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import type { OrgContext } from "@/lib/auth/context";
import { assertWebsiteAccess } from "@/lib/auth/context";
import { UserError } from "@/lib/errors";
import { sha256 } from "@/lib/crypto";
import { writeAuditLog } from "@/lib/audit-log";
import { fetchHtmlPolitely } from "@/lib/net/polite-fetch";
import { isSameSite } from "@/lib/url";
import { parseHtml, simhash, hamming, type ParsedPage } from "@/crawler/parse";
import { findConnection, withSyncLog } from "@/integrations/connections";
import { DataForSeoClient } from "@/integrations/dataforseo";
import { getAiClient, NoAiProviderError } from "@/integrations/ai";
import { parseJsonLoose, FACT_GUARDRAIL } from "./ai-json";
import { readSettings } from "./websites";
import { proposeSiteChange } from "./site-changes";

// ───────────── Text statistics (deterministic, no AI)

const STOPWORDS = new Set(`a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves also get got may might must new one two us use used using via well within without www com https http`.split(/\s+/));

export const tokenize = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).map((w) => w.replace(/^['-]+|['-]+$/g, "")).filter(Boolean);

/** Rough English syllable count; used only for the labelled readability estimate. */
export function syllables(word: string) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

/** Flesch reading ease (0–100, higher is easier). An estimate tuned for English text. */
export function fleschReadingEase(text: string) {
  const sentences = Math.max(1, (text.match(/[.!?]+(\s|$)/g) ?? []).length);
  const words = tokenize(text).filter((w) => /[a-z]/i.test(w));
  if (words.length < 30) return null;
  const syl = words.reduce((s, w) => s + syllables(w), 0);
  const score = 206.835 - 1.015 * (words.length / sentences) - 84.6 * (syl / words.length);
  return Math.round(Math.max(0, Math.min(100, score)));
}

export const readabilityLabel = (s: number | null) => s == null ? "Not enough text" : s >= 70 ? "Easy" : s >= 50 ? "Fairly difficult" : s >= 30 ? "Difficult" : "Very difficult";

/** Most frequent meaningful unigrams and bigrams, normalised per 1,000 words. */
export function topTerms(text: string, limit = 40) {
  const words = tokenize(text);
  const counts = new Map<string, number>();
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!STOPWORDS.has(w) && w.length > 2 && !/^\d+$/.test(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
    const n = words[i + 1];
    if (n && !STOPWORDS.has(w) && !STOPWORDS.has(n) && w.length > 2 && n.length > 2) counts.set(`${w} ${n}`, (counts.get(`${w} ${n}`) ?? 0) + 1);
  }
  const total = Math.max(1, words.length);
  return [...counts.entries()].filter(([t, c]) => c >= (t.includes(" ") ? 2 : 3)).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([term, count]) => ({ term, count, per1k: Math.round((count / total) * 10000) / 10 }));
}

/** Numbers, percentages, years, superlatives and citations-needed phrases a human should verify. */
export function claimsToVerify(text: string) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const re = /(\d+(?:[.,]\d+)?\s?%|\$\s?\d|\b(19|20)\d{2}\b|\b\d{2,}(?:[.,]\d+)?\b|\b(best|first|only|largest|leading|#1|number one|guarantee[sd]?|proven|studies show|research shows|according to)\b)/i;
  return [...new Set(sentences.filter((s) => re.test(s)).map((s) => s.trim().slice(0, 300)))].slice(0, 25);
}

// ───────────── Page analysis

export interface ContentAnalysis {
  url: string | null;
  keyword: string | null;
  title: string | null;
  metaDescription: string | null;
  h1: string[];
  headings: { level: number; text: string }[];
  wordCount: number;
  paragraphs: number;
  avgParagraphWords: number;
  readability: number | null;
  readabilityLabel: string;
  questionHeadings: number;
  images: number;
  imagesMissingAlt: number;
  internalLinks: number;
  externalLinks: number;
  schemaTypes: string[];
  terms: { term: string; count: number; per1k: number }[];
  keywordChecks: { label: string; pass: boolean; detail: string }[];
  checks: { label: string; pass: boolean; detail: string; severity: "high" | "medium" | "low" }[];
  duplicates: { url: string; distance: number; exact: boolean }[];
  simhash: string;
}

const lenCheck = (v: string | null, min: number, max: number) => !!v && v.length >= min && v.length <= max;

export function analyzeParsed(p: ParsedPage, opts: { url: string | null; keyword?: string | null; siteHost?: string | null }): Omit<ContentAnalysis, "duplicates"> {
  const kw = opts.keyword?.trim().toLowerCase() || null;
  const text = p.text;
  // Paragraphs keep their sentence boundaries; the flattened page text can run blocks together.
  const readability = fleschReadingEase(p.paragraphs.length ? p.paragraphs.join("\n") : text);
  const internal = opts.url ? p.links.filter((l) => opts.siteHost && isSameSite(l.href, opts.siteHost)).length : 0;
  const keywordChecks: ContentAnalysis["keywordChecks"] = [];
  if (kw) {
    const has = (s: string | null | undefined) => !!s && s.toLowerCase().includes(kw);
    const firstPara = p.paragraphs.find((x) => x.split(/\s+/).length > 8) ?? "";
    const occurrences = text.toLowerCase().split(kw).length - 1;
    const per1k = p.wordCount ? (occurrences / p.wordCount) * 1000 : 0;
    keywordChecks.push(
      { label: "Keyword in title", pass: has(p.title), detail: p.title ?? "No title" },
      { label: "Keyword in H1", pass: p.h1.some(has), detail: p.h1[0] ?? "No H1" },
      { label: "Keyword in meta description", pass: has(p.metaDescription), detail: p.metaDescription ?? "No meta description" },
      { label: "Keyword in the opening paragraph", pass: has(firstPara), detail: firstPara.slice(0, 160) || "No paragraph found" },
      { label: "Keyword in a subheading", pass: p.headings.some((h) => h.level > 1 && has(h.text)), detail: `${p.headings.filter((h) => h.level > 1).length} subheadings` },
      { label: "Keyword in URL", pass: !!opts.url && opts.url.toLowerCase().includes(kw.replace(/\s+/g, "-")), detail: opts.url ?? "Pasted text" },
      { label: "Natural keyword frequency", pass: occurrences > 0 && per1k <= 30, detail: `${occurrences} uses (${per1k.toFixed(1)} per 1,000 words)${per1k > 30 ? " - reads as stuffed" : ""}` },
    );
  }
  const questionHeadings = p.headings.filter((h) => /\?$|^(how|what|why|when|where|which|who|can|does|do|is|are|should)\b/i.test(h.text)).length;
  const imagesMissingAlt = p.images.filter((i) => i.alt == null).length;
  const paraWords = p.paragraphs.map((x) => x.split(/\s+/).length);
  const avgParagraphWords = paraWords.length ? Math.round(paraWords.reduce((a, b) => a + b, 0) / paraWords.length) : 0;
  const checks: ContentAnalysis["checks"] = [];
  if (opts.url) {
    checks.push({ label: "Title length 30–60 characters", pass: lenCheck(p.title, 30, 60), detail: p.title ? `${p.title.length} characters` : "Missing", severity: p.title ? "medium" : "high" });
    checks.push({ label: "Meta description 70–155 characters", pass: lenCheck(p.metaDescription, 70, 155), detail: p.metaDescription ? `${p.metaDescription.length} characters` : "Missing", severity: p.metaDescription ? "low" : "medium" });
    checks.push({ label: "Exactly one H1", pass: p.h1.length === 1, detail: `${p.h1.length} H1 tag(s)`, severity: "medium" });
    checks.push({ label: "Images have alt text", pass: imagesMissingAlt === 0, detail: `${imagesMissingAlt} of ${p.images.length} missing alt`, severity: "low" });
    checks.push({ label: "Links to other pages on the site", pass: internal >= 2, detail: `${internal} internal links`, severity: "low" });
  }
  checks.push({ label: "Substantial content (300+ words)", pass: p.wordCount >= 300, detail: `${p.wordCount} words`, severity: p.wordCount < 150 ? "high" : "medium" });
  checks.push({ label: "Structured with subheadings", pass: p.headings.filter((h) => h.level >= 2).length >= Math.min(3, Math.floor(p.wordCount / 300)), detail: `${p.headings.filter((h) => h.level >= 2).length} H2–H6 for ${p.wordCount} words`, severity: "low" });
  checks.push({ label: "Paragraphs are scannable (≤ 80 words on average)", pass: avgParagraphWords > 0 && avgParagraphWords <= 80, detail: `${avgParagraphWords} words per paragraph`, severity: "low" });
  checks.push({ label: "Readable for a general audience", pass: readability == null || readability >= 50, detail: `${readability ?? "n/a"} Flesch reading ease (${readabilityLabel(readability)})`, severity: "low" });
  return {
    url: opts.url, keyword: kw, title: p.title, metaDescription: p.metaDescription, h1: p.h1, headings: p.headings.slice(0, 80),
    wordCount: p.wordCount, paragraphs: p.paragraphs.length, avgParagraphWords, readability, readabilityLabel: readabilityLabel(readability), questionHeadings,
    images: p.images.length, imagesMissingAlt, internalLinks: internal, externalLinks: opts.url ? p.links.length - internal : 0,
    schemaTypes: [...new Set(p.structuredData.flatMap((s) => s.types))], terms: topTerms(text), keywordChecks, checks, simhash: p.simhash,
  };
}

/** Pages in the latest crawl that are exact or near duplicates (simhash distance ≤ 3) of the given text. */
async function findDuplicates(websiteId: string, hash: string, contentHash: string | null, excludeUrl: string | null) {
  const crawl = await prisma.crawl.findFirst({ where: { websiteId, status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" }, select: { id: true } });
  if (!crawl) return [];
  const pages = await prisma.crawledPage.findMany({ where: { crawlId: crawl.id, simhash: { not: null }, wordCount: { gte: 50 } }, select: { url: true, simhash: true, contentHash: true } });
  return pages
    .filter((p) => p.url !== excludeUrl)
    .map((p) => ({ url: p.url, distance: hamming(hash, p.simhash!), exact: !!contentHash && p.contentHash === contentHash }))
    .filter((d) => d.exact || d.distance <= 3)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 10);
}

const analyzeInput = z.object({
  websiteId: z.string(),
  url: z.string().trim().url("Enter a full URL").optional().or(z.literal("").transform(() => undefined)),
  text: z.string().trim().max(200_000).optional().or(z.literal("").transform(() => undefined)),
  keyword: z.string().trim().max(120).optional().or(z.literal("").transform(() => undefined)),
}).refine((d) => d.url || (d.text && d.text.length >= 50), { message: "Enter a URL or paste at least 50 characters of text", path: ["url"] });

function textToHtml(text: string) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<html><body><main>${text.split(/\n{2,}/).map((block) => {
    const m = block.match(/^(#{1,6})\s+(.*)$/);
    return m ? `<h${m[1].length}>${esc(m[2])}</h${m[1].length}>` : `<p>${esc(block.replace(/\n/g, " "))}</p>`;
  }).join("")}</main></body></html>`;
}

/** Analyses a live URL (robots-respecting fetch) or pasted text; stored as an ANALYSIS suggestion for history. */
export async function analyzeContent(ctx: OrgContext, input: z.input<typeof analyzeInput>) {
  ctx.assert("content:write");
  const d = analyzeInput.parse(input);
  await assertWebsiteAccess(ctx, d.websiteId);
  const site = await ctx.db.website.findUniqueOrThrow({ where: { id: d.websiteId } });
  let parsed: ParsedPage;
  let url: string | null = null;
  if (d.url) {
    const res = await fetchHtmlPolitely(d.url);
    url = res.finalUrl;
    parsed = parseHtml(res.body, res.finalUrl);
  } else {
    parsed = parseHtml(textToHtml(d.text!), `https://${site.domain}/`);
  }
  const base = analyzeParsed(parsed, { url, keyword: d.keyword, siteHost: site.domain });
  const duplicates = await findDuplicates(site.id, parsed.simhash, parsed.contentHash, url);
  const analysis: ContentAnalysis = { ...base, duplicates };
  const s = await ctx.db.contentSuggestion.create({
    data: {
      organizationId: ctx.org.id, websiteId: site.id, url, kind: "ANALYSIS", input: { keyword: d.keyword ?? null, source: url ? "url" : "text" },
      output: JSON.stringify(analysis), provider: "internal", createdById: ctx.userId, status: "SUGGESTED",
    },
  });
  return { id: s.id, analysis };
}

// ───────────── Competitor comparison

const compareInput = z.object({
  websiteId: z.string(),
  url: z.string().trim().url("Enter your page URL"),
  competitorUrl: z.string().trim().url("Enter the competitor page URL"),
  keyword: z.string().trim().max(120).optional().or(z.literal("").transform(() => undefined)),
});

export interface ContentComparison {
  own: Omit<ContentAnalysis, "duplicates">;
  competitor: Omit<ContentAnalysis, "duplicates">;
  missingTerms: { term: string; competitorPer1k: number }[];
  missingTopics: string[];
  schemaGap: string[];
  summary: string[];
}

export function compareAnalyses(own: Omit<ContentAnalysis, "duplicates">, comp: Omit<ContentAnalysis, "duplicates">): Omit<ContentComparison, "own" | "competitor"> {
  const ownTerms = new Set(own.terms.map((t) => t.term));
  const ownText = new Set([...own.terms.map((t) => t.term), ...own.headings.flatMap((h) => tokenize(h.text))]);
  const missingTerms = comp.terms.filter((t) => !ownTerms.has(t.term) && !t.term.split(" ").every((w) => ownText.has(w))).slice(0, 20).map((t) => ({ term: t.term, competitorPer1k: t.per1k }));
  // Words from either H1 describe the shared page topic, so they don't distinguish subtopics.
  const topic = new Set([...own.h1, ...comp.h1].flatMap((h) => tokenize(h)));
  const ownHeadingWords = new Set(own.headings.filter((h) => h.level > 1).flatMap((h) => tokenize(h.text).filter((w) => !STOPWORDS.has(w))));
  const missingTopics = comp.headings.filter((h) => h.level >= 2 && h.level <= 3).map((h) => h.text).filter((t) => {
    const words = tokenize(t).filter((w) => !STOPWORDS.has(w) && w.length > 2 && !topic.has(w));
    return words.length > 0 && words.filter((w) => ownHeadingWords.has(w)).length / words.length < 0.5;
  }).slice(0, 15);
  const schemaGap = comp.schemaTypes.filter((t) => !own.schemaTypes.includes(t));
  const summary: string[] = [];
  if (comp.wordCount > own.wordCount * 1.5 && comp.wordCount - own.wordCount > 300) summary.push(`The competitor page is longer (${comp.wordCount} vs ${own.wordCount} words). Length alone doesn't rank; check whether the extra sections answer questions your page skips.`);
  if (missingTopics.length) summary.push(`${missingTopics.length} competitor subheadings cover topics your headings don't mention.`);
  if (comp.questionHeadings > own.questionHeadings) summary.push(`The competitor uses ${comp.questionHeadings} question-style headings vs your ${own.questionHeadings}.`);
  if (schemaGap.length) summary.push(`The competitor has structured data you don't: ${schemaGap.join(", ")}. Add only what matches visible content.`);
  if (own.readability != null && comp.readability != null && comp.readability - own.readability >= 10) summary.push(`The competitor reads more easily (${comp.readability} vs ${own.readability} Flesch).`);
  if (!summary.length) summary.push("No major structural gaps found. Compare depth, originality and first-hand experience manually.");
  return { missingTerms, missingTopics, schemaGap, summary };
}

export async function compareWithCompetitor(ctx: OrgContext, input: z.input<typeof compareInput>) {
  ctx.assert("content:write");
  const d = compareInput.parse(input);
  await assertWebsiteAccess(ctx, d.websiteId);
  const site = await ctx.db.website.findUniqueOrThrow({ where: { id: d.websiteId } });
  if (!isSameSite(d.url, site.domain)) throw new UserError(`Your page must be on ${site.domain}`);
  if (isSameSite(d.competitorUrl, site.domain)) throw new UserError("The competitor URL is on your own site");
  const [a, b] = await Promise.all([fetchHtmlPolitely(d.url), fetchHtmlPolitely(d.competitorUrl)]);
  const own = analyzeParsed(parseHtml(a.body, a.finalUrl), { url: a.finalUrl, keyword: d.keyword, siteHost: site.domain });
  const competitor = analyzeParsed(parseHtml(b.body, b.finalUrl), { url: b.finalUrl, keyword: d.keyword, siteHost: new URL(b.finalUrl).hostname });
  const result: ContentComparison = { own, competitor, ...compareAnalyses(own, competitor) };
  const s = await ctx.db.contentSuggestion.create({
    data: { organizationId: ctx.org.id, websiteId: site.id, url: a.finalUrl, kind: "COMPARE", input: { competitorUrl: b.finalUrl, keyword: d.keyword ?? null }, output: JSON.stringify(result), provider: "internal", createdById: ctx.userId },
  });
  return { id: s.id, result };
}

// ───────────── AI content brief

const briefInput = z.object({
  websiteId: z.string(),
  keyword: z.string().trim().min(2, "Enter a target keyword or topic").max(120),
  url: z.string().trim().url().optional().or(z.literal("").transform(() => undefined)),
  audience: z.string().trim().max(300).optional().or(z.literal("").transform(() => undefined)),
});

export interface ContentBrief {
  searchIntent: string;
  titleOptions: string[];
  metaDescription: string;
  outline: { level: 2 | 3; text: string; notes?: string }[];
  faqs: { question: string; answerGuidance: string }[];
  entities: string[];
  internalLinks: { url: string; anchor: string }[];
  wordCountGuidance: string;
  claimsToVerify: string[];
  rationale: string;
}

/**
 * Drafts a content brief grounded in real data: live SERP results (DataForSEO, when
 * connected), Search Console queries for the site and the site's own crawled pages.
 * Stored as a reviewable BRIEF suggestion with provider/model/prompt hash.
 */
export async function generateBrief(ctx: OrgContext, input: z.input<typeof briefInput>) {
  ctx.assert("content:write");
  const d = briefInput.parse(input);
  await assertWebsiteAccess(ctx, d.websiteId);
  const ai = await getAiClient(ctx.org.id);
  if (!ai) throw new NoAiProviderError();
  const site = await ctx.db.website.findUniqueOrThrow({ where: { id: d.websiteId } });
  const settings = readSettings(site.settings);
  const sources: string[] = [];

  let serp: { position: number; title: string; url: string }[] = [];
  const dfsConn = await findConnection(ctx.org.id, "DATAFORSEO");
  if (dfsConn?.status === "CONNECTED") {
    const dfs = new DataForSeoClient(dfsConn);
    const { list } = await withSyncLog(dfsConn, "serp.content_brief", site.id, async () => {
      const items = await dfs.serp(d.keyword, { locationCode: settings.rankLocationCode, languageCode: settings.rankLanguageCode, device: "desktop", depth: 10 });
      return { list: items, items: items.length, cost: dfs.cost };
    });
    serp = list.filter((i) => i.type === "organic" && i.url).slice(0, 10).map((i) => ({ position: i.rank_group ?? 0, title: i.title ?? "", url: i.url! }));
    sources.push(`DataForSEO SERP (${serp.length} organic results)`);
  }
  const kwTokens = tokenize(d.keyword).filter((w) => !STOPWORDS.has(w));
  const gsc = kwTokens.length ? await prisma.searchConsoleQuery.groupBy({
    by: ["query"], where: { websiteId: site.id, date: { gte: new Date(Date.now() - 90 * 86400_000) }, OR: kwTokens.map((t) => ({ query: { contains: t, mode: "insensitive" as const } })) },
    _sum: { impressions: true, clicks: true }, orderBy: { _sum: { impressions: "desc" } }, take: 25,
  }) : [];
  if (gsc.length) sources.push(`Search Console (${gsc.length} related queries, 90 days)`);
  const crawl = await prisma.crawl.findFirst({ where: { websiteId: site.id, status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" }, select: { id: true } });
  const pages = crawl ? await prisma.crawledPage.findMany({ where: { crawlId: crawl.id, indexable: true, statusCode: 200, title: { not: null } }, orderBy: { inlinks: "desc" }, take: 80, select: { url: true, title: true } }) : [];
  if (pages.length) sources.push(`Your crawled pages (${pages.length})`);
  let current: string | null = null;
  if (d.url) {
    const p = await prisma.crawledPage.findFirst({ where: { url: d.url, websiteId: site.id }, orderBy: { fetchedAt: "desc" }, select: { title: true, headings: true, textSample: true } });
    if (p) current = `Title: ${p.title}\nHeadings:\n${((p.headings as { level: number; text: string }[]) ?? []).slice(0, 30).map((h) => `${"#".repeat(h.level)} ${h.text}`).join("\n")}\nExcerpt: ${(p.textSample ?? "").slice(0, 2500)}`;
  }

  const prompt = `Create an SEO content brief for ${site.name} (${site.domain}).

Target keyword/topic: ${d.keyword}
Audience: ${d.audience ?? "not specified"}
${d.url ? `Existing page to improve: ${d.url}\n${current ?? "(not in the latest crawl)"}` : "This is a new page."}

Current top search results${serp.length ? "" : " (not available; DataForSEO is not connected, so do not guess what ranks)"}:
${serp.map((r) => `${r.position}. ${r.title} — ${r.url}`).join("\n")}

Related Search Console queries for this site (impressions, clicks):
${gsc.map((g) => `- ${g.query} (${g._sum.impressions ?? 0}, ${g._sum.clicks ?? 0})`).join("\n") || "(none)"}

Pages on the site available for internal links (use only these URLs):
${pages.map((p) => `- ${p.url} — ${p.title}`).join("\n") || "(none)"}

Rules:
- ${FACT_GUARDRAIL}
- Do not invent statistics, prices, credentials or testimonials. Where the writer must add real data, say so in the notes.
- Internal link URLs must come from the list above.
- titleOptions: 3 options, 30–60 characters. metaDescription: 70–155 characters.
- claimsToVerify: facts the writer must confirm before publishing.
Respond with JSON only matching:
{"searchIntent": "...", "titleOptions": ["..."], "metaDescription": "...", "outline": [{"level": 2, "text": "...", "notes": "..."}], "faqs": [{"question": "...", "answerGuidance": "..."}], "entities": ["..."], "internalLinks": [{"url": "...", "anchor": "..."}], "wordCountGuidance": "...", "claimsToVerify": ["..."], "rationale": "..."}`;
  const res = await ai.complete({ system: "You are a senior SEO content strategist who writes precise, honest briefs.", prompt, maxTokens: 6000 });
  if (res.refusal) throw new UserError(`The AI provider declined this request: ${res.refusal}`);
  const brief = parseJsonLoose<ContentBrief>(res.text);
  if (!brief?.outline?.length) throw new UserError("The AI response couldn't be parsed into a brief. Try again.");
  const allowed = new Set(pages.map((p) => p.url));
  brief.internalLinks = (brief.internalLinks ?? []).filter((l) => allowed.has(l.url));
  const s = await ctx.db.contentSuggestion.create({
    data: {
      organizationId: ctx.org.id, websiteId: site.id, url: d.url ?? null, kind: "BRIEF",
      input: { keyword: d.keyword, audience: d.audience ?? null, sources, serp } as Prisma.InputJsonValue,
      output: JSON.stringify(brief), provider: res.provider, model: res.model, promptHash: sha256(prompt).slice(0, 16), createdById: ctx.userId,
    },
  });
  return { id: s.id, brief, sources };
}

// ───────────── Suggestion review

export const SUGGESTION_KINDS: Record<string, string> = {
  METADATA: "Title & meta", BRIEF: "Content brief", AEO_ANSWER: "Answer draft", ANALYSIS: "Page analysis", COMPARE: "Competitor comparison",
};

export async function updateSuggestionStatus(ctx: OrgContext, id: string, status: "APPROVED" | "REJECTED" | "SUGGESTED") {
  ctx.assert("content:write");
  const s = await ctx.db.contentSuggestion.findUnique({ where: { id } });
  if (!s) throw new UserError("Suggestion not found");
  await assertWebsiteAccess(ctx, s.websiteId);
  if (s.status === "APPLIED") throw new UserError("This suggestion was already applied");
  // Who approved is recorded: policy-based auto-publishing only trusts approvals by people who may decide site changes.
  const input = { ...((s.input as Record<string, unknown>) ?? {}), approvedById: status === "APPROVED" ? ctx.userId : null, approvedByCanDecide: status === "APPROVED" ? ctx.can("approvals:decide") : false };
  await ctx.db.contentSuggestion.update({ where: { id }, data: { status, input: input as Prisma.InputJsonValue } });
  await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: `content.${status.toLowerCase()}`, entityType: "ContentSuggestion", entityId: id, metadata: { kind: s.kind } });
}

/** Human edit of a suggestion. METADATA edits are validated field-by-field. */
export async function editSuggestion(ctx: OrgContext, id: string, fields: { title?: string; metaDescription?: string; text?: string }) {
  ctx.assert("content:write");
  const s = await ctx.db.contentSuggestion.findUnique({ where: { id } });
  if (!s) throw new UserError("Suggestion not found");
  await assertWebsiteAccess(ctx, s.websiteId);
  if (s.status === "APPLIED") throw new UserError("Applied suggestions can't be edited");
  const prev = JSON.parse(s.output) as Record<string, unknown>;
  let output: string;
  if (s.kind === "METADATA") {
    const t = z.object({ title: z.string().trim().min(1, "Title is required").max(120), metaDescription: z.string().trim().max(320) }).parse(fields);
    output = JSON.stringify({ ...prev, title: t.title, metaDescription: t.metaDescription });
  } else if (s.kind === "AEO_ANSWER") {
    output = JSON.stringify({ ...prev, answer: z.string().trim().min(1).max(20_000).parse(fields.text) });
  } else throw new UserError("This kind of suggestion can't be edited inline");
  await ctx.db.contentSuggestion.update({ where: { id }, data: { output, status: "EDITED", input: { ...((s.input as Record<string, unknown>) ?? {}), approvedById: null, approvedByCanDecide: false } as Prisma.InputJsonValue } });
}

/** Sends an approved METADATA suggestion to the live-site approval flow (WordPress). */
export async function proposeSuggestionToSite(ctx: OrgContext, id: string) {
  ctx.assert("content:write");
  const s = await ctx.db.contentSuggestion.findUnique({ where: { id } });
  if (!s) throw new UserError("Suggestion not found");
  if (s.kind !== "METADATA" || !s.url) throw new UserError("Only title/meta suggestions for a URL can be proposed to the site");
  if (s.status !== "APPROVED") throw new UserError("Approve the suggestion first");
  const out = JSON.parse(s.output) as { title?: string; metaDescription?: string };
  const input = (s.input ?? {}) as { currentTitle?: string | null; currentMetaDescription?: string | null };
  let proposed = 0;
  const errors: string[] = [];
  for (const [field, value, current] of [["title", out.title, input.currentTitle], ["meta_description", out.metaDescription, input.currentMetaDescription]] as const) {
    if (!value || value === current) continue;
    try {
      await proposeSiteChange(ctx, { websiteId: s.websiteId, url: s.url, field, value, source: `content:${s.id}` });
      proposed++;
    } catch (e) { errors.push((e as Error).message); }
  }
  if (!proposed) throw new UserError(errors[0] ?? "Nothing to change");
  await ctx.db.contentSuggestion.update({ where: { id }, data: { status: "APPLIED" } });
  return { proposed };
}

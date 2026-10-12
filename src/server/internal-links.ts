import * as cheerio from "cheerio";
import { prisma } from "@/lib/db/client";
import type { OrgContext } from "@/lib/auth/context";
import { assertWebsiteAccess } from "@/lib/auth/context";
import type { JobContext } from "@/lib/jobs/context";
import { UserError } from "@/lib/errors";
import { writeAuditLog } from "@/lib/audit-log";
import { openSitePageFetcher } from "./page-fetch";
import { normalizeUrl } from "@/lib/url";
import { readSettings } from "./websites";
import { proposeEdit } from "./site-changes";

// ───────────── Phrase selection

export interface TargetPhrase { phrase: string; source: "keyword" | "gsc" | "h1" | "title"; weight: number }

const SOURCE_WEIGHT: Record<TargetPhrase["source"], number> = { keyword: 1, gsc: 0.9, h1: 0.7, title: 0.6 };
const GENERIC = /^(home|homepage|about|about us|contact|contact us|blog|news|services|products|privacy policy|terms|login|search|page not found|404)$/i;

/** Strips a trailing " | Brand" / " - Brand" segment and normalises whitespace/case. */
export function cleanTitle(title: string, brandTerms: string[] = []) {
  let t = title.split(/\s+[|–—:·]\s+|\s+-\s+/)[0] ?? title;
  for (const b of brandTerms) t = t.replace(new RegExp(`\\b${escapeRe(b)}\\b`, "ig"), "");
  return t.replace(/\s+/g, " ").trim().toLowerCase();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

export function phrasesForTarget(input: { title?: string | null; h1?: string[]; keywords?: string[]; queries?: string[]; brandTerms?: string[] }): TargetPhrase[] {
  const out = new Map<string, TargetPhrase>();
  const add = (raw: string | null | undefined, source: TargetPhrase["source"], minWords: number) => {
    if (!raw) return;
    const p = raw.replace(/[“”"?!.]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    const n = wordCount(p);
    if (n < minWords || n > 6 || p.length < 4 || GENERIC.test(p)) return;
    if (!out.has(p) || out.get(p)!.weight < SOURCE_WEIGHT[source]) out.set(p, { phrase: p, source, weight: SOURCE_WEIGHT[source] });
  };
  for (const k of input.keywords ?? []) add(k, "keyword", 1);
  for (const q of input.queries ?? []) add(q, "gsc", 2);
  for (const h of input.h1 ?? []) add(cleanTitle(h, input.brandTerms), "h1", 2);
  add(input.title ? cleanTitle(input.title, input.brandTerms) : null, "title", 2);
  return [...out.values()].sort((a, b) => b.weight - a.weight).slice(0, 8);
}

// ───────────── Paragraph extraction (text that is not already a link)

export interface SourceParagraph { text: string; unlinked: string }

/** Content paragraphs from the main area, with existing link text blanked so it is never re-linked. */
export function linkableParagraphs(html: string): SourceParagraph[] {
  const $ = cheerio.load(html);
  $("script, style, noscript, nav, header, footer, aside, form, [aria-hidden=true]").remove();
  const main = $("main, article, [role=main]").first();
  const scope = main.length ? main : $("body");
  return scope.find("p, li").toArray().map((el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    const clone = $(el).clone();
    clone.find("a, h1, h2, h3, h4, h5, h6, code, button").each((_, a) => { $(a).replaceWith(" \u0000 "); });
    return { text, unlinked: clone.text().replace(/\s+/g, " ").trim() };
  }).filter((p) => p.text.length >= 40);
}

const phraseRe = (phrase: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(phrase).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "iu");

export function findAnchor(paragraphs: SourceParagraph[], phrase: string) {
  const re = phraseRe(phrase);
  for (const p of paragraphs) {
    const m = p.unlinked.match(re);
    if (m) return { paragraph: p.text.slice(0, 600), anchor: m[0] };
  }
  return null;
}

// ───────────── Safe link insertion into CMS HTML

const BLOCKED = new Set(["a", "h1", "h2", "h3", "h4", "h5", "h6", "script", "style", "code", "pre", "button", "textarea", "select", "option", "figcaption", "title", "label"]);
const VOID = new Set(["br", "img", "hr", "input", "meta", "link", "source", "wbr", "area", "col", "embed", "track", "base", "param"]);
const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * Wraps the first occurrence of `anchor` that sits in paragraph/list text (never inside an
 * existing link, heading, code or script) with a link to `href`. Returns null when there is
 * no safe place, so callers never write a change they can't explain.
 */
export function insertLink(html: string, anchor: string, href: string): string | null {
  const re = phraseRe(anchor);
  const tokens = html.split(/(<!--[\s\S]*?-->|<[^>]+>)/);
  const stack: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    if (tok.startsWith("<!--")) continue;
    if (tok.startsWith("<")) {
      const m = tok.match(/^<\s*(\/)?\s*([a-zA-Z0-9-]+)/);
      if (!m) continue;
      const name = m[2].toLowerCase();
      if (m[1]) {
        const idx = stack.lastIndexOf(name);
        if (idx >= 0) stack.splice(idx);
      } else if (!VOID.has(name) && !tok.endsWith("/>")) stack.push(name);
      continue;
    }
    if (stack.some((t) => BLOCKED.has(t))) continue;
    if (!stack.some((t) => t === "p" || t === "li")) continue;
    const m = tok.match(re);
    if (!m || m.index == null) continue;
    tokens[i] = `${tok.slice(0, m.index)}<a href="${escapeAttr(href)}">${m[0]}</a>${tok.slice(m.index + m[0].length)}`;
    return tokens.join("");
  }
  return null;
}

// ───────────── Analysis job

const MAX_FETCH = 120;
const PER_SOURCE = 3;
const PER_TARGET = 5;

export function scoreSuggestion(p: { weight: number; targetInlinks: number; sourceInlinks: number }) {
  const need = p.targetInlinks === 0 ? 0.3 : p.targetInlinks < 3 ? 0.2 : p.targetInlinks < 10 ? 0.1 : 0;
  const authority = Math.min(0.2, p.sourceInlinks / 50);
  return Math.round(Math.min(1, p.weight * 0.5 + need + authority) * 100);
}

export async function processInternalLinks(jc: JobContext) {
  const websiteId = jc.job.websiteId!;
  const site = await prisma.website.findUniqueOrThrow({ where: { id: websiteId } });
  const crawl = await prisma.crawl.findFirst({ where: { websiteId, status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" } });
  if (!crawl) throw new Error("Run a crawl first; internal link analysis uses the latest crawl");
  const pages = await prisma.crawledPage.findMany({
    where: { crawlId: crawl.id, statusCode: 200, indexable: true, contentType: { contains: "html" } },
    select: { url: true, title: true, h1: true, inlinks: true, textSample: true, wordCount: true },
  });
  const links = await prisma.crawledLink.findMany({ where: { crawlId: crawl.id, isInternal: true }, select: { fromUrl: true, toUrl: true } });
  const linked = new Set(links.map((l) => `${l.fromUrl} ${normalizeUrl(l.toUrl) ?? l.toUrl}`));

  // Mark previously approved suggestions as applied once the crawl shows the link exists.
  const approved = await prisma.internalLinkSuggestion.findMany({ where: { websiteId, status: "APPROVED" } });
  for (const s of approved) if (linked.has(`${s.sourceUrl} ${s.targetUrl}`)) await prisma.internalLinkSuggestion.update({ where: { id: s.id }, data: { status: "APPLIED" } });

  await jc.progress(5, "Selecting target phrases");
  const since = new Date(Date.now() - 90 * 86400_000);
  const [keywords, gsc] = await Promise.all([
    prisma.keyword.findMany({ where: { websiteId, targetUrl: { not: null } }, select: { phrase: true, targetUrl: true } }),
    prisma.searchConsoleQuery.groupBy({ by: ["page", "query"], where: { websiteId, date: { gte: since } }, _sum: { impressions: true }, having: { impressions: { _sum: { gte: 10 } } }, orderBy: { _sum: { impressions: "desc" } }, take: 2000 }),
  ]);
  const targets = pages.map((p) => ({
    page: p,
    phrases: phrasesForTarget({
      title: p.title, h1: p.h1, brandTerms: [site.name, ...site.brandTerms],
      keywords: keywords.filter((k) => normalizeUrl(k.targetUrl!) === p.url).map((k) => k.phrase),
      queries: gsc.filter((g) => normalizeUrl(g.page) === p.url).slice(0, 5).map((g) => g.query),
    }),
  })).filter((t) => t.phrases.length);

  // Candidate (source, target, phrase) triples from the crawl's stored paragraph text.
  type Cand = { source: (typeof pages)[number]; target: (typeof pages)[number]; phrase: TargetPhrase };
  const cands: Cand[] = [];
  for (const t of targets) {
    for (const src of pages) {
      if (src.url === t.page.url || linked.has(`${src.url} ${t.page.url}`) || !src.textSample) continue;
      const sample = src.textSample.toLowerCase();
      const ph = t.phrases.find((p) => sample.includes(p.phrase));
      if (ph) cands.push({ source: src, target: t.page, phrase: ph });
    }
  }
  cands.sort((a, b) => scoreSuggestion({ weight: b.phrase.weight, targetInlinks: b.target.inlinks, sourceInlinks: b.source.inlinks }) - scoreSuggestion({ weight: a.phrase.weight, targetInlinks: a.target.inlinks, sourceInlinks: a.source.inlinks }));

  const existing = await prisma.internalLinkSuggestion.findMany({ where: { websiteId, status: { in: ["REJECTED", "APPLIED", "APPROVED"] } }, select: { sourceUrl: true, targetUrl: true } });
  const decided = new Set(existing.map((e) => `${e.sourceUrl} ${e.targetUrl}`));
  const sources = [...new Set(cands.filter((c) => !decided.has(`${c.source.url} ${c.target.url}`)).map((c) => c.source.url))].slice(0, MAX_FETCH);
  const delay = readSettings(site.settings).crawlDelayMs;
  const perSource = new Map<string, number>();
  const perTarget = new Map<string, number>();
  let created = 0;
  let fetched = 0;
  const pagesFetcher = await openSitePageFetcher(websiteId);
  try {
  for (const srcUrl of sources) {
    if (await jc.isCancelled()) break;
    let paragraphs: SourceParagraph[];
    try {
      paragraphs = linkableParagraphs((await pagesFetcher.get(srcUrl)).html);
    } catch (err) {
      jc.log(`skip ${srcUrl}: ${(err as Error).message}`);
      continue;
    } finally {
      fetched++;
      await jc.progress(10 + Math.round((fetched / sources.length) * 85), `Checked ${fetched}/${sources.length} pages`);
    }
    for (const c of cands.filter((x) => x.source.url === srcUrl)) {
      const key = `${c.source.url} ${c.target.url}`;
      if (decided.has(key) || (perSource.get(srcUrl) ?? 0) >= PER_SOURCE || (perTarget.get(c.target.url) ?? 0) >= PER_TARGET) continue;
      const hit = findAnchor(paragraphs, c.phrase.phrase);
      if (!hit) continue;
      const score = scoreSuggestion({ weight: c.phrase.weight, targetInlinks: c.target.inlinks, sourceInlinks: c.source.inlinks });
      const why = [
        `“${hit.anchor}” matches the target's ${c.phrase.source === "keyword" ? "tracked keyword" : c.phrase.source === "gsc" ? "Search Console query" : c.phrase.source === "h1" ? "H1" : "title"}`,
        c.target.inlinks === 0 ? "target has no internal links (orphan)" : `target has ${c.target.inlinks} internal link(s)`,
        `source page has ${c.source.inlinks} internal link(s)`,
      ].join("; ");
      await prisma.internalLinkSuggestion.upsert({
        where: { crawlId_sourceUrl_targetUrl: { crawlId: crawl.id, sourceUrl: c.source.url, targetUrl: c.target.url } },
        create: { organizationId: site.organizationId, websiteId, crawlId: crawl.id, sourceUrl: c.source.url, targetUrl: c.target.url, anchor: hit.anchor, sourceParagraph: hit.paragraph, rationale: why, score },
        update: { anchor: hit.anchor, sourceParagraph: hit.paragraph, rationale: why, score },
      });
      decided.add(key);
      perSource.set(srcUrl, (perSource.get(srcUrl) ?? 0) + 1);
      perTarget.set(c.target.url, (perTarget.get(c.target.url) ?? 0) + 1);
      created++;
    }
    if (delay) await new Promise((r) => setTimeout(r, delay));
  }
  } finally {
    await pagesFetcher.close();
  }
  // Older SUGGESTED rows from previous crawls are superseded by this run.
  await prisma.internalLinkSuggestion.deleteMany({ where: { websiteId, status: "SUGGESTED", crawlId: { not: crawl.id } } });
  return { suggestions: created, pagesChecked: fetched, targets: targets.length };
}

// ───────────── Overview statistics (from crawl data)

export async function linkGraphStats(websiteId: string) {
  const crawl = await prisma.crawl.findFirst({ where: { websiteId, status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" }, select: { id: true, finishedAt: true } });
  if (!crawl) return null;
  const pages = await prisma.crawledPage.findMany({ where: { crawlId: crawl.id, statusCode: 200, indexable: true }, select: { url: true, title: true, inlinks: true, outlinks: true, depth: true, inSitemap: true } });
  const orphans = pages.filter((p) => p.inlinks === 0 && p.depth > 0);
  const deep = pages.filter((p) => p.depth > 3);
  const buckets = [
    { label: "0", value: pages.filter((p) => p.inlinks === 0).length },
    { label: "1–2", value: pages.filter((p) => p.inlinks >= 1 && p.inlinks <= 2).length },
    { label: "3–9", value: pages.filter((p) => p.inlinks >= 3 && p.inlinks <= 9).length },
    { label: "10–49", value: pages.filter((p) => p.inlinks >= 10 && p.inlinks <= 49).length },
    { label: "50+", value: pages.filter((p) => p.inlinks >= 50).length },
  ];
  const top = [...pages].sort((a, b) => b.inlinks - a.inlinks).slice(0, 10);
  const weak = [...pages].filter((p) => p.depth > 0).sort((a, b) => a.inlinks - b.inlinks || b.depth - a.depth).slice(0, 15);
  return { crawlId: crawl.id, finishedAt: crawl.finishedAt, total: pages.length, orphans, deep: deep.length, buckets, top, weak };
}

// ───────────── Review and apply

export async function setLinkSuggestionStatus(ctx: OrgContext, id: string, status: "APPROVED" | "REJECTED" | "SUGGESTED") {
  ctx.assert("content:write");
  const s = await ctx.db.internalLinkSuggestion.findUnique({ where: { id } });
  if (!s) throw new UserError("Suggestion not found");
  await assertWebsiteAccess(ctx, s.websiteId);
  if (s.status === "APPLIED") throw new UserError("Already applied");
  if (s.changeId && status !== "APPROVED") throw new UserError("This link was already sent for a site change; manage it in Automation → Site changes");
  await ctx.db.internalLinkSuggestion.update({ where: { id }, data: { status } });
  await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: `internal_link.${status.toLowerCase()}`, entityType: "InternalLinkSuggestion", entityId: id });
}

/**
 * Sends an accepted link through the live-change pipeline (WordPress or a File host), which
 * computes the exact edit, keeps a backup and waits for approval before anything is written.
 */
export async function proposeInternalLink(ctx: OrgContext, id: string) {
  ctx.assert("content:write");
  const s = await ctx.db.internalLinkSuggestion.findUnique({ where: { id } });
  if (!s) throw new UserError("Suggestion not found");
  await assertWebsiteAccess(ctx, s.websiteId);
  if (s.status !== "APPROVED") throw new UserError("Accept the suggestion before proposing it to the site");
  if (s.changeId) throw new UserError("A site change was already proposed for this link");
  const change = await proposeEdit(ctx, { websiteId: s.websiteId, url: s.sourceUrl, edit: { kind: "link", anchor: s.anchor, href: s.targetUrl }, source: `internal-link:${s.id}` });
  await ctx.db.internalLinkSuggestion.update({ where: { id }, data: { changeId: change.id } });
  return change;
}

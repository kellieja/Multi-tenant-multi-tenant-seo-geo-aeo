import type { CrawlResult, CrawledPageRecord } from "@/crawler/crawl";
import { blocksEverything, isAllowed } from "@/crawler/robots";
import { hamming } from "@/crawler/parse";
import { normalizeUrl } from "@/lib/url";
import { validateStructuredData } from "./schema";
import { ISSUES, type IssueType } from "./catalog";

export interface RawFinding {
  issueType: IssueType;
  url: string;
  evidence: Record<string, unknown>;
  /** Distinguishes multiple findings of one type on one URL (rare). */
  key?: string;
}

const isIndexable = (p: CrawledPageRecord) =>
  p.isHtml && p.statusCode === 200 && !p.blockedByRobots && !/noindex/.test(`${p.robotsMeta ?? ""} ${p.xRobotsTag ?? ""}`);

export function indexabilityReason(p: CrawledPageRecord): string | null {
  if (p.blockedByRobots) return `Blocked by robots.txt (${p.robotsRule ?? "rule"})`;
  if (p.error) return "Fetch failed";
  if (p.statusCode !== 200) return `HTTP ${p.statusCode}`;
  if (!p.isHtml) return "Not HTML";
  if (/noindex/.test(p.robotsMeta ?? "")) return "noindex (robots meta)";
  if (/noindex/.test(p.xRobotsTag ?? "")) return "noindex (X-Robots-Tag)";
  if (p.canonical && normalizeUrl(p.canonical) !== p.url) return "Canonicalized to another URL";
  return null;
}

const HREFLANG_RE = /^(x-default|[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?)$/i;

export function runAudit(r: CrawlResult): RawFinding[] {
  const out: RawFinding[] = [];
  const add = (issueType: IssueType, url: string, evidence: Record<string, unknown>, key?: string) => out.push({ issueType, url, evidence, key });
  const pages = r.pages;
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const home = normalizeUrl(r.baseUrl) ?? r.baseUrl;
  const ua = "SearchOpsBot";
  const statusOf = (u: string) => byUrl.get(u)?.statusCode ?? null;

  // ── Site level: robots & sitemaps
  if (r.robots.status != null && r.robots.status >= 500) add("robots_unreachable", `${new URL(r.baseUrl).origin}/robots.txt`, { status: r.robots.status });
  else if (r.robots.status === 404) add("robots_missing", `${new URL(r.baseUrl).origin}/robots.txt`, { status: 404 });
  if (r.robots.parsed && r.robots.status === 200 && (blocksEverything(r.robots.parsed, ua) || blocksEverything(r.robots.parsed, "Googlebot"))) {
    add("robots_blocks_all", `${new URL(r.baseUrl).origin}/robots.txt`, { excerpt: r.robots.parsed.raw.slice(0, 500) });
  }
  const okSitemaps = r.sitemap.sitemaps.filter((s) => s.status === 200 && !s.error);
  if (!okSitemaps.length) add("sitemap_missing", `${new URL(r.baseUrl).origin}/sitemap.xml`, { checked: r.sitemap.sitemaps.map((s) => ({ url: s.url, status: s.status, error: s.error })) });
  for (const s of r.sitemap.sitemaps) {
    if (s.error && !(s.status === 404 && s.url.endsWith("/sitemap.xml") && okSitemaps.length)) {
      if (s.status === 404 && !okSitemaps.length) continue; // covered by sitemap_missing
      add("sitemap_error", s.url, { status: s.status, error: s.error });
    }
  }
  const sitemapSet = new Set(r.sitemap.urls.map((u) => normalizeUrl(u.loc)).filter(Boolean) as string[]);

  // ── Duplicate groups (indexable pages only)
  const indexable = pages.filter(isIndexable).filter((p) => !p.canonical || normalizeUrl(p.canonical) === p.url);
  const groupBy = (f: (p: CrawledPageRecord) => string | null) => {
    const m = new Map<string, string[]>();
    for (const p of indexable) {
      const k = f(p);
      if (!k) continue;
      m.set(k, [...(m.get(k) ?? []), p.url]);
    }
    return m;
  };
  const titleGroups = groupBy((p) => p.title?.trim().toLowerCase() || null);
  const descGroups = groupBy((p) => p.metaDescription?.trim().toLowerCase() || null);
  const hashGroups = groupBy((p) => (p.wordCount >= 50 ? p.contentHash : null));

  // Inbound links per target (for evidence on redirect/broken link findings)
  const linksTo = new Map<string, { from: string; anchor: string }[]>();
  for (const l of r.links) {
    if (!l.isInternal) continue;
    const arr = linksTo.get(l.toUrl) ?? [];
    if (arr.length < 20) arr.push({ from: l.fromUrl, anchor: l.anchor });
    linksTo.set(l.toUrl, arr);
  }
  const linksFrom = new Map<string, typeof r.links>();
  for (const l of r.links) linksFrom.set(l.fromUrl, [...(linksFrom.get(l.fromUrl) ?? []), l]);

  for (const p of pages) {
    const ev = { status: p.statusCode, depth: p.depth };
    // ── Status & fetch
    if (p.blockedByRobots) {
      if (p.inSitemap) add("sitemap_blocked", p.url, { rule: p.robotsRule });
      else if ((linksTo.get(p.url)?.length ?? 0) > 0) add("blocked_by_robots", p.url, { rule: p.robotsRule, linkedFrom: linksTo.get(p.url)?.slice(0, 5) });
      continue;
    }
    if (p.error) { add("fetch_error", p.url, { error: p.error }); continue; }
    if (p.redirectChain.length) {
      if (p.redirectChain.length >= 10 || (p.finalStatus != null && p.finalStatus >= 300 && p.finalStatus < 400)) add("redirect_loop", p.url, { hops: p.redirectChain });
      else if (p.redirectChain.length > 1) add("redirect_chain", p.url, { hops: p.redirectChain, finalUrl: p.finalUrl, finalStatus: p.finalStatus });
      const inbound = linksTo.get(p.url);
      if (inbound?.length) add("internal_link_to_redirect", p.url, { finalUrl: p.finalUrl, linkedFrom: inbound });
      if (p.inSitemap) add("sitemap_non_200", p.url, { status: p.statusCode, finalUrl: p.finalUrl });
      continue;
    }
    if (p.statusCode != null && p.statusCode >= 500) add("http_5xx", p.url, { ...ev, linkedFrom: linksTo.get(p.url)?.slice(0, 10) });
    else if (p.statusCode != null && p.statusCode >= 400) add("http_4xx", p.url, { ...ev, linkedFrom: linksTo.get(p.url)?.slice(0, 10) });
    if (p.inSitemap && p.statusCode !== 200) add("sitemap_non_200", p.url, { status: p.statusCode });
    if (!p.isHtml || p.statusCode !== 200) continue;

    const noindex = /noindex/.test(`${p.robotsMeta ?? ""} ${p.xRobotsTag ?? ""}`);
    const canonical = p.canonical ? normalizeUrl(p.canonical) : null;
    const selfCanonical = !canonical || canonical === p.url;

    // ── Indexing directives
    if (noindex) {
      add("noindex", p.url, { robotsMeta: p.robotsMeta, xRobotsTag: p.xRobotsTag });
      if (p.inSitemap) add("sitemap_noindex", p.url, { robotsMeta: p.robotsMeta, xRobotsTag: p.xRobotsTag });
    }
    if (p.canonicalCount > 1) add("multiple_canonicals", p.url, { count: p.canonicalCount });
    if (!p.canonical && !noindex) add("missing_canonical", p.url, {});
    if (canonical && !selfCanonical) {
      const target = byUrl.get(canonical);
      const isPaginated = /[?&](page|p|pg)=\d+|\/page\/\d+\/?$/i.test(p.url);
      if (target && target.statusCode !== 200) add("canonical_to_non_200", p.url, { canonical, targetStatus: target.statusCode, targetFinalUrl: target.finalUrl });
      else if (target && /noindex/.test(`${target.robotsMeta ?? ""} ${target.xRobotsTag ?? ""}`)) add("canonical_to_noindex", p.url, { canonical });
      else if (isPaginated && p.relPrev) add("pagination_canonical_first", p.url, { canonical });
      else if (p.inSitemap || noindex) add("canonical_conflict", p.url, { canonical, inSitemap: p.inSitemap, noindex });
      else add("canonicalized_elsewhere", p.url, { canonical });
    }
    if (sitemapSet.size && !p.inSitemap && !noindex && selfCanonical && p.url !== home && p.inlinks > 0) add("not_in_sitemap", p.url, { inlinks: p.inlinks });

    // ── On-page
    if (!p.title) add("missing_title", p.url, {});
    else {
      if (p.title.length < 15 || p.title.length > 65) add("title_length", p.url, { title: p.title, length: p.title.length });
      const dupes = titleGroups.get(p.title.trim().toLowerCase());
      if (dupes && dupes.length > 1 && !noindex && selfCanonical) add("duplicate_title", p.url, { title: p.title, alsoOn: dupes.filter((u) => u !== p.url).slice(0, 10), count: dupes.length });
    }
    if (p.titleCount > 1) add("multiple_titles", p.url, { count: p.titleCount });
    if (!p.metaDescription) add("missing_meta_description", p.url, {});
    else {
      if (p.metaDescription.length < 70 || p.metaDescription.length > 160) add("meta_description_length", p.url, { description: p.metaDescription, length: p.metaDescription.length });
      const dupes = descGroups.get(p.metaDescription.trim().toLowerCase());
      if (dupes && dupes.length > 1 && !noindex && selfCanonical) add("duplicate_meta_description", p.url, { description: p.metaDescription, alsoOn: dupes.filter((u) => u !== p.url).slice(0, 10), count: dupes.length });
    }
    if (p.h1.length === 0) add("missing_h1", p.url, {});
    else if (p.h1.length > 1) add("multiple_h1", p.url, { h1: p.h1 });
    const skips: string[] = [];
    let prev = 0;
    for (const h of p.headings) {
      if (prev && h.level > prev + 1) skips.push(`H${prev} → H${h.level} ("${h.text.slice(0, 60)}")`);
      prev = h.level;
    }
    if (skips.length) add("heading_hierarchy", p.url, { skips: skips.slice(0, 10) });

    // ── Content
    if (!noindex && selfCanonical) {
      const dupes = p.contentHash ? hashGroups.get(p.contentHash) : null;
      if (dupes && dupes.length > 1) add("duplicate_content", p.url, { alsoOn: dupes.filter((u) => u !== p.url).slice(0, 10), wordCount: p.wordCount });
      if (p.wordCount < 200 && p.url !== home && p.scriptCount < 8) add("thin_content", p.url, { wordCount: p.wordCount });
    }
    if (p.render) {
      // Rendered crawl: compare what crawlers that don't run JavaScript would see with the rendered page.
      const raw = p.render.raw;
      const missing: string[] = [];
      if (p.wordCount >= 50 && raw.wordCount < p.wordCount * 0.5) missing.push(`${raw.wordCount} of ${p.wordCount} words`);
      if (!raw.title && p.title) missing.push("title");
      if (!raw.h1 && p.h1.length) missing.push("H1");
      if (missing.length) add("content_requires_js", p.url, { rawWords: raw.wordCount, renderedWords: p.wordCount, rawLinks: raw.links, missingWithoutJs: missing, pageErrors: p.render.pageErrors });
    } else if (p.wordCount < 50 && p.scriptCount >= 8) add("js_rendering_suspected", p.url, { wordCount: p.wordCount, externalScripts: p.scriptCount });

    // ── Links on this page
    const outs = linksFrom.get(p.url) ?? [];
    const brokenInternal = outs.filter((l) => l.isInternal && l.statusCode != null && l.statusCode >= 400);
    if (brokenInternal.length) add("broken_internal_link", p.url, { links: brokenInternal.slice(0, 20).map((l) => ({ href: l.toUrl, anchor: l.anchor, status: l.statusCode })), count: brokenInternal.length });
    const brokenExternal = outs.filter((l) => !l.isInternal && r.externalChecks.has(l.toUrl) && (() => { const c = r.externalChecks.get(l.toUrl)!; return c.status == null || c.status >= 400; })());
    // 401/403/429 from external sites are often bot protection, not breakage.
    const reallyBroken = brokenExternal.filter((l) => { const c = r.externalChecks.get(l.toUrl)!; return c.status == null ? true : ![401, 403, 429, 999].includes(c.status); });
    if (reallyBroken.length) add("broken_external_link", p.url, { links: reallyBroken.slice(0, 20).map((l) => ({ href: l.toUrl, anchor: l.anchor, status: r.externalChecks.get(l.toUrl)?.status, error: r.externalChecks.get(l.toUrl)?.error })), count: reallyBroken.length });

    // ── Images
    const noAlt = p.images.filter((i) => i.alt == null);
    if (noAlt.length) add("image_missing_alt", p.url, { images: noAlt.slice(0, 15).map((i) => i.src), count: noAlt.length });
    const noDims = p.images.filter((i) => !i.width || !i.height);
    if (noDims.length) add("image_missing_dimensions", p.url, { images: noDims.slice(0, 15).map((i) => i.src), count: noDims.length });
    const big = p.images.map((i) => r.imageChecks.get(i.src)).filter((c) => c && c.bytes && c.bytes > 300 * 1024);
    if (big.length) add("oversized_image", p.url, { images: big.slice(0, 10).map((c) => ({ src: c!.url, kb: Math.round(c!.bytes! / 1024) })) });
    const brokenImgs = p.images.map((i) => r.imageChecks.get(i.src)).filter((c) => c && (c.status == null || c.status >= 400));
    if (brokenImgs.length) add("broken_image", p.url, { images: brokenImgs.slice(0, 10).map((c) => ({ src: c!.url, status: c!.status, error: c!.error })) });

    // ── Structured data
    const invalid = p.structuredData.filter((s) => !s.valid);
    if (invalid.length) add("schema_invalid_json", p.url, { errors: invalid.map((s) => s.error) });
    const schemaErrors = p.structuredData.filter((s) => s.valid && s.data).flatMap((s) => validateStructuredData(s.data).filter((i) => i.severity === "error"));
    if (schemaErrors.length) add("schema_missing_required", p.url, { errors: schemaErrors.slice(0, 15).map((e) => e.message), types: [...new Set(schemaErrors.map((e) => e.type))] });

    // ── Security / mobile / performance
    if (p.url.startsWith("http:")) add("not_https", p.url, {});
    if (p.mixedContent.length) add("mixed_content", p.url, { resources: p.mixedContent.slice(0, 15), count: p.mixedContent.length });
    if (!p.hasViewport) add("missing_viewport", p.url, {});
    if (p.responseTimeMs != null && p.responseTimeMs > 1500) add("slow_response", p.url, { responseTimeMs: p.responseTimeMs, note: "Single lab fetch from the crawler" });
    if (!p.lang) add("missing_lang", p.url, {});

    // ── Pagination
    for (const rel of [p.relNext, p.relPrev]) {
      if (!rel) continue;
      const s = statusOf(rel);
      if (s != null && s !== 200) add("pagination_broken", p.url, { target: rel, status: s }, rel);
    }

    // ── hreflang
    if (p.hreflang.length) {
      const bad = p.hreflang.filter((h) => !HREFLANG_RE.test(h.lang));
      if (bad.length) add("hreflang_invalid_code", p.url, { values: bad });
      if (!p.hreflang.some((h) => normalizeUrl(h.href) === p.url)) add("hreflang_missing_self", p.url, { alternates: p.hreflang.slice(0, 20) });
      const missingReturn: string[] = [];
      const non200: { href: string; status: number | null }[] = [];
      for (const h of p.hreflang) {
        const target = normalizeUrl(h.href);
        if (!target || target === p.url) continue;
        const tp = byUrl.get(target);
        if (!tp) continue;
        if (tp.statusCode !== 200) non200.push({ href: target, status: tp.statusCode });
        else if (!tp.hreflang.some((x) => normalizeUrl(x.href) === p.url)) missingReturn.push(target);
      }
      if (missingReturn.length) add("hreflang_missing_return", p.url, { alternatesWithoutReturn: missingReturn.slice(0, 20) });
      if (non200.length) add("hreflang_to_non_200", p.url, { targets: non200.slice(0, 20) });
    }

    // ── Internal link support
    if (!noindex && selfCanonical && p.url !== home) {
      if (p.inlinks === 0 && p.inSitemap) add("orphan_page", p.url, { inSitemap: true, inlinks: 0 });
      else if (p.inlinks > 0 && (p.inlinks <= 1 || p.depth > 4)) add("weak_internal_links", p.url, { inlinks: p.inlinks, depth: p.depth, linkedFrom: linksTo.get(p.url)?.slice(0, 5) });
    }
  }

  // Orphans: sitemap URLs never reached via links and not crawled as part of discovery
  for (const u of sitemapSet) {
    const p = byUrl.get(u);
    if (p && p.inlinks === 0 && p.statusCode === 200 && u !== home && !out.some((f) => f.url === u && f.issueType === "orphan_page")) {
      if (isIndexable(p)) add("orphan_page", u, { inSitemap: true, inlinks: 0 });
    }
  }

  // Near duplicates (bounded O(n²) on indexable pages with enough text)
  const candidates = indexable.filter((p) => p.simhash && p.wordCount >= 150).slice(0, 1500);
  const reported = new Set<string>();
  for (let i = 0; i < candidates.length; i++) {
    const near: string[] = [];
    for (let j = 0; j < candidates.length; j++) {
      if (i === j || candidates[i].contentHash === candidates[j].contentHash) continue;
      if (hamming(candidates[i].simhash!, candidates[j].simhash!) <= 3) near.push(candidates[j].url);
    }
    if (near.length && !reported.has(candidates[i].url)) {
      reported.add(candidates[i].url);
      add("near_duplicate", candidates[i].url, { similarTo: near.slice(0, 10) });
    }
  }

  return out;
}

export const SEVERITY_WEIGHT = { CRITICAL: 10, HIGH: 5, MEDIUM: 2, LOW: 0.5, INFO: 0 } as const;
const PAGE_PENALTY = { CRITICAL: 40, HIGH: 20, MEDIUM: 8, LOW: 2, INFO: 0 } as const;
const SITE_PENALTY = { CRITICAL: 25, HIGH: 10, MEDIUM: 5, LOW: 2, INFO: 0 } as const;

export const HEALTH_FORMULA =
  "Each crawled HTML page starts at 100 and loses 40/20/8/2 points per critical/high/medium/low issue (floor 0). " +
  "Site health = average page score − 25/10/5/2 per site-level (robots/sitemap) issue, floor 0. Internal score, not a Google metric.";

/** Internal health score (0–100), see HEALTH_FORMULA. */
export function healthScore(findings: RawFinding[], htmlPageUrls: string[] | number): number {
  const urls = typeof htmlPageUrls === "number" ? null : new Set(htmlPageUrls);
  const pageCount = urls ? urls.size : (htmlPageUrls as number);
  if (pageCount === 0) return 0;
  const perPage = new Map<string, number>();
  let sitePenalty = 0;
  for (const f of findings) {
    const sev = ISSUES[f.issueType].severity;
    if (urls && !urls.has(f.url)) {
      // Findings on non-HTML URLs (robots.txt, sitemap, redirects, 4xx targets) count as site-level.
      sitePenalty += SITE_PENALTY[sev] / (urls.size > 20 ? 4 : 1);
      continue;
    }
    perPage.set(f.url, (perPage.get(f.url) ?? 0) + PAGE_PENALTY[sev]);
  }
  let total = 0;
  if (urls) for (const u of urls) total += Math.max(0, 100 - (perPage.get(u) ?? 0));
  else total = pageCount * 100 - [...perPage.values()].reduce((s, v) => s + Math.min(100, v), 0);
  const score = Math.max(0, total / pageCount - Math.min(60, sitePenalty));
  return Math.round(score * 10) / 10;
}

export { isIndexable };

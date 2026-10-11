import { safeFetch, type RedirectHop } from "@/lib/net/safe-fetch";
import { UnsafeUrlError } from "@/lib/net/ssrf";
import { normalizeUrl } from "@/lib/url";
import { parseRobots, isAllowed, groupFor, type ParsedRobots } from "./robots";
import { loadSitemaps, type SitemapResult } from "./sitemap";
import { parseHtml, type ParsedPage, type StructuredDataItem, type Heading, type ParsedImage } from "./parse";

export interface CrawlOptions {
  baseUrl: string;
  maxPages: number;
  maxDepth: number;
  delayMs: number;
  concurrency: number;
  includePatterns: string[];
  excludePatterns: string[];
  userAgent: string;
  checkExternalLinks: boolean;
  allowPrivate?: boolean;
  /** Incremental mode: only these URLs are fetched (no link discovery beyond them). */
  incrementalSeeds?: string[];
  maxExternalChecks?: number;
  maxImageChecks?: number;
  onProgress?: (p: { crawled: number; discovered: number; message: string }) => Promise<void> | void;
  isCancelled?: () => Promise<boolean>;
}

export interface CrawledPageRecord {
  url: string;
  finalUrl: string | null;
  /** Status of the final hop when the URL redirects. */
  finalStatus?: number | null;
  statusCode: number | null;
  contentType: string | null;
  redirectChain: RedirectHop[];
  responseTimeMs: number | null;
  bytes: number | null;
  depth: number;
  blockedByRobots: boolean;
  robotsRule?: string;
  xRobotsTag: string | null;
  error: string | null;
  inSitemap: boolean;
  isHtml: boolean;
  // Parsed fields (HTML only)
  title: string | null;
  titleCount: number;
  metaDescription: string | null;
  metaDescriptionCount: number;
  robotsMeta: string | null;
  canonical: string | null;
  canonicalCount: number;
  lang: string | null;
  hasViewport: boolean;
  headings: Heading[];
  h1: string[];
  images: ParsedImage[];
  hreflang: { lang: string; href: string }[];
  relNext: string | null;
  relPrev: string | null;
  structuredData: StructuredDataItem[];
  mixedContent: string[];
  wordCount: number;
  textSample: string;
  contentHash: string | null;
  simhash: string | null;
  scriptCount: number;
  outlinks: number;
  inlinks: number;
}

export interface CrawlLinkRecord {
  fromUrl: string;
  toUrl: string;
  anchor: string;
  rel: string;
  isInternal: boolean;
  statusCode?: number | null;
}

export interface ResourceCheck {
  url: string;
  status: number | null;
  bytes: number | null;
  error?: string;
  finalUrl?: string;
}

export interface CrawlResult {
  baseUrl: string;
  host: string;
  pages: CrawledPageRecord[];
  links: CrawlLinkRecord[];
  robots: { status: number | null; fetched: boolean; parsed: ParsedRobots | null; error?: string; crawlDelay?: number };
  sitemap: SitemapResult;
  externalChecks: Map<string, ResourceCheck>;
  imageChecks: Map<string, ResourceCheck>;
  limitReached: boolean;
  cancelled: boolean;
  startedAt: Date;
  finishedAt: Date;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function siteHosts(baseUrl: string) {
  const host = new URL(baseUrl).hostname.toLowerCase();
  const bare = host.replace(/^www\./, "");
  return new Set([bare, `www.${bare}`]);
}

function matchesPatterns(url: string, include: string[], exclude: string[]) {
  const path = (() => { try { const u = new URL(url); return u.pathname + u.search; } catch { return url; } })();
  if (exclude.some((p) => path.startsWith(p) || url.includes(p))) return false;
  if (include.length && !include.some((p) => path.startsWith(p) || url.includes(p))) return false;
  return true;
}

function emptyRecord(url: string, depth: number, inSitemap: boolean): CrawledPageRecord {
  return {
    url, finalUrl: null, statusCode: null, contentType: null, redirectChain: [], responseTimeMs: null, bytes: null, depth,
    blockedByRobots: false, xRobotsTag: null, error: null, inSitemap, isHtml: false, title: null, titleCount: 0,
    metaDescription: null, metaDescriptionCount: 0, robotsMeta: null, canonical: null, canonicalCount: 0, lang: null,
    hasViewport: false, headings: [], h1: [], images: [], hreflang: [], relNext: null, relPrev: null, structuredData: [],
    mixedContent: [], wordCount: 0, textSample: "", contentHash: null, simhash: null, scriptCount: 0, outlinks: 0, inlinks: 0,
  };
}

export async function crawlSite(opts: CrawlOptions): Promise<CrawlResult> {
  const startedAt = new Date();
  const base = new URL(opts.baseUrl);
  const hosts = siteHosts(opts.baseUrl);
  const origin = `${base.protocol}//${base.host}`;
  const headers = { "user-agent": opts.userAgent, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "accept-language": "en;q=0.9,*;q=0.5" };
  const isInternal = (u: string) => { try { return hosts.has(new URL(u).hostname.toLowerCase()); } catch { return false; } };

  // 1) robots.txt
  const robots: CrawlResult["robots"] = { status: null, fetched: false, parsed: null };
  try {
    const r = await safeFetch(`${origin}/robots.txt`, { headers, maxBytes: 512 * 1024, allowPrivate: opts.allowPrivate });
    robots.status = r.status;
    robots.fetched = true;
    if (r.status === 200) robots.parsed = parseRobots(r.body);
    // 4xx = no restrictions (per RFC 9309); 5xx = treat as full disallow.
    if (r.status >= 500) robots.parsed = parseRobots("User-agent: *\nDisallow: /");
  } catch (err) {
    robots.error = (err as Error).message;
    if (err instanceof UnsafeUrlError) throw err;
  }
  const group = robots.parsed ? groupFor(robots.parsed, opts.userAgent) : null;
  robots.crawlDelay = group?.crawlDelay;
  const delayMs = Math.max(opts.delayMs, Math.min(30_000, (group?.crawlDelay ?? 0) * 1000));

  // 2) sitemaps (robots-declared + /sitemap.xml)
  const sitemapSeeds = [...(robots.parsed?.sitemaps ?? []), `${origin}/sitemap.xml`].filter((s) => {
    try { return isInternal(s); } catch { return false; }
  });
  const sitemap = await loadSitemaps(sitemapSeeds, { maxUrls: Math.max(opts.maxPages * 3, 1000), headers, allowPrivate: opts.allowPrivate });
  const sitemapUrls = new Set(sitemap.urls.map((u) => normalizeUrl(u.loc)).filter(Boolean) as string[]);

  // 3) frontier
  const pages = new Map<string, CrawledPageRecord>();
  const links: CrawlLinkRecord[] = [];
  const queued = new Set<string>();
  const queue: { url: string; depth: number }[] = [];
  const enqueue = (url: string, depth: number) => {
    if (queued.has(url) || queued.size >= opts.maxPages * 4) return;
    if (!isInternal(url) || !matchesPatterns(url, opts.includePatterns, opts.excludePatterns)) return;
    queued.add(url);
    queue.push({ url, depth });
  };
  const incremental = Boolean(opts.incrementalSeeds?.length);
  if (incremental) {
    for (const u of opts.incrementalSeeds!) { const n = normalizeUrl(u); if (n) enqueue(n, 0); }
  } else {
    enqueue(normalizeUrl(base.toString())!, 0);
    for (const u of sitemapUrls) enqueue(u, 1);
  }

  let nextSlot = 0;
  let limitReached = false;
  let cancelled = false;
  let lastProgress = 0;

  async function politeWait() {
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + delayMs;
    if (wait) await sleep(wait);
  }

  async function fetchPage(url: string, depth: number) {
    const rec = emptyRecord(url, depth, sitemapUrls.has(url));
    pages.set(url, rec);
    const allowed = isAllowed(robots.parsed, opts.userAgent, url);
    if (!allowed.allowed) {
      rec.blockedByRobots = true;
      rec.robotsRule = allowed.rule;
      return;
    }
    await politeWait();
    try {
      const res = await safeFetch(url, { headers, maxRedirects: 10, allowPrivate: opts.allowPrivate });
      rec.statusCode = res.status;
      rec.redirectChain = res.redirects;
      rec.responseTimeMs = res.timeMs;
      rec.bytes = res.bytes;
      rec.contentType = res.headers.get("content-type");
      rec.xRobotsTag = res.headers.get("x-robots-tag")?.toLowerCase() ?? null;
      if (res.redirects.length) {
        // A redirecting URL is recorded as a redirect; its destination is crawled as its own URL.
        rec.statusCode = res.redirects[0].status;
        rec.finalUrl = res.finalUrl;
        rec.finalStatus = res.status;
        const dest = normalizeUrl(res.finalUrl);
        if (dest && !incremental && depth <= opts.maxDepth) enqueue(dest, depth);
        return;
      }
      rec.isHtml = /text\/html|application\/xhtml/i.test(rec.contentType ?? "");
      if (!rec.isHtml || res.status >= 400 || !res.body) return;
      const parsed: ParsedPage = parseHtml(res.body, res.finalUrl);
      Object.assign(rec, {
        title: parsed.title, titleCount: parsed.titleCount, metaDescription: parsed.metaDescription,
        metaDescriptionCount: parsed.metaDescriptionCount, robotsMeta: parsed.robotsMeta, canonical: parsed.canonical,
        canonicalCount: parsed.canonicalCount, lang: parsed.lang, hasViewport: parsed.hasViewport, headings: parsed.headings,
        h1: parsed.h1, images: parsed.images.slice(0, 200), hreflang: parsed.hreflang, relNext: parsed.relNext, relPrev: parsed.relPrev,
        structuredData: parsed.structuredData, mixedContent: parsed.mixedContent, wordCount: parsed.wordCount,
        textSample: parsed.paragraphs.join("\n").slice(0, 12000) || parsed.text.slice(0, 4000),
        contentHash: parsed.contentHash, simhash: parsed.simhash, scriptCount: parsed.scriptCount,
      });
      const seen = new Set<string>();
      for (const l of parsed.links) {
        const internal = isInternal(l.href);
        const key = `${l.href}|${l.anchor}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ fromUrl: url, toUrl: l.href, anchor: l.anchor, rel: l.rel, isInternal: internal });
        if (internal && !l.nofollow && !incremental && depth + 1 <= opts.maxDepth) enqueue(l.href, depth + 1);
      }
      rec.outlinks = seen.size;
    } catch (err) {
      rec.error = err instanceof UnsafeUrlError ? `Blocked for safety: ${err.message}` : (err as Error).message.slice(0, 300);
    }
  }

  // Worker pool
  let crawled = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(4, opts.concurrency)) }, async () => {
    while (queue.length) {
      if (pages.size >= opts.maxPages) { limitReached = true; return; }
      if (opts.isCancelled && crawled % 10 === 0 && (await opts.isCancelled())) { cancelled = true; queue.length = 0; return; }
      const next = queue.shift()!;
      await fetchPage(next.url, next.depth);
      crawled++;
      if (opts.onProgress && Date.now() - lastProgress > 1500) {
        lastProgress = Date.now();
        await opts.onProgress({ crawled, discovered: queued.size, message: `Crawled ${crawled} of ${Math.min(queued.size, opts.maxPages)} discovered URLs` });
      }
    }
  });
  await Promise.all(workers);
  if (queue.length && pages.size >= opts.maxPages) limitReached = true;

  // Inlinks (unique source pages per target)
  const inlinkSources = new Map<string, Set<string>>();
  for (const l of links) {
    if (!l.isInternal || l.fromUrl === l.toUrl) continue;
    const s = inlinkSources.get(l.toUrl) ?? new Set();
    s.add(l.fromUrl);
    inlinkSources.set(l.toUrl, s);
  }
  for (const p of pages.values()) p.inlinks = inlinkSources.get(p.url)?.size ?? 0;
  for (const l of links) if (l.isInternal) l.statusCode = pages.get(l.toUrl)?.statusCode ?? null;

  // External link checks (HEAD, fall back to GET when HEAD is refused)
  const externalChecks = new Map<string, ResourceCheck>();
  if (opts.checkExternalLinks && !cancelled) {
    const targets = [...new Set(links.filter((l) => !l.isInternal).map((l) => l.toUrl))].slice(0, opts.maxExternalChecks ?? 300);
    await opts.onProgress?.({ crawled, discovered: queued.size, message: `Checking ${targets.length} outbound links` });
    await pool(targets, 4, async (u) => externalChecks.set(u, await checkResource(u, headers, opts.allowPrivate)));
    for (const l of links) if (!l.isInternal) l.statusCode = externalChecks.get(l.toUrl)?.status ?? null;
  }

  // Image checks: status + size for internal images
  const imageChecks = new Map<string, ResourceCheck>();
  if (!cancelled) {
    const imgs = [...new Set([...pages.values()].flatMap((p) => p.images.map((i) => i.src)).filter(isInternal))].slice(0, opts.maxImageChecks ?? 200);
    if (imgs.length) await opts.onProgress?.({ crawled, discovered: queued.size, message: `Checking ${imgs.length} images` });
    await pool(imgs, 3, async (u) => { await politeWait(); imageChecks.set(u, await checkResource(u, headers, opts.allowPrivate, true)); });
  }

  return {
    baseUrl: opts.baseUrl, host: base.hostname, pages: [...pages.values()], links, robots, sitemap, externalChecks, imageChecks,
    limitReached, cancelled, startedAt, finishedAt: new Date(),
  };
}

async function checkResource(url: string, headers: Record<string, string>, allowPrivate?: boolean, measureSize = false): Promise<ResourceCheck> {
  try {
    let r = await safeFetch(url, { method: "HEAD", headers, timeoutMs: 12_000, allowPrivate });
    const noLength = r.status < 400 && !r.headers.get("content-length") && measureSize;
    if (r.status === 405 || r.status === 403 || r.status === 501 || noLength) r = await safeFetch(url, { headers, timeoutMs: 12_000, maxBytes: 2 * 1024 * 1024, allowPrivate });
    const len = Number(r.headers.get("content-length"));
    return { url, status: r.status, bytes: Number.isFinite(len) && len > 0 ? len : r.bytes || null, finalUrl: r.finalUrl };
  } catch (err) {
    return { url, status: null, bytes: null, error: (err as Error).message.slice(0, 200) };
  }
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<unknown>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

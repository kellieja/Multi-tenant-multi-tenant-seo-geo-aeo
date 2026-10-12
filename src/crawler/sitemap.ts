import { gunzipSync } from "node:zlib";
import * as cheerio from "cheerio";
import { safeFetch } from "@/lib/net/safe-fetch";

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
  sitemap: string;
}

export interface SitemapResult {
  urls: SitemapUrl[];
  sitemaps: { url: string; status: number | null; urlCount: number; error?: string; isIndex: boolean }[];
  truncated: boolean;
}

/**
 * Fetches and expands sitemaps (sitemap indexes, gzip) up to `maxUrls`.
 * Each fetch goes through the SSRF-safe client.
 */
export async function loadSitemaps(
  seeds: string[],
  opts: { maxUrls: number; maxSitemaps?: number; headers?: Record<string, string>; allowPrivate?: boolean },
): Promise<SitemapResult> {
  const queue = [...new Set(seeds)];
  const seen = new Set<string>();
  const result: SitemapResult = { urls: [], sitemaps: [], truncated: false };
  const maxSitemaps = opts.maxSitemaps ?? 50;

  while (queue.length && result.sitemaps.length < maxSitemaps) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const res = await safeFetch(url, { headers: opts.headers, maxBytes: 50 * 1024 * 1024, timeoutMs: 30_000, allowPrivate: opts.allowPrivate });
      if (res.status !== 200) {
        result.sitemaps.push({ url, status: res.status, urlCount: 0, isIndex: false, error: `HTTP ${res.status}` });
        continue;
      }
      let body = res.body;
      if (url.endsWith(".gz") || res.headers.get("content-type")?.includes("gzip")) {
        try { body = gunzipSync(res.raw).toString("utf8"); } catch { /* served already-decoded */ }
      }
      const $ = cheerio.load(body, { xml: true });
      const isIndex = $("sitemapindex").length > 0;
      if (isIndex) {
        const children = $("sitemap > loc").map((_, el) => $(el).text().trim()).get();
        queue.push(...children);
        result.sitemaps.push({ url, status: 200, urlCount: children.length, isIndex: true });
        continue;
      }
      const locs = $("url").map((_, el) => ({ loc: $(el).find("loc").first().text().trim(), lastmod: $(el).find("lastmod").first().text().trim() || undefined })).get();
      if (!$("urlset").length) {
        result.sitemaps.push({ url, status: 200, urlCount: 0, isIndex: false, error: "Not a valid XML sitemap (no <urlset> or <sitemapindex>)" });
        continue;
      }
      result.sitemaps.push({ url, status: 200, urlCount: locs.length, isIndex: false });
      for (const l of locs) {
        if (!l.loc) continue;
        if (result.urls.length >= opts.maxUrls) { result.truncated = true; break; }
        result.urls.push({ ...l, sitemap: url });
      }
    } catch (err) {
      result.sitemaps.push({ url, status: null, urlCount: 0, isIndex: false, error: (err as Error).message });
    }
  }
  return result;
}

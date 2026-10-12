import { prisma } from "@/lib/db/client";
import { fetchHtmlPolitely, userAgent } from "@/lib/net/polite-fetch";
import { createRenderer, type PageRenderer } from "@/crawler/render";

/** Whether the site's latest successful crawl found that its content needs JavaScript rendering. */
export async function siteNeedsRendering(websiteId: string) {
  const crawl = await prisma.crawl.findFirst({ where: { websiteId, status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" }, select: { summary: true } });
  return Boolean((crawl?.summary as { rendering?: { active?: boolean } } | null)?.rendering?.active);
}

export interface SitePageFetcher {
  /** Robots-aware fetch of one page; returns rendered HTML on JavaScript sites. */
  get(url: string): Promise<{ html: string; finalUrl: string; rendered: boolean }>;
  close(): Promise<void>;
}

/**
 * Page fetcher for worker jobs (AEO assessment, internal-link checks) that matches what the
 * crawler saw: raw HTML for ordinary sites, rendered DOM for single-page apps. The renderer is
 * started once per job and reused. If Chromium isn't available it falls back to raw HTML.
 */
export async function openSitePageFetcher(websiteId: string, opts: { rendererFactory?: () => Promise<PageRenderer> } = {}): Promise<SitePageFetcher> {
  let renderer: PageRenderer | null = null;
  if (await siteNeedsRendering(websiteId)) {
    try {
      renderer = await (opts.rendererFactory ?? (() => createRenderer({ userAgent: userAgent() })))();
    } catch (err) {
      console.warn("[page-fetch] rendering unavailable, using raw HTML:", (err as Error).message);
    }
  }
  return {
    async get(url) {
      const res = await fetchHtmlPolitely(url);
      if (!renderer) return { html: res.body, finalUrl: res.finalUrl, rendered: false };
      const r = await renderer.render(res.finalUrl);
      return { html: r.html, finalUrl: res.finalUrl, rendered: true };
    },
    async close() { await renderer?.close(); },
  };
}

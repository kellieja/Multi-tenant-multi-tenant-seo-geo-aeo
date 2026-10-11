import { getOrgContextOrThrow } from "@/lib/auth/context";
import { csvResponse } from "@/lib/csv";
import { httpStatusFor } from "@/lib/errors";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getOrgContextOrThrow();
    const { id } = await params;
    const crawl = await ctx.db.crawl.findUnique({ where: { id }, include: { website: { select: { domain: true } } } });
    if (!crawl || (ctx.websiteScope && !ctx.websiteScope.includes(crawl.websiteId))) return Response.json({ error: "Not found" }, { status: 404 });
    const pages = await ctx.db.crawledPage.findMany({ where: { crawlId: id }, orderBy: { url: "asc" } });
    return csvResponse(
      [["url", "status", "final_url", "indexable", "indexability_reason", "title", "meta_description", "h1", "canonical", "word_count", "inlinks", "outlinks", "depth", "in_sitemap", "response_ms", "carried_forward"],
        ...pages.map((p) => [p.url, p.statusCode, p.finalUrl, p.indexable, p.indexabilityReason, p.title, p.metaDescription, p.h1.join(" | "), p.canonical, p.wordCount, p.inlinks, p.outlinks, p.depth, p.inSitemap, p.responseTimeMs, p.carriedForward])],
      `crawl_${crawl.website.domain}_${crawl.createdAt.toISOString().slice(0, 10)}.csv`,
    );
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: httpStatusFor(err) });
  }
}

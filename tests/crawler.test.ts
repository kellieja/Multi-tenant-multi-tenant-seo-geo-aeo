import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crawlSite } from "@/crawler/crawl";
import { runAudit, healthScore } from "@/audit/rules";
import { parseRobots, isAllowed } from "@/crawler/robots";
import { validateStructuredData } from "@/audit/schema";
import { scoreFinding } from "@/audit/priority";
import { fixtureSite } from "./fixtures/site";

const site = fixtureSite();
beforeAll(async () => { await site.start(); });
afterAll(async () => { await site.stop(); });

const opts = () => ({
  baseUrl: site.origin, maxPages: 100, maxDepth: 5, delayMs: 0, concurrency: 2, includePatterns: [], excludePatterns: [],
  userAgent: "SearchOpsBot/1.0", checkExternalLinks: false, allowPrivate: true,
});

describe("robots.txt", () => {
  it("applies longest-match with Allow winning ties and wildcard/anchor support", () => {
    const r = parseRobots("User-agent: *\nDisallow: /shop\nAllow: /shop/public\nDisallow: /*.pdf$\n\nUser-agent: searchopsbot\nDisallow: /bots-only\n");
    expect(isAllowed(r, "Googlebot", "https://x.com/shop/cart").allowed).toBe(false);
    expect(isAllowed(r, "Googlebot", "https://x.com/shop/public/a").allowed).toBe(true);
    expect(isAllowed(r, "Googlebot", "https://x.com/files/a.pdf").allowed).toBe(false);
    expect(isAllowed(r, "Googlebot", "https://x.com/files/a.pdf?x=1").allowed).toBe(true);
    // Specific group replaces the * group for our bot
    expect(isAllowed(r, "SearchOpsBot/1.0", "https://x.com/shop/cart").allowed).toBe(true);
    expect(isAllowed(r, "SearchOpsBot/1.0", "https://x.com/bots-only").allowed).toBe(false);
  });
});

describe("crawler + audit against a live fixture site", () => {
  it("discovers pages, respects robots.txt and produces evidence-backed findings", async () => {
    const result = await crawlSite(opts());
    const urls = result.pages.map((p) => p.url.replace(site.origin, ""));
    expect(urls).toEqual(expect.arrayContaining(["/", "/about", "/services", "/orphan", "/noindexed", "/missing", "/old-page", "/es/"]));
    // Disallowed URL is recorded but never requested
    expect(result.pages.find((p) => p.url.endsWith("/private/secret"))?.blockedByRobots).toBe(true);
    expect(site.state.requests).not.toContain("/private/secret");

    const findings = runAudit(result);
    const has = (type: string, path: string) => findings.some((f) => f.issueType === type && f.url === `${site.origin}${path}`);
    expect(has("http_4xx", "/missing")).toBe(true);
    expect(has("broken_internal_link", "/")).toBe(true);
    expect(has("redirect_chain", "/old-page")).toBe(true);
    expect(has("internal_link_to_redirect", "/old-page")).toBe(true);
    expect(has("sitemap_non_200", "/old-page")).toBe(true);
    expect(has("duplicate_title", "/about")).toBe(true);
    expect(has("duplicate_title", "/services")).toBe(true);
    expect(has("missing_meta_description", "/about")).toBe(true);
    expect(has("missing_title", "/thin")).toBe(true);
    expect(has("thin_content", "/thin")).toBe(true);
    expect(has("sitemap_noindex", "/noindexed")).toBe(true);
    expect(has("orphan_page", "/orphan")).toBe(true);
    expect(has("heading_hierarchy", "/about")).toBe(true);
    expect(has("schema_missing_required", "/services")).toBe(true);
    expect(has("image_missing_alt", "/")).toBe(true);
    expect(has("oversized_image", "/")).toBe(true);
    expect(has("broken_image", "/")).toBe(true);
    expect(has("hreflang_missing_return", "/es/")).toBe(true);
    expect(has("sitemap_blocked", "/private/secret")).toBe(true);
    expect(has("not_https", "/")).toBe(true);
    // Evidence is attached
    const chain = findings.find((f) => f.issueType === "redirect_chain")!;
    expect((chain.evidence.hops as unknown[]).length).toBe(2);
    const score = healthScore(findings, result.pages.filter((p) => p.isHtml && p.statusCode === 200).map((p) => p.url));
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThan(100);
  });

  it("honours the max page limit", async () => {
    const result = await crawlSite({ ...opts(), maxPages: 3 });
    expect(result.pages.length).toBeLessThanOrEqual(3);
    expect(result.limitReached).toBe(true);
  });

  it("refuses private addresses unless explicitly allowed", async () => {
    await expect(crawlSite({ ...opts(), allowPrivate: false })).rejects.toThrow(/Blocked/);
  });
});

describe("structured data + priority", () => {
  it("flags missing required properties", () => {
    expect(validateStructuredData({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "Q?" }] }).some((i) => /acceptedAnswer/.test(i.message))).toBe(true);
    expect(validateStructuredData({ "@context": "https://schema.org", "@type": "Product", name: "W", offers: { "@type": "Offer", price: "1", priceCurrency: "USD", availability: "x" }, image: "i", description: "d", brand: "b" })).toEqual([]);
  });
  it("explains every priority factor and ranks severe, high-traffic issues higher", () => {
    const a = scoreFinding({ issueType: "http_5xx", affectedPages: 5, impressions: 5000, depth: 1, inlinks: 20, isHomepage: false });
    const b = scoreFinding({ issueType: "missing_lang", affectedPages: 1, impressions: 0, depth: 6, inlinks: 0, isHomepage: false });
    expect(a.score).toBeGreaterThan(b.score);
    expect(a.factors.map((f) => f.key)).toEqual(["severity", "reach", "business", "traffic", "confidence", "effort"]);
    const noGsc = scoreFinding({ issueType: "http_5xx", affectedPages: 5, impressions: null, depth: 1, inlinks: 20, isHomepage: false });
    expect(noGsc.factors.find((f) => f.key === "traffic")!.explanation).toMatch(/not connected/);
  });
});

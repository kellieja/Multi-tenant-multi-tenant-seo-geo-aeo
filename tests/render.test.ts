import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crawlSite } from "@/crawler/crawl";
import { createRenderer, needsRendering } from "@/crawler/render";
import { runAudit } from "@/audit/rules";
import { spaSite } from "./fixtures/spa";
import { fixtureSite } from "./fixtures/site";

// Locally, point CHROMIUM_PATH (or PW_CHROMIUM_PATH) at a Chromium binary; CI installs one with Playwright.
if (!process.env.CHROMIUM_PATH && process.env.PW_CHROMIUM_PATH) process.env.CHROMIUM_PATH = process.env.PW_CHROMIUM_PATH;

const spa = spaSite();
const ssr = fixtureSite();
beforeAll(async () => { process.env.ALLOW_PRIVATE_NETWORK_FETCH = "true"; await spa.start(); await ssr.start(); });
afterAll(async () => { await spa.stop(); await ssr.stop(); process.env.ALLOW_PRIVATE_NETWORK_FETCH = "false"; });

const base = { maxPages: 10, maxDepth: 3, delayMs: 0, concurrency: 2, includePatterns: [], excludePatterns: [], userAgent: "SearchOpsBot/1.0 (test)", checkExternalLinks: false, allowPrivate: true };

describe("rendering decision", () => {
  it("only asks for rendering when content appears after JavaScript", () => {
    expect(needsRendering({ wordCount: 3, links: 0, title: null, h1: 0 }, { wordCount: 120, links: 8, title: "T", h1: 1 }).required).toBe(true);
    expect(needsRendering({ wordCount: 400, links: 30, title: "T", h1: 1 }, { wordCount: 420, links: 31, title: "T", h1: 1 }).required).toBe(false);
  });
});

describe("JavaScript rendering crawl", () => {
  it("detects a client-rendered app, crawls its rendered routes and flags the JS dependence", async () => {
    const r = await crawlSite({ ...base, baseUrl: spa.origin, render: "auto" });
    expect(r.rendering.error).toBeUndefined();
    expect(r.rendering.active).toBe(true);
    expect(r.rendering.probe?.raw.wordCount).toBeLessThan(5);
    const pricing = r.pages.find((p) => p.url === `${spa.origin}/pricing`);
    expect(pricing?.title).toBe("Widget repair pricing | Acme"); // discovered through a JS-built link
    expect(pricing?.h1).toEqual(["Pricing"]);
    expect(pricing?.wordCount).toBeGreaterThan(30);
    expect(pricing?.render?.raw.wordCount).toBeLessThan(5);
    const findings = runAudit(r).filter((f) => f.issueType === "content_requires_js");
    expect(findings.map((f) => f.url).sort()).toEqual([`${spa.origin}/`, `${spa.origin}/about`, `${spa.origin}/pricing`]);
    expect(findings[0].evidence.missingWithoutJs).toEqual(expect.arrayContaining(["title", "H1"]));
    expect(runAudit(r).some((f) => f.issueType === "missing_title" && f.url.endsWith("/pricing"))).toBe(false);
  }, 60_000);

  it("leaves server-rendered sites on the fast raw crawl", async () => {
    const r = await crawlSite({ ...base, baseUrl: ssr.origin, render: "auto" });
    expect(r.rendering.active).toBe(false);
    expect(r.pages.every((p) => !p.render)).toBe(true);
    expect(runAudit(r).some((f) => f.issueType === "content_requires_js")).toBe(false);
  }, 60_000);

  it("falls back to the raw crawl when Chromium is unavailable", async () => {
    const r = await crawlSite({ ...base, baseUrl: spa.origin, render: "auto", rendererFactory: async () => { throw new Error("no chromium here"); } });
    expect(r.rendering).toMatchObject({ active: false, error: "no chromium here" });
    expect(r.pages.length).toBeGreaterThan(0);
  });
});

describe("renderer safety", () => {
  it("routes the page's own requests through the SSRF guard and blocks WebSockets", async () => {
    // The dev-only env override would otherwise allow private addresses (production refuses to start with it).
    process.env.ALLOW_PRIVATE_NETWORK_FETCH = "false";
    const guarded = await createRenderer({ userAgent: "test", allowPrivate: false });
    try {
      // 127.0.0.1 is private: the navigation itself is refused by the guard.
      await expect(guarded.render(`${spa.origin}/`)).rejects.toThrow(/Blocked for safety/);
    } finally { await guarded.close(); process.env.ALLOW_PRIVATE_NETWORK_FETCH = "true"; }

    const local = await createRenderer({ userAgent: "test", allowPrivate: true });
    try {
      const r = await local.render(`${spa.origin}/about`);
      expect(r.html).toContain("About us");
      expect(r.blocked).toBeGreaterThanOrEqual(1); // the app's WebSocket
    } finally { await local.close(); }
  }, 60_000);
});

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/client";
import { encryptSecret } from "@/lib/crypto";
import { createWebsite } from "@/server/websites";
import {
  fleschReadingEase, topTerms, claimsToVerify, compareAnalyses, analyzeParsed, analyzeContent, compareWithCompetitor,
  generateBrief, updateSuggestionStatus, editSuggestion, proposeSuggestionToSite,
} from "@/server/content-studio";
import { parseHtml } from "@/crawler/parse";
import { _clearRobotsCache } from "@/lib/net/polite-fetch";
import { fakeWeb } from "./fixtures/web";
import { makeContext } from "./helpers";

const web = fakeWeb(() => "https://acme.example");
beforeAll(async () => { process.env.ALLOW_PRIVATE_NETWORK_FETCH = "true"; await web.start(); });
afterAll(async () => { await web.stop(); process.env.ALLOW_PRIVATE_NETWORK_FETCH = "false"; });
afterEach(() => { vi.unstubAllGlobals(); _clearRobotsCache(); });

const ARTICLE = `# How to maintain industrial widgets

Widget maintenance keeps production lines running. Clean the widget housing every week and check the bearings for wear.

## How often should widgets be lubricated?

Most teams lubricate widgets every 500 hours. Hot or dusty sites need shorter intervals. Keep a maintenance log for each widget.

## Inspection checklist

Inspect seals, bearings and fasteners. Replace worn seals quickly. Record every inspection in the maintenance log so trends are visible.`;

describe("text statistics", () => {
  it("estimates readability and returns null for tiny texts", () => {
    expect(fleschReadingEase("Too short.")).toBeNull();
    const easy = fleschReadingEase("The cat sat on the mat. ".repeat(10));
    const hard = fleschReadingEase("Comprehensive institutional interoperability necessitates multidimensional organizational transformation initiatives. ".repeat(6));
    expect(easy!).toBeGreaterThan(80);
    expect(hard!).toBeLessThan(20);
  });

  it("extracts frequent terms without stopwords", () => {
    const terms = topTerms(ARTICLE.repeat(2)).map((t) => t.term);
    expect(terms).toContain("widget");
    expect(terms).toContain("maintenance log");
    expect(terms).not.toContain("the");
  });

  it("flags numbers, years and superlatives as claims to verify", () => {
    const c = claimsToVerify("Our widgets last 40% longer. We are a friendly team. Founded in 1998. The best widgets in Ohio.");
    expect(c).toHaveLength(3);
    expect(c.join(" ")).not.toMatch(/friendly/);
  });

  it("finds competitor topics and schema the page lacks", () => {
    const own = analyzeParsed(parseHtml("<main><h1>Widget repair</h1><h2>Our repair process</h2><p>We repair widgets.</p></main>", "https://a.example/r"), { url: "https://a.example/r", siteHost: "a.example" });
    const comp = analyzeParsed(parseHtml(`<head><script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script></head><main><h1>Widget repair</h1><h2>Repair process</h2><h2>Warranty and guarantees</h2><h3>How much does widget repair cost?</h3><p>${"Widget repair warranty coverage explained in detail. ".repeat(30)}</p></main>`, "https://b.example/r"), { url: "https://b.example/r", siteHost: "b.example" });
    const r = compareAnalyses(own, comp);
    expect(r.missingTopics).toEqual(["Warranty and guarantees", "How much does widget repair cost?"]);
    expect(r.schemaGap).toEqual(["FAQPage"]);
    expect(r.summary.join(" ")).toMatch(/question-style headings/);
  });
});

describe("Content Studio", () => {
  it("analyzes pasted text with keyword checks and stores the result for the tenant", async () => {
    const ctx = await makeContext();
    const w = await createWebsite(ctx, { name: "Acme", url: "content-a.example.com" });
    const r = await analyzeContent(ctx, { websiteId: w.id, text: ARTICLE, keyword: "widget maintenance" });
    const by = Object.fromEntries(r.analysis.keywordChecks.map((c) => [c.label, c.pass]));
    expect(by["Keyword in H1"]).toBe(false); // "maintain industrial widgets"
    expect(by["Keyword in the opening paragraph"]).toBe(true);
    expect(r.analysis.questionHeadings).toBe(2); // "How to…" H1 and the lubrication question
    expect(r.analysis.headings[0]).toMatchObject({ level: 1 });
    const row = await prisma.contentSuggestion.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ organizationId: ctx.org.id, kind: "ANALYSIS", provider: "internal" });
    await expect(analyzeContent(ctx, { websiteId: w.id, text: "short" })).rejects.toThrow();

    const other = await makeContext();
    await expect(analyzeContent(other, { websiteId: w.id, text: ARTICLE })).rejects.toThrow();
    const client = await makeContext("CLIENT", { orgId: ctx.org.id });
    await expect(analyzeContent(client, { websiteId: w.id, text: ARTICLE })).rejects.toThrow(/permission/i);
  });

  it("fetches live URLs politely and refuses robots-disallowed pages", async () => {
    const ctx = await makeContext();
    const w = await createWebsite(ctx, { name: "Web", url: "content-b.example.com" });
    const r = await analyzeContent(ctx, { websiteId: w.id, url: `${web.origin}/resources` });
    expect(r.analysis.title).toBe("Widget maintenance resources");
    expect(r.analysis.h1).toEqual(["Useful widget maintenance tools"]);
    await expect(analyzeContent(ctx, { websiteId: w.id, url: `${web.origin}/private/page` })).rejects.toThrow(/robots\.txt/);
    await expect(analyzeContent(ctx, { websiteId: w.id, url: `${web.origin}/gone` })).rejects.toThrow(/404/);
  });

  it("compares a page with a competitor page and rejects same-site or off-site inputs", async () => {
    const ctx = await makeContext();
    const w = await createWebsite(ctx, { name: "Fixture", url: web.origin });
    const compUrl = `${web.origin.replace("127.0.0.1", "localhost")}/links-page`;
    const r = await compareWithCompetitor(ctx, { websiteId: w.id, url: `${web.origin}/resources`, competitorUrl: compUrl });
    expect(r.result.own.url).toContain("/resources");
    expect(r.result.summary.length).toBeGreaterThan(0);
    await expect(compareWithCompetitor(ctx, { websiteId: w.id, url: compUrl, competitorUrl: `${web.origin}/mention` })).rejects.toThrow(/must be on/);
    await expect(compareWithCompetitor(ctx, { websiteId: w.id, url: `${web.origin}/resources`, competitorUrl: `${web.origin}/mention` })).rejects.toThrow(/own site/);
  });

  it("drafts a brief with an AI provider, keeping only real internal-link URLs", async () => {
    const ctx = await makeContext();
    const w = await createWebsite(ctx, { name: "Acme", url: "content-c.example.com" });
    await expect(generateBrief(ctx, { websiteId: w.id, keyword: "widget repair" })).rejects.toThrow(/No AI provider/);
    await prisma.integrationConnection.create({ data: { organizationId: ctx.org.id, provider: "PERPLEXITY", status: "CONNECTED", encryptedSecret: encryptSecret({ apiKey: "pk" }) } });
    let prompt = "";
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      prompt = JSON.parse(String(init.body)).messages.at(-1).content;
      const brief = { searchIntent: "informational", titleOptions: ["Widget repair guide"], metaDescription: "How to repair widgets.", outline: [{ level: 2, text: "Common faults" }], faqs: [], entities: ["bearing"], internalLinks: [{ url: "https://invented.example/x", anchor: "x" }], wordCountGuidance: "As long as needed", claimsToVerify: ["Repair times"], rationale: "r" };
      return new Response(JSON.stringify({ model: "sonar", choices: [{ message: { content: "```json\n" + JSON.stringify(brief) + "\n```" } }] }));
    }));
    const r = await generateBrief(ctx, { websiteId: w.id, keyword: "widget repair" });
    expect(prompt).toMatch(/not available; DataForSEO is not connected/);
    expect(r.brief.internalLinks).toEqual([]);
    const row = await prisma.contentSuggestion.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ kind: "BRIEF", provider: "PERPLEXITY", model: "sonar" });
    expect(row.promptHash).toHaveLength(16);
  });

  it("requires human approval before a metadata suggestion can be proposed to the site", async () => {
    const ctx = await makeContext();
    const w = await createWebsite(ctx, { name: "Acme", url: "content-d.example.com" });
    const s = await prisma.contentSuggestion.create({ data: { organizationId: ctx.org.id, websiteId: w.id, url: "https://content-d.example.com/a", kind: "METADATA", output: JSON.stringify({ title: "T", metaDescription: "M" }), provider: "ANTHROPIC" } });
    await expect(proposeSuggestionToSite(ctx, s.id)).rejects.toThrow(/Approve/);
    await expect(editSuggestion(ctx, s.id, { title: "", metaDescription: "x" })).rejects.toThrow();
    await editSuggestion(ctx, s.id, { title: "Widget repair in Ohio", metaDescription: "Fast repairs." });
    expect((await prisma.contentSuggestion.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("EDITED");
    await updateSuggestionStatus(ctx, s.id, "APPROVED");
    // Site isn't WordPress: the live-change path refuses rather than pretending to publish.
    await expect(proposeSuggestionToSite(ctx, s.id)).rejects.toThrow(/WordPress/);
    const analyst = await makeContext("ANALYST", { orgId: (await makeContext()).org.id });
    await expect(updateSuggestionStatus(analyst, s.id, "REJECTED")).rejects.toThrow(/not found/);
  });
});

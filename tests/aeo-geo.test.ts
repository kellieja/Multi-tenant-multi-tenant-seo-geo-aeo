import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/client";
import { assessHtml, recommendFormat, processAeoOpportunities } from "@/server/aeo";
import { analyzeAnswer, brandSentiment, processGeoRun, savePromptSet, geoSummary, runPromptSetNow } from "@/server/geo";
import { createWebsite } from "@/server/websites";
import { encryptSecret } from "@/lib/crypto";
import { getAiClientFor } from "@/integrations/ai";
import type { JobContext } from "@/lib/jobs/context";
import { makeContext } from "./helpers";

afterEach(() => vi.unstubAllGlobals());
const jc = (orgId: string, websiteId: string, payload: object = {}) =>
  ({ job: { id: "j", organizationId: orgId, websiteId, payload, attempts: 1, type: "x", status: "RUNNING" }, progress: async () => undefined, isCancelled: async () => false, log: () => undefined }) as unknown as JobContext;

const GOOD = `<!doctype html><html><head><title>How to lubricate widgets</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"How to lubricate widgets","author":{"@type":"Person","name":"Sam Lee"},"datePublished":"2026-01-02","image":"https://x/i.png"}</script></head>
<body><main><h1>How to lubricate industrial widgets</h1>
<p>Widget lubrication is the process of applying grease to the widget bearings at fixed intervals so that friction stays low and the parts last longer in daily industrial operation.</p>
<p class="byline">By <a rel="author" href="/team/sam">Sam Lee</a> · <time datetime="2026-01-02">Jan 2, 2026</time></p>
<h2>How often should you lubricate a widget?</h2><p>Most widgets need grease every 500 operating hours according to the manufacturer guidance, though dusty or hot environments shorten that interval noticeably for many teams.</p>
<ol><li>Stop the line</li><li>Clean fittings</li><li>Apply grease</li></ol>
<p>${"Detail about maintenance planning and safety. ".repeat(40)}</p>
<a href="https://standards.example/iso">ISO guidance</a> <a href="/a">a</a> <a href="/b">b</a> <a href="/c">c</a></main></body></html>`;

describe("AEO", () => {
  it("scores a well-structured article highly with explained checks", () => {
    const a = assessHtml(GOOD, "https://acme.example/lube", { domain: "acme.example", brandTerms: ["Acme"], isHomepage: false });
    const by = Object.fromEntries(a.checks.map((c) => [c.key, c]));
    expect(by.question_headings.pass).toBe(true);
    expect(by.answer_passage.pass).toBe(true);
    expect(by.author.pass).toBe(true);
    expect(by.freshness.pass).toBe(true);
    expect(by.sources.pass).toBe(true);
    expect(by.schema_valid.pass).toBe(true);
    expect(by.organization.applicable).toBe(false);
    expect(a.score).toBeGreaterThanOrEqual(80);
  });

  it("scores a thin page low and explains why", () => {
    const a = assessHtml("<html><body><h1>Widgets</h1><h1>More</h1><p>We sell widgets.</p>" + "<p>word </p>".repeat(160) + "</body></html>", "https://acme.example/w", { domain: "acme.example", brandTerms: [], isHomepage: false });
    expect(a.score).toBeLessThan(40);
    expect(a.checks.find((c) => c.key === "answer_passage")!.detail).toMatch(/No short/);
    expect(a.checks.find((c) => c.key === "semantic_html")!.pass).toBe(false);
  });

  it("checks Organization entity markup on the homepage", () => {
    const html = `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Other Corp","url":"https://acme.example"}</script></head><body><main><h1>Home</h1></main></body></html>`;
    const a = assessHtml(html, "https://acme.example/", { domain: "acme.example", brandTerms: ["Acme"], isHomepage: true });
    expect(a.checks.find((c) => c.key === "organization")!.pass).toBe(true);
    expect(a.checks.find((c) => c.key === "entity_name")!.pass).toBe(false);
  });

  it("recommends answer formats by question type", () => {
    expect(recommendFormat("how to clean a widget")).toMatch(/Numbered steps/);
    expect(recommendFormat("what is a widget")).toMatch(/definition/);
    expect(recommendFormat("widget a vs widget b")).toMatch(/Comparison table/);
    expect(recommendFormat("can widgets rust")).toMatch(/yes\/no/);
  });

  it("builds question opportunities from Search Console with measured evidence", async () => {
    const ctx = await makeContext("OWNER");
    const w = await createWebsite(ctx, { name: "Acme", url: "aeo-opps.example.com" });
    const day = new Date(Date.now() - 4 * 86400_000); day.setUTCHours(0, 0, 0, 0);
    await prisma.searchConsoleQuery.createMany({ data: [
      { organizationId: ctx.org.id, websiteId: w.id, date: day, query: "how often to lubricate widgets", page: "https://aeo-opps.example.com/lube", clicks: 4, impressions: 120, ctr: 0.03, position: 7.2 },
      { organizationId: ctx.org.id, websiteId: w.id, date: day, query: "acme widgets", page: "https://aeo-opps.example.com/", clicks: 40, impressions: 100, ctr: 0.4, position: 1 },
    ] });
    await processAeoOpportunities(jc(ctx.org.id, w.id));
    const opps = await ctx.db.aeoOpportunity.findMany({ where: { websiteId: w.id } });
    expect(opps.map((o) => o.question)).toEqual(["how often to lubricate widgets"]);
    expect(opps[0].rankingUrl).toBe("https://aeo-opps.example.com/lube");
    expect(opps[0].evidence).toMatchObject({ impressions: 120, measured: true });
    expect(opps[0].source).toBe("Google Search Console");
    expect((opps[0].contentGaps as string[]).join(" ")).toMatch(/not assessed yet/);
  });
});

describe("GEO", () => {
  it("detects brand vs competitor mentions with word boundaries, own citations and sentiment", () => {
    const a = analyzeAnswer(
      { text: "For widgets, Acme Widgets is a trusted choice. RivalCo is also popular. Avoid cheap knockoffs.", citations: [{ url: "https://www.acme.example/guide" }, { url: "https://rival.example/x" }] },
      { domain: "acme.example", brandTerms: ["Acme Widgets"] },
      [{ name: "RivalCo", domain: "rival.example", terms: ["RivalCo"] }, { name: "Zeta", terms: ["Zeta"] }],
    );
    expect(a).toMatchObject({ brandMentioned: true, brandCited: true, citedOwnUrls: ["https://www.acme.example/guide"], sentiment: "positive" });
    expect(a.competitorMentions).toEqual({ RivalCo: { mentioned: true, cited: true }, Zeta: { mentioned: false, cited: false } });
    expect(analyzeAnswer({ text: "Acmeish products", citations: [] }, { domain: "a.example", brandTerms: ["Acme"] }, []).brandMentioned).toBe(false);
    expect(brandSentiment("Nothing about it", ["Acme"])).toBeNull();
    expect(brandSentiment("Acme had many complaints.", ["Acme"])).toBe("negative");
  });

  it("runs prompt sets on connected platforms, stores evidence, and summarises as samples", async () => {
    const ctx = await makeContext("OWNER");
    const w = await createWebsite(ctx, { name: "Acme Widgets", url: "geo-run.example.com", brandTerms: "Acme Widgets" });
    await ctx.db.competitor.create({ data: { organizationId: ctx.org.id, websiteId: w.id, domain: "rival.example", name: "RivalCo", brandTerms: ["RivalCo"] } });
    await prisma.integrationConnection.create({ data: { organizationId: ctx.org.id, provider: "PERPLEXITY", status: "CONNECTED", encryptedSecret: encryptSecret({ apiKey: "pk" }) } });
    const set = await savePromptSet(ctx, w.id, { name: "Buyers", market: "us", platforms: ["PERPLEXITY"], prompts: ["best industrial widget supplier", "who repairs widgets"] });
    await expect(savePromptSet(ctx, w.id, { name: "x", platforms: ["OPENAI"], prompts: ["hi"] })).rejects.toThrow(/at least 5/);
    await expect(runPromptSetNow(ctx, (await savePromptSet(ctx, w.id, { name: "o", platforms: ["OPENAI"], prompts: ["which widget is best"] })).id)).rejects.toThrow(/not connected/);

    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.messages[0].content).toMatch(/neutral|helpfully/i); // neutral system prompt, never brand-steering
      call++;
      const answer = call === 1 ? { choices: [{ message: { content: "Acme Widgets and RivalCo are well regarded suppliers." } }], search_results: [{ title: "Acme", url: "https://geo-run.example.com/about" }, { title: "Rival", url: "https://rival.example/" }], model: "sonar" }
        : { choices: [{ message: { content: "Local repair shops and RivalCo offer repairs." } }], citations: ["https://rival.example/repairs"], model: "sonar" };
      return new Response(JSON.stringify(answer), { status: 200 });
    }));
    const r = await processGeoRun(jc(ctx.org.id, w.id, { promptSetId: set.id }));
    expect(r.checks).toBe(2);
    const obs = await ctx.db.geoObservation.findMany({ where: { websiteId: w.id }, orderBy: { query: "asc" } });
    expect(obs[0]).toMatchObject({ platform: "PERPLEXITY", brandMentioned: true, brandCited: true, market: "US" });
    expect(obs[0].methodology).toMatch(/single sample/);
    expect(obs[1].brandMentioned).toBe(false);
    const s = await geoSummary(ctx, w.id);
    expect(s.samples).toBe(2);
    expect(s.mentionRate).toBe(0.5);
    expect(s.shareOfVoice.find((x) => x.name === "RivalCo")!.count).toBe(2);
    expect(s.gaps.map((g) => g.query)).toEqual(["who repairs widgets"]);
    expect(s.topCitedDomains[0]).toEqual({ label: "rival.example", value: 2 });
  });
});

describe("AI provider adapters (request/response shape)", () => {
  async function client(provider: "ANTHROPIC" | "OPENAI" | "GEMINI" | "PERPLEXITY") {
    const ctx = await makeContext("OWNER");
    await prisma.integrationConnection.create({ data: { organizationId: ctx.org.id, provider, status: "CONNECTED", encryptedSecret: encryptSecret({ apiKey: "key-123" }) } });
    return (await getAiClientFor(ctx.org.id, provider))!;
  }

  it("Anthropic: default model, server-side refusal fallback, web search citations, refusal handling", async () => {
    const ai = await client("ANTHROPIC");
    expect(ai.model).toBe("claude-opus-5-5");
    const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    let refuse = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const req = url instanceof Request ? url : new Request(String(url), init);
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(await req.text()) });
      const msg = refuse
        ? { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: "Declined." }, usage: { input_tokens: 5, output_tokens: 0 } }
        : { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 20 },
            content: [{ type: "text", text: "Acme is a supplier.", citations: [{ type: "web_search_result_location", url: "https://acme.example/a", title: "Acme", cited_text: "x", encrypted_index: "e" }] }] };
      return new Response(JSON.stringify(msg), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const r = await ai.complete({ prompt: "who sells widgets", webSearch: true, country: "US" });
    expect(seen[0].url).toContain("/v1/messages");
    expect(seen[0].headers.get("x-api-key")).toBe("key-123");
    expect(seen[0].headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(seen[0].body).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", tools: [{ type: "web_search_20260209", name: "web_search", user_location: { type: "approximate", country: "US" } }] });
    expect(seen[0].body).not.toHaveProperty("thinking");
    expect(r.citations).toEqual([{ url: "https://acme.example/a", title: "Acme" }]);
    refuse = true;
    const d = await ai.complete({ prompt: "x" });
    expect(d.refusal).toBe("Declined.");
    expect(d.text).toBe("");
  });

  it("OpenAI, Gemini and Perplexity parse text and citations", async () => {
    const openai = await client("OPENAI");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ model: "gpt-x", output: [{ type: "message", content: [{ type: "output_text", text: "Hi", annotations: [{ type: "url_citation", url: "https://s.example/1", title: "S" }] }] }] }))));
    expect(await openai.complete({ prompt: "q", webSearch: true })).toMatchObject({ text: "Hi", citations: [{ url: "https://s.example/1" }] });
    const gemini = await client("GEMINI");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "G" }] }, groundingMetadata: { groundingChunks: [{ web: { uri: "https://g.example", title: "G" } }] } }] }))));
    expect(await gemini.complete({ prompt: "q", webSearch: true })).toMatchObject({ text: "G", citations: [{ url: "https://g.example" }] });
    const pplx = await client("PERPLEXITY");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 })));
    await expect(pplx.complete({ prompt: "q" })).rejects.toThrow(/401: Invalid API key/);
  });
});

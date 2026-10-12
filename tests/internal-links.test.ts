import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/client";
import { processCrawlJob } from "@/server/crawls";
import { createWebsite, updateWebsiteSettings } from "@/server/websites";
import { connectWithCredentials } from "@/server/integrations";
import { decideApproval } from "@/server/approvals";
import { processSiteChangeApply, rollbackSiteChange } from "@/server/site-changes";
import {
  insertLink, phrasesForTarget, linkableParagraphs, findAnchor, cleanTitle, scoreSuggestion,
  processInternalLinks, setLinkSuggestionStatus, proposeInternalLink, linkGraphStats,
} from "@/server/internal-links";
import * as queue from "@/lib/jobs/queue";
import type { JobContext } from "@/lib/jobs/context";
import { fixtureSite } from "./fixtures/site";
import { fakeWordPress } from "./fixtures/wordpress";
import { makeContext } from "./helpers";

const site = fixtureSite();
const wp = fakeWordPress();
beforeAll(async () => { process.env.ALLOW_PRIVATE_NETWORK_FETCH = "true"; await site.start(); await wp.start(); });
afterAll(async () => { await site.stop(); await wp.stop(); process.env.ALLOW_PRIVATE_NETWORK_FETCH = "false"; vi.restoreAllMocks(); });

const jc = (job: object) => ({ job: { attempts: 1, status: "RUNNING", payload: {}, ...job }, progress: async () => undefined, isCancelled: async () => false, log: () => undefined }) as unknown as JobContext;

describe("link insertion", () => {
  it("links the first safe occurrence in paragraph text, preserving case", () => {
    const html = `<!-- wp:heading --><h2>Lubrication intervals</h2><!-- /wp:heading --><p>See <a href="/x">lubrication intervals</a> above.</p><p>Plan Lubrication Intervals by load &amp; heat.</p>`;
    const out = insertLink(html, "lubrication intervals", "https://acme.example/guide?a=1&b=2");
    expect(out).toBe(`<!-- wp:heading --><h2>Lubrication intervals</h2><!-- /wp:heading --><p>See <a href="/x">lubrication intervals</a> above.</p><p>Plan <a href="https://acme.example/guide?a=1&amp;b=2">Lubrication Intervals</a> by load &amp; heat.</p>`);
  });

  it("refuses to link inside headings, links, code or outside paragraphs, and respects word boundaries", () => {
    expect(insertLink("<h3>widget repair</h3><div>widget repair</div>", "widget repair", "/r")).toBeNull();
    expect(insertLink("<p><code>widget repair</code></p>", "widget repair", "/r")).toBeNull();
    expect(insertLink("<p>widget repairs are</p>", "widget repair", "/r")).toBeNull();
    expect(insertLink("<ul><li>Book widget repair<br>today</li></ul>", "widget repair", "/r")).toBe('<ul><li>Book <a href="/r">widget repair</a><br>today</li></ul>');
  });

  it("builds target phrases from keywords, queries, H1 and cleaned title", () => {
    expect(cleanTitle("Widget Repair Services | Acme Widgets", ["Acme Widgets"])).toBe("widget repair services");
    const p = phrasesForTarget({ title: "About | Acme", h1: ["Industrial widget repair"], keywords: ["widget repair"], queries: ["widget repair near me", "repair"], brandTerms: ["Acme"] });
    expect(p.map((x) => [x.phrase, x.source])).toEqual([["widget repair", "keyword"], ["widget repair near me", "gsc"], ["industrial widget repair", "h1"]]);
  });

  it("ignores text that is already linked when finding an anchor", () => {
    const paras = linkableParagraphs(`<main><p>Read our <a href="/g">widget repair guide</a> before booking anything today.</p><p>Professional widget repair keeps production lines running safely.</p></main>`);
    expect(findAnchor(paras, "widget repair")?.paragraph).toMatch(/^Professional/);
    expect(scoreSuggestion({ weight: 1, targetInlinks: 0, sourceInlinks: 100 })).toBe(100);
    expect(scoreSuggestion({ weight: 0.6, targetInlinks: 20, sourceInlinks: 0 })).toBe(30);
  });
});

describe("internal link analysis job", () => {
  it("suggests contextual links to an orphan page from crawl data and re-checks live paragraphs", async () => {
    const ctx = await makeContext();
    const w = await createWebsite(ctx, { name: "Fixture", url: site.origin });
    await updateWebsiteSettings(ctx, w.id, { crawlDelayMs: 100, checkExternalLinks: false });
    const crawl = await prisma.crawl.create({ data: { organizationId: ctx.org.id, websiteId: w.id, settings: {}, summary: {} } });
    await processCrawlJob(jc({ id: "c", organizationId: ctx.org.id, websiteId: w.id, type: "crawl", payload: { crawlId: crawl.id } }));
    await prisma.keyword.create({ data: { organizationId: ctx.org.id, websiteId: w.id, phrase: "lubrication intervals", targetUrl: `${site.origin}/orphan` } });

    const res = await processInternalLinks(jc({ id: "l", organizationId: ctx.org.id, websiteId: w.id, type: "internal-links" })) as { suggestions: number };
    expect(res.suggestions).toBeGreaterThan(0);
    const rows = await ctx.db.internalLinkSuggestion.findMany({ where: { websiteId: w.id } });
    expect(rows.length).toBeLessThanOrEqual(5); // per-target cap
    for (const r of rows) {
      expect(r.targetUrl).toBe(`${site.origin}/orphan`);
      expect(r.anchor.toLowerCase()).toBe("lubrication intervals");
      expect(r.sourceParagraph.toLowerCase()).toContain("lubrication intervals");
      expect(r.rationale).toMatch(/tracked keyword.*orphan/);
      expect(r.sourceUrl).not.toBe(r.targetUrl);
    }
    expect(site.state.requests).not.toContain("/private/secret");

    // Rejected suggestions are not re-created by the next run
    await setLinkSuggestionStatus(ctx, rows[0].id, "REJECTED");
    await processInternalLinks(jc({ id: "l2", organizationId: ctx.org.id, websiteId: w.id, type: "internal-links" }));
    const again = await ctx.db.internalLinkSuggestion.findMany({ where: { websiteId: w.id, sourceUrl: rows[0].sourceUrl, targetUrl: rows[0].targetUrl } });
    expect(again).toHaveLength(1);
    expect(again[0].status).toBe("REJECTED");

    const stats = (await linkGraphStats(w.id))!;
    expect(stats.orphans.map((o) => o.url)).toContain(`${site.origin}/orphan`);

    // Non-WordPress sites never get a live change
    await setLinkSuggestionStatus(ctx, rows[1]?.id ?? rows[0].id, "APPROVED").catch(() => undefined);
    const approved = await ctx.db.internalLinkSuggestion.findFirst({ where: { websiteId: w.id, status: "APPROVED" } });
    if (approved) await expect(proposeInternalLink(ctx, approved.id)).rejects.toThrow(/WordPress/);
    const client = await makeContext("CLIENT", { orgId: ctx.org.id });
    await expect(setLinkSuggestionStatus(client, rows[0].id, "APPROVED")).rejects.toThrow(/permission/i);
  });
});

describe("applying an internal link to WordPress", () => {
  it("goes through approval, refuses stale content, applies with backup and rolls back", async () => {
    const queued: { type: string }[] = [];
    vi.spyOn(queue, "enqueueJob").mockImplementation(async (j) => { queued.push(j as { type: string }); return { job: { id: "q", status: "QUEUED" }, deduped: false } as never; });
    const owner = await makeContext();
    const w = await createWebsite(owner, { name: "WP links", url: wp.origin, cmsType: "WORDPRESS" });
    await connectWithCredentials(owner, "WORDPRESS", { baseUrl: wp.origin, username: "editor", appPassword: "app pass" }, w.id);
    wp.page.content = "<!-- wp:paragraph --><p>Our team follows strict lubrication intervals for every widget.</p><!-- /wp:paragraph -->";
    const original = wp.page.content;
    const crawl = await prisma.crawl.create({ data: { organizationId: owner.org.id, websiteId: w.id, settings: {}, summary: {} } });
    const s = await prisma.internalLinkSuggestion.create({ data: { organizationId: owner.org.id, websiteId: w.id, crawlId: crawl.id, sourceUrl: `${wp.origin}/about/`, targetUrl: `${wp.origin}/guide`, anchor: "lubrication intervals", sourceParagraph: "Our team follows strict lubrication intervals for every widget.", rationale: "test", score: 80 } });

    await expect(proposeInternalLink(owner, s.id)).rejects.toThrow(/Accept/);
    await setLinkSuggestionStatus(owner, s.id, "APPROVED");
    const change = await proposeInternalLink(owner, s.id);
    expect(change.status).toBe("PENDING_APPROVAL");
    expect(change.after).toContain(`<a href="${wp.origin}/guide">lubrication intervals</a>`);
    expect(wp.page.content).toBe(original); // nothing written before approval
    await expect(proposeInternalLink(owner, s.id)).rejects.toThrow(/already proposed/);

    const manager = await makeContext("MANAGER", { orgId: owner.org.id });
    await decideApproval(manager, change.approvalId!, "APPROVED");
    // Someone edits the page after the proposal: applying would discard their edit, so it's refused
    wp.page.content = original.replace("strict", "very strict");
    await expect(processSiteChangeApply(jc({ id: "a", organizationId: owner.org.id, websiteId: w.id, type: "site-change-apply", payload: { siteChangeId: change.id } }))).rejects.toThrow(/changed after this change was proposed/);
    expect(wp.page.content).toContain("very strict");
    expect((await prisma.siteChange.findUniqueOrThrow({ where: { id: change.id } })).status).toBe("FAILED");

    // Restore and apply cleanly
    wp.page.content = original;
    await prisma.siteChange.update({ where: { id: change.id }, data: { status: "APPROVED" } });
    await processSiteChangeApply(jc({ id: "b", organizationId: owner.org.id, websiteId: w.id, type: "site-change-apply", payload: { siteChangeId: change.id } }));
    expect(wp.page.content).toContain(`<a href="${wp.origin}/guide">lubrication intervals</a>`);
    expect((await prisma.internalLinkSuggestion.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("APPLIED");
    await rollbackSiteChange(manager, change.id);
    expect(wp.page.content).toBe(original);
    expect((await prisma.internalLinkSuggestion.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("ROLLED_BACK");
  });
});

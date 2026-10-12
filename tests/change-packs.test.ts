import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/client";
import { createWebsite } from "@/server/websites";
import { createChangePack, packItems, packMarkdown, packPrompt, verifyChangePacks } from "@/server/change-packs";
import { makeContext } from "./helpers";

async function seed() {
  const ctx = await makeContext();
  const site = await createWebsite(ctx, { name: "Replit Shop", url: `replit-shop-${Date.now()}.example.com` });
  const u = (p: string) => `https://${site.domain}${p}`;
  const crawl0 = await prisma.crawl.create({ data: { organizationId: ctx.org.id, websiteId: site.id, settings: {}, summary: {}, status: "SUCCEEDED", finishedAt: new Date() } });
  const meta = await prisma.contentSuggestion.create({ data: { organizationId: ctx.org.id, websiteId: site.id, url: u("/pricing"), kind: "METADATA", status: "APPROVED", provider: "ANTHROPIC", input: { currentTitle: "Pricing", currentMetaDescription: null }, output: JSON.stringify({ title: "Widget repair pricing | Replit Shop", metaDescription: "Fixed-price widget repairs with a written quote before any work starts." }) } });
  const answer = await prisma.contentSuggestion.create({ data: { organizationId: ctx.org.id, websiteId: site.id, url: u("/faq"), kind: "AEO_ANSWER", status: "APPROVED", provider: "ANTHROPIC", input: { question: "How often should widgets be serviced?" }, output: JSON.stringify({ heading: "How often should widgets be serviced?", answer: "Most widgets need servicing every 500 operating hours." }) } });
  const draft = await prisma.contentSuggestion.create({ data: { organizationId: ctx.org.id, websiteId: site.id, url: u("/about"), kind: "METADATA", status: "SUGGESTED", provider: "ANTHROPIC", output: JSON.stringify({ title: "Not approved yet" }) } });
  const link = await prisma.internalLinkSuggestion.create({ data: { organizationId: ctx.org.id, websiteId: site.id, crawlId: crawl0.id, sourceUrl: u("/"), targetUrl: u("/pricing"), anchor: "repair pricing", sourceParagraph: "See our repair pricing before you book.", rationale: "test", score: 70, status: "APPROVED" } });
  return { ctx, site, u, meta, answer, draft, link };
}

describe("change packs", () => {
  it("bundles only approved work and renders a checklist and an agent prompt", async () => {
    const { ctx, site } = await seed();
    const pack = await createChangePack(ctx, site.id);
    const items = packItems(pack);
    expect(items.map((i) => i.kind).sort()).toEqual(["answer_section", "internal_link", "meta_description", "title"]);
    expect(items.some((i) => i.proposed === "Not approved yet")).toBe(false);
    await expect(createChangePack(ctx, site.id)).rejects.toThrow(/Nothing to include/); // items already in an open pack

    const md = packMarkdown(pack, site);
    expect(md).toContain("## /pricing");
    expect(md).toContain("`Widget repair pricing | Replit Shop`");
    expect(md).toContain('make "repair pricing" a link to');

    const prompt = packPrompt(pack, site, { jsRendered: false });
    expect(prompt).toContain('set the <title> to exactly: "Widget repair pricing | Replit Shop"');
    expect(prompt).toContain("Change only what is listed");
    expect(prompt).not.toContain("renders its pages with JavaScript");
    expect(packPrompt(pack, site, { jsRendered: true })).toContain("pre-rendering");
  });

  it("marks items live from the next crawl and closes the pack when everything is done", async () => {
    const { ctx, site, u, meta, answer, link } = await seed();
    const pack = await createChangePack(ctx, site.id);
    const crawl = await prisma.crawl.create({ data: { organizationId: ctx.org.id, websiteId: site.id, settings: {}, summary: {}, status: "SUCCEEDED", finishedAt: new Date() } });
    const page = (url: string, extra: object) => prisma.crawledPage.create({ data: { organizationId: ctx.org.id, crawlId: crawl.id, websiteId: site.id, url, statusCode: 200, ...extra } });
    // Only the title is live so far.
    await page(u("/pricing"), { title: "Widget repair pricing | Replit Shop", metaDescription: "Old description" });
    await page(u("/faq"), { headings: [{ level: 1, text: "FAQ" }] });
    let r = await verifyChangePacks(site.id, crawl.id);
    expect(r.newlyDone).toBe(1);
    let after = await prisma.changePack.findUniqueOrThrow({ where: { id: pack.id } });
    expect(after.status).toBe("OPEN");
    expect((await prisma.contentSuggestion.findUniqueOrThrow({ where: { id: meta.id } })).status).toBe("APPROVED"); // meta description still pending

    // Next crawl: everything live.
    const crawl2 = await prisma.crawl.create({ data: { organizationId: ctx.org.id, websiteId: site.id, settings: {}, summary: {}, status: "SUCCEEDED", finishedAt: new Date() } });
    const page2 = (url: string, extra: object) => prisma.crawledPage.create({ data: { organizationId: ctx.org.id, crawlId: crawl2.id, websiteId: site.id, url, statusCode: 200, ...extra } });
    await page2(u("/pricing"), { title: "Widget repair pricing | Replit Shop", metaDescription: "Fixed-price widget repairs with a written  quote before any work starts." });
    await page2(u("/faq"), { headings: [{ level: 2, text: "How often should widgets be serviced?" }] });
    await prisma.crawledLink.create({ data: { organizationId: ctx.org.id, crawlId: crawl2.id, fromUrl: u("/"), toUrl: u("/pricing"), anchor: "repair pricing", isInternal: true } });
    r = await verifyChangePacks(site.id, crawl2.id);
    expect(r.newlyDone).toBe(3);
    after = await prisma.changePack.findUniqueOrThrow({ where: { id: pack.id } });
    expect(after.status).toBe("VERIFIED");
    expect(packItems(after).every((i) => i.status === "done")).toBe(true);
    expect((await prisma.contentSuggestion.findUniqueOrThrow({ where: { id: meta.id } })).status).toBe("APPLIED");
    expect((await prisma.contentSuggestion.findUniqueOrThrow({ where: { id: answer.id } })).status).toBe("APPLIED");
    expect((await prisma.internalLinkSuggestion.findUniqueOrThrow({ where: { id: link.id } })).status).toBe("APPLIED");
    expect(await prisma.notification.count({ where: { organizationId: ctx.org.id, type: "change_pack_verified" } })).toBe(1);
  });

  it("enforces permissions and tenancy", async () => {
    const { ctx, site } = await seed();
    const client = await makeContext("CLIENT", { orgId: ctx.org.id });
    await expect(createChangePack(client, site.id)).rejects.toThrow(/permission/i);
    const outsider = await makeContext();
    await expect(createChangePack(outsider, site.id)).rejects.toThrow();
  });
});

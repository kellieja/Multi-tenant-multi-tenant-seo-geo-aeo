import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/delivery", () => ({
  sendEmail: vi.fn(async () => "msg-id-1"),
  postSlack: vi.fn(async () => false),
  deliverExternally: vi.fn(async () => undefined),
}));

import { prisma } from "@/lib/db/client";
import { createWebsite } from "@/server/websites";
import { importBacklinksCsv, checkBacklink, processBacklinkVerify, processBacklinkSync, addDisavow, reviewDisavow, disavowFile, backlinkStats } from "@/server/backlinks";
import { addProspect, researchProspect, createCampaign, saveTemplate, draftCampaignMessages, requestSendApproval, processOutreachSend, setProspectStage, renderTemplate } from "@/server/outreach";
import { decideApproval } from "@/server/approvals";
import { addKeywords, classifyIntent, findRanking, processRankCheck, parseKeywordInput, searchConsoleInsights } from "@/server/keywords";
import { sendEmail } from "@/server/delivery";
import { encryptSecret } from "@/lib/crypto";
import type { JobContext } from "@/lib/jobs/context";
import { makeContext } from "./helpers";
import { fakeWeb } from "./fixtures/web";

const TARGET = "https://acme-widgets.example.com";
const web = fakeWeb(() => TARGET);
beforeAll(async () => { process.env.ALLOW_PRIVATE_NETWORK_FETCH = "true"; await web.start(); });
afterAll(async () => { await web.stop(); process.env.ALLOW_PRIVATE_NETWORK_FETCH = "false"; vi.unstubAllGlobals(); });

const jc = (orgId: string, websiteId: string, payload: object = {}) =>
  ({ job: { id: "j", organizationId: orgId, websiteId, payload, attempts: 1, type: "x", status: "RUNNING" }, progress: async () => undefined, isCancelled: async () => false, log: () => undefined }) as unknown as JobContext;

async function site(role: "OWNER" | "MANAGER" = "OWNER") {
  const ctx = await makeContext(role);
  const w = await createWebsite(ctx, { name: "Acme Widgets", url: TARGET, brandTerms: "Acme Widgets", industry: "industrial widget maintenance" });
  return { ctx, w };
}

describe("backlink inventory", () => {
  it("imports CSV exports with common column names and rejects foreign targets", async () => {
    const { ctx, w } = await site();
    const csv = `url_from,url_to,anchor,nofollow\n${web.origin}/links-page,${TARGET}/guide,Acme guide,true\nhttps://blog.example/a,https://other.example/x,foo,false\nnot-a-url,${TARGET}/,x,false`;
    const r = await importBacklinksCsv(ctx, w.id, csv);
    expect(r.created).toBe(1);
    expect(r.skipped.map((s) => s.row)).toEqual([3, 4]);
    const b = await ctx.db.backlink.findFirstOrThrow({ where: { websiteId: w.id } });
    expect(b.rel).toBe("nofollow");
    expect(b.status).toBe("UNVERIFIED");
    expect(await ctx.db.referringDomain.count({ where: { websiteId: w.id } })).toBe(1);
  });

  it("verifies links live: active with anchor/rel, lost when removed, broken on 404, skipped when robots disallow", async () => {
    const robots = new Map();
    const active = await checkBacklink({ sourceUrl: `${web.origin}/links-page`, targetUrl: `${TARGET}/guide` }, "acme-widgets.example.com", robots);
    expect(active).toMatchObject({ status: "ACTIVE", anchor: "Acme guide", rel: "nofollow" });
    expect((await checkBacklink({ sourceUrl: `${web.origin}/gone`, targetUrl: `${TARGET}/` }, "acme-widgets.example.com", robots)).status).toBe("BROKEN");
    expect((await checkBacklink({ sourceUrl: `${web.origin}/private/page`, targetUrl: `${TARGET}/` }, "acme-widgets.example.com", robots)).status).toBe("UNVERIFIED");

    const { ctx, w } = await site();
    await importBacklinksCsv(ctx, w.id, `source_url,target_url\n${web.origin}/links-page,${TARGET}/guide`);
    await processBacklinkVerify(jc(ctx.org.id, w.id));
    expect((await ctx.db.backlink.findFirstOrThrow({ where: { websiteId: w.id } })).status).toBe("ACTIVE");
    web.state.linkRemoved = true;
    await processBacklinkVerify(jc(ctx.org.id, w.id));
    const lost = await ctx.db.backlink.findFirstOrThrow({ where: { websiteId: w.id } });
    expect(lost.status).toBe("LOST");
    expect(lost.lostAt).not.toBeNull();
    web.state.linkRemoved = false;
    const stats = await backlinkStats(ctx, w.id);
    expect(stats.byStatus.LOST).toBe(1);
    expect(stats.velocity.reduce((s, v) => s + v.lost, 0)).toBe(-1);
  });

  it("syncs provider backlinks (mocked DataForSEO) and records cost", async () => {
    const { ctx, w } = await site();
    await prisma.integrationConnection.create({ data: { organizationId: ctx.org.id, provider: "DATAFORSEO", status: "CONNECTED", encryptedSecret: encryptSecret({ login: "a", password: "b" }) } });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const ok = (result: unknown) => new Response(JSON.stringify({ status_code: 20000, status_message: "Ok.", cost: 0.02, tasks: [{ id: "t", status_code: 20000, status_message: "Ok.", cost: 0.02, result: [result] }] }));
      if (url.endsWith("/backlinks/backlinks/live")) return ok({ total_count: 2, items: [
        { url_from: "https://news.example/story", domain_from: "news.example", url_to: `${TARGET}/`, anchor: "Acme", dofollow: true, first_seen: "2026-09-01 00:00:00 +00:00", rank: 310 },
        { url_from: "https://old.example/page", domain_from: "old.example", url_to: `${TARGET}/x`, anchor: "x", dofollow: false, attributes: ["nofollow"], is_lost: true, lost_date: "2026-10-01 00:00:00 +00:00", rank: 50 },
      ] });
      if (url.endsWith("/backlinks/referring_domains/live")) return ok({ items: [{ domain: "news.example", rank: 410, backlinks: 1, first_seen: "2026-09-01" }] });
      throw new Error(`unexpected ${url}`);
    }));
    const r = await processBacklinkSync(jc(ctx.org.id, w.id));
    expect(r.cost).toBeCloseTo(0.04);
    expect(await ctx.db.backlink.count({ where: { websiteId: w.id, status: "LOST" } })).toBe(1);
    const rd = await ctx.db.referringDomain.findFirstOrThrow({ where: { websiteId: w.id, domain: "news.example" } });
    expect(rd.providerRank).toBe(410);
    expect(rd.rankSource).toMatch(/DataForSEO/);
    vi.unstubAllGlobals();
  });

  it("only exports disavow entries a reviewer explicitly included", async () => {
    const { ctx, w } = await site();
    await addDisavow(ctx, w.id, "domain:WWW.Spammy.example", "Paid link network");
    const e2 = await addDisavow(ctx, w.id, "https://other.example/page", "Hacked page");
    let file = await disavowFile(ctx, w.id);
    expect(file).not.toContain("spammy");
    await reviewDisavow(ctx, e2.id, true);
    file = await disavowFile(ctx, w.id);
    expect(file).toContain("https://other.example/page");
    expect(file).not.toContain("domain:spammy.example");
  });
});

describe("keywords & rank tracking", () => {
  it("classifies intent with labelled rules and parses keyword input", () => {
    expect(classifyIntent("how to lubricate widgets")).toBe("INFORMATIONAL");
    expect(classifyIntent("best widget brands 2026")).toBe("COMMERCIAL");
    expect(classifyIntent("buy widget online")).toBe("TRANSACTIONAL");
    expect(classifyIntent("acme widgets login", ["Acme Widgets"])).toBe("NAVIGATIONAL");
    expect(parseKeywordInput("phrase,group,tags\nWidget Repair,services,a;b")).toEqual([{ phrase: "Widget Repair", group: "services", tags: ["a", "b"], targetUrl: null, device: "desktop" }]);
  });

  it("finds our ranking (including subdomains) and alerts on drops", async () => {
    expect(findRanking([{ type: "featured_snippet" }, { type: "organic", rank_group: 1, url: "https://x.com" }, { type: "organic", rank_group: 4, url: "https://www.acme-widgets.example.com/guide" }], "acme-widgets.example.com")).toEqual({ position: 4, url: "https://www.acme-widgets.example.com/guide", features: ["featured_snippet"] });
    const { ctx, w } = await site();
    await addKeywords(ctx, w.id, [{ phrase: "widget maintenance" }]);
    await prisma.integrationConnection.create({ data: { organizationId: ctx.org.id, provider: "DATAFORSEO", status: "CONNECTED", encryptedSecret: encryptSecret({ login: "a", password: "b" }) } });
    let pos = 3;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status_code: 20000, cost: 0.002, tasks: [{ status_code: 20000, cost: 0.002, result: [{ items: [{ type: "organic", rank_group: pos, url: `${TARGET}/` }] }] }] }))));
    await processRankCheck(jc(ctx.org.id, w.id));
    pos = 12;
    await processRankCheck(jc(ctx.org.id, w.id));
    expect(await prisma.rankObservation.count({ where: { websiteId: w.id } })).toBe(2);
    expect(await prisma.notification.count({ where: { organizationId: ctx.org.id, type: "rank_drop" } })).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it("refuses to fabricate rankings without a provider", async () => {
    const { ctx, w } = await site();
    await addKeywords(ctx, w.id, [{ phrase: "widget" }]);
    await expect(processRankCheck(jc(ctx.org.id, w.id))).rejects.toThrow(/DataForSEO/);
    expect(await prisma.rankObservation.count({ where: { websiteId: w.id } })).toBe(0);
  });

  it("detects cannibalization and striking-distance queries from Search Console rows", async () => {
    const { ctx, w } = await site();
    const day = new Date(Date.now() - 3 * 86400_000);
    day.setUTCHours(0, 0, 0, 0);
    await prisma.searchConsoleQuery.createMany({ data: [
      { organizationId: ctx.org.id, websiteId: w.id, date: day, query: "widget repair", page: `${TARGET}/repair`, clicks: 5, impressions: 60, ctr: 0.08, position: 6 },
      { organizationId: ctx.org.id, websiteId: w.id, date: day, query: "widget repair", page: `${TARGET}/blog/repair`, clicks: 2, impressions: 40, ctr: 0.05, position: 9 },
    ] });
    const ins = await searchConsoleInsights(ctx, w.id);
    expect(ins!.cannibalization[0].query).toBe("widget repair");
    expect(ins!.cannibalization[0].competing).toHaveLength(2);
    expect(ins!.strikingDistance[0].query).toBe("widget repair");
  });
});

describe("outreach CRM", () => {
  it("researches a prospect: relevance, published contacts, broken outbound links; dedupes", async () => {
    const { ctx, w } = await site();
    await addKeywords(ctx, w.id, [{ phrase: "widget maintenance schedule" }, { phrase: "widget inspection checklist" }]);
    const r = await researchProspect(w.id, `${web.origin}/resources`);
    expect(r.contacts).toEqual([{ email: "editor@resources.example", source: "mailto link on page" }]);
    expect(r.brokenOutboundLinks[0].href).toContain("/dead-tool");
    expect(r.relevanceScore).toBeGreaterThan(30);
    expect(r.relevanceReason).toMatch(/topic terms/);
    const { prospect } = await addProspect(ctx, w.id, { url: `${web.origin}/resources` });
    expect(prospect.contactEmail).toBe("editor@resources.example");
    expect(prospect.type).toBe("BROKEN_LINK");
    await expect(addProspect(ctx, w.id, { url: `${web.origin}/resources` })).rejects.toThrow(/already in the pipeline/);
    const mention = await researchProspect(w.id, `${web.origin}/mention`);
    expect(mention.suggestedType).toBe("UNLINKED_MENTION");
  });

  it("drafts, requires a second person's approval, sends, schedules follow-up and verifies acquired links", async () => {
    const { ctx, w } = await site("MANAGER");
    const { prospect } = await addProspect(ctx, w.id, { url: `${web.origin}/links-page`, contactEmail: "pat@links.example", contactName: "Pat", research: false });
    const tpl = await saveTemplate(ctx, { name: "Resource", subject: "Resource for {{prospect_domain}}", body: "Hi {{contact_name}}, we noticed your page {{prospect_url}}. Our guide at {{target_url}} might help. – {{sender_name}}" });
    const camp = await createCampaign(ctx, w.id, { name: "Q4", templateId: tpl.id, followUpDays: 4 });
    const d = await draftCampaignMessages(ctx, camp.id, [prospect.id]);
    expect(d.drafted).toBe(1);
    const msg = await ctx.db.outreachMessage.findFirstOrThrow({ where: { prospectId: prospect.id } });
    expect(msg.body).toContain("Hi Pat");
    expect(msg.status).toBe("DRAFT");

    const approval = await requestSendApproval(ctx, [msg.id]);
    await expect(decideApproval(ctx, approval.id, "APPROVED")).rejects.toThrow(/someone other than the requester/);
    const other = await makeContext("ADMIN", { orgId: ctx.org.id });
    await decideApproval(other, approval.id, "APPROVED");
    const r = await processOutreachSend({ ...jc(ctx.org.id, w.id, { approvalId: approval.id, messageIds: [msg.id] }) });
    expect(r.sent).toBe(1);
    expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(ctx.org.id, expect.objectContaining({ to: "pat@links.example" }));
    const p2 = await ctx.db.outreachProspect.findUniqueOrThrow({ where: { id: prospect.id } });
    expect(p2.stage).toBe("CONTACTED");
    expect(p2.nextFollowUpAt!.getTime()).toBeGreaterThan(Date.now() + 3 * 86400_000);

    await setProspectStage(ctx, prospect.id, "ACQUIRED", { acquiredLinkUrl: `${web.origin}/links-page` });
    const { verifyAcquiredOutreachLinks } = await import("@/server/backlinks");
    await verifyAcquiredOutreachLinks(w.id);
    expect((await ctx.db.outreachProspect.findUniqueOrThrow({ where: { id: prospect.id } })).stage).toBe("VERIFIED");
    expect(await ctx.db.backlink.count({ where: { websiteId: w.id, source: "outreach", status: "ACTIVE" } })).toBe(1);
  });

  it("renders template variables", () => {
    expect(renderTemplate("Hi {{ contact_name }} from {{site_name}}{{unknown}}", { contact_name: "Al", site_name: "Acme" })).toBe("Hi Al from Acme");
  });
});

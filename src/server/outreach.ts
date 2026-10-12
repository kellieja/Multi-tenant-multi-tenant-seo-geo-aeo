import * as cheerio from "cheerio";
import { z } from "zod";
import type { OpportunityType, OutreachStage, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { OrgContext } from "@/lib/auth/context";
import { assertWebsiteAccess } from "@/lib/auth/context";
import type { JobContext } from "@/lib/jobs/context";
import { enqueueJob } from "@/lib/jobs/queue";
import { UserError } from "@/lib/errors";
import { hostOf, isSameSite, normalizeUrl } from "@/lib/url";
import { safeFetch } from "@/lib/net/safe-fetch";
import { parseRobots, isAllowed } from "@/crawler/robots";
import { findConnection, withSyncLog } from "@/integrations/connections";
import { DataForSeoClient } from "@/integrations/dataforseo";
import { requestApproval, assertApproved } from "./approvals";
import { sendEmail } from "./delivery";
import { notify } from "./notifications";

export const STAGES: OutreachStage[] = ["DISCOVERED", "QUALIFIED", "CONTACTED", "RESPONDED", "NEGOTIATING", "ACQUIRED", "VERIFIED", "LOST", "REJECTED"];
export const DAILY_SEND_CAP = Number(process.env.OUTREACH_DAILY_CAP ?? 50);

const STOP = new Set("the a an and or of to in on for with by is are be this that it as at from your our you we they their its was were has have not but can will about more".split(" "));
const terms = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w));

// ───────────── Research

export interface ProspectResearch {
  url: string;
  domain: string;
  title: string | null;
  relevanceScore: number;
  relevanceReason: string;
  contacts: { email: string; source: string }[];
  brokenOutboundLinks: { href: string; anchor: string; status: number | null }[];
  mentionsBrand: boolean;
  linksToSite: boolean;
  suggestedType: OpportunityType;
}

/**
 * Fetches a candidate page (respecting robots.txt), scores topical relevance against the
 * site's tracked keywords and brand terms, finds broken outbound links (replacement pitch)
 * and publicly listed contact emails. Never guesses or scrapes private contact data.
 */
export async function researchProspect(websiteId: string, url: string): Promise<ProspectResearch> {
  const site = await prisma.website.findUniqueOrThrow({ where: { id: websiteId } });
  const ua = process.env.CRAWLER_USER_AGENT ?? "SearchOpsBot/1.0";
  const target = new URL(url);
  const robotsRes = await safeFetch(`${target.origin}/robots.txt`, { headers: { "user-agent": ua }, maxBytes: 256 * 1024, timeoutMs: 10_000 }).catch(() => null);
  const robots = robotsRes?.status === 200 ? parseRobots(robotsRes.body) : null;
  if (!isAllowed(robots, ua, url).allowed) throw new UserError("That site's robots.txt disallows fetching this page");
  const res = await safeFetch(url, { headers: { "user-agent": ua, accept: "text/html" }, maxBytes: 4 * 1024 * 1024 });
  if (res.status >= 400) throw new UserError(`Page returned HTTP ${res.status}`);
  const $ = cheerio.load(res.body);
  const title = $("title").first().text().trim() || null;
  $("script,style,noscript").remove();
  const text = $("body").text().replace(/\s+/g, " ").slice(0, 50_000);

  // Relevance: overlap between page terms and the site's topic vocabulary.
  const keywords = await prisma.keyword.findMany({ where: { websiteId }, select: { phrase: true }, take: 500 });
  const vocab = new Set([...keywords.flatMap((k) => terms(k.phrase)), ...terms(site.industry ?? ""), ...site.tags.flatMap(terms)]);
  const pageTerms = new Set(terms(`${title ?? ""} ${text}`));
  const matched = [...vocab].filter((t) => pageTerms.has(t));
  const coverage = vocab.size ? matched.length / vocab.size : 0;
  const relevanceScore = Math.round(Math.min(100, coverage * 250 + (matched.length >= 5 ? 15 : 0)));
  const relevanceReason = vocab.size
    ? `${matched.length} of ${vocab.size} topic terms from your tracked keywords appear on the page${matched.length ? ` (e.g. ${matched.slice(0, 6).join(", ")})` : ""}.`
    : "Add tracked keywords to this website to enable relevance scoring.";

  const mentionsBrand = site.brandTerms.some((b) => b && text.toLowerCase().includes(b.toLowerCase()));
  const outbound: { href: string; anchor: string }[] = [];
  let linksToSite = false;
  $("a[href]").each((_, el) => {
    const href = normalizeUrl($(el).attr("href")!, res.finalUrl);
    if (!href) return;
    if (isSameSite(href, site.domain)) linksToSite = true;
    else if (!isSameSite(href, hostOf(res.finalUrl))) outbound.push({ href, anchor: $(el).text().replace(/\s+/g, " ").trim().slice(0, 120) });
  });
  const brokenOutboundLinks: ProspectResearch["brokenOutboundLinks"] = [];
  for (const l of [...new Map(outbound.map((o) => [o.href, o])).values()].slice(0, 25)) {
    try {
      const r = await safeFetch(l.href, { method: "HEAD", headers: { "user-agent": ua }, timeoutMs: 8000 });
      if (r.status === 404 || r.status === 410 || r.status >= 500) brokenOutboundLinks.push({ ...l, status: r.status });
    } catch {
      brokenOutboundLinks.push({ ...l, status: null });
    }
  }

  // Publicly listed contacts: mailto links on the page, then a same-site /contact page.
  const contacts = new Map<string, string>();
  const collect = (html: string, source: string) => {
    const c$ = cheerio.load(html);
    c$('a[href^="mailto:"]').each((_, el) => {
      const email = (c$(el).attr("href") ?? "").slice(7).split("?")[0].trim().toLowerCase();
      if (z.string().email().safeParse(email).success) contacts.set(email, source);
    });
  };
  collect(res.body, "mailto link on page");
  if (!contacts.size) {
    const contactUrl = $("a[href]").map((_, el) => $(el).attr("href")).get().map((h) => normalizeUrl(h, res.finalUrl)).find((h) => h && isSameSite(h, hostOf(res.finalUrl)) && /contact|about|write-for-us|contribute/i.test(h));
    if (contactUrl && isAllowed(robots, ua, contactUrl).allowed) {
      const c = await safeFetch(contactUrl, { headers: { "user-agent": ua }, maxBytes: 2 * 1024 * 1024 }).catch(() => null);
      if (c?.status === 200) collect(c.body, `mailto link on ${contactUrl}`);
    }
  }

  const suggestedType: OpportunityType = mentionsBrand && !linksToSite ? "UNLINKED_MENTION" : brokenOutboundLinks.length ? "BROKEN_LINK" : /resources?|links|useful|tools/i.test(`${title} ${url}`) ? "RESOURCE_PAGE" : /write-for-us|contribute|guest/i.test(`${url} ${text.slice(0, 5000)}`) ? "GUEST_CONTRIBUTION" : /podcast|episode/i.test(`${title} ${url}`) ? "PODCAST_INTERVIEW" : "OTHER";
  return { url: res.finalUrl, domain: hostOf(res.finalUrl), title, relevanceScore, relevanceReason, contacts: [...contacts].map(([email, source]) => ({ email, source })), brokenOutboundLinks, mentionsBrand, linksToSite, suggestedType };
}

// ───────────── Prospects

export const prospectSchema = z.object({
  url: z.string().trim().url(),
  type: z.enum(["INDUSTRY_PUBLICATION", "RESOURCE_PAGE", "ASSOCIATION", "DIRECTORY", "PARTNER_SUPPLIER", "EDITORIAL_MENTION", "UNLINKED_MENTION", "BROKEN_LINK", "GUEST_CONTRIBUTION", "COMPETITOR_GAP", "PODCAST_INTERVIEW", "OTHER"]).optional(),
  contactName: z.string().trim().max(120).optional().nullable(),
  contactEmail: z.string().trim().toLowerCase().email().optional().nullable().or(z.literal("").transform(() => null)),
  targetUrl: z.string().trim().url().optional().nullable().or(z.literal("").transform(() => null)),
  notes: z.string().trim().max(5000).optional().nullable(),
  research: z.coerce.boolean().default(true),
});

export async function addProspect(ctx: OrgContext, websiteId: string, input: z.input<typeof prospectSchema>) {
  ctx.assert("outreach:write");
  await assertWebsiteAccess(ctx, websiteId);
  const p = prospectSchema.parse(input);
  const url = normalizeUrl(p.url)!;
  const domain = hostOf(url);
  const existing = await ctx.db.outreachProspect.findFirst({ where: { websiteId, OR: [{ url }, { domain }] } });
  if (existing?.url === url) throw new UserError("This page is already in the pipeline");
  let r: ProspectResearch | null = null;
  let researchError: string | null = null;
  if (p.research) {
    try { r = await researchProspect(websiteId, url); } catch (err) { researchError = (err as Error).message; }
  }
  const brokenNote = r?.brokenOutboundLinks.length ? `\nBroken outbound links on the page (replacement opportunity):\n${r.brokenOutboundLinks.map((b) => `- ${b.href} (${b.status ?? "unreachable"}) "${b.anchor}"`).join("\n")}` : "";
  const prospect = await ctx.db.outreachProspect.create({
    data: {
      organizationId: ctx.org.id, websiteId, url, domain, type: p.type ?? r?.suggestedType ?? "OTHER", discoverySource: "manual",
      relevanceScore: r?.relevanceScore ?? null, relevanceReason: r?.relevanceReason ?? (researchError ? `Research failed: ${researchError}` : null),
      contactName: p.contactName ?? null, contactEmail: p.contactEmail ?? r?.contacts[0]?.email ?? null,
      contactSource: p.contactEmail ? "entered manually" : r?.contacts[0]?.source ?? null,
      targetUrl: p.targetUrl ?? null,
      notes: [p.notes, existing ? `Note: ${domain} already has another prospect in the pipeline.` : null, r?.title ? `Page title: ${r.title}` : null, brokenNote || null].filter(Boolean).join("\n") || null,
    },
  });
  return { prospect, research: r, duplicateDomain: Boolean(existing) };
}

export async function setProspectStage(ctx: OrgContext, id: string, stage: OutreachStage, extra: { acquiredLinkUrl?: string; note?: string } = {}) {
  ctx.assert("outreach:write");
  const p = await ctx.db.outreachProspect.findUnique({ where: { id } });
  if (!p) throw new UserError("Prospect not found");
  if (stage === "VERIFIED") throw new UserError("Links are verified automatically after you mark them acquired");
  if (stage === "ACQUIRED") {
    const link = z.string().url("Enter the URL of the page that now links to you").parse(extra.acquiredLinkUrl);
    await ctx.db.outreachProspect.update({ where: { id }, data: { stage, acquiredLinkUrl: link, nextFollowUpAt: null } });
    await enqueueJob({ organizationId: ctx.org.id, websiteId: p.websiteId, type: "backlink-verify", payload: { limit: 0 }, createdById: ctx.userId });
    return;
  }
  await ctx.db.outreachProspect.update({
    where: { id },
    data: { stage, ...(["RESPONDED", "NEGOTIATING", "LOST", "REJECTED"].includes(stage) ? { nextFollowUpAt: null } : {}), ...(extra.note ? { notes: `${p.notes ?? ""}\n[${new Date().toISOString().slice(0, 10)}] ${extra.note}`.trim() } : {}) },
  });
}

export async function recordReply(ctx: OrgContext, prospectId: string, body: string) {
  ctx.assert("outreach:write");
  const p = await ctx.db.outreachProspect.findUnique({ where: { id: prospectId } });
  if (!p) throw new UserError("Prospect not found");
  await ctx.db.outreachMessage.create({ data: { organizationId: ctx.org.id, prospectId, direction: "INBOUND", subject: "Reply", body: body.slice(0, 20000), status: "SENT", sentAt: new Date() } });
  await ctx.db.outreachProspect.update({ where: { id: prospectId }, data: { stage: "RESPONDED", nextFollowUpAt: null } });
}

// ───────────── Discovery (licensed data)

/** Competitor link gap: domains linking to competitors but not to this site. */
export async function discoverLinkGap(jc: JobContext) {
  const websiteId = jc.job.websiteId!;
  const site = await prisma.website.findUniqueOrThrow({ where: { id: websiteId } });
  const conn = await findConnection(site.organizationId, "DATAFORSEO", null);
  if (!conn) throw new Error("Link-gap discovery needs DataForSEO");
  const competitors = await prisma.competitor.findMany({ where: { websiteId }, take: 5 });
  if (!competitors.length) throw new Error("Add competitors for this website first (Competitor Intelligence)");
  const dfs = new DataForSeoClient(conn);
  return withSyncLog(conn, "backlinks.link_gap", websiteId, async () => {
    const rows = await dfs.domainIntersection(competitors.map((c) => c.domain), site.domain, 200);
    let added = 0;
    for (const r of rows) {
      const url = `https://${r.domain}/`;
      const exists = await prisma.outreachProspect.findFirst({ where: { websiteId, domain: r.domain } });
      if (exists) continue;
      await prisma.outreachProspect.create({ data: { organizationId: site.organizationId, websiteId, url, domain: r.domain, type: "COMPETITOR_GAP", discoverySource: "dataforseo link gap", relevanceScore: r.rank != null ? Math.round(r.rank / 10) : null, relevanceReason: `Links to ${r.linksTo.join(", ")} but not to ${site.domain}. Domain rank ${r.rank ?? "n/a"} (DataForSEO, 0–1000; not a Google metric).` } });
      added++;
    }
    return { items: rows.length, cost: dfs.cost, message: `${added} new competitor-gap prospects` };
  });
}

/** Unlinked brand mentions: pages mentioning brand terms that don't link to the site. */
export async function discoverUnlinkedMentions(jc: JobContext) {
  const websiteId = jc.job.websiteId!;
  const site = await prisma.website.findUniqueOrThrow({ where: { id: websiteId } });
  const conn = await findConnection(site.organizationId, "DATAFORSEO", null);
  if (!conn) throw new Error("Unlinked-mention discovery needs DataForSEO");
  const dfs = new DataForSeoClient(conn);
  return withSyncLog(conn, "content.mentions", websiteId, async () => {
    let added = 0, checked = 0;
    for (const term of site.brandTerms.slice(0, 3)) {
      const results = await dfs.contentSearch(term, 50);
      for (const r of results) {
        if (isSameSite(r.url, site.domain)) continue;
        const url = normalizeUrl(r.url);
        if (!url || (await prisma.outreachProspect.findFirst({ where: { websiteId, url } }))) continue;
        checked++;
        const page = await safeFetch(url, { maxBytes: 3 * 1024 * 1024, timeoutMs: 15_000 }).catch(() => null);
        if (!page || page.status >= 400) continue;
        const $ = cheerio.load(page.body);
        const links = $("a[href]").map((_, el) => normalizeUrl($(el).attr("href")!, page.finalUrl)).get().filter(Boolean) as string[];
        if (links.some((l) => isSameSite(l, site.domain))) continue;
        await prisma.outreachProspect.create({ data: { organizationId: site.organizationId, websiteId, url, domain: hostOf(url), type: "UNLINKED_MENTION", discoverySource: "dataforseo content search", relevanceScore: 70, relevanceReason: `Mentions “${term}” without linking to ${site.domain}${r.content_info?.title ? ` (“${r.content_info.title}”)` : ""}. A polite request to add a link is usually well received.` } });
        added++;
        await jc.progress(Math.min(95, checked * 2), `Checked ${checked} mentions`);
      }
    }
    return { items: checked, cost: dfs.cost, message: `${added} unlinked mentions found` };
  });
}

// ───────────── Templates, campaigns, messages

export const templateSchema = z.object({ name: z.string().trim().min(1).max(120), subject: z.string().trim().min(1).max(300), body: z.string().trim().min(20).max(20000) });
export const TEMPLATE_VARS = ["contact_name", "prospect_domain", "prospect_url", "target_url", "site_name", "site_domain", "sender_name"];

export function renderTemplate(tpl: string, vars: Record<string, string>) {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? "");
}

export async function saveTemplate(ctx: OrgContext, input: unknown, id?: string) {
  ctx.assert("outreach:write");
  const t = templateSchema.parse(input);
  return id ? ctx.db.outreachTemplate.update({ where: { id }, data: t }) : ctx.db.outreachTemplate.create({ data: { ...t, organizationId: ctx.org.id } });
}

export async function createCampaign(ctx: OrgContext, websiteId: string, input: { name: string; templateId?: string | null; followUpDays?: number }) {
  ctx.assert("outreach:write");
  await assertWebsiteAccess(ctx, websiteId);
  const name = z.string().trim().min(1).max(120).parse(input.name);
  if (input.templateId && !(await ctx.db.outreachTemplate.findUnique({ where: { id: input.templateId } }))) throw new UserError("Unknown template");
  return ctx.db.outreachCampaign.create({ data: { organizationId: ctx.org.id, websiteId, name, templateId: input.templateId ?? null, followUpDays: Math.min(30, Math.max(2, input.followUpDays ?? 5)), status: "ACTIVE" } });
}

/** Drafts one personalised email per selected prospect from the campaign template. Nothing is sent. */
export async function draftCampaignMessages(ctx: OrgContext, campaignId: string, prospectIds: string[]) {
  ctx.assert("outreach:write");
  const c = await ctx.db.outreachCampaign.findUnique({ where: { id: campaignId } });
  if (!c?.templateId) throw new UserError("Campaign needs a template");
  const tpl = await ctx.db.outreachTemplate.findUniqueOrThrow({ where: { id: c.templateId } });
  const site = await ctx.db.website.findUniqueOrThrow({ where: { id: c.websiteId } });
  const prospects = await ctx.db.outreachProspect.findMany({ where: { id: { in: prospectIds }, websiteId: c.websiteId } });
  let drafted = 0;
  const skipped: string[] = [];
  for (const p of prospects) {
    if (!p.contactEmail) { skipped.push(`${p.domain}: no contact email`); continue; }
    if (["REJECTED", "LOST", "ACQUIRED", "VERIFIED"].includes(p.stage)) { skipped.push(`${p.domain}: stage ${p.stage.toLowerCase()}`); continue; }
    if (await ctx.db.outreachMessage.findFirst({ where: { prospectId: p.id, status: { in: ["DRAFT", "PENDING_APPROVAL", "APPROVED"] } } })) { skipped.push(`${p.domain}: already has a draft`); continue; }
    const vars = { contact_name: p.contactName ?? "there", prospect_domain: p.domain, prospect_url: p.url, target_url: p.targetUrl ?? site.baseUrl, site_name: site.name, site_domain: site.domain, sender_name: ctx.userName };
    await ctx.db.outreachMessage.create({ data: { organizationId: ctx.org.id, prospectId: p.id, direction: "OUTBOUND", subject: renderTemplate(tpl.subject, vars), body: renderTemplate(tpl.body, vars), status: "DRAFT" } });
    await ctx.db.outreachProspect.update({ where: { id: p.id }, data: { campaignId: c.id, stage: p.stage === "DISCOVERED" ? "QUALIFIED" : p.stage } });
    drafted++;
  }
  return { drafted, skipped };
}

export async function updateDraft(ctx: OrgContext, messageId: string, subject: string, body: string) {
  ctx.assert("outreach:write");
  const m = await ctx.db.outreachMessage.findUnique({ where: { id: messageId } });
  if (!m || m.status !== "DRAFT") throw new UserError("Only drafts can be edited");
  return ctx.db.outreachMessage.update({ where: { id: messageId }, data: { subject: subject.slice(0, 300), body: body.slice(0, 20000) } });
}

/** Every send, single or bulk, requires an approval decided by someone other than the requester. */
export async function requestSendApproval(ctx: OrgContext, messageIds: string[]) {
  ctx.assert("outreach:write");
  const msgs = await ctx.db.outreachMessage.findMany({ where: { id: { in: messageIds }, status: "DRAFT" }, include: { prospect: true } });
  if (!msgs.length) throw new UserError("Select at least one draft");
  if (msgs.length > 200) throw new UserError("Request approval for at most 200 emails at a time");
  const websiteId = msgs[0].prospect.websiteId;
  if (msgs.some((m) => m.prospect.websiteId !== websiteId)) throw new UserError("Send approvals are per website");
  await ctx.db.outreachMessage.updateMany({ where: { id: { in: msgs.map((m) => m.id) } }, data: { status: "PENDING_APPROVAL" } });
  const a = await requestApproval({
    organizationId: ctx.org.id, websiteId, kind: "OUTREACH_SEND", subjectType: "OutreachBatch", subjectId: `batch-${Date.now()}-${msgs[0].id.slice(-6)}`, requestedById: ctx.userId,
    summary: `Send ${msgs.length} outreach email${msgs.length > 1 ? "s" : ""} (${[...new Set(msgs.map((m) => m.prospect.domain))].slice(0, 4).join(", ")}${msgs.length > 4 ? ", …" : ""})`,
    payload: { messageIds: msgs.map((m) => m.id), sample: { to: msgs[0].prospect.contactEmail, subject: msgs[0].subject, body: msgs[0].body.slice(0, 1500) } },
  });
  await ctx.db.outreachMessage.updateMany({ where: { id: { in: msgs.map((m) => m.id) } }, data: { approvalId: a.id } });
  return a;
}

/** Worker: sends approved emails through the org's SMTP connection, respecting a daily cap. */
export async function processOutreachSend(jc: JobContext) {
  const { approvalId, messageIds } = jc.job.payload as { approvalId: string; messageIds: string[] };
  const approval = await prisma.approval.findUniqueOrThrow({ where: { id: approvalId } });
  if (approval.organizationId !== jc.job.organizationId) throw new Error("Tenant mismatch");
  await assertApproved(approval.organizationId, approvalId, approval.subjectType, approval.subjectId);
  const startOfDay = new Date(new Date().toISOString().slice(0, 10));
  let sentToday = await prisma.outreachMessage.count({ where: { organizationId: approval.organizationId, direction: "OUTBOUND", status: "SENT", sentAt: { gte: startOfDay } } });
  const msgs = await prisma.outreachMessage.findMany({ where: { id: { in: messageIds }, approvalId, status: "APPROVED" }, include: { prospect: { include: { campaign: true } } } });
  let sent = 0, failed = 0, deferred = 0;
  for (const m of msgs) {
    if (sentToday >= DAILY_SEND_CAP) { deferred++; continue; }
    if (!m.prospect.contactEmail || ["REJECTED", "LOST"].includes(m.prospect.stage)) {
      await prisma.outreachMessage.update({ where: { id: m.id }, data: { status: "FAILED", error: "Prospect has no contact email or opted out" } });
      failed++;
      continue;
    }
    try {
      const id = await sendEmail(approval.organizationId, { to: m.prospect.contactEmail, subject: m.subject, text: m.body });
      await prisma.outreachMessage.update({ where: { id: m.id }, data: { status: "SENT", sentAt: new Date(), providerMessageId: id ?? null } });
      await prisma.outreachProspect.update({ where: { id: m.prospectId }, data: { stage: ["DISCOVERED", "QUALIFIED"].includes(m.prospect.stage) ? "CONTACTED" : m.prospect.stage, nextFollowUpAt: new Date(Date.now() + (m.prospect.campaign?.followUpDays ?? 5) * 86400_000) } });
      sent++; sentToday++;
    } catch (err) {
      await prisma.outreachMessage.update({ where: { id: m.id }, data: { status: "FAILED", error: (err as Error).message.slice(0, 500) } });
      failed++;
    }
    await jc.progress(Math.round(((sent + failed) / msgs.length) * 100));
  }
  if (deferred) {
    // Re-queue the remainder for tomorrow; the approval still covers them.
    await enqueueJob({ organizationId: approval.organizationId, websiteId: approval.websiteId, type: "outreach-send", payload: { approvalId, messageIds }, delayMs: 24 * 3600_000 });
  }
  if (failed && !sent) throw new Error(`All ${failed} sends failed. Check the SMTP integration.`);
  return { sent, failed, deferred };
}

/** Scheduler: one reminder per due follow-up (never auto-sends). */
export async function followUpReminders(now: Date) {
  const due = await prisma.outreachProspect.findMany({ where: { stage: "CONTACTED", nextFollowUpAt: { lte: now } }, take: 500 });
  for (const p of due) {
    await notify({ organizationId: p.organizationId, websiteId: p.websiteId, type: "outreach_followup", title: `Follow up with ${p.domain}`, body: "No reply recorded since the last email. Draft a follow-up or update the stage.", link: `/backlinks?tab=outreach&websiteId=${p.websiteId}` });
    await prisma.outreachProspect.update({ where: { id: p.id }, data: { nextFollowUpAt: null } });
  }
  return due.length;
}

export async function outreachReport(ctx: OrgContext, websiteId: string) {
  await assertWebsiteAccess(ctx, websiteId);
  const [byStage, sent, replies, verified] = await Promise.all([
    ctx.db.outreachProspect.groupBy({ by: ["stage"], where: { websiteId }, _count: true }),
    ctx.db.outreachMessage.count({ where: { direction: "OUTBOUND", status: "SENT", prospect: { websiteId } } }),
    ctx.db.outreachMessage.count({ where: { direction: "INBOUND", prospect: { websiteId } } }),
    ctx.db.outreachProspect.findMany({ where: { websiteId, stage: "VERIFIED" }, select: { domain: true, acquiredLinkUrl: true, updatedAt: true }, orderBy: { updatedAt: "desc" }, take: 20 }),
  ]);
  return { byStage: Object.fromEntries(byStage.map((s) => [s.stage, s._count])) as Record<string, number>, sent, replies, verified };
}

export type { Prisma };

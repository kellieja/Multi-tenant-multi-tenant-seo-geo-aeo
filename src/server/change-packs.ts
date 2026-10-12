import type { ChangePack, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { OrgContext } from "@/lib/auth/context";
import { assertWebsiteAccess } from "@/lib/auth/context";
import { UserError } from "@/lib/errors";
import { writeAuditLog } from "@/lib/audit-log";
import { normalizeUrl } from "@/lib/url";
import { notify } from "./notifications";
import { siteNeedsRendering } from "./page-fetch";

export type PackItemKind = "title" | "meta_description" | "internal_link" | "answer_section" | "issue";

export interface PackItem {
  id: string;
  kind: PackItemKind;
  url: string;
  current: string | null;
  proposed: string;
  /** Extra context: link anchor/paragraph, answer heading, issue recommendation. */
  detail?: Record<string, string | null>;
  sourceType: "ContentSuggestion" | "InternalLinkSuggestion" | "AuditFinding";
  sourceId: string;
  status: "pending" | "done";
  doneAt?: string;
}

const path = (u: string) => { try { const x = new URL(u); return `${x.pathname}${x.search}` || "/"; } catch { return u; } };
const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** Approved work for a website that isn't already in an open pack or applied through a CMS connector. */
export async function collectPendingItems(organizationId: string, websiteId: string, opts: { includeIssues?: boolean } = {}): Promise<Omit<PackItem, "id" | "status">[]> {
  const open = await prisma.changePack.findMany({ where: { organizationId, websiteId, status: "OPEN" }, select: { items: true } });
  const taken = new Set(open.flatMap((p) => (p.items as unknown as PackItem[]).map((i) => `${i.sourceType}:${i.sourceId}:${i.kind}`)));
  const items: Omit<PackItem, "id" | "status">[] = [];
  const push = (i: Omit<PackItem, "id" | "status">) => { if (!taken.has(`${i.sourceType}:${i.sourceId}:${i.kind}`)) items.push(i); };

  const suggestions = await prisma.contentSuggestion.findMany({ where: { organizationId, websiteId, status: "APPROVED", kind: { in: ["METADATA", "AEO_ANSWER"] }, url: { not: null } }, orderBy: { updatedAt: "asc" } });
  for (const s of suggestions) {
    const out = JSON.parse(s.output) as { title?: string; metaDescription?: string; heading?: string; answer?: string };
    const inp = (s.input ?? {}) as { currentTitle?: string | null; currentMetaDescription?: string | null; question?: string };
    if (s.kind === "METADATA") {
      if (out.title && norm(out.title) !== norm(inp.currentTitle)) push({ kind: "title", url: s.url!, current: inp.currentTitle ?? null, proposed: out.title, sourceType: "ContentSuggestion", sourceId: s.id });
      if (out.metaDescription && norm(out.metaDescription) !== norm(inp.currentMetaDescription)) push({ kind: "meta_description", url: s.url!, current: inp.currentMetaDescription ?? null, proposed: out.metaDescription, sourceType: "ContentSuggestion", sourceId: s.id });
    } else if (out.answer) {
      push({ kind: "answer_section", url: s.url!, current: null, proposed: out.answer, detail: { heading: out.heading ?? inp.question ?? null, question: inp.question ?? null }, sourceType: "ContentSuggestion", sourceId: s.id });
    }
  }

  const links = await prisma.internalLinkSuggestion.findMany({ where: { organizationId, websiteId, status: "APPROVED", changeId: null }, orderBy: { score: "desc" } });
  for (const l of links) push({ kind: "internal_link", url: l.sourceUrl, current: null, proposed: l.targetUrl, detail: { anchor: l.anchor, paragraph: l.sourceParagraph.slice(0, 400) }, sourceType: "InternalLinkSuggestion", sourceId: l.id });

  if (opts.includeIssues) {
    const findings = await prisma.auditFinding.findMany({ where: { organizationId, websiteId, status: { in: ["OPEN", "REGRESSED"] }, severity: { in: ["CRITICAL", "HIGH"] } }, orderBy: { priorityScore: "desc" }, take: 25 });
    for (const f of findings) push({ kind: "issue", url: f.url, current: null, proposed: f.recommendation, detail: { title: f.title, implementation: f.implementation, severity: f.severity }, sourceType: "AuditFinding", sourceId: f.id });
  }
  return items;
}

export async function createChangePack(ctx: OrgContext, websiteId: string, opts: { includeIssues?: boolean; title?: string } = {}) {
  ctx.assert("content:write");
  const site = await assertWebsiteAccess(ctx, websiteId);
  const pending = await collectPendingItems(ctx.org.id, websiteId, opts);
  if (!pending.length) throw new UserError("Nothing to include yet. Approve titles/meta, answer sections or internal links first (or include open high-priority issues).");
  const items: PackItem[] = pending.map((p, n) => ({ ...p, id: `i${n + 1}`, status: "pending" }));
  const pack = await ctx.db.changePack.create({
    data: {
      organizationId: ctx.org.id, websiteId, createdById: ctx.userId,
      title: opts.title?.trim() || `${site.name} changes – ${new Date().toISOString().slice(0, 10)}`,
      items: items as unknown as Prisma.InputJsonValue,
    },
  });
  await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: "change_pack.create", entityType: "ChangePack", entityId: pack.id, metadata: { items: items.length } });
  return pack;
}

export const packItems = (p: Pick<ChangePack, "items">) => p.items as unknown as PackItem[];

// ───────────── Outputs

const KIND_LABEL: Record<PackItemKind, string> = { title: "Title tag", meta_description: "Meta description", internal_link: "Internal link", answer_section: "Answer section", issue: "Fix issue" };

/** Human checklist (Markdown) a developer or site owner can follow. */
export function packMarkdown(pack: Pick<ChangePack, "title" | "items" | "createdAt">, site: { name: string; domain: string }) {
  const items = packItems(pack);
  const lines = [`# ${pack.title}`, "", `Website: ${site.name} (${site.domain}) · ${items.length} change(s) · created ${pack.createdAt.toISOString().slice(0, 10)}`, "", "Each item is checked automatically on the next crawl. Change only what is listed.", ""];
  const byUrl = new Map<string, PackItem[]>();
  for (const i of items) byUrl.set(i.url, [...(byUrl.get(i.url) ?? []), i]);
  for (const [url, list] of byUrl) {
    lines.push(`## ${path(url)}`, "", url, "");
    for (const i of list) {
      const box = i.status === "done" ? "[x]" : "[ ]";
      if (i.kind === "title" || i.kind === "meta_description") {
        lines.push(`- ${box} **${KIND_LABEL[i.kind]}**`, `  - Current: ${i.current ? `\`${i.current}\`` : "_(none)_"}`, `  - New: \`${i.proposed}\``);
      } else if (i.kind === "internal_link") {
        lines.push(`- ${box} **Internal link**: in the paragraph below, make "${i.detail?.anchor}" a link to ${i.proposed}`, `  > ${i.detail?.paragraph ?? ""}`);
      } else if (i.kind === "answer_section") {
        lines.push(`- ${box} **Answer section**: add a section headed "${i.detail?.heading ?? ""}" with this text (check every fact first):`, "", ...i.proposed.split("\n").map((l) => `  > ${l}`));
      } else {
        lines.push(`- ${box} **${i.detail?.title ?? "Issue"}** (${(i.detail?.severity ?? "").toLowerCase()}): ${i.proposed}`, i.detail?.implementation ? `  - How: ${i.detail.implementation}` : "");
      }
    }
    lines.push("");
  }
  return lines.filter((l, n, a) => !(l === "" && a[n - 1] === "")).join("\n");
}

/**
 * A prompt for Replit Agent (or any coding assistant) that makes exactly these edits in the
 * site's source. It forbids unrelated changes and invented facts, and on JavaScript-rendered
 * sites asks for metadata in the served HTML, not just in the browser.
 */
export function packPrompt(pack: Pick<ChangePack, "items">, site: { name: string; domain: string }, opts: { jsRendered: boolean }) {
  const items = packItems(pack).filter((i) => i.status !== "done");
  const out: string[] = [
    `Make the following SEO changes to this website (${site.domain}). Change only what is listed: no redesigns, no new dependencies unless a step needs one, and no new facts beyond the text given.`,
    "",
  ];
  if (opts.jsRendered) {
    out.push(
      "This site renders its pages with JavaScript. Titles, meta descriptions and main content must also be present in the HTML the server sends for each URL, because many crawlers don't run JavaScript. If the project can't do that yet, add per-route metadata in the router (for example with react-helmet-async) AND enable pre-rendering of these routes at build time. Tell me which approach you used.",
      "",
    );
  }
  let n = 0;
  for (const i of items) {
    n++;
    const where = `the page served at ${path(i.url)}`;
    if (i.kind === "title") out.push(`${n}. On ${where}, set the <title> to exactly: ${JSON.stringify(i.proposed)}`);
    else if (i.kind === "meta_description") out.push(`${n}. On ${where}, set <meta name="description"> to exactly: ${JSON.stringify(i.proposed)}`);
    else if (i.kind === "internal_link") out.push(`${n}. On ${where}, in the paragraph starting ${JSON.stringify((i.detail?.paragraph ?? "").slice(0, 80))}, turn the words ${JSON.stringify(i.detail?.anchor ?? "")} into a normal link (<a href>) to ${path(i.proposed)}. Don't change the wording.`);
    else if (i.kind === "answer_section") out.push(`${n}. On ${where}, add a section with the heading ${JSON.stringify(i.detail?.heading ?? "")} followed by this text, using the page's existing styles:\n${i.proposed}`);
    else out.push(`${n}. ${i.detail?.title ?? "Fix"} on ${where}: ${i.proposed}${i.detail?.implementation ? ` (${i.detail.implementation})` : ""}`);
  }
  out.push("", "When you're done, list each numbered change and the file you edited, then deploy the site so the changes go live.");
  return out.join("\n");
}

// ───────────── Verification after each crawl

/**
 * Marks pack items done when the latest crawl shows them live, and closes packs whose items are
 * all done. Sources (suggestions) are marked APPLIED so they leave the review queues.
 */
export async function verifyChangePacks(websiteId: string, crawlId: string) {
  const packs = await prisma.changePack.findMany({ where: { websiteId, status: "OPEN" } });
  if (!packs.length) return { checked: 0, newlyDone: 0 };
  const pages = await prisma.crawledPage.findMany({ where: { crawlId }, select: { url: true, finalUrl: true, title: true, metaDescription: true, headings: true } });
  const pageBy = new Map<string, (typeof pages)[number]>();
  for (const p of pages) { pageBy.set(p.url, p); if (p.finalUrl) pageBy.set(p.finalUrl, p); }
  const find = (u: string) => pageBy.get(normalizeUrl(u) ?? u) ?? pageBy.get(u);
  let newlyDone = 0;
  for (const pack of packs) {
    const items = packItems(pack);
    const now = new Date().toISOString();
    for (const i of items) {
      if (i.status === "done") continue;
      let done = false;
      const page = find(i.url);
      if (i.kind === "title") done = !!page && norm(page.title) === norm(i.proposed);
      else if (i.kind === "meta_description") done = !!page && norm(page.metaDescription) === norm(i.proposed);
      else if (i.kind === "answer_section") {
        const heading = norm(i.detail?.heading).toLowerCase();
        done = !!page && !!heading && ((page.headings as { text: string }[]) ?? []).some((h) => norm(h.text).toLowerCase() === heading);
      } else if (i.kind === "internal_link") {
        done = !!(await prisma.crawledLink.findFirst({ where: { crawlId, fromUrl: i.url, toUrl: normalizeUrl(i.proposed) ?? i.proposed }, select: { id: true } }));
      } else if (i.kind === "issue") {
        const f = await prisma.auditFinding.findUnique({ where: { id: i.sourceId }, select: { status: true } });
        done = f?.status === "RESOLVED";
      }
      if (!done) continue;
      i.status = "done";
      i.doneAt = now;
      newlyDone++;
      if (i.sourceType === "ContentSuggestion") {
        const siblings = items.filter((x) => x.sourceId === i.sourceId);
        if (siblings.every((x) => x.status === "done")) await prisma.contentSuggestion.updateMany({ where: { id: i.sourceId, status: "APPROVED" }, data: { status: "APPLIED" } });
      } else if (i.sourceType === "InternalLinkSuggestion") {
        await prisma.internalLinkSuggestion.updateMany({ where: { id: i.sourceId, status: "APPROVED" }, data: { status: "APPLIED" } });
      }
    }
    const allDone = items.every((i) => i.status === "done");
    await prisma.changePack.update({ where: { id: pack.id }, data: { items: items as unknown as Prisma.InputJsonValue, lastCheckedAt: new Date(), ...(allDone ? { status: "VERIFIED", verifiedAt: new Date() } : {}) } });
    if (allDone) await notify({ organizationId: pack.organizationId, websiteId, type: "change_pack_verified", severity: "success", title: `All ${items.length} changes are live`, body: pack.title, link: `/automation?tab=packs&id=${pack.id}` });
  }
  return { checked: packs.length, newlyDone };
}

export async function packPromptFor(pack: ChangePack) {
  const site = await prisma.website.findUniqueOrThrow({ where: { id: pack.websiteId }, select: { name: true, domain: true } });
  return packPrompt(pack, site, { jsRendered: await siteNeedsRendering(pack.websiteId) });
}

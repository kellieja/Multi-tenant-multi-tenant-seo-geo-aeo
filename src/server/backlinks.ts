import Papa from "papaparse";
import * as cheerio from "cheerio";
import { z } from "zod";
import type { Backlink, BacklinkStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { OrgContext } from "@/lib/auth/context";
import { assertWebsiteAccess } from "@/lib/auth/context";
import type { JobContext } from "@/lib/jobs/context";
import { UserError } from "@/lib/errors";
import { hostOf, isSameSite, normalizeUrl } from "@/lib/url";
import { safeFetch } from "@/lib/net/safe-fetch";
import { parseRobots, isAllowed } from "@/crawler/robots";
import { findConnection, withSyncLog } from "@/integrations/connections";
import { DataForSeoClient } from "@/integrations/dataforseo";
import { writeAuditLog } from "@/lib/audit-log";
import { notify } from "./notifications";

const backlinkRow = z.object({
  sourceUrl: z.string().trim().url(),
  targetUrl: z.string().trim().url(),
  anchor: z.string().trim().max(500).optional().nullable(),
  rel: z.string().trim().toLowerCase().max(50).optional().nullable(),
  firstSeen: z.string().optional().nullable(),
});

const relOf = (rel?: string | null) => {
  const r = (rel ?? "").toLowerCase();
  if (r.includes("sponsored")) return "sponsored";
  if (r.includes("ugc")) return "ugc";
  if (r.includes("nofollow")) return "nofollow";
  return "follow";
};

/** CSV columns: source_url, target_url, anchor, rel, first_seen (header row required). */
export async function importBacklinksCsv(ctx: OrgContext, websiteId: string, csv: string) {
  ctx.assert("backlinks:write");
  const site = await assertWebsiteAccess(ctx, websiteId);
  if (csv.length > 10_000_000) throw new UserError("CSV is too large (10 MB max)");
  const p = Papa.parse<Record<string, string>>(csv.trim(), { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_") });
  const fields = p.meta.fields ?? [];
  const srcKey = fields.find((f) => ["source_url", "source", "url_from", "referring_page_url", "from_url"].includes(f));
  const tgtKey = fields.find((f) => ["target_url", "target", "url_to", "destination", "to_url"].includes(f));
  if (!srcKey || !tgtKey) throw new UserError('CSV needs "source_url" and "target_url" columns (common export names like url_from/url_to also work)');
  let created = 0, updated = 0;
  const skipped: { row: number; reason: string }[] = [];
  for (const [i, r] of p.data.entries()) {
    const parsed = backlinkRow.safeParse({ sourceUrl: r[srcKey], targetUrl: r[tgtKey], anchor: r.anchor ?? r.anchor_text, rel: r.rel ?? r.link_type ?? r.nofollow, firstSeen: r.first_seen });
    if (!parsed.success) { skipped.push({ row: i + 2, reason: parsed.error.issues[0].message }); continue; }
    const b = parsed.data;
    if (!isSameSite(b.targetUrl, site.domain)) { skipped.push({ row: i + 2, reason: `Target is not on ${site.domain}` }); continue; }
    const res = await upsertBacklink(site.organizationId, websiteId, { sourceUrl: b.sourceUrl, targetUrl: b.targetUrl, anchor: b.anchor ?? null, rel: relOf(b.rel === "true" ? "nofollow" : b.rel), source: "csv", firstSeenAt: b.firstSeen ? new Date(b.firstSeen) : undefined });
    if (res === "created") created++; else updated++;
  }
  await recomputeReferringDomains(websiteId);
  await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: "backlinks.import", entityType: "Website", entityId: websiteId, metadata: { created, updated, skipped: skipped.length } });
  return { created, updated, skipped };
}

export async function addBacklink(ctx: OrgContext, websiteId: string, input: unknown) {
  ctx.assert("backlinks:write");
  const site = await assertWebsiteAccess(ctx, websiteId);
  const b = backlinkRow.parse(input);
  if (!isSameSite(b.targetUrl, site.domain)) throw new UserError(`Target URL must be on ${site.domain}`);
  await upsertBacklink(site.organizationId, websiteId, { sourceUrl: b.sourceUrl, targetUrl: b.targetUrl, anchor: b.anchor ?? null, rel: relOf(b.rel), source: "manual" });
  await recomputeReferringDomains(websiteId);
}

async function upsertBacklink(orgId: string, websiteId: string, b: { sourceUrl: string; targetUrl: string; anchor: string | null; rel: string; source: string; firstSeenAt?: Date; providerRank?: number | null; status?: BacklinkStatus; lostAt?: Date | null; lastSeenAt?: Date }) {
  const sourceUrl = normalizeUrl(b.sourceUrl) ?? b.sourceUrl;
  const targetUrl = normalizeUrl(b.targetUrl) ?? b.targetUrl;
  const existing = await prisma.backlink.findUnique({ where: { websiteId_sourceUrl_targetUrl: { websiteId, sourceUrl, targetUrl } } });
  const data = { anchor: b.anchor, rel: b.rel, ...(b.providerRank != null ? { providerRank: b.providerRank } : {}), lastSeenAt: b.lastSeenAt ?? new Date(), ...(b.status ? { status: b.status } : {}), ...(b.lostAt !== undefined ? { lostAt: b.lostAt } : {}) };
  if (existing) {
    await prisma.backlink.update({ where: { id: existing.id }, data });
    return "updated" as const;
  }
  await prisma.backlink.create({ data: { organizationId: orgId, websiteId, sourceUrl, sourceDomain: hostOf(sourceUrl), targetUrl, source: b.source, firstSeenAt: b.firstSeenAt ?? new Date(), ...data } });
  return "created" as const;
}

export async function recomputeReferringDomains(websiteId: string) {
  const site = await prisma.website.findUniqueOrThrow({ where: { id: websiteId } });
  const groups = await prisma.backlink.groupBy({ by: ["sourceDomain"], where: { websiteId }, _count: true, _min: { firstSeenAt: true }, _max: { lastSeenAt: true, providerRank: true } });
  const active = await prisma.backlink.groupBy({ by: ["sourceDomain"], where: { websiteId, status: { in: ["ACTIVE", "UNVERIFIED", "REDIRECTED"] } }, _count: true });
  const activeBy = new Map(active.map((a) => [a.sourceDomain, a._count]));
  for (const g of groups) {
    const live = activeBy.get(g.sourceDomain) ?? 0;
    const existing = await prisma.referringDomain.findUnique({ where: { websiteId_domain: { websiteId, domain: g.sourceDomain } } });
    const data = { backlinks: live, lastSeenAt: g._max.lastSeenAt ?? new Date(), lostAt: live === 0 ? existing?.lostAt ?? new Date() : null, ...(g._max.providerRank != null && !existing?.rankSource ? { providerRank: g._max.providerRank, rankSource: "DataForSEO rank (0–1000)" } : {}) };
    if (existing) await prisma.referringDomain.update({ where: { id: existing.id }, data });
    else await prisma.referringDomain.create({ data: { organizationId: site.organizationId, websiteId, domain: g.sourceDomain, firstSeenAt: g._min.firstSeenAt ?? new Date(), ...data } });
  }
}

/**
 * Provider sync: pulls backlinks and referring domains from DataForSEO. Links the provider
 * reports as lost become LOST; links absent from a full pull are left as-is (index coverage
 * differs between pulls) and are confirmed by our own verification job instead.
 */
export async function processBacklinkSync(jc: JobContext) {
  const websiteId = jc.job.websiteId!;
  const site = await prisma.website.findUniqueOrThrow({ where: { id: websiteId } });
  const conn = await findConnection(site.organizationId, "DATAFORSEO", null);
  if (!conn) throw new Error("Backlink sync needs a connected DataForSEO account. You can still import backlinks from CSV.");
  const dfs = new DataForSeoClient(conn);
  const limit = Number((jc.job.payload as { limit?: number }).limit ?? 2000);
  return withSyncLog(conn, "backlinks.sync", websiteId, async () => {
    let offset = 0, created = 0, lost = 0, total = 0;
    while (offset < limit) {
      const page = await dfs.backlinks(site.domain, { limit: Math.min(1000, limit - offset), offset });
      total = page.total;
      for (const b of page.items) {
        const rel = b.dofollow === false ? relOf((b.attributes ?? []).join(" ") || "nofollow") : "follow";
        const res = await upsertBacklink(site.organizationId, websiteId, {
          sourceUrl: b.url_from, targetUrl: b.url_to, anchor: b.anchor ?? null, rel, source: "dataforseo", providerRank: b.rank ?? null,
          firstSeenAt: b.first_seen ? new Date(b.first_seen) : undefined, lastSeenAt: b.last_seen ? new Date(b.last_seen) : undefined,
          ...(b.is_lost ? { status: "LOST" as const, lostAt: b.lost_date ? new Date(b.lost_date) : new Date() } : {}),
        });
        if (res === "created") created++;
        if (b.is_lost) lost++;
      }
      offset += page.items.length;
      await jc.progress(Math.min(80, Math.round((offset / Math.min(limit, Math.max(1, total))) * 80)), `Fetched ${offset} of ${Math.min(total, limit)} backlinks`);
      if (page.items.length === 0 || offset >= total) break;
    }
    await jc.progress(85, "Updating referring domains");
    const domains = await dfs.referringDomains(site.domain, 1000);
    for (const d of domains) {
      await prisma.referringDomain.upsert({
        where: { websiteId_domain: { websiteId, domain: d.domain } },
        create: { organizationId: site.organizationId, websiteId, domain: d.domain, backlinks: d.backlinks ?? 0, providerRank: d.rank ?? null, rankSource: "DataForSEO rank (0–1000)", firstSeenAt: d.first_seen ? new Date(d.first_seen) : new Date(), lostAt: d.lost_date ? new Date(d.lost_date) : null },
        update: { providerRank: d.rank ?? null, rankSource: "DataForSEO rank (0–1000)", lostAt: d.lost_date ? new Date(d.lost_date) : null, lastSeenAt: new Date() },
      });
    }
    await recomputeReferringDomains(websiteId);
    await announceChanges(site.organizationId, websiteId, site.domain, created, lost);
    return { items: offset + domains.length, cost: dfs.cost, message: `${offset} backlinks (${created} new, ${lost} reported lost), ${domains.length} referring domains` };
  });
}

async function announceChanges(orgId: string, websiteId: string, domain: string, gained: number, lost: number) {
  const { emitEvent } = await import("./workflows");
  if (gained) await emitEvent(orgId, "backlink.new", websiteId, { count: gained });
  if (lost) {
    await notify({ organizationId: orgId, websiteId, type: "backlinks_lost", severity: "warning", title: `${domain}: ${lost} backlink${lost > 1 ? "s" : ""} lost`, link: `/backlinks?websiteId=${websiteId}&status=LOST` });
    await emitEvent(orgId, "backlink.lost", websiteId, { count: lost });
  }
}

export interface LinkCheck { status: BacklinkStatus; httpStatus: number | null; note: string; anchor?: string | null; rel?: string; finalUrl?: string }

/** Fetches a source page (respecting its robots.txt) and checks it still links to the target site. */
export async function checkBacklink(b: Pick<Backlink, "sourceUrl" | "targetUrl">, domain: string, robotsCache: Map<string, ReturnType<typeof parseRobots> | null>): Promise<LinkCheck> {
  const ua = process.env.CRAWLER_USER_AGENT ?? "SearchOpsBot/1.0";
  let origin: string;
  try { origin = new URL(b.sourceUrl).origin; } catch { return { status: "BROKEN", httpStatus: null, note: "Invalid source URL" }; }
  if (!robotsCache.has(origin)) {
    try {
      const r = await safeFetch(`${origin}/robots.txt`, { headers: { "user-agent": ua }, maxBytes: 256 * 1024, timeoutMs: 10_000 });
      robotsCache.set(origin, r.status === 200 ? parseRobots(r.body) : null);
    } catch { robotsCache.set(origin, null); }
  }
  if (!isAllowed(robotsCache.get(origin) ?? null, ua, b.sourceUrl).allowed) return { status: "UNVERIFIED", httpStatus: null, note: "Source page disallows crawling in robots.txt; not checked" };
  try {
    const res = await safeFetch(b.sourceUrl, { headers: { "user-agent": ua, accept: "text/html" }, maxBytes: 4 * 1024 * 1024, timeoutMs: 20_000 });
    if (res.status >= 400) return { status: "BROKEN", httpStatus: res.status, note: `Source page returns HTTP ${res.status}` };
    if (res.redirects.length && !isSameSite(res.finalUrl, hostOf(b.sourceUrl))) return { status: "REDIRECTED", httpStatus: res.status, note: `Source page redirects to ${res.finalUrl}`, finalUrl: res.finalUrl };
    const $ = cheerio.load(res.body);
    const target = normalizeUrl(b.targetUrl);
    let found: { anchor: string; rel: string } | null = null;
    let anyToSite: { anchor: string; rel: string } | null = null;
    $("a[href]").each((_, el) => {
      const href = normalizeUrl($(el).attr("href")!, res.finalUrl);
      if (!href || !isSameSite(href, domain)) return;
      const hit = { anchor: $(el).text().replace(/\s+/g, " ").trim().slice(0, 300), rel: ($(el).attr("rel") ?? "").toLowerCase() };
      anyToSite ??= hit;
      if (href === target) { found = hit; return false; }
    });
    const hit = (found ?? anyToSite) as { anchor: string; rel: string } | null;
    if (!hit) return { status: "LOST", httpStatus: res.status, note: "Source page is live but no longer links to this site" };
    return { status: "ACTIVE", httpStatus: res.status, note: found ? "Link found" : "Links to this site, but to a different URL than recorded", anchor: hit.anchor || null, rel: relOf(hit.rel) };
  } catch (err) {
    return { status: "BROKEN", httpStatus: null, note: `Could not fetch source: ${(err as Error).message.slice(0, 200)}` };
  }
}

/** Verification job: re-checks the least recently verified backlinks of a site. */
export async function processBacklinkVerify(jc: JobContext) {
  const websiteId = jc.job.websiteId!;
  const site = await prisma.website.findUniqueOrThrow({ where: { id: websiteId } });
  const p = jc.job.payload as { limit?: number; backlinkIds?: string[] };
  const links = await prisma.backlink.findMany({
    where: { websiteId, ...(p.backlinkIds ? { id: { in: p.backlinkIds } } : { status: { not: "LOST" } }) },
    orderBy: [{ lastVerifiedAt: { sort: "asc", nulls: "first" } }], take: p.limit ?? 200,
  });
  const robots = new Map<string, ReturnType<typeof parseRobots> | null>();
  let lostNow = 0, done = 0;
  const lastByHost = new Map<string, number>();
  for (const b of links) {
    // Politeness: at most one request per source host every 2 seconds.
    const host = hostOf(b.sourceUrl);
    const wait = (lastByHost.get(host) ?? 0) + 2000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastByHost.set(host, Date.now());
    const r = await checkBacklink(b, site.domain, robots);
    const becameLost = r.status === "LOST" && b.status !== "LOST";
    if (becameLost) lostNow++;
    await prisma.backlink.update({
      where: { id: b.id },
      data: {
        status: r.status, verifyHttpStatus: r.httpStatus, verifyNote: r.note, lastVerifiedAt: new Date(),
        ...(r.status === "ACTIVE" ? { lastSeenAt: new Date(), lostAt: null, anchor: r.anchor ?? b.anchor, rel: r.rel ?? b.rel } : {}),
        ...(becameLost ? { lostAt: new Date() } : {}),
      },
    });
    done++;
    await jc.progress(Math.round((done / links.length) * 95), `Verified ${done}/${links.length}`);
  }
  await recomputeReferringDomains(websiteId);
  await verifyAcquiredOutreachLinks(websiteId, robots);
  await announceChanges(site.organizationId, websiteId, site.domain, 0, lostNow);
  return { verified: done, lost: lostNow };
}

/** Outreach prospects marked ACQUIRED get their link checked; verified links become VERIFIED + a tracked backlink. */
export async function verifyAcquiredOutreachLinks(websiteId: string, robots = new Map<string, ReturnType<typeof parseRobots> | null>()) {
  const site = await prisma.website.findUniqueOrThrow({ where: { id: websiteId } });
  const prospects = await prisma.outreachProspect.findMany({ where: { websiteId, stage: "ACQUIRED", acquiredLinkUrl: { not: null } } });
  for (const p of prospects) {
    const r = await checkBacklink({ sourceUrl: p.acquiredLinkUrl!, targetUrl: p.targetUrl ?? site.baseUrl }, site.domain, robots);
    if (r.status === "ACTIVE") {
      await prisma.outreachProspect.update({ where: { id: p.id }, data: { stage: "VERIFIED", notes: `${p.notes ?? ""}\n[${new Date().toISOString().slice(0, 10)}] Link verified on ${p.acquiredLinkUrl}`.trim() } });
      await upsertBacklink(site.organizationId, websiteId, { sourceUrl: p.acquiredLinkUrl!, targetUrl: p.targetUrl ?? site.baseUrl, anchor: r.anchor ?? null, rel: r.rel ?? "follow", source: "outreach", status: "ACTIVE" });
    }
  }
}

// ───────────── Queries

export const backlinkFilterSchema = z.object({
  websiteId: z.string(),
  status: z.enum(["ACTIVE", "LOST", "BROKEN", "REDIRECTED", "UNVERIFIED"]).optional(),
  rel: z.enum(["follow", "nofollow", "ugc", "sponsored"]).optional(),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

export async function listBacklinks(ctx: OrgContext, raw: unknown) {
  const f = backlinkFilterSchema.parse(raw);
  await assertWebsiteAccess(ctx, f.websiteId);
  const where: Prisma.BacklinkWhereInput = {
    websiteId: f.websiteId,
    ...(f.status ? { status: f.status } : {}),
    ...(f.rel ? { rel: f.rel } : {}),
    ...(f.q ? { OR: [{ sourceUrl: { contains: f.q, mode: "insensitive" } }, { anchor: { contains: f.q, mode: "insensitive" } }, { targetUrl: { contains: f.q, mode: "insensitive" } }] } : {}),
  };
  const [total, rows] = await Promise.all([ctx.db.backlink.count({ where }), ctx.db.backlink.findMany({ where, orderBy: [{ firstSeenAt: "desc" }], skip: (f.page - 1) * 50, take: 50 })]);
  return { filter: f, total, rows, pages: Math.max(1, Math.ceil(total / 50)) };
}

export async function backlinkStats(ctx: OrgContext, websiteId: string) {
  await assertWebsiteAccess(ctx, websiteId);
  const DAY = 86400_000;
  const since = new Date(Date.now() - 90 * DAY);
  const [byStatus, byRel, anchors, domains, recent, targets, lastSync] = await Promise.all([
    ctx.db.backlink.groupBy({ by: ["status"], where: { websiteId }, _count: true }),
    ctx.db.backlink.groupBy({ by: ["rel"], where: { websiteId, status: { not: "LOST" } }, _count: true }),
    ctx.db.backlink.groupBy({ by: ["anchor"], where: { websiteId, status: { not: "LOST" } }, _count: true, orderBy: { _count: { anchor: "desc" } }, take: 15 }),
    ctx.db.referringDomain.findMany({ where: { websiteId }, orderBy: [{ providerRank: { sort: "desc", nulls: "last" } }, { backlinks: "desc" }], take: 25 }),
    ctx.db.backlink.findMany({ where: { websiteId, OR: [{ firstSeenAt: { gte: since } }, { lostAt: { gte: since } }] }, select: { firstSeenAt: true, lostAt: true } }),
    ctx.db.backlink.groupBy({ by: ["targetUrl"], where: { websiteId, status: { not: "LOST" } }, _count: true, orderBy: { _count: { targetUrl: "desc" } }, take: 10 }),
    ctx.db.syncLog.findFirst({ where: { websiteId, operation: "backlinks.sync", status: "SUCCEEDED" }, orderBy: { startedAt: "desc" } }),
  ]);
  const totalDomains = await ctx.db.referringDomain.count({ where: { websiteId, lostAt: null } });
  // Weekly link velocity
  const weeks = Array.from({ length: 13 }, (_, i) => {
    const start = new Date(Date.now() - (13 - i) * 7 * DAY);
    const end = new Date(start.getTime() + 7 * DAY);
    return {
      date: start.toISOString().slice(0, 10),
      gained: recent.filter((r) => r.firstSeenAt >= start && r.firstSeenAt < end).length,
      lost: -recent.filter((r) => r.lostAt && r.lostAt >= start && r.lostAt < end).length,
    };
  });
  return {
    byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count])) as Record<string, number>,
    byRel: byRel.map((r) => ({ label: r.rel, value: r._count })),
    anchors: anchors.map((a) => ({ label: a.anchor || "(empty / image)", value: a._count })),
    domains, totalDomains, velocity: weeks, targets: targets.map((t) => ({ label: t.targetUrl, value: t._count })), lastSync: lastSync?.startedAt ?? null,
  };
}

// ───────────── Disavow (manual review only)

export async function addDisavow(ctx: OrgContext, websiteId: string, value: string, reason: string) {
  ctx.assert("backlinks:write");
  await assertWebsiteAccess(ctx, websiteId);
  const v = value.trim();
  const normalized = v.startsWith("domain:") ? `domain:${v.slice(7).trim().toLowerCase().replace(/^www\./, "")}` : z.string().url().parse(v);
  return ctx.db.disavowEntry.upsert({
    where: { websiteId_value: { websiteId, value: normalized } },
    create: { organizationId: ctx.org.id, websiteId, value: normalized, reason: reason.slice(0, 500) || "Added for review" },
    update: { reason: reason.slice(0, 500) || undefined },
  });
}

/** Only a human review sets `included`. Nothing is added to the export automatically. */
export async function reviewDisavow(ctx: OrgContext, id: string, include: boolean) {
  ctx.assert("approvals:decide");
  return ctx.db.disavowEntry.update({ where: { id }, data: { included: include, reviewedById: ctx.userId, reviewedAt: new Date() } });
}

export async function disavowFile(ctx: OrgContext, websiteId: string) {
  const site = await assertWebsiteAccess(ctx, websiteId);
  const entries = await ctx.db.disavowEntry.findMany({ where: { websiteId, included: true, reviewedAt: { not: null } }, orderBy: { value: "asc" } });
  const lines = [
    `# Disavow file for ${site.domain}`,
    `# Generated ${new Date().toISOString()} — contains only entries a reviewer explicitly included.`,
    "# Use with care: disavowing is rarely needed and can remove link value. Upload via Google Search Console's disavow tool.",
    ...entries.flatMap((e) => [`# ${e.reason.replace(/\n/g, " ")}`, e.value]),
  ];
  return lines.join("\n") + "\n";
}

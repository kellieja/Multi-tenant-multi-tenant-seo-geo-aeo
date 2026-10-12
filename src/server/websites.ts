import Papa from "papaparse";
import { z } from "zod";
import type { Prisma, WebsiteStatus } from "@prisma/client";
import type { OrgContext } from "@/lib/auth/context";
import { assertWebsiteAccess } from "@/lib/auth/context";
import { writeAuditLog } from "@/lib/audit-log";
import { NotFoundError, UserError } from "@/lib/errors";
import { normalizeSiteUrl } from "@/lib/url";

const tagList = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((v) =>
    (Array.isArray(v) ? v : (v ?? "").split(","))
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 30),
  );

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

export const websiteInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  url: z.string().trim().min(1, "Website URL is required").max(500),
  clientId: optionalText(40),
  project: optionalText(80),
  industry: optionalText(80),
  folder: optionalText(80),
  tags: tagList,
  brandTerms: tagList,
  cmsType: z.enum(["NONE", "WORDPRESS", "WEBFLOW", "SHOPIFY", "CUSTOM"]).default("NONE"),
});
export type WebsiteInput = z.input<typeof websiteInputSchema>;

export const websiteSettingsSchema = z.object({
  maxPages: z.coerce.number().int().min(1).max(20000).default(500),
  maxDepth: z.coerce.number().int().min(1).max(50).default(10),
  crawlDelayMs: z.coerce.number().int().min(100).max(60000).default(500),
  concurrency: z.coerce.number().int().min(1).max(4).default(2),
  includePatterns: tagList,
  excludePatterns: tagList,
  // Cron expression for scheduled crawls, e.g. "0 3 * * 1". Empty = manual only.
  crawlSchedule: z.string().trim().max(100).optional().nullable().transform((v) => v || null),
  crawlMode: z.enum(["FULL", "INCREMENTAL"]).default("FULL"),
  // JavaScript rendering: "auto" renders only when the homepage's content appears after JS runs (single-page apps).
  renderMode: z.enum(["auto", "always", "off"]).default("auto"),
  checkExternalLinks: z.coerce.boolean().default(true),
  // "always": every site change needs a human approval. "safe-auto": only low-risk metadata fixes may auto-apply in AUTOMATIC workflows.
  approvalPolicy: z.enum(["always", "safe-auto"]).default("always"),
  gscPropertyUrl: z.string().trim().max(300).optional().nullable(),
  ga4PropertyId: z.string().trim().max(40).optional().nullable(),
  rankLocationCode: z.coerce.number().int().default(2840),
  rankLanguageCode: z.string().default("en"),
  alertRankDrop: z.coerce.number().int().min(1).max(100).default(5),
  alertHealthDrop: z.coerce.number().min(1).max(100).default(10),
});
export type WebsiteSettings = z.infer<typeof websiteSettingsSchema>;

export function readSettings(raw: unknown): WebsiteSettings {
  const parsed = websiteSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : websiteSettingsSchema.parse({});
}

async function resolveClientId(ctx: OrgContext, clientId: string | null) {
  if (!clientId) return null;
  const client = await ctx.db.client.findUnique({ where: { id: clientId } });
  if (!client) throw new UserError("Selected client does not exist");
  return client.id;
}

export async function createWebsite(ctx: OrgContext, input: WebsiteInput) {
  ctx.assert("websites:write");
  const data = websiteInputSchema.parse(input);
  const { baseUrl, domain } = normalizeSiteUrl(data.url);
  const existing = await ctx.db.website.findFirst({ where: { domain } });
  if (existing) throw new UserError(`${domain} is already in this workspace`);
  const site = await ctx.db.website.create({
    data: {
      organizationId: ctx.org.id,
      name: data.name,
      baseUrl,
      domain,
      clientId: await resolveClientId(ctx, data.clientId),
      project: data.project,
      industry: data.industry,
      folder: data.folder,
      tags: data.tags,
      brandTerms: data.brandTerms.length ? data.brandTerms : [data.name],
      cmsType: data.cmsType,
      settings: websiteSettingsSchema.parse({}) as Prisma.InputJsonValue,
    },
  });
  await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: "website.create", entityType: "Website", entityId: site.id, metadata: { domain } });
  return site;
}

export async function updateWebsite(ctx: OrgContext, websiteId: string, input: WebsiteInput) {
  ctx.assert("websites:write");
  await assertWebsiteAccess(ctx, websiteId);
  const data = websiteInputSchema.parse(input);
  const { baseUrl, domain } = normalizeSiteUrl(data.url);
  const clash = await ctx.db.website.findFirst({ where: { domain, id: { not: websiteId } } });
  if (clash) throw new UserError(`${domain} is already in this workspace`);
  const site = await ctx.db.website.update({
    where: { id: websiteId },
    data: {
      name: data.name,
      baseUrl,
      domain,
      clientId: await resolveClientId(ctx, data.clientId),
      project: data.project,
      industry: data.industry,
      folder: data.folder,
      tags: data.tags,
      brandTerms: data.brandTerms,
      cmsType: data.cmsType,
    },
  });
  await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: "website.update", entityType: "Website", entityId: websiteId });
  return site;
}

export async function updateWebsiteSettings(ctx: OrgContext, websiteId: string, input: unknown) {
  ctx.assert("websites:write");
  const site = await assertWebsiteAccess(ctx, websiteId);
  const merged = websiteSettingsSchema.parse({ ...readSettings(site.settings), ...(input as object) });
  if (merged.crawlSchedule) {
    const { CronExpressionParser } = await import("cron-parser");
    try {
      CronExpressionParser.parse(merged.crawlSchedule);
    } catch {
      throw new UserError("Crawl schedule must be a valid cron expression, e.g. 0 3 * * 1");
    }
  }
  return ctx.db.website.update({ where: { id: websiteId }, data: { settings: merged as Prisma.InputJsonValue } });
}

export async function setWebsiteStatus(ctx: OrgContext, websiteId: string, status: WebsiteStatus) {
  ctx.assert("websites:write");
  await assertWebsiteAccess(ctx, websiteId);
  const site = await ctx.db.website.update({
    where: { id: websiteId },
    data: { status, archivedAt: status === "ARCHIVED" ? new Date() : null },
  });
  await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: `website.status.${status.toLowerCase()}`, entityType: "Website", entityId: websiteId });
  return site;
}

export async function deleteWebsite(ctx: OrgContext, websiteId: string, confirmDomain: string) {
  ctx.assert("websites:delete");
  const site = await assertWebsiteAccess(ctx, websiteId);
  if (confirmDomain.trim().toLowerCase() !== site.domain) throw new UserError(`Type ${site.domain} to confirm deletion`);
  // Child tables without FK cascades are cleared explicitly.
  const where = { websiteId };
  await ctx.db.$transaction([
    ctx.db.searchConsoleDaily.deleteMany({ where }),
    ctx.db.searchConsoleQuery.deleteMany({ where }),
    ctx.db.analyticsDaily.deleteMany({ where }),
    ctx.db.pageSpeedResult.deleteMany({ where }),
    ctx.db.rankObservation.deleteMany({ where }),
    ctx.db.referringDomain.deleteMany({ where }),
    ctx.db.outreachProspect.deleteMany({ where }),
    ctx.db.outreachCampaign.deleteMany({ where }),
    ctx.db.disavowEntry.deleteMany({ where }),
    ctx.db.contentSuggestion.deleteMany({ where }),
    ctx.db.aeoAssessment.deleteMany({ where }),
    ctx.db.aeoOpportunity.deleteMany({ where }),
    ctx.db.geoObservation.deleteMany({ where }),
    ctx.db.geoPromptSet.deleteMany({ where }),
    ctx.db.internalLinkSuggestion.deleteMany({ where }),
    ctx.db.siteChange.deleteMany({ where }),
    ctx.db.competitor.deleteMany({ where }),
    ctx.db.task.deleteMany({ where }),
    ctx.db.website.delete({ where: { id: websiteId } }),
  ]);
  await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: "website.delete", entityType: "Website", entityId: websiteId, metadata: { domain: site.domain } });
}

export const websiteListSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED", "ALL"]).optional(),
  clientId: z.string().optional(),
  project: z.string().optional(),
  folder: z.string().optional(),
  industry: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(25),
  sort: z.enum(["name", "domain", "createdAt", "updatedAt"]).default("name"),
  dir: z.enum(["asc", "desc"]).default("asc"),
});

export async function listWebsites(ctx: OrgContext, raw: unknown) {
  const f = websiteListSchema.parse(raw ?? {});
  const where: Prisma.WebsiteWhereInput = {
    ...(ctx.websiteScope ? { id: { in: ctx.websiteScope } } : {}),
    ...(f.status && f.status !== "ALL" ? { status: f.status } : f.status === "ALL" ? {} : { status: { not: "ARCHIVED" } }),
    ...(f.clientId ? { clientId: f.clientId } : {}),
    ...(f.project ? { project: f.project } : {}),
    ...(f.folder ? { folder: f.folder } : {}),
    ...(f.industry ? { industry: f.industry } : {}),
    ...(f.q
      ? { OR: [{ name: { contains: f.q, mode: "insensitive" } }, { domain: { contains: f.q, mode: "insensitive" } }, { tags: { has: f.q } }] }
      : {}),
  };
  const [total, rows] = await Promise.all([
    ctx.db.website.count({ where }),
    ctx.db.website.findMany({
      where,
      orderBy: { [f.sort]: f.dir },
      skip: (f.page - 1) * f.pageSize,
      take: f.pageSize,
      include: { client: { select: { id: true, name: true } }, assignments: { select: { userId: true } } },
    }),
  ]);
  return { total, rows, page: f.page, pageSize: f.pageSize, pages: Math.max(1, Math.ceil(total / f.pageSize)) };
}

export async function getWebsite(ctx: OrgContext, websiteId: string) {
  await assertWebsiteAccess(ctx, websiteId);
  const site = await ctx.db.website.findUnique({
    where: { id: websiteId },
    include: { client: true, assignments: { include: { user: { select: { id: true, name: true, email: true } } } } },
  });
  if (!site) throw new NotFoundError("Website");
  return site;
}

export async function setAssignments(ctx: OrgContext, websiteId: string, userIds: string[]) {
  ctx.assert("websites:write");
  await assertWebsiteAccess(ctx, websiteId);
  const members = await ctx.db.membership.findMany({ where: { userId: { in: userIds }, role: { not: "CLIENT" } } });
  const valid = members.map((m) => m.userId);
  await ctx.db.$transaction([
    ctx.db.websiteAssignment.deleteMany({ where: { websiteId, userId: { notIn: valid } } }),
    ...valid.map((userId) =>
      ctx.db.websiteAssignment.upsert({
        where: { websiteId_userId: { websiteId, userId } },
        create: { organizationId: ctx.org.id, websiteId, userId },
        update: {},
      }),
    ),
  ]);
}

export interface CsvImportResult {
  created: number;
  skipped: { row: number; reason: string }[];
}

/**
 * CSV columns (header row required): name, url, client, project, industry, folder, tags, cms
 * Unknown clients are created. Existing domains are skipped, not overwritten.
 */
export async function importWebsitesCsv(ctx: OrgContext, csvText: string): Promise<CsvImportResult> {
  ctx.assert("websites:write");
  if (csvText.length > 2_000_000) throw new UserError("CSV is too large (2 MB max)");
  const parsed = Papa.parse<Record<string, string>>(csvText.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  if (!parsed.meta.fields?.includes("url")) throw new UserError('CSV must include a "url" column');
  if (parsed.data.length > 1000) throw new UserError("Import at most 1,000 websites per file");
  const result: CsvImportResult = { created: 0, skipped: [] };
  const clientCache = new Map<string, string>();
  for (const [i, row] of parsed.data.entries()) {
    const rowNo = i + 2;
    try {
      let clientId: string | null = null;
      const clientName = row.client?.trim();
      if (clientName) {
        clientId = clientCache.get(clientName) ?? null;
        if (!clientId) {
          const c = await ctx.db.client.upsert({
            where: { organizationId_name: { organizationId: ctx.org.id, name: clientName } },
            create: { organizationId: ctx.org.id, name: clientName },
            update: {},
          });
          clientId = c.id;
          clientCache.set(clientName, clientId);
        }
      }
      const cms = (row.cms ?? "").trim().toUpperCase();
      await createWebsite(ctx, {
        name: row.name?.trim() || normalizeSiteUrl(row.url).domain,
        url: row.url,
        clientId,
        project: row.project,
        industry: row.industry,
        folder: row.folder,
        tags: row.tags?.replace(/;/g, ","),
        cmsType: (["WORDPRESS", "WEBFLOW", "SHOPIFY", "CUSTOM"].includes(cms) ? cms : "NONE") as WebsiteInput["cmsType"],
      });
      result.created++;
    } catch (err) {
      result.skipped.push({ row: rowNo, reason: err instanceof Error ? err.message : "Invalid row" });
    }
  }
  return result;
}

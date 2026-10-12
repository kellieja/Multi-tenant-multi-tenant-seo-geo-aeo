import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { OrgContext } from "@/lib/auth/context";
import { websiteWhere } from "@/lib/auth/context";

export const findingFilterSchema = z.object({
  websiteId: z.string().optional(),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]).optional(),
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "IGNORED", "REGRESSED", "ACTIVE", "ALL"]).default("ACTIVE"),
  category: z.string().optional(),
  issueType: z.string().optional(),
  automatable: z.enum(["yes", "no"]).optional(),
  effort: z.enum(["low", "medium", "high"]).optional(),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(["priorityScore", "severity", "lastSeenAt", "firstSeenAt", "url"]).default("priorityScore"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(50),
});

export function findingWhere(ctx: OrgContext, f: z.infer<typeof findingFilterSchema>): Prisma.AuditFindingWhereInput {
  return {
    ...websiteWhere(ctx, f.websiteId),
    ...(f.severity ? { severity: f.severity } : {}),
    ...(f.status === "ACTIVE" ? { status: { in: ["OPEN", "IN_PROGRESS", "REGRESSED"] } } : f.status === "ALL" ? {} : { status: f.status }),
    ...(f.category ? { category: f.category } : {}),
    ...(f.issueType ? { issueType: f.issueType } : {}),
    ...(f.automatable ? { automatable: f.automatable === "yes" } : {}),
    ...(f.effort ? { priorityFactors: { array_contains: [{ key: "effort", value: { low: 1, medium: 0.75, high: 0.5 }[f.effort] }] } } : {}),
    ...(f.q ? { OR: [{ url: { contains: f.q, mode: "insensitive" } }, { title: { contains: f.q, mode: "insensitive" } }] } : {}),
  };
}

const SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

export async function listFindings(ctx: OrgContext, raw: unknown) {
  const f = findingFilterSchema.parse(raw ?? {});
  const where = findingWhere(ctx, f);
  const orderBy: Prisma.AuditFindingOrderByWithRelationInput[] =
    f.sort === "severity" ? [{ severity: f.dir === "desc" ? "asc" : "desc" }, { priorityScore: "desc" }] : [{ [f.sort]: f.dir }, { id: "asc" }];
  const [total, rows, bySeverity, byCategory] = await Promise.all([
    ctx.db.auditFinding.count({ where }),
    ctx.db.auditFinding.findMany({ where, orderBy, skip: (f.page - 1) * f.pageSize, take: f.pageSize, include: { website: { select: { id: true, name: true, domain: true } } } }),
    ctx.db.auditFinding.groupBy({ by: ["severity"], where, _count: true }),
    ctx.db.auditFinding.groupBy({ by: ["category"], where: { ...where, category: undefined }, _count: true }),
  ]);
  return {
    filter: f,
    total,
    rows,
    pages: Math.max(1, Math.ceil(total / f.pageSize)),
    bySeverity: SEVERITY_ORDER.map((s) => ({ severity: s, count: bySeverity.find((b) => b.severity === s)?._count ?? 0 })),
    byCategory: byCategory.map((c) => ({ category: c.category, count: c._count })).sort((a, b) => b.count - a.count),
  };
}

/** Issue-type level comparison between two crawls of the same site (counts from crawl summaries + lifecycle events). */
export async function compareCrawls(ctx: OrgContext, crawlId: string, baselineId?: string) {
  const crawl = await ctx.db.crawl.findUnique({ where: { id: crawlId }, include: { website: true } });
  if (!crawl) return null;
  const baseline = baselineId
    ? await ctx.db.crawl.findUnique({ where: { id: baselineId } })
    : await ctx.db.crawl.findFirst({ where: { websiteId: crawl.websiteId, status: "SUCCEEDED", createdAt: { lt: crawl.createdAt } }, orderBy: { createdAt: "desc" } });
  const cur = ((crawl.summary as { issueCounts?: Record<string, number> } | null)?.issueCounts) ?? {};
  const base = ((baseline?.summary as { issueCounts?: Record<string, number> } | null)?.issueCounts) ?? {};
  const types = [...new Set([...Object.keys(cur), ...Object.keys(base)])];
  const events = baseline
    ? await ctx.db.findingEvent.groupBy({ by: ["toStatus"], where: { crawlId: crawl.id }, _count: true })
    : [];
  return {
    crawl,
    baseline,
    rows: types.map((t) => ({ issueType: t, before: base[t] ?? 0, after: cur[t] ?? 0, delta: (cur[t] ?? 0) - (base[t] ?? 0) })).sort((a, b) => a.delta - b.delta),
    events: Object.fromEntries(events.map((e) => [e.toStatus, e._count])),
  };
}

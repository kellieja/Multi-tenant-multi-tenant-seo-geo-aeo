import type { Prisma, Report } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { tenantDb } from "@/lib/db/tenant";
import type { OrgContext } from "@/lib/auth/context";
import { UserError } from "@/lib/errors";
import { writeAuditLog } from "@/lib/audit-log";
import { enqueueJob } from "@/lib/jobs/queue";
import type { JobContext } from "@/lib/jobs/context";
import { getDashboard, type DashboardScope, type DashboardData } from "./dashboard";
import { notify } from "./notifications";
import { sendEmail } from "./delivery";

const DAY = 86400_000;

export interface ReportSite {
  id: string;
  name: string;
  domain: string;
  /** Latest crawl before the period ended; falls back to the first crawl after it (flagged) for brand-new sites. */
  health: { score: number | null; previous: number | null; crawledAt: string | null; afterPeriod?: boolean } | null;
  openFindings: { critical: number; high: number; medium: number; low: number };
  resolvedInPeriod: number;
  topIssues: { title: string; severity: string; pages: number }[];
  topQueries: { query: string; clicks: number; impressions: number; position: number | null }[];
  movers: { improved: { phrase: string; from: number | null; to: number | null }[]; declined: { phrase: string; from: number | null; to: number | null }[] };
  completedTasks: string[];
  tasksDone: number;
  changesApplied: number;
}

export interface ReportData {
  version: 1;
  generatedAt: string;
  brand: { name: string; color: string; logoUrl: string | null };
  period: { from: string; to: string; prevFrom: string; prevTo: string; days: number };
  scope: { siteIds: string[]; clientId: string | null; clientName: string | null };
  dashboard: DashboardData;
  sites: ReportSite[];
}

/** Every number is copied out of the database at generation time so the report never changes afterwards. */
export async function buildReportData(organizationId: string, scope: DashboardScope, input: { websiteIds?: string[]; clientId?: string | null; from: Date; to: Date }): Promise<ReportData> {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const filter = { range: "custom" as const, from: input.from.toISOString().slice(0, 10), to: input.to.toISOString().slice(0, 10), clientId: input.clientId ?? undefined };
  const restricted: DashboardScope = {
    db: scope.db,
    websiteScope: input.websiteIds?.length ? (scope.websiteScope ? input.websiteIds.filter((id) => scope.websiteScope!.includes(id)) : input.websiteIds) : scope.websiteScope,
  };
  const dashboard = await getDashboard(restricted, filter);
  const p = dashboard.period;
  const siteRows = await scope.db.website.findMany({
    where: { status: { not: "ARCHIVED" }, ...(restricted.websiteScope ? { id: { in: restricted.websiteScope } } : {}), ...(input.clientId ? { clientId: input.clientId } : {}) },
    select: { id: true, name: true, domain: true }, orderBy: { name: "asc" },
  });
  if (!siteRows.length) throw new UserError("No websites in this report's scope");
  const end = new Date(p.to.getTime() + DAY);
  const inPeriod = { gte: p.from, lt: end };
  const sites: ReportSite[] = [];
  for (const s of siteRows) {
    const crawls = await prisma.crawl.findMany({ where: { websiteId: s.id, status: "SUCCEEDED", finishedAt: { lt: end } }, orderBy: { finishedAt: "desc" }, take: 2, select: { healthScore: true, finishedAt: true } });
    const after = crawls.length ? null : await prisma.crawl.findFirst({ where: { websiteId: s.id, status: "SUCCEEDED", finishedAt: { gte: end } }, orderBy: { finishedAt: "asc" }, select: { healthScore: true, finishedAt: true } });
    const open = await prisma.auditFinding.groupBy({ by: ["severity"], where: { websiteId: s.id, status: { in: ["OPEN", "REGRESSED", "IN_PROGRESS"] } }, _count: true });
    const sev = (k: string) => open.find((o) => o.severity === k)?._count ?? 0;
    const issues = await prisma.auditFinding.groupBy({ by: ["title", "severity"], where: { websiteId: s.id, status: { in: ["OPEN", "REGRESSED", "IN_PROGRESS"] } }, _count: true, _max: { priorityScore: true }, orderBy: { _max: { priorityScore: "desc" } }, take: 6 });
    const queries = await prisma.searchConsoleQuery.groupBy({ by: ["query"], where: { websiteId: s.id, date: { gte: p.from, lte: p.to } }, _sum: { clicks: true, impressions: true }, _avg: { position: true }, orderBy: { _sum: { clicks: "desc" } }, take: 10 });
    const keywords = await prisma.keyword.findMany({ where: { websiteId: s.id }, select: { phrase: true, observations: { where: { observedAt: { lt: end } }, orderBy: { observedAt: "desc" }, select: { position: true, observedAt: true }, take: 60 } } });
    const moves = keywords.map((k) => {
      const now = k.observations[0];
      const before = k.observations.find((o) => o.observedAt < p.from);
      if (!now || !before || now.observedAt < p.from) return null;
      const a = before.position ?? 101; const b = now.position ?? 101;
      return { phrase: k.phrase, from: before.position, to: now.position, delta: a - b };
    }).filter((x): x is NonNullable<typeof x> => !!x && x.delta !== 0);
    const tasks = await prisma.task.findMany({ where: { websiteId: s.id, status: "DONE", completedAt: inPeriod }, select: { title: true, visibleToClient: true } });
    sites.push({
      id: s.id, name: s.name, domain: s.domain,
      health: crawls.length ? { score: crawls[0].healthScore, previous: crawls[1]?.healthScore ?? null, crawledAt: crawls[0].finishedAt?.toISOString() ?? null } : after ? { score: after.healthScore, previous: null, crawledAt: after.finishedAt?.toISOString() ?? null, afterPeriod: true } : null,
      openFindings: { critical: sev("CRITICAL"), high: sev("HIGH"), medium: sev("MEDIUM"), low: sev("LOW") },
      resolvedInPeriod: await prisma.auditFinding.count({ where: { websiteId: s.id, status: "RESOLVED", resolvedAt: inPeriod } }),
      topIssues: issues.map((i) => ({ title: i.title, severity: i.severity, pages: i._count })),
      topQueries: queries.map((q) => ({ query: q.query, clicks: q._sum.clicks ?? 0, impressions: q._sum.impressions ?? 0, position: q._avg.position })),
      movers: {
        improved: moves.filter((m) => m.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 5).map(({ phrase, from, to }) => ({ phrase, from, to })),
        declined: moves.filter((m) => m.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 5).map(({ phrase, from, to }) => ({ phrase, from, to })),
      },
      // Only tasks explicitly shared with the client are named; the total covers all work.
      completedTasks: tasks.filter((t) => t.visibleToClient).map((t) => t.title).slice(0, 15),
      tasksDone: tasks.length,
      changesApplied: await prisma.siteChange.count({ where: { websiteId: s.id, status: "APPLIED", appliedAt: inPeriod } }),
    });
  }
  const client = input.clientId ? await prisma.client.findFirst({ where: { id: input.clientId, organizationId } }) : null;
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    brand: { name: org.brandName || org.name, color: org.brandColor || "#2F5BEA", logoUrl: org.logoUrl },
    period: { from: p.from.toISOString(), to: p.to.toISOString(), prevFrom: p.prevFrom.toISOString(), prevTo: p.prevTo.toISOString(), days: p.days },
    scope: { siteIds: siteRows.map((s) => s.id), clientId: input.clientId ?? null, clientName: client?.name ?? null },
    dashboard: JSON.parse(JSON.stringify(dashboard)),
    sites,
  };
}

export const readReportData = (r: Pick<Report, "data">) => r.data as unknown as ReportData;

// ───────────── Manual reports

export const reportInput = z.object({
  title: z.string().trim().min(2, "Enter a title").max(160),
  websiteIds: z.array(z.string()).default([]),
  clientId: z.string().optional().or(z.literal("").transform(() => undefined)),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a start date"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick an end date"),
  notes: z.string().trim().max(5000).optional().or(z.literal("").transform(() => undefined)),
}).refine((d) => d.from <= d.to, { message: "Start must be before end", path: ["from"] })
  .refine((d) => (Date.parse(d.to) - Date.parse(d.from)) / DAY <= 400, { message: "Reports can cover at most 400 days", path: ["to"] });

export async function createReport(ctx: OrgContext, raw: z.input<typeof reportInput>) {
  ctx.assert("reports:write");
  const d = reportInput.parse(raw);
  if (d.clientId && !(await ctx.db.client.findUnique({ where: { id: d.clientId } }))) throw new UserError("Client not found");
  for (const id of d.websiteIds) if (ctx.websiteScope && !ctx.websiteScope.includes(id)) throw new UserError("Website not found");
  const data = await buildReportData(ctx.org.id, ctx, { websiteIds: d.websiteIds, clientId: d.clientId ?? null, from: new Date(`${d.from}T00:00:00Z`), to: new Date(`${d.to}T00:00:00Z`) });
  const report = await ctx.db.report.create({
    data: {
      organizationId: ctx.org.id, title: d.title, clientId: d.clientId ?? null, websiteId: data.scope.siteIds.length === 1 ? data.scope.siteIds[0] : null,
      periodStart: new Date(data.period.from), periodEnd: new Date(data.period.to), status: "GENERATED", data: data as unknown as Prisma.InputJsonValue, notes: d.notes ?? null, createdById: ctx.userId,
    },
  });
  await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: "report.create", entityType: "Report", entityId: report.id });
  return report;
}

/** Whether the member may see this report. Clients see only approved reports wholly within their websites. */
export function canViewReport(ctx: Pick<OrgContext, "role" | "websiteScope" | "can">, r: Pick<Report, "status" | "data">) {
  if (!ctx.can("reports:read")) return false;
  const ids = readReportData(r).scope.siteIds;
  if (ctx.websiteScope && !ids.every((id) => ctx.websiteScope!.includes(id))) return false;
  if (ctx.role === "CLIENT" && r.status !== "APPROVED") return false;
  return true;
}

export async function getReportForViewer(ctx: OrgContext, id: string) {
  const r = await ctx.db.report.findUnique({ where: { id } });
  if (!r || !canViewReport(ctx, r)) throw new UserError("Report not found", 404);
  return r;
}

export async function listReportsForViewer(ctx: OrgContext) {
  const rows = await ctx.db.report.findMany({ where: ctx.role === "CLIENT" ? { status: "APPROVED" } : {}, orderBy: { createdAt: "desc" }, take: 200 });
  return rows.filter((r) => canViewReport(ctx, r));
}

export async function approveReport(ctx: OrgContext, id: string, notes?: string) {
  ctx.assert("reports:approve");
  const r = await getReportForViewer(ctx, id);
  if (r.status === "APPROVED") throw new UserError("Already approved");
  const updated = await ctx.db.report.update({ where: { id }, data: { status: "APPROVED", approvedAt: new Date(), approvedById: ctx.userId, ...(notes !== undefined ? { notes: notes || null } : {}) } });
  await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: "report.approve", entityType: "Report", entityId: id });
  if (r.scheduleId) {
    const sched = await ctx.db.reportSchedule.findUnique({ where: { id: r.scheduleId } });
    if (sched?.recipients.length) await enqueueJob({ organizationId: ctx.org.id, type: "report-generate", payload: { sendReportId: id }, createdById: ctx.userId });
  }
  return updated;
}

export async function updateReportNotes(ctx: OrgContext, id: string, notes: string) {
  ctx.assert("reports:write");
  const r = await getReportForViewer(ctx, id);
  if (r.status === "APPROVED") throw new UserError("Approved reports are frozen. Generate a new report to change it.");
  return ctx.db.report.update({ where: { id }, data: { notes: notes.trim().slice(0, 5000) || null } });
}

export async function deleteReport(ctx: OrgContext, id: string) {
  ctx.assert("reports:approve");
  await getReportForViewer(ctx, id);
  await ctx.db.report.delete({ where: { id } });
  await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: "report.delete", entityType: "Report", entityId: id });
}

// ───────────── Sending (approved reports only)

export async function sendReport(organizationId: string, reportId: string, recipients: string[]) {
  const r = await prisma.report.findFirstOrThrow({ where: { id: reportId, organizationId } });
  // Server-side gate: nothing reaches a client before a human (or an explicit auto-approve schedule) approved it.
  if (r.status !== "APPROVED") throw new UserError("Only approved reports can be sent");
  if (!recipients.length) throw new UserError("No recipients");
  const { renderReportPdf } = await import("@/reports/pdf");
  const pdf = await renderReportPdf(r);
  const data = readReportData(r);
  const appUrl = process.env.APP_URL ?? "";
  await sendEmail(organizationId, {
    to: recipients,
    subject: `${r.title} (${data.brand.name})`,
    text: `Your ${data.brand.name} report for ${data.period.from.slice(0, 10)} to ${data.period.to.slice(0, 10)} is attached.${appUrl ? `\n\nView it online: ${appUrl}/reports/${r.id}` : ""}`,
    attachments: [{ filename: `${r.title.replace(/[^\w.-]+/g, "_").slice(0, 80)}.pdf`, content: pdf, contentType: "application/pdf" }],
  });
  await writeAuditLog({ organizationId, userId: null, action: "report.send", entityType: "Report", entityId: r.id, metadata: { recipients: recipients.length } });
}

export async function sendReportNow(ctx: OrgContext, id: string, recipientsRaw: string) {
  ctx.assert("reports:approve");
  const r = await getReportForViewer(ctx, id);
  const recipients = z.array(z.string().trim().email("Enter valid email addresses")).min(1, "Enter at least one recipient").max(20).parse(recipientsRaw.split(/[\s,;]+/).filter(Boolean));
  await sendReport(ctx.org.id, r.id, recipients);
  return recipients.length;
}

// ───────────── Schedules

export const scheduleInput = z.object({
  name: z.string().trim().min(2, "Enter a name").max(120),
  websiteIds: z.array(z.string()).default([]),
  clientId: z.string().optional().or(z.literal("").transform(() => undefined)),
  frequency: z.enum(["WEEKLY", "MONTHLY"]),
  recipients: z.array(z.string().trim().email("Enter valid email addresses")).max(20).default([]),
  autoApprove: z.boolean().default(false),
});

/** Next run: Monday 06:00 UTC for weekly, the 1st at 06:00 UTC for monthly. */
export function nextScheduleRun(frequency: "WEEKLY" | "MONTHLY", after: Date) {
  if (frequency === "MONTHLY") {
    const d = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), 1, 6));
    return d > after ? d : new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth() + 1, 1, 6));
  }
  const d = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), 6));
  const add = (8 - d.getUTCDay()) % 7; // days until Monday
  d.setUTCDate(d.getUTCDate() + add);
  return d > after ? d : new Date(d.getTime() + 7 * DAY);
}

/** The full period that just ended: last Monday–Sunday, or last calendar month. */
export function previousPeriod(frequency: "WEEKLY" | "MONTHLY", runAt: Date) {
  const today = new Date(Date.UTC(runAt.getUTCFullYear(), runAt.getUTCMonth(), runAt.getUTCDate()));
  if (frequency === "MONTHLY") {
    const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
    return { from: new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1)), to };
  }
  const sinceMonday = (today.getUTCDay() + 6) % 7;
  const to = new Date(today.getTime() - (sinceMonday + 1) * DAY);
  return { from: new Date(to.getTime() - 6 * DAY), to };
}

export async function saveSchedule(ctx: OrgContext, raw: z.input<typeof scheduleInput>, id?: string) {
  ctx.assert("reports:write");
  const d = scheduleInput.parse(raw);
  // Auto-approval skips human review before clients receive the report, so only approvers may enable it.
  if (d.autoApprove) ctx.assert("reports:approve");
  if (d.clientId && !(await ctx.db.client.findUnique({ where: { id: d.clientId } }))) throw new UserError("Client not found");
  for (const wid of d.websiteIds) if (!(await ctx.db.website.findUnique({ where: { id: wid } }))) throw new UserError("Website not found");
  const data = { name: d.name, websiteIds: d.websiteIds, clientId: d.clientId ?? null, frequency: d.frequency, recipients: d.recipients, autoApprove: d.autoApprove, nextRunAt: nextScheduleRun(d.frequency, new Date()) };
  const s = id ? await ctx.db.reportSchedule.update({ where: { id }, data }) : await ctx.db.reportSchedule.create({ data: { ...data, organizationId: ctx.org.id } });
  await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: id ? "report_schedule.update" : "report_schedule.create", entityType: "ReportSchedule", entityId: s.id, metadata: { autoApprove: d.autoApprove } });
  return s;
}

export async function scheduleReports(now: Date) {
  const due = await prisma.reportSchedule.findMany({ where: { enabled: true, nextRunAt: { lte: now } } });
  for (const s of due) {
    await prisma.reportSchedule.update({ where: { id: s.id }, data: { lastRunAt: now, nextRunAt: nextScheduleRun(s.frequency as "WEEKLY" | "MONTHLY", now) } });
    await enqueueJob({ organizationId: s.organizationId, type: "report-generate", payload: { scheduleId: s.id, runAt: now.toISOString() } });
  }
  return due.length;
}

/** Worker: generates a scheduled report, or sends an approved one. */
export async function processReportJob(jc: JobContext) {
  const p = jc.job.payload as { scheduleId?: string; runAt?: string; sendReportId?: string };
  const orgId = jc.job.organizationId;
  if (p.sendReportId) {
    const r = await prisma.report.findFirstOrThrow({ where: { id: p.sendReportId, organizationId: orgId } });
    const s = r.scheduleId ? await prisma.reportSchedule.findUnique({ where: { id: r.scheduleId } }) : null;
    await sendReport(orgId, r.id, s?.recipients ?? []);
    return { sent: s?.recipients.length ?? 0 };
  }
  const s = await prisma.reportSchedule.findFirstOrThrow({ where: { id: p.scheduleId, organizationId: orgId } });
  const freq = s.frequency as "WEEKLY" | "MONTHLY";
  const period = previousPeriod(freq, p.runAt ? new Date(p.runAt) : new Date());
  await jc.progress(10, "Collecting metrics");
  const data = await buildReportData(orgId, { db: tenantDb(orgId), websiteScope: null }, { websiteIds: s.websiteIds, clientId: s.clientId, from: period.from, to: period.to });
  const label = freq === "WEEKLY" ? `week of ${period.from.toISOString().slice(0, 10)}` : period.from.toISOString().slice(0, 7);
  const report = await prisma.report.create({
    data: {
      organizationId: orgId, scheduleId: s.id, clientId: s.clientId, websiteId: data.scope.siteIds.length === 1 ? data.scope.siteIds[0] : null, title: `${s.name} – ${label}`,
      periodStart: period.from, periodEnd: period.to, status: s.autoApprove ? "APPROVED" : "GENERATED", approvedAt: s.autoApprove ? new Date() : null,
      notes: s.autoApprove ? null : null, data: data as unknown as Prisma.InputJsonValue,
    },
  });
  if (s.autoApprove) {
    await writeAuditLog({ organizationId: orgId, userId: null, action: "report.auto_approve", entityType: "Report", entityId: report.id, metadata: { scheduleId: s.id } });
    if (s.recipients.length) await sendReport(orgId, report.id, s.recipients);
  } else {
    const approvers = await prisma.membership.findMany({ where: { organizationId: orgId, role: { in: ["OWNER", "ADMIN", "MANAGER"] } }, select: { userId: true } });
    await notify({ organizationId: orgId, type: "report_ready", severity: "info", title: "Report ready for review", body: `${report.title}${s.recipients.length ? ` will be emailed to ${s.recipients.length} recipient(s) once approved.` : ""}`, link: `/reports/${report.id}`, userIds: approvers.map((m) => m.userId) });
  }
  return { reportId: report.id, autoApproved: s.autoApprove };
}

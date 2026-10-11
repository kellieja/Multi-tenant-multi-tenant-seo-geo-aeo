import type { Prisma, Workflow, WorkflowMode } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { OrgContext } from "@/lib/auth/context";
import type { JobContext } from "@/lib/jobs/context";
import { enqueueJob } from "@/lib/jobs/queue";
import { UserError } from "@/lib/errors";
import { writeAuditLog } from "@/lib/audit-log";
import { nextCronRun } from "@/lib/cron";
import { ACTIONS, CONDITION_FIELDS, evaluateCondition, workflowSchema, type ActionType, type EventName, type WorkflowInput } from "./workflow-schema";
import { queueCrawl } from "./crawls";
import { readSettings } from "./websites";
import { requestApproval, assertApproved } from "./approvals";
import { notify } from "./notifications";
import { sendEmail, postSlack } from "./delivery";
import { generateMetadataSuggestions } from "./content";

type Log = { at: string; level: "info" | "warn" | "error" | "dry-run"; message: string; data?: unknown };

function computeNext(trigger: WorkflowInput["trigger"], from = new Date()) {
  return trigger.type === "schedule" ? nextCronRun(trigger.cron, from) : null;
}

function validate(input: unknown) {
  const data = workflowSchema.parse(input);
  if (data.trigger.type === "schedule") {
    try { nextCronRun(data.trigger.cron, new Date()); } catch { throw new UserError("Schedule must be a valid 5-field cron expression, e.g. 0 3 * * 1"); }
  }
  return data;
}

export async function saveWorkflow(ctx: OrgContext, input: unknown, id?: string) {
  ctx.assert("automation:write");
  const data = validate(input);
  if (data.scope.type === "websites") {
    const n = await ctx.db.website.count({ where: { id: { in: data.scope.ids } } });
    if (n !== data.scope.ids.length) throw new UserError("Scope includes unknown websites");
  }
  if (data.scope.type === "clients") {
    const n = await ctx.db.client.count({ where: { id: { in: data.scope.ids } } });
    if (n !== data.scope.ids.length) throw new UserError("Scope includes unknown clients");
  }
  const row = {
    name: data.name, description: data.description ?? null, mode: data.mode as WorkflowMode,
    trigger: data.trigger as Prisma.InputJsonValue, conditions: data.conditions as Prisma.InputJsonValue,
    actions: data.actions as Prisma.InputJsonValue, scope: data.scope as Prisma.InputJsonValue,
    maxRetries: data.maxRetries, notifyOn: data.notifyOn, nextRunAt: computeNext(data.trigger),
  };
  const wf = id
    ? await ctx.db.workflow.update({ where: { id }, data: row })
    : await ctx.db.workflow.create({ data: { ...row, organizationId: ctx.org.id, createdById: ctx.userId } });
  await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: id ? "workflow.update" : "workflow.create", entityType: "Workflow", entityId: wf.id, metadata: { mode: data.mode } });
  return wf;
}

export async function setWorkflowEnabled(ctx: OrgContext, id: string, enabled: boolean) {
  ctx.assert("automation:write");
  const wf = await ctx.db.workflow.findUnique({ where: { id } });
  if (!wf) throw new UserError("Workflow not found");
  const trigger = wf.trigger as WorkflowInput["trigger"];
  return ctx.db.workflow.update({ where: { id }, data: { enabled, nextRunAt: enabled ? computeNext(trigger) : null } });
}

export async function deleteWorkflow(ctx: OrgContext, id: string) {
  ctx.assert("automation:write");
  await ctx.db.workflow.delete({ where: { id } });
}

async function scopeWebsites(wf: Workflow, onlyWebsiteId?: string | null) {
  const scope = wf.scope as WorkflowInput["scope"];
  const where: Prisma.WebsiteWhereInput = { organizationId: wf.organizationId, status: "ACTIVE" };
  if (scope.type === "websites") where.id = { in: scope.ids };
  if (scope.type === "clients") where.clientId = { in: scope.ids };
  const sites = await prisma.website.findMany({ where, select: { id: true } });
  const ids = sites.map((s) => s.id);
  return onlyWebsiteId ? ids.filter((i) => i === onlyWebsiteId) : ids;
}

/** Queues one run per in-scope website. */
export async function dispatchWorkflow(wf: Workflow, triggeredBy: string, websiteId?: string | null, createdById?: string | null) {
  const ids = await scopeWebsites(wf, websiteId);
  for (const id of ids) {
    await enqueueJob({ organizationId: wf.organizationId, websiteId: id, type: "workflow-run", payload: { workflowId: wf.id, websiteId: id, triggeredBy }, createdById, attempts: wf.maxRetries + 1 });
  }
  return ids.length;
}

export async function runWorkflowNow(ctx: OrgContext, id: string) {
  ctx.assert("automation:write");
  const wf = await ctx.db.workflow.findUnique({ where: { id } });
  if (!wf) throw new UserError("Workflow not found");
  const n = await dispatchWorkflow(wf, "manual", null, ctx.userId);
  if (!n) throw new UserError("No active websites are in this workflow's scope");
  await ctx.db.workflow.update({ where: { id }, data: { lastRunAt: new Date() } });
  return n;
}

/** Called by modules when something happens (crawl completed, links lost, …). */
export async function emitEvent(organizationId: string, event: EventName, websiteId: string, data: Record<string, unknown> = {}) {
  const wfs = await prisma.workflow.findMany({ where: { organizationId, enabled: true, trigger: { path: ["event"], equals: event } } });
  let n = 0;
  for (const wf of wfs) n += await dispatchWorkflow(wf, `event:${event}`, websiteId);
  if (n) console.log(`[workflows] ${event} → ${n} run(s)`, data);
  return n;
}

/** Scheduler tick: dispatch scheduled workflows whose nextRunAt has passed. */
export async function scheduleWorkflows(now: Date) {
  const due = await prisma.workflow.findMany({ where: { enabled: true, nextRunAt: { lte: now } } });
  let n = 0;
  for (const wf of due) {
    const trigger = wf.trigger as WorkflowInput["trigger"];
    await prisma.workflow.update({ where: { id: wf.id }, data: { lastRunAt: now, nextRunAt: computeNext(trigger, now) } });
    n += await dispatchWorkflow(wf, "schedule");
  }
  return n;
}

/** Live per-website facts that conditions are evaluated against. */
export async function conditionContext(websiteId: string) {
  const site = await prisma.website.findUniqueOrThrow({ where: { id: websiteId } });
  const settings = readSettings(site.settings);
  const DAY = 86400_000;
  const now = Date.now();
  const [crawl, openCritical, openFindings, missingMeta, cur, prev, lost, keywords] = await Promise.all([
    prisma.crawl.findFirst({ where: { websiteId, status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" } }),
    prisma.auditFinding.count({ where: { websiteId, severity: "CRITICAL", status: { in: ["OPEN", "REGRESSED"] } } }),
    prisma.auditFinding.count({ where: { websiteId, status: { in: ["OPEN", "REGRESSED", "IN_PROGRESS"] } } }),
    prisma.auditFinding.count({ where: { websiteId, issueType: { in: ["missing_title", "missing_meta_description"] }, status: { in: ["OPEN", "REGRESSED"] } } }),
    prisma.searchConsoleDaily.aggregate({ where: { websiteId, date: { gte: new Date(now - 28 * DAY) } }, _sum: { clicks: true }, _count: true }),
    prisma.searchConsoleDaily.aggregate({ where: { websiteId, date: { gte: new Date(now - 56 * DAY), lt: new Date(now - 28 * DAY) } }, _sum: { clicks: true } }),
    prisma.backlink.count({ where: { websiteId, lostAt: { gte: new Date(now - 7 * DAY) } } }),
    prisma.keyword.findMany({ where: { websiteId }, select: { observations: { orderBy: { observedAt: "desc" }, take: 2, select: { position: true } } } }),
  ]);
  const rankDrops = keywords.filter((k) => {
    const [a, b] = k.observations;
    if (!a || !b) return false;
    const now = a.position ?? 101, before = b.position ?? 101;
    return now - before >= settings.alertRankDrop;
  }).length;
  const clicks = cur._count ? cur._sum.clicks ?? 0 : null;
  const prevClicks = prev._sum.clicks ?? null;
  return {
    healthScore: crawl?.healthScore ?? null,
    openCritical, openFindings, missingMetadata: missingMeta,
    clicks28d: clicks,
    clicksChangePct: clicks != null && prevClicks ? Math.round(((clicks - prevClicks) / prevClicks) * 1000) / 10 : null,
    rankDrops, lostBacklinks7d: lost,
    daysSinceCrawl: crawl?.finishedAt ? Math.floor((now - crawl.finishedAt.getTime()) / DAY) : null,
    tag: site.tags, cmsType: site.cmsType,
  } satisfies Record<keyof typeof CONDITION_FIELDS, unknown>;
}

type Action = WorkflowInput["actions"][number];

/** Worker: executes one workflow for one website, with full execution logging. */
export async function processWorkflowRun(jc: JobContext) {
  const p = jc.job.payload as { workflowId: string; websiteId: string; triggeredBy: string; approvedAction?: Action; approvalId?: string };
  const wf = await prisma.workflow.findUnique({ where: { id: p.workflowId } });
  if (!wf || wf.organizationId !== jc.job.organizationId) throw new Error("Workflow not found");
  const logs: Log[] = [];
  const log = (level: Log["level"], message: string, data?: unknown) => logs.push({ at: new Date().toISOString(), level, message, ...(data !== undefined ? { data } : {}) });
  const exec = await prisma.workflowExecution.create({
    data: { organizationId: wf.organizationId, workflowId: wf.id, websiteId: p.websiteId, mode: wf.mode, triggeredBy: p.triggeredBy, status: "RUNNING", startedAt: new Date(), attempt: jc.job.attempts || 1 },
  });
  const save = (data: Prisma.WorkflowExecutionUpdateInput = {}) => prisma.workflowExecution.update({ where: { id: exec.id }, data: { logs: logs as unknown as Prisma.InputJsonValue, ...data } });

  try {
    if (!wf.enabled && p.triggeredBy !== "approval") {
      log("warn", "Workflow is paused; nothing executed");
      await save({ status: "CANCELLED", finishedAt: new Date() });
      return { skipped: "paused" };
    }
    const site = await prisma.website.findUniqueOrThrow({ where: { id: p.websiteId } });
    log("info", `Run started for ${site.domain} (${wf.mode.toLowerCase().replace("_", "-")} mode, trigger: ${p.triggeredBy})`);

    let actions = wf.actions as Action[];
    if (p.approvedAction) {
      await assertApproved(wf.organizationId, p.approvalId, "WorkflowExecutionAction", `${wf.id}:${p.websiteId}:${p.approvedAction.type}`);
      log("info", `Executing approved action: ${ACTIONS[p.approvedAction.type].label}`);
      actions = [p.approvedAction];
    } else {
      const ctx = await conditionContext(site.id);
      const conds = wf.conditions as WorkflowInput["conditions"];
      for (const c of conds) {
        const r = evaluateCondition(c, ctx);
        log(r.pass ? "info" : "warn", `Condition ${CONDITION_FIELDS[c.field].label} ${c.op} ${c.value}: actual ${JSON.stringify(r.actual)} → ${r.pass ? "pass" : "fail"}`);
        if (!r.pass) {
          log("info", "Conditions not met; no actions run");
          await save({ status: "SUCCEEDED", finishedAt: new Date() });
          return { conditionsMet: false };
        }
      }
    }

    const settings = readSettings(site.settings);
    let i = 0;
    for (const action of actions) {
      i++;
      await jc.progress(Math.round((i / actions.length) * 90), ACTIONS[action.type].label);
      const def = ACTIONS[action.type];
      if (wf.mode === "DRY_RUN") {
        log("dry-run", `Would run: ${def.label}`, action.params);
        continue;
      }
      const external = def.risk === "external";
      const autoAllowed = wf.mode === "AUTOMATIC" && settings.approvalPolicy === "safe-auto" && action.type === "propose_metadata_fixes";
      if (external && !p.approvedAction && wf.mode === "APPROVAL") {
        const a = await requestApproval({
          organizationId: wf.organizationId, websiteId: site.id, kind: "WORKFLOW_ACTION", subjectType: "WorkflowExecutionAction", subjectId: `${wf.id}:${site.id}:${action.type}`,
          summary: `Workflow "${wf.name}" wants to: ${def.label} on ${site.domain}`, payload: { workflowId: wf.id, websiteId: site.id, action },
        });
        log("info", `Approval requested for "${def.label}" (approval ${a.id.slice(-6)})`);
        continue;
      }
      const result = await runAction(action, { orgId: wf.organizationId, websiteId: site.id, domain: site.domain, workflow: wf, autoApprove: autoAllowed });
      log("info", `${def.label}: ${result}`);
    }
    await save({ status: "SUCCEEDED", finishedAt: new Date(), error: null });
    if (wf.notifyOn.includes("SUCCEEDED")) await notify({ organizationId: wf.organizationId, websiteId: p.websiteId, type: "workflow_succeeded", severity: "success", title: `Workflow "${wf.name}" completed`, body: logs.slice(-3).map((l) => l.message).join("\n"), link: `/automation?tab=executions` });
    return { executed: actions.length };
  } catch (err) {
    const message = (err as Error).message;
    log("error", message);
    const final = (jc.job.attempts || 1) >= wf.maxRetries + 1;
    await save({ status: "FAILED", error: message.slice(0, 1000), finishedAt: new Date() });
    if (final && wf.notifyOn.includes("FAILED")) {
      await notify({ organizationId: wf.organizationId, websiteId: p.websiteId, type: "workflow_failed", severity: "warning", title: `Workflow "${wf.name}" failed`, body: message, link: `/automation?tab=executions` });
    }
    throw err;
  }
}

async function runAction(action: Action, c: { orgId: string; websiteId: string; domain: string; workflow: Workflow; autoApprove: boolean }): Promise<string> {
  const P = action.params as Record<string, string | number>;
  const enqueue = async (type: Parameters<typeof enqueueJob>[0]["type"], payload: Record<string, unknown> = {}) => {
    const { job, deduped } = await enqueueJob({ organizationId: c.orgId, websiteId: c.websiteId, type, payload, dedupe: true });
    if (job.status === "FAILED") throw new Error(job.error ?? "Could not queue job");
    return deduped ? "already running" : `queued job ${job.id.slice(-6)}`;
  };
  switch (action.type as ActionType) {
    case "run_crawl": {
      const { crawl, deduped } = await queueCrawl(c.orgId, c.websiteId, P.mode === "FULL" ? "FULL" : "INCREMENTAL", null, `workflow:${c.workflow.name}`);
      return deduped ? "a crawl is already running" : `crawl ${crawl.id.slice(-6)} queued`;
    }
    case "create_tasks": {
      const order = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
      const min = order.indexOf(String(P.minSeverity ?? "HIGH"));
      const findings = await prisma.auditFinding.findMany({
        where: { websiteId: c.websiteId, status: { in: ["OPEN", "REGRESSED"] }, severity: { in: order.slice(0, min + 1) as never }, tasks: { none: { status: { in: ["TODO", "IN_PROGRESS"] } } } },
        orderBy: { priorityScore: "desc" }, take: Number(P.limit ?? 20),
      });
      for (const f of findings) {
        await prisma.task.create({ data: { organizationId: c.orgId, websiteId: c.websiteId, findingId: f.id, title: `${f.title}: ${f.url}`.slice(0, 300), description: `${f.recommendation}\n\n${f.implementation}`, priority: Math.round(f.priorityScore), source: `workflow:${c.workflow.name}` } });
        await prisma.auditFinding.update({ where: { id: f.id }, data: { status: "IN_PROGRESS" } });
        await prisma.findingEvent.create({ data: { organizationId: c.orgId, findingId: f.id, fromStatus: f.status, toStatus: "IN_PROGRESS", note: `Task created by workflow "${c.workflow.name}"` } });
      }
      return `${findings.length} task(s) created`;
    }
    case "run_pagespeed": return enqueue("psi-check");
    case "sync_search_console": return enqueue("gsc-sync");
    case "check_rankings": return enqueue("rank-check");
    case "sync_backlinks": return enqueue("backlink-sync");
    case "verify_backlinks": return enqueue("backlink-verify");
    case "run_geo": return enqueue("geo-run");
    case "generate_report": return enqueue("report-generate", { days: Number(P.days ?? 30), source: `workflow:${c.workflow.name}` });
    case "suggest_metadata": {
      const r = await generateMetadataSuggestions(c.orgId, c.websiteId, { limit: Number(P.limit ?? 10) });
      return `${r.created} draft(s) created for review in Content Studio`;
    }
    case "propose_metadata_fixes": {
      const { proposeApprovedSuggestions } = await import("./content-apply");
      const r = await proposeApprovedSuggestions(c.orgId, c.websiteId, { limit: Number(P.limit ?? 10), autoApprove: c.autoApprove, source: `workflow:${c.workflow.name}` });
      return `${r.proposed} change(s) proposed${c.autoApprove ? " and auto-approved under the site's safe-auto policy" : " and waiting for approval"}`;
    }
    case "notify": {
      const message = String(P.message ?? `Workflow "${c.workflow.name}" ran for ${c.domain}`);
      const channel = String(P.channel ?? "in-app");
      if (channel === "slack") { const ok = await postSlack(c.orgId, `${message}\n${c.domain}`); if (!ok) throw new Error("Slack is not connected"); return "posted to Slack"; }
      if (channel === "email") {
        const org = await prisma.organization.findUniqueOrThrow({ where: { id: c.orgId } });
        const to = (org.settings as { notifyEmail?: string }).notifyEmail;
        if (!to) throw new Error("Set an alert email in Settings → Workspace first");
        await sendEmail(c.orgId, { to, subject: `[${c.domain}] ${c.workflow.name}`, text: message });
        return `emailed ${to}`;
      }
      await notify({ organizationId: c.orgId, websiteId: c.websiteId, type: "workflow_notice", title: message, link: "/automation" });
      return "in-app notification sent";
    }
  }
}

export { workflowSchema };

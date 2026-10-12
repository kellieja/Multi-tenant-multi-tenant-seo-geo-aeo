import Link from "next/link";
import { Plus, Workflow as WorkflowIcon, Pause, Play } from "lucide-react";
import { requireStaffContext, websiteWhere } from "@/lib/auth/context";
import { prisma } from "@/lib/db/client";
import { PageHeader, EmptyState, Notice } from "@/components/ui/page";
import { Card, CardHeader } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tabs";
import { Badge, jobTone } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Table, THead, TH, TR, TD, Pagination, makeHref } from "@/components/ui/table";
import { ActionButton } from "@/components/ui/action-form";
import { JobProgress } from "@/components/jobs/job-progress";
import { JOB_TYPES, type JobType } from "@/lib/jobs/types";
import { ACTIONS, EVENTS, type WorkflowInput } from "@/server/workflow-schema";
import { fmtDate, fmtDuration, fmtRelative } from "@/lib/format";
import { toggleWorkflowAction, runWorkflowAction, cancelJobAction, rollbackAction, archiveChangePackAction } from "./actions";
import { ApprovalCard, TaskRow, CreatePackForm, PromptBox, type ApprovalDetail } from "./parts";
import { packItems, packPromptFor } from "@/server/change-packs";
import { changeRegion } from "@/lib/diff";

export const metadata = { title: "Automation Center" };

const modeTone = { DRY_RUN: "neutral", APPROVAL: "warn", AUTOMATIC: "accent" } as const;
const triggerLabel = (t: WorkflowInput["trigger"]) => t.type === "schedule" ? `Cron ${t.cron} (UTC)` : t.type === "event" ? `When: ${EVENTS[t.event].toLowerCase()}` : "Manual only";

export default async function AutomationPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireStaffContext();
  const [pendingApprovals, activeJobs, openTasks] = await Promise.all([
    ctx.db.approval.count({ where: { status: "PENDING" } }),
    ctx.db.job.count({ where: { status: { in: ["QUEUED", "RUNNING"] } } }),
    ctx.db.task.count({ where: { status: { in: ["TODO", "IN_PROGRESS"] } } }),
  ]);
  const tabs = [
    { key: "workflows", label: "Workflows" },
    { key: "approvals", label: "Approvals", count: pendingApprovals },
    { key: "tasks", label: "Tasks", count: openTasks },
    { key: "executions", label: "Execution log" },
    { key: "jobs", label: "Background jobs", count: activeJobs },
    { key: "changes", label: "Site changes" },
    { key: "packs", label: "Change packs" },
  ];
  const tab = tabs.find((t) => t.key === sp.tab)?.key ?? "workflows";
  const canWrite = ctx.can("automation:write");

  return (
    <>
      <PageHeader
        title="Automation Center"
        description="Workflows run on schedules or events across selected websites. Anything that touches a live site or contacts people goes through approval."
        actions={canWrite && <ButtonLink href="/automation/workflows/new" variant="primary"><Plus className="size-3.5" />New workflow</ButtonLink>}
      />
      <TabNav active={tab} tabs={tabs.map((t) => ({ ...t, href: `/automation?tab=${t.key}` }))} />
      {tab === "workflows" && <Workflows />}
      {tab === "approvals" && <Approvals />}
      {tab === "tasks" && <Tasks />}
      {tab === "executions" && <Executions />}
      {tab === "jobs" && <Jobs />}
      {tab === "changes" && <Changes />}
      {tab === "packs" && <Packs />}
    </>
  );

  async function Workflows() {
    const wfs = await ctx.db.workflow.findMany({ orderBy: { createdAt: "desc" } });
    const stats = await ctx.db.workflowExecution.groupBy({ by: ["workflowId", "status"], where: { createdAt: { gte: new Date(Date.now() - 30 * 86400_000) } }, _count: true });
    if (!wfs.length) return <Card><EmptyState icon={<WorkflowIcon className="size-5" />} title="No workflows yet" description="Start from a template (weekly audits, critical-issue alerts, metadata drafts, backlink watch, monthly reports) or build your own." action={canWrite && <ButtonLink href="/automation/workflows/new" variant="primary">Create a workflow</ButtonLink>} /></Card>;
    return (
      <Card>
        <Table>
          <THead><tr><TH>Workflow</TH><TH>Trigger</TH><TH>Mode</TH><TH>Status</TH><TH align="right">30-day runs</TH><TH>Last / next run</TH>{canWrite && <TH align="right"><span className="sr-only">Actions</span></TH>}</tr></THead>
          <tbody>
            {wfs.map((w) => {
              const s = (st: string) => stats.find((x) => x.workflowId === w.id && x.status === st)?._count ?? 0;
              const actions = (w.actions as WorkflowInput["actions"]).map((a) => ACTIONS[a.type]?.label ?? a.type);
              return (
                <TR key={w.id}>
                  <TD><Link href={`/automation/workflows/${w.id}`} className="font-medium hover:text-accent">{w.name}</Link><div className="max-w-md truncate text-2xs text-fg-subtle">{actions.join(" → ")}</div></TD>
                  <TD className="text-xs">{triggerLabel(w.trigger as WorkflowInput["trigger"])}</TD>
                  <TD><Badge tone={modeTone[w.mode]}>{w.mode.toLowerCase().replace("_", "-")}</Badge></TD>
                  <TD>{w.enabled ? <Badge tone="good">active</Badge> : <Badge>paused</Badge>}</TD>
                  <TD align="right" className="text-xs"><span className="text-good">{s("SUCCEEDED")} ok</span> · <span className={s("FAILED") ? "text-bad" : ""}>{s("FAILED")} failed</span></TD>
                  <TD className="text-xs text-fg-muted">{fmtRelative(w.lastRunAt)}{w.nextRunAt && <div className="text-2xs">next {fmtRelative(w.nextRunAt)}</div>}</TD>
                  {canWrite && (
                    <TD align="right">
                      <div className="flex justify-end gap-1">
                        <ActionButton action={runWorkflowAction} fields={{ id: w.id }} size="sm">Run now</ActionButton>
                        <ActionButton action={toggleWorkflowAction} fields={{ id: w.id, enabled: w.enabled ? "0" : "1" }} size="icon" variant="ghost" aria-label={w.enabled ? "Pause" : "Resume"} title={w.enabled ? "Pause" : "Resume"}>{w.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}</ActionButton>
                      </div>
                    </TD>
                  )}
                </TR>
              );
            })}
          </tbody>
        </Table>
      </Card>
    );
  }

  async function Approvals() {
    const status = sp.status === "decided" ? "decided" : "PENDING";
    const rows = await ctx.db.approval.findMany({ where: { ...(status === "PENDING" ? { status: "PENDING" as const } : { status: { not: "PENDING" as const } }), ...(ctx.websiteScope ? { websiteId: { in: ctx.websiteScope } } : {}) }, orderBy: { createdAt: "desc" }, take: 50 });
    const users = await prisma.user.findMany({ where: { id: { in: rows.flatMap((r) => [r.requestedById, r.decidedById]).filter(Boolean) as string[] } }, select: { id: true, name: true } });
    const name = new Map(users.map((u) => [u.id, u.name]));
    // Approvers review the full change, not the truncated preview stored in the payload.
    const changes = await ctx.db.siteChange.findMany({ where: { id: { in: rows.filter((r) => r.subjectType === "SiteChange").map((r) => r.subjectId) } }, select: { id: true, field: true, before: true, after: true } });
    const changeById = new Map(changes.map((c) => [c.id, c]));
    const emails = await ctx.db.outreachMessage.findMany({ where: { approvalId: { in: rows.filter((r) => r.kind === "OUTREACH_SEND").map((r) => r.id) } }, select: { approvalId: true, subject: true, body: true, prospect: { select: { contactEmail: true, domain: true } } }, take: 2000 });
    const detailFor = (a: (typeof rows)[number]): ApprovalDetail | undefined => {
      const c = a.subjectType === "SiteChange" ? changeById.get(a.subjectId) : undefined;
      if (c) return { type: "diff", field: c.field, region: changeRegion(c.before ?? "", c.after), afterLength: c.after.length };
      if (a.kind === "OUTREACH_SEND") return { type: "emails", items: emails.filter((m) => m.approvalId === a.id).map((m) => ({ to: m.prospect.contactEmail ?? m.prospect.domain, subject: m.subject, body: m.body })) };
      return undefined;
    };
    return (
      <div className="space-y-3">
        <div className="flex gap-2 text-xs">
          <Link href="/automation?tab=approvals" className={status === "PENDING" ? "font-semibold text-fg" : "text-fg-muted hover:text-fg"}>Pending</Link>
          <Link href="/automation?tab=approvals&status=decided" className={status === "decided" ? "font-semibold text-fg" : "text-fg-muted hover:text-fg"}>History</Link>
        </div>
        {!ctx.can("approvals:decide") && <Notice tone="info">You can view approval requests but only owners, admins and managers can decide them.</Notice>}
        {rows.length === 0 ? <Card><EmptyState title={status === "PENDING" ? "Nothing waiting for approval" : "No decisions yet"} description="Site changes, outreach sends and external workflow actions appear here before anything happens." /></Card> : rows.map((a) => (
          <ApprovalCard key={a.id} approval={{ id: a.id, kind: a.kind, summary: a.summary, status: a.status, payload: a.payload as Record<string, unknown>, createdAt: a.createdAt.toISOString(), requestedBy: a.requestedById ? name.get(a.requestedById) ?? "user" : "automation", decidedBy: a.decidedById ? name.get(a.decidedById) ?? "user" : a.status === "APPROVED" ? "policy" : null, note: a.note, expiresAt: a.expiresAt?.toISOString() ?? null }} detail={detailFor(a)} canDecide={ctx.can("approvals:decide")} />
        ))}
      </div>
    );
  }

  async function Tasks() {
    const statusFilter = sp.status === "done" ? ["DONE", "CANCELLED"] : ["TODO", "IN_PROGRESS"];
    const where = { ...websiteWhere(ctx, sp.websiteId), status: { in: statusFilter as never[] }, ...(ctx.role === "CLIENT" ? { visibleToClient: true } : {}), ...(sp.mine ? { assigneeId: ctx.userId } : {}) };
    const page = Math.max(1, Number(sp.page ?? 1));
    const [total, tasks, members, sites] = await Promise.all([
      ctx.db.task.count({ where }),
      ctx.db.task.findMany({ where, orderBy: [{ priority: "desc" }, { createdAt: "desc" }], skip: (page - 1) * 50, take: 50, include: { assignee: { select: { name: true } } } }),
      ctx.db.membership.findMany({ where: { role: { not: "CLIENT" } }, include: { user: { select: { id: true, name: true } } } }),
      ctx.db.website.findMany({ select: { id: true, name: true } }),
    ]);
    const siteName = new Map(sites.map((s) => [s.id, s.name]));
    return (
      <Card>
        <CardHeader title="SEO tasks" description="Created from findings manually or by workflows. Completing a task doesn't resolve its finding; the next crawl verifies the fix."
          actions={<div className="flex gap-3 text-xs"><Link href="/automation?tab=tasks" className={!sp.status ? "font-semibold" : "text-fg-muted"}>Open</Link><Link href="/automation?tab=tasks&mine=1" className={sp.mine ? "font-semibold" : "text-fg-muted"}>Mine</Link><Link href="/automation?tab=tasks&status=done" className={sp.status === "done" ? "font-semibold" : "text-fg-muted"}>Done</Link></div>} />
        {tasks.length === 0 ? <EmptyState title="No tasks here" description="Create tasks from audit findings or with a workflow." /> : (
          <>
            <Table>
              <THead><tr><TH align="right">Priority</TH><TH>Task</TH><TH>Website</TH><TH>Assignee</TH><TH>Status</TH><TH>Created</TH></tr></THead>
              <tbody>{tasks.map((t) => <TaskRow key={t.id} task={{ id: t.id, title: t.title, priority: t.priority, status: t.status, source: t.source, findingId: t.findingId, assigneeId: t.assigneeId, visibleToClient: t.visibleToClient, website: t.websiteId ? siteName.get(t.websiteId) ?? "" : "", createdAt: t.createdAt.toISOString() }} members={members.map((m) => m.user)} canWrite={ctx.can("tasks:write")} />)}</tbody>
            </Table>
            <Pagination page={page} pages={Math.max(1, Math.ceil(total / 50))} total={total} pageSize={50} href={makeHref("/automation", { ...sp, tab: "tasks" })} />
          </>
        )}
      </Card>
    );
  }

  async function Executions() {
    const rows = await ctx.db.workflowExecution.findMany({ where: ctx.websiteScope ? { websiteId: { in: ctx.websiteScope } } : {}, orderBy: { createdAt: "desc" }, take: 60, include: { workflow: { select: { name: true } } } });
    const sites = await ctx.db.website.findMany({ select: { id: true, name: true } });
    const siteName = new Map(sites.map((s) => [s.id, s.name]));
    if (!rows.length) return <Card><EmptyState title="No workflow runs yet" /></Card>;
    return (
      <div className="space-y-2">
        {rows.map((r) => (
          <details key={r.id} className="group rounded-[var(--radius-card)] border border-border bg-surface">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-4 py-2.5 text-[13px]">
              <Badge tone={jobTone(r.status)}>{r.status.toLowerCase()}</Badge>
              <span className="font-medium">{r.workflow.name}</span>
              <span className="text-xs text-fg-muted">{r.websiteId ? siteName.get(r.websiteId) : "—"}</span>
              <Badge tone={modeTone[r.mode]}>{r.mode.toLowerCase().replace("_", "-")}</Badge>
              <span className="text-xs text-fg-subtle">{r.triggeredBy}{r.attempt > 1 ? ` · attempt ${r.attempt}` : ""}</span>
              <span className="ml-auto text-xs text-fg-subtle">{fmtDate(r.createdAt, true)}{r.startedAt && r.finishedAt ? ` · ${fmtDuration(r.finishedAt.getTime() - r.startedAt.getTime())}` : ""}</span>
            </summary>
            <ol className="border-t border-border px-4 py-2.5 font-mono text-xs">
              {(r.logs as { at: string; level: string; message: string }[]).map((l, i) => (
                <li key={i} className="flex gap-3 py-0.5"><span className="text-fg-subtle">{l.at.slice(11, 19)}</span><span className={l.level === "error" ? "text-bad" : l.level === "warn" ? "text-warn" : l.level === "dry-run" ? "text-info" : "text-fg-muted"}>{l.level}</span><span className="text-fg">{l.message}</span></li>
              ))}
              {r.error && <li className="pt-1 text-bad">{r.error}</li>}
            </ol>
          </details>
        ))}
      </div>
    );
  }

  async function Jobs() {
    const page = Math.max(1, Number(sp.page ?? 1));
    const where = { ...(ctx.websiteScope ? { websiteId: { in: ctx.websiteScope } } : {}), ...(sp.status ? { status: sp.status as never } : {}) };
    const [total, jobs, sites] = await Promise.all([
      ctx.db.job.count({ where }),
      ctx.db.job.findMany({ where, orderBy: { queuedAt: "desc" }, skip: (page - 1) * 50, take: 50 }),
      ctx.db.website.findMany({ select: { id: true, name: true } }),
    ]);
    const siteName = new Map(sites.map((s) => [s.id, s.name]));
    return (
      <Card>
        <CardHeader title="Background jobs" description="Every crawl, sync, check and automation run, with live progress and the exact failure message. Retries use exponential backoff." actions={<div className="flex gap-3 text-xs">{["", "RUNNING", "QUEUED", "FAILED", "SUCCEEDED"].map((s) => <Link key={s} href={`/automation?tab=jobs${s ? `&status=${s}` : ""}`} className={(sp.status ?? "") === s ? "font-semibold" : "text-fg-muted"}>{s ? s.toLowerCase() : "all"}</Link>)}</div>} />
        {jobs.length === 0 ? <EmptyState title="No jobs" /> : (
          <>
            <Table>
              <THead><tr><TH>Job</TH><TH>Website</TH><TH>Status / progress</TH><TH align="right">Attempts</TH><TH>Queued</TH><TH align="right">Duration</TH>{ctx.can("audits:run") && <TH />}</tr></THead>
              <tbody>
                {jobs.map((j) => {
                  const active = j.status === "QUEUED" || j.status === "RUNNING";
                  return (
                    <TR key={j.id}>
                      <TD className="font-medium">{JOB_TYPES[j.type as JobType]?.label ?? j.type}</TD>
                      <TD className="text-xs">{j.websiteId ? siteName.get(j.websiteId) : "—"}</TD>
                      <TD className="min-w-64">{active ? <JobProgress jobId={j.id} initial={j} compact /> : <><Badge tone={jobTone(j.status)}>{j.status.toLowerCase()}</Badge>{(j.error || j.progressMessage) && <div className={`mt-0.5 max-w-sm text-2xs ${j.status === "FAILED" ? "text-bad" : "text-fg-subtle"}`}>{j.error ?? j.progressMessage}</div>}</>}</TD>
                      <TD align="right">{j.attempts}</TD>
                      <TD className="text-xs text-fg-muted">{fmtRelative(j.queuedAt)}</TD>
                      <TD align="right" className="text-xs text-fg-muted">{j.startedAt && j.finishedAt ? fmtDuration(j.finishedAt.getTime() - j.startedAt.getTime()) : "—"}</TD>
                      {ctx.can("audits:run") && <TD align="right">{active && <ActionButton action={cancelJobAction} fields={{ id: j.id }} size="sm" variant="ghost">Cancel</ActionButton>}</TD>}
                    </TR>
                  );
                })}
              </tbody>
            </Table>
            <Pagination page={page} pages={Math.max(1, Math.ceil(total / 50))} total={total} pageSize={50} href={makeHref("/automation", { ...sp, tab: "jobs" })} />
          </>
        )}
      </Card>
    );
  }

  async function Packs() {
    const sites = await ctx.db.website.findMany({ where: { status: { not: "ARCHIVED" }, ...(ctx.websiteScope ? { id: { in: ctx.websiteScope } } : {}) }, select: { id: true, name: true }, orderBy: { name: "asc" } });
    const packs = await ctx.db.changePack.findMany({ where: { status: { in: sp.status === "all" ? ["OPEN", "VERIFIED", "ARCHIVED"] : ["OPEN", "VERIFIED"] }, ...websiteWhere(ctx) }, orderBy: { createdAt: "desc" }, take: 50 });
    const siteName = new Map(sites.map((s) => [s.id, s.name]));
    const selected = sp.id ? packs.find((p) => p.id === sp.id) ?? null : null;
    const prompt = selected ? await packPromptFor(selected) : null;
    const kindLabel: Record<string, string> = { title: "Title", meta_description: "Meta description", internal_link: "Internal link", answer_section: "Answer section", issue: "Issue" };
    return (
      <div className="space-y-4">
        <Notice tone="info">For sites without a connected CMS (Replit apps, static or custom-built sites): bundle approved titles, meta descriptions, answer sections and internal links into exact instructions. Apply them by hand or paste the prompt into Replit Agent, then deploy. The next crawl checks every item and marks it done.</Notice>
        {ctx.can("content:write") && sites.length > 0 && <Card className="p-4"><CreatePackForm sites={sites} /></Card>}
        {!packs.length ? <Card><EmptyState title="No change packs yet" description="Approve suggestions in Content Studio, AEO or Internal Linking first, then create a pack for the website." /></Card> : (
          <Card>
            <Table>
              <THead><tr><TH>Pack</TH><TH>Website</TH><TH>Progress</TH><TH>Status</TH><TH><span className="sr-only">Actions</span></TH></tr></THead>
              <tbody>{packs.map((p) => {
                const items = packItems(p);
                const done = items.filter((i) => i.status === "done").length;
                return (
                  <TR key={p.id}>
                    <TD><Link href={`/automation?tab=packs&id=${p.id}`} className="font-medium hover:underline">{p.title}</Link><div className="text-2xs text-fg-subtle">created {fmtRelative(p.createdAt)}{p.lastCheckedAt ? ` · checked ${fmtRelative(p.lastCheckedAt)}` : " · not checked yet"}</div></TD>
                    <TD className="text-fg-muted">{siteName.get(p.websiteId) ?? ""}</TD>
                    <TD className="tabular">{done} / {items.length} live</TD>
                    <TD><Badge tone={p.status === "VERIFIED" ? "good" : p.status === "ARCHIVED" ? "neutral" : "warn"}>{p.status === "OPEN" ? "waiting for next crawl" : p.status.toLowerCase()}</Badge></TD>
                    <TD align="right"><div className="flex justify-end gap-2 text-xs">
                      <a className="text-accent hover:underline" href={`/api/change-packs/${p.id}?format=md`}>Checklist</a>
                      <a className="text-accent hover:underline" href={`/api/change-packs/${p.id}?format=json`}>JSON</a>
                      {p.status === "OPEN" && ctx.can("content:write") && <ActionButton action={archiveChangePackAction} fields={{ id: p.id }} size="sm" variant="ghost">Archive</ActionButton>}
                    </div></TD>
                  </TR>
                );
              })}</tbody>
            </Table>
          </Card>
        )}
        {selected && prompt && (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title={selected.title} description={`${siteName.get(selected.websiteId) ?? ""} · ${packItems(selected).length} item(s)`} />
              <ul className="divide-y divide-border text-[13px]">{packItems(selected).map((i) => (
                <li key={i.id} className="flex items-start gap-2.5 px-4 py-2">
                  <Badge tone={i.status === "done" ? "good" : "neutral"}>{i.status === "done" ? "live" : "to do"}</Badge>
                  <div className="min-w-0"><div className="font-medium">{kindLabel[i.kind]} · <span className="text-fg-muted">{(() => { try { return new URL(i.url).pathname; } catch { return i.url; } })()}</span></div><div className="truncate text-2xs text-fg-subtle">{i.kind === "internal_link" ? `“${i.detail?.anchor}” → ${i.proposed}` : i.kind === "answer_section" ? i.detail?.heading : i.proposed}</div></div>
                </li>
              ))}</ul>
            </Card>
            <Card><CardHeader title="Prompt for Replit Agent" description="Paste into Replit Agent (or any coding assistant) in the site's project, review its changes, then deploy." /><div className="p-4 pt-0"><PromptBox prompt={prompt} /></div></Card>
          </div>
        )}
      </div>
    );
  }

  async function Changes() {
    const rows = await ctx.db.siteChange.findMany({ where: websiteWhere(ctx), orderBy: { createdAt: "desc" }, take: 100 });
    if (!rows.length) return <Card><EmptyState title="No site changes yet" description="Approved changes applied through CMS connectors are listed here with the previous value kept for rollback." /></Card>;
    const tone = (s: string) => ({ APPLIED: "good", PENDING_APPROVAL: "warn", APPROVED: "info", PR_OPEN: "info", REVERT_PR_OPEN: "info", FAILED: "bad", ROLLED_BACK: "neutral", REJECTED: "neutral" } as const)[s as "APPLIED"] ?? "neutral";
    const statusLabel = (s: string) => ({ PR_OPEN: "pull request open", REVERT_PR_OPEN: "revert PR open" } as Record<string, string>)[s] ?? s.toLowerCase().replace("_", " ");
    return (
      <Card>
        <Table>
          <THead><tr><TH>Page</TH><TH>Field</TH><TH>Before → after</TH><TH>Status</TH><TH>Source</TH><TH>When</TH>{ctx.can("approvals:decide") && <TH />}</tr></THead>
          <tbody>
            {rows.map((c) => (
              <TR key={c.id}>
                <TD className="max-w-xs truncate text-xs">{c.targetUrl}</TD>
                <TD><code className="font-mono text-2xs">{c.field === "file" ? c.targetRef.replace(/^(file|gh):|@[0-9a-f]+$/g, "") : c.field}</code><div className="text-2xs text-fg-subtle">{c.connector}</div></TD>
                <TD className="max-w-md text-xs">{(() => {
                  // Whole-file changes: show only the text that changes.
                  const r = c.field === "file" ? changeRegion(c.before ?? "", c.after, 0) : null;
                  return <><div className="truncate text-fg-subtle line-through">{(r ? r.removed : c.before) || "(empty)"}</div><div className="truncate">{r ? r.added : c.after}</div></>;
                })()}</TD>
                <TD><Badge tone={tone(c.status)}>{statusLabel(c.status)}</Badge>{c.externalUrl && <div className="mt-0.5"><a href={c.externalUrl} target="_blank" rel="noreferrer noopener" className="text-2xs text-accent hover:underline">View pull request</a></div>}{c.error && <div className="mt-0.5 max-w-xs text-2xs text-bad">{c.error}</div>}</TD>
                <TD className="text-xs text-fg-muted">{c.source}</TD>
                <TD className="text-xs text-fg-muted">{fmtRelative(c.appliedAt ?? c.createdAt)}</TD>
                {ctx.can("approvals:decide") && <TD align="right">{c.status === "APPLIED" && c.before != null && <ActionButton action={rollbackAction} fields={{ id: c.id }} size="sm" variant="ghost" confirm={c.connector === "github" ? "Open a pull request that reverts this change?" : "Restore the previous value on the live site?"}>{c.connector === "github" ? "Open revert PR" : "Roll back"}</ActionButton>}</TD>}
              </TR>
            ))}
          </tbody>
        </Table>
      </Card>
    );
  }
}

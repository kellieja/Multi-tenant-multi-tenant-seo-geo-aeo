import Link from "next/link";
import { FileBarChart } from "lucide-react";
import { requireOrgContext } from "@/lib/auth/context";
import { PageHeader, EmptyState, Notice } from "@/components/ui/page";
import { Card, CardHeader } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Table, THead, TH, TR, TD } from "@/components/ui/table";
import { ActionButton } from "@/components/ui/action-form";
import { fmtDate, fmtRelative } from "@/lib/format";
import { listReportsForViewer, readReportData } from "@/server/reports";
import { NewReportDialog, ScheduleDialog } from "./forms";
import { toggleScheduleAction, deleteScheduleAction } from "./actions";

export const metadata = { title: "Reports" };

const STATUS_TONE: Record<string, "good" | "warn" | "neutral"> = { APPROVED: "good", GENERATED: "warn", DRAFT: "neutral" };
const STATUS_LABEL: Record<string, string> = { APPROVED: "approved", GENERATED: "awaiting approval", DRAFT: "draft" };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireOrgContext();
  const isClient = ctx.role === "CLIENT";
  const staffTabs = [{ key: "reports", label: "Reports" }, { key: "schedules", label: "Schedules" }];
  const tab = !isClient && sp.tab === "schedules" ? "schedules" : "reports";
  const canWrite = ctx.can("reports:write");
  const canApprove = ctx.can("reports:approve");
  const sites = await ctx.db.website.findMany({ where: { status: { not: "ARCHIVED" }, ...(ctx.websiteScope ? { id: { in: ctx.websiteScope } } : {}) }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const clients = isClient ? [] : await ctx.db.client.findMany({ where: { archivedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const now = new Date();
  const lastMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const lastMonthStart = new Date(Date.UTC(lastMonthEnd.getUTCFullYear(), lastMonthEnd.getUTCMonth(), 1));
  const defaults = { from: lastMonthStart.toISOString().slice(0, 10), to: lastMonthEnd.toISOString().slice(0, 10), title: `SEO report – ${lastMonthStart.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}` };

  return (
    <>
      <PageHeader
        title="Reports"
        description={isClient ? "Reports approved for you by your account team, and the work in progress on your websites." : "White-label reports with frozen numbers, approval before clients see them, PDF/CSV export and email schedules."}
        actions={canWrite && tab === "reports" && sites.length > 0 ? <NewReportDialog sites={sites} clients={clients} defaults={defaults} /> : undefined}
      />
      {!isClient && <TabNav active={tab} tabs={staffTabs.map((t) => ({ ...t, href: `/reports?tab=${t.key}` }))} />}
      {tab === "reports" ? <Reports /> : <Schedules />}
      {isClient && <ClientWork />}
    </>
  );

  async function Reports() {
    const reports = await listReportsForViewer(ctx);
    if (!reports.length) return <Card><EmptyState icon={<FileBarChart className="size-5" />} title={isClient ? "No reports shared yet" : "No reports yet"} description={isClient ? "Your account team will share reports here once they're approved." : sites.length ? "Generate a report for any period, review it, add commentary and approve it for your client." : "Add a website first."} /></Card>;
    return (
      <Card>
        <Table>
          <THead><tr><TH>Report</TH><TH>Period</TH><TH>Websites</TH><TH>Status</TH><TH>Created</TH></tr></THead>
          <tbody>
            {reports.map((r) => {
              const d = readReportData(r);
              return (
                <TR key={r.id}>
                  <TD><Link href={`/reports/${r.id}`} className="font-medium hover:underline">{r.title}</Link>{r.scheduleId && <span className="ml-1.5 text-2xs text-fg-subtle">scheduled</span>}</TD>
                  <TD className="whitespace-nowrap text-fg-muted">{fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)}</TD>
                  <TD className="max-w-60 truncate text-fg-muted">{d.scope.clientName ? `${d.scope.clientName}: ` : ""}{d.sites.map((s) => s.name).join(", ")}</TD>
                  <TD><Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{STATUS_LABEL[r.status] ?? r.status.toLowerCase()}</Badge></TD>
                  <TD className="whitespace-nowrap text-fg-muted">{fmtRelative(r.createdAt)}</TD>
                </TR>
              );
            })}
          </tbody>
        </Table>
      </Card>
    );
  }

  async function Schedules() {
    const schedules = await ctx.db.reportSchedule.findMany({ orderBy: { createdAt: "desc" } });
    const siteName = new Map(sites.map((s) => [s.id, s.name]));
    const clientName = new Map(clients.map((c) => [c.id, c.name]));
    return (
      <div className="space-y-3">
        {canWrite && <div className="flex justify-end"><ScheduleDialog sites={sites} clients={clients} canApprove={canApprove} /></div>}
        <Notice tone="info">Scheduled reports are generated by the background worker. Unless a schedule is set to approve automatically, each report waits for approval before anyone outside your team can see it or receive it by email. Email needs SMTP configured in Integrations.</Notice>
        {!schedules.length ? <Card><EmptyState title="No schedules" description="Create a weekly or monthly schedule per client or website." /></Card> : (
          <Card>
            <Table>
              <THead><tr><TH>Schedule</TH><TH>Scope</TH><TH>Recipients</TH><TH>Next run</TH><TH><span className="sr-only">Actions</span></TH></tr></THead>
              <tbody>
                {schedules.map((s) => (
                  <TR key={s.id}>
                    <TD><div className="font-medium">{s.name}</div><div className="text-2xs text-fg-subtle">{s.frequency.toLowerCase()} · {s.autoApprove ? <span className="text-warn">auto-approved</span> : "approval required"}{!s.enabled && " · paused"}</div></TD>
                    <TD className="max-w-60 truncate text-fg-muted">{s.clientId ? `${clientName.get(s.clientId) ?? "client"}: ` : ""}{s.websiteIds.length ? s.websiteIds.map((id) => siteName.get(id) ?? "?").join(", ") : "all websites"}</TD>
                    <TD className="text-fg-muted">{s.recipients.length || "–"}</TD>
                    <TD className="whitespace-nowrap text-fg-muted">{s.enabled && s.nextRunAt ? fmtDate(s.nextRunAt, true) : "–"}{s.lastRunAt && <div className="text-2xs text-fg-subtle">last {fmtRelative(s.lastRunAt)}</div>}</TD>
                    <TD align="right">
                      {canWrite && <div className="flex justify-end gap-1">
                        <ScheduleDialog sites={sites} clients={clients} canApprove={canApprove} initial={{ id: s.id, name: s.name, websiteIds: s.websiteIds, clientId: s.clientId, frequency: s.frequency, recipients: s.recipients, autoApprove: s.autoApprove }} />
                        <ActionButton action={toggleScheduleAction} fields={{ id: s.id, enabled: s.enabled ? "0" : "1" }} size="sm" variant="ghost">{s.enabled ? "Pause" : "Resume"}</ActionButton>
                        {canApprove && <ActionButton action={deleteScheduleAction} fields={{ id: s.id }} size="sm" variant="ghost" confirm="Delete this schedule? Existing reports are kept.">Delete</ActionButton>}
                      </div>}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </Card>
        )}
      </div>
    );
  }

  async function ClientWork() {
    const tasks = await ctx.db.task.findMany({
      where: { visibleToClient: true, ...(ctx.websiteScope ? { websiteId: { in: ctx.websiteScope } } : {}), OR: [{ status: { in: ["TODO", "IN_PROGRESS"] } }, { status: "DONE", completedAt: { gte: new Date(Date.now() - 60 * 86400_000) } }] },
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }], take: 100,
    });
    const siteName = new Map(sites.map((s) => [s.id, s.name]));
    return (
      <Card className="mt-5">
        <CardHeader title="Work on your websites" description="Tasks your account team has shared with you" />
        {!tasks.length ? <p className="px-4 pb-4 text-[13px] text-fg-muted">Nothing shared yet.</p> : (
          <Table>
            <THead><tr><TH>Task</TH><TH>Website</TH><TH>Status</TH><TH>Updated</TH></tr></THead>
            <tbody>{tasks.map((t) => (
              <TR key={t.id}>
                <TD><div className="font-medium">{t.title}</div>{t.description && <div className="max-w-xl truncate text-2xs text-fg-subtle">{t.description}</div>}</TD>
                <TD className="text-fg-muted">{t.websiteId ? siteName.get(t.websiteId) ?? "" : ""}</TD>
                <TD><Badge tone={t.status === "DONE" ? "good" : t.status === "IN_PROGRESS" ? "info" : "neutral"}>{t.status.replace("_", " ").toLowerCase()}</Badge></TD>
                <TD className="whitespace-nowrap text-fg-muted">{fmtRelative(t.completedAt ?? t.updatedAt)}</TD>
              </TR>
            ))}</tbody>
          </Table>
        )}
      </Card>
    );
  }
}

export const dynamic = "force-dynamic";

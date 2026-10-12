import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download } from "lucide-react";
import { requireOrgContext } from "@/lib/auth/context";
import { UserError } from "@/lib/errors";
import { PageHeader, Notice } from "@/components/ui/page";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { MetricTile, UnavailableTile } from "@/components/ui/metric";
import { Table, THead, TH, TR, TD } from "@/components/ui/table";
import { ActionButton } from "@/components/ui/action-form";
import { TrendChart } from "@/components/charts/charts";
import { fmtDate, fmtDec, fmtInt, fmtPct, pctChange } from "@/lib/format";
import { getReportForViewer, readReportData } from "@/server/reports";
import { NotesForm, SendForm } from "../forms";
import { approveReportAction, deleteReportAction } from "../actions";

export const metadata = { title: "Report" };

const pos = (p: number | null) => (p == null ? ">100" : `#${p}`);

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireOrgContext();
  const report = await getReportForViewer(ctx, (await params).id).catch((e) => { if (e instanceof UserError) notFound(); throw e; });
  const data = readReportData(report);
  const d = data.dashboard;
  const t = d.searchConsole.totals, p = d.searchConsole.previous;
  const approved = report.status === "APPROVED";
  const schedule = report.scheduleId ? await ctx.db.reportSchedule.findUnique({ where: { id: report.scheduleId } }) : null;
  const top10 = d.rankings.distribution.filter((b) => b.label === "1–3" || b.label === "4–10").reduce((n, b) => n + b.count, 0);

  return (
    <>
      <Link href="/reports" className="mb-2 inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg"><ArrowLeft className="size-3" />Reports</Link>
      <PageHeader
        title={report.title}
        description={`${fmtDate(report.periodStart)} – ${fmtDate(report.periodEnd)} · ${data.scope.clientName ? `${data.scope.clientName} · ` : ""}${data.sites.map((s) => s.domain).join(", ")} · branded as ${data.brand.name}`}
        actions={<div className="flex gap-2">
          <ButtonLink href={`/api/reports/${report.id}/csv`} prefetch={false}><Download className="size-3.5" />CSV</ButtonLink>
          <ButtonLink href={`/api/reports/${report.id}/pdf`} prefetch={false} variant="primary"><Download className="size-3.5" />PDF</ButtonLink>
        </div>}
      />

      {ctx.role !== "CLIENT" && (
        <Card className="mb-5">
          <CardHeader title="Review" actions={<Badge tone={approved ? "good" : "warn"}>{approved ? `approved ${fmtDate(report.approvedAt)}` : "awaiting approval"}</Badge>} />
          <CardBody className="space-y-4">
            {!approved && <Notice tone="info">Client users can&apos;t see this report until it&apos;s approved{schedule?.recipients.length ? <>, and approving emails it to <b>{schedule.recipients.join(", ")}</b></> : ""}. Numbers were frozen on {fmtDate(data.generatedAt, true)}.</Notice>}
            {!approved && ctx.can("reports:write") && <NotesForm id={report.id} notes={report.notes} />}
            <div className="flex flex-wrap items-end justify-between gap-3">
              {approved && ctx.can("reports:approve") ? <SendForm id={report.id} defaultRecipients={schedule?.recipients.join(", ") ?? ""} /> : <span />}
              <div className="flex gap-2">
                {!approved && ctx.can("reports:approve") && <ActionButton action={approveReportAction} fields={{ id: report.id }} variant="primary">Approve for client</ActionButton>}
                {ctx.can("reports:approve") && <ActionButton action={deleteReportAction} fields={{ id: report.id }} variant="ghost" confirm="Delete this report permanently?">Delete</ActionButton>}
              </div>
            </div>
          </CardBody>
        </Card>
      )}

      {(approved || ctx.role === "CLIENT") && report.notes && <Card className="mb-5"><CardHeader title="Commentary" /><CardBody><p className="whitespace-pre-line text-[13px]">{report.notes}</p></CardBody></Card>}

      <h2 className="mb-2 text-sm font-semibold">Summary</h2>
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {t ? <>
          <MetricTile label="Organic clicks" value={fmtInt(t.clicks)} delta={pctChange(t.clicks, p?.clicks)} provenance="measured" source="Search Console" />
          <MetricTile label="Impressions" value={fmtInt(t.impressions)} delta={pctChange(t.impressions, p?.impressions)} provenance="measured" source="Search Console" />
          <MetricTile label="CTR" value={fmtPct(t.ctr)} delta={pctChange(t.ctr, p?.ctr)} provenance="measured" source="Search Console" />
          <MetricTile label="Avg. position" value={fmtDec(t.position)} delta={pctChange(t.position, p?.position)} invertDelta provenance="measured" source="Search Console" />
        </> : <UnavailableTile label="Search Console" reason="Not connected for these websites during this period." />}
        {d.analytics.available ? <MetricTile label="Organic sessions" value={fmtInt(d.analytics.organicSessions)} delta={pctChange(d.analytics.organicSessions, d.analytics.previous)} provenance="measured" source="GA4" /> : <UnavailableTile label="Organic sessions" reason="GA4 not connected." />}
        {d.technical.avgHealth != null ? <MetricTile label="Avg. site health" value={fmtInt(d.technical.avgHealth)} provenance="internal" source="crawler" /> : <UnavailableTile label="Site health" reason="No crawl yet." />}
        {d.rankings.available ? <MetricTile label="Keywords in top 10" value={`${fmtInt(top10)} / ${fmtInt(d.rankings.tracked)}`} provenance="measured" source="rank tracker" /> : <UnavailableTile label="Rankings" reason="No keywords tracked." />}
        <MetricTile label="Tasks completed" value={fmtInt(d.work.tasksDone)} delta={pctChange(d.work.tasksDone, d.work.tasksDonePrev)} provenance="internal" source="task log" />
      </div>
      {t && d.searchConsole.series.length > 1 && (
        <Card className="mb-5"><CardHeader title="Organic clicks" /><CardBody><TrendChart data={d.searchConsole.series} dataKey="clicks" compareKey="prevClicks" label="Clicks" height={200} /></CardBody></Card>
      )}

      {data.sites.map((s) => (
        <section key={s.id} className="mb-6">
          <h2 className="mb-2 text-sm font-semibold">{s.name} <span className="font-normal text-fg-subtle">{s.domain}</span></h2>
          <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {s.health?.score != null ? <MetricTile label="Health score" value={fmtInt(s.health.score)} provenance="internal" source={s.health.crawledAt ? `crawl ${fmtDate(s.health.crawledAt)}${s.health.afterPeriod ? " (after period)" : ""}` : "crawler"} footer={s.health.previous != null ? <span className="text-2xs text-fg-subtle">prev. {fmtInt(s.health.previous)}</span> : undefined} /> : <UnavailableTile label="Health score" reason="No crawl yet." />}
            <MetricTile label="Open critical / high" value={`${s.openFindings.critical} / ${s.openFindings.high}`} provenance="internal" source="crawler" />
            <MetricTile label="Resolved this period" value={fmtInt(s.resolvedInPeriod)} provenance="internal" source="re-crawl" />
            <MetricTile label="Site changes applied" value={fmtInt(s.changesApplied)} provenance="internal" source="change log" />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {s.topQueries.length > 0 && <Card><CardHeader title="Top queries" /><Table><THead><tr><TH>Query</TH><TH align="right">Clicks</TH><TH align="right">Impr.</TH><TH align="right">Pos.</TH></tr></THead><tbody>{s.topQueries.map((q) => <TR key={q.query}><TD>{q.query}</TD><TD align="right" className="tabular">{fmtInt(q.clicks)}</TD><TD align="right" className="tabular">{fmtInt(q.impressions)}</TD><TD align="right" className="tabular">{fmtDec(q.position)}</TD></TR>)}</tbody></Table></Card>}
            {s.topIssues.length > 0 && <Card><CardHeader title="Priority issues" /><Table><THead><tr><TH>Issue</TH><TH>Severity</TH><TH align="right">Pages</TH></tr></THead><tbody>{s.topIssues.map((i) => <TR key={i.title}><TD>{i.title}</TD><TD><Badge tone={i.severity === "CRITICAL" || i.severity === "HIGH" ? "bad" : "neutral"}>{i.severity.toLowerCase()}</Badge></TD><TD align="right" className="tabular">{i.pages}</TD></TR>)}</tbody></Table></Card>}
            {(s.movers.improved.length > 0 || s.movers.declined.length > 0) && <Card><CardHeader title="Keyword movement" /><Table><THead><tr><TH>Keyword</TH><TH align="right">Start</TH><TH align="right">End</TH></tr></THead><tbody>{[...s.movers.improved, ...s.movers.declined].map((m) => <TR key={m.phrase}><TD>{m.phrase}</TD><TD align="right" className="tabular">{pos(m.from)}</TD><TD align="right" className="tabular">{pos(m.to)}</TD></TR>)}</tbody></Table></Card>}
            {s.completedTasks.length > 0 && <Card><CardHeader title="Completed work" /><CardBody><ul className="list-disc space-y-0.5 pl-4 text-[13px]">{s.completedTasks.map((x) => <li key={x}>{x}</li>)}</ul></CardBody></Card>}
          </div>
        </section>
      ))}
    </>
  );
}

export const dynamic = "force-dynamic";

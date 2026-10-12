import Link from "next/link";
import { Download, ScanSearch } from "lucide-react";
import { requireStaffContext, websiteWhere } from "@/lib/auth/context";
import { listFindings } from "@/server/findings";
import { PageHeader, EmptyState } from "@/components/ui/page";
import { Card, CardHeader } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tabs";
import { ButtonLink } from "@/components/ui/button";
import { Badge, severityTone, jobTone } from "@/components/ui/badge";
import { Table, THead, TH, TR, TD, Pagination, makeHref } from "@/components/ui/table";
import { FilterBar } from "@/components/data/filter-bar";
import { SegmentBar } from "@/components/charts/bars";
import { JobProgress } from "@/components/jobs/job-progress";
import { ISSUES } from "@/audit/catalog";
import { fmtDate, fmtDuration, fmtInt, fmtRelative } from "@/lib/format";
import { RunCrawlDialog } from "./run-crawl";
import { FindingsTable } from "./findings-table";

export const metadata = { title: "SEO Audits" };

const SEV_COLORS: Record<string, string> = { CRITICAL: "var(--bad)", HIGH: "var(--chart-5)", MEDIUM: "var(--warn)", LOW: "var(--info)", INFO: "var(--chart-muted)" };

export default async function AuditsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireStaffContext();
  const tab = sp.tab === "crawls" ? "crawls" : "findings";
  const sites = await ctx.db.website.findMany({ where: { status: "ACTIVE", ...(ctx.websiteScope ? { id: { in: ctx.websiteScope } } : {}) }, select: { id: true, name: true, domain: true }, orderBy: { name: "asc" } });
  const canRun = ctx.can("audits:run");
  const href = makeHref("/audits", sp);
  const qs = new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as [string, string][]).toString();

  return (
    <>
      <PageHeader
        title="SEO Audits"
        description="Crawl-based technical audits. Every finding includes the affected URL, evidence, a recommended fix and its resolution history."
        actions={<>
          {tab === "findings" && <ButtonLink href={`/api/export/findings?${qs}`} prefetch={false}><Download className="size-3.5" />Export CSV</ButtonLink>}
          {canRun && <RunCrawlDialog sites={sites} defaultSite={sp.websiteId} />}
        </>}
      />
      <TabNav active={tab} tabs={[{ key: "findings", label: "Findings", href: `/audits?${new URLSearchParams({ ...(sp.websiteId ? { websiteId: sp.websiteId } : {}) })}` }, { key: "crawls", label: "Crawl history", href: `/audits?tab=crawls${sp.websiteId ? `&websiteId=${sp.websiteId}` : ""}` }]} />
      {tab === "findings" ? <Findings /> : <Crawls />}
    </>
  );

  async function Findings() {
    const data = await listFindings(ctx, sp);
    const anyCrawl = await ctx.db.crawl.count({ where: websiteWhere(ctx, sp.websiteId) });
    const issueTypes = Object.entries(ISSUES).map(([k, v]) => ({ value: k, label: v.title })).sort((a, b) => a.label.localeCompare(b.label));
    const categories = [...new Set(Object.values(ISSUES).map((i) => i.category))].sort();
    const sorts = Object.fromEntries(["priorityScore", "severity", "url", "lastSeenAt"].map((field) => {
      const active = data.filter.sort === field;
      return [field, { active, dir: data.filter.dir, href: href({ sort: field, dir: active && data.filter.dir === "desc" ? "asc" : "desc", page: "1" }) }];
    }));
    if (!anyCrawl) {
      return (
        <Card>
          <EmptyState icon={<ScanSearch className="size-5" />} title="No crawls yet" description="Run a crawl to audit a website. The crawler discovers pages from internal links and XML sitemaps, respects robots.txt, and rate-limits itself."
            action={canRun && <RunCrawlDialog sites={sites} defaultSite={sp.websiteId} label="Run first crawl" />} />
        </Card>
      );
    }
    return (
      <div className="space-y-5">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between"><span className="text-xs font-medium text-fg-muted">Matching findings by severity</span><span className="text-sm font-semibold tabular">{fmtInt(data.total)}</span></div>
            <SegmentBar segments={data.bySeverity.map((s) => ({ label: s.severity.toLowerCase(), value: s.count, color: SEV_COLORS[s.severity] }))} />
          </Card>
          <Card className="p-4">
            <div className="mb-2 text-xs font-medium text-fg-muted">By category</div>
            <div className="flex flex-wrap gap-1.5">
              {data.byCategory.map((c) => (
                <Link key={c.category} href={href({ category: sp.category === c.category ? "" : c.category, page: "1" })}>
                  <Badge tone={sp.category === c.category ? "accent" : "neutral"}>{c.category} · {c.count}</Badge>
                </Link>
              ))}
            </div>
          </Card>
        </div>
        <Card>
          <FilterBar
            q={sp.q}
            qPlaceholder="Search URL or issue"
            values={sp}
            preserve={{ sort: sp.sort, dir: sp.dir, category: sp.category }}
            filters={[
              ...(sites.length > 1 ? [{ name: "websiteId", label: "Website", options: sites.map((s) => ({ value: s.id, label: s.name })) }] : []),
              { name: "severity", label: "Severity", options: ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].map((s) => ({ value: s, label: s.toLowerCase() })) },
              { name: "status", label: "Status", options: [{ value: "ALL", label: "Any status" }, { value: "OPEN", label: "Open" }, { value: "IN_PROGRESS", label: "In progress" }, { value: "REGRESSED", label: "Regressed" }, { value: "RESOLVED", label: "Resolved" }, { value: "IGNORED", label: "Ignored" }] },
              { name: "issueType", label: "Issue", options: issueTypes },
              { name: "effort", label: "Effort", options: [{ value: "low", label: "Low effort" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }] },
              { name: "automatable", label: "Automatable", options: [{ value: "yes", label: "Automatable" }, { value: "no", label: "Manual" }] },
            ]}
          />
          {data.rows.length === 0 ? (
            <EmptyState title="No findings match" description={sp.status ? undefined : "No active issues. Try 'Any status' to include resolved and ignored findings."} />
          ) : (
            <>
              <FindingsTable
                rows={data.rows.map((r) => ({ ...r, lastSeenAt: r.lastSeenAt.toISOString() }))}
                canWrite={ctx.can("findings:write")}
                showSite={!sp.websiteId && sites.length > 1}
                sorts={sorts}
              />
              <Pagination page={data.filter.page} pages={data.pages} total={data.total} pageSize={data.filter.pageSize} href={href} />
            </>
          )}
        </Card>
        <p className="text-2xs text-fg-subtle">{categories.length} categories · priority is an internal score combining severity, affected pages, page importance, Search Console impressions (when connected), evidence confidence and effort. Open a finding to see its breakdown. Not a Google metric.</p>
      </div>
    );
  }

  async function Crawls() {
    const crawls = await ctx.db.crawl.findMany({ where: websiteWhere(ctx, sp.websiteId), orderBy: { createdAt: "desc" }, take: 100, include: { website: { select: { name: true, domain: true } } } });
    const jobs = await ctx.db.job.findMany({ where: { id: { in: crawls.map((c) => c.jobId).filter(Boolean) as string[] } } });
    const jobBy = new Map(jobs.map((j) => [j.id, j]));
    return (
      <Card>
        <CardHeader title="Crawl history" description="Detailed page data is kept for the 5 most recent crawls per site; summaries and findings are kept indefinitely." />
        {crawls.length === 0 ? <EmptyState title="No crawls yet" action={canRun && <RunCrawlDialog sites={sites} />} /> : (
          <Table>
            <THead><tr><TH>Started</TH><TH>Website</TH><TH>Mode</TH><TH>Status</TH><TH align="right">URLs</TH><TH align="right">Health</TH><TH align="right">New / resolved</TH><TH align="right">Duration</TH></tr></THead>
            <tbody>
              {crawls.map((c) => {
                const s = (c.summary ?? {}) as { newFindings?: number; resolved?: number; regressed?: number; triggeredBy?: string; error?: string };
                const job = c.jobId ? jobBy.get(c.jobId) : null;
                const active = c.status === "QUEUED" || c.status === "RUNNING";
                return (
                  <TR key={c.id}>
                    <TD><Link href={`/audits/${c.id}`} className="font-medium hover:text-accent">{fmtDate(c.createdAt, true)}</Link><div className="text-2xs text-fg-subtle">{s.triggeredBy ?? "manual"}</div></TD>
                    <TD>{c.website.name}</TD>
                    <TD><Badge>{c.mode.toLowerCase()}</Badge></TD>
                    <TD className="min-w-48">{active && job ? <JobProgress jobId={job.id} initial={job} compact /> : <><Badge tone={jobTone(c.status)}>{c.status.toLowerCase()}</Badge>{s.error && <div className="mt-0.5 max-w-xs truncate text-2xs text-bad" title={s.error}>{s.error}</div>}</>}</TD>
                    <TD align="right">{fmtInt(c.pagesDiscovered || c.pagesCrawled)}</TD>
                    <TD align="right">{c.healthScore != null ? Math.round(c.healthScore) : "—"}</TD>
                    <TD align="right">{c.status === "SUCCEEDED" ? <><span className="text-bad">+{s.newFindings ?? 0}</span> / <span className="text-good">−{s.resolved ?? 0}</span></> : "—"}</TD>
                    <TD align="right" className="text-xs text-fg-muted">{c.startedAt && c.finishedAt ? fmtDuration(c.finishedAt.getTime() - c.startedAt.getTime()) : active ? fmtRelative(c.createdAt) : "—"}</TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    );
  }
}


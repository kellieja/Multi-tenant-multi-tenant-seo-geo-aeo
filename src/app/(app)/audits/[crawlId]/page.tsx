import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { requireStaffContext } from "@/lib/auth/context";
import { compareCrawls } from "@/server/findings";
import { PageHeader, Notice } from "@/components/ui/page";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge, jobTone } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Table, THead, TH, TR, TD, Pagination, makeHref } from "@/components/ui/table";
import { MetricTile } from "@/components/ui/metric";
import { ScoreRing } from "@/components/charts/bars";
import { FilterBar } from "@/components/data/filter-bar";
import { JobProgress } from "@/components/jobs/job-progress";
import { ISSUES, type IssueType } from "@/audit/catalog";
import { fmtDate, fmtDuration, fmtInt } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { Prisma } from "@prisma/client";

export const metadata = { title: "Crawl" };

interface Summary {
  htmlPages?: number; totalUrls?: number; indexablePages?: number; errorPages?: number; redirects?: number; blockedByRobots?: number;
  carriedForward?: number; limitReached?: boolean; rendering?: { mode: string; active: boolean; reasons: string[]; error?: string }; robotsStatus?: number | null; sitemapUrls?: number; externalLinksChecked?: number;
  newFindings?: number; resolved?: number; regressed?: number; healthFormula?: string; error?: string; triggeredBy?: string;
  sitemaps?: { url: string; status: number | null; urlCount: number; error?: string; isIndex: boolean }[];
}

export default async function CrawlDetail({ params, searchParams }: { params: Promise<{ crawlId: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { crawlId } = await params;
  const sp = await searchParams;
  const ctx = await requireStaffContext();
  const cmp = await compareCrawls(ctx, crawlId);
  if (!cmp || (ctx.websiteScope && !ctx.websiteScope.includes(cmp.crawl.websiteId))) notFound();
  const { crawl, baseline } = cmp;
  const s = (crawl.summary ?? {}) as Summary;
  const job = crawl.jobId ? await ctx.db.job.findUnique({ where: { id: crawl.jobId } }) : null;
  const active = crawl.status === "QUEUED" || crawl.status === "RUNNING";

  // Pages table
  const page = Math.max(1, Number(sp.page ?? 1));
  const pageSize = 50;
  const where: Prisma.CrawledPageWhereInput = {
    crawlId,
    ...(sp.q ? { url: { contains: sp.q, mode: "insensitive" } } : {}),
    ...(sp.indexable === "yes" ? { indexable: true } : sp.indexable === "no" ? { indexable: false } : {}),
    ...(sp.status === "2xx" ? { statusCode: { gte: 200, lt: 300 } } : sp.status === "3xx" ? { statusCode: { gte: 300, lt: 400 } } : sp.status === "4xx" ? { statusCode: { gte: 400, lt: 500 } } : sp.status === "5xx" ? { statusCode: { gte: 500 } } : {}),
  };
  const [total, pages] = await Promise.all([
    ctx.db.crawledPage.count({ where }),
    ctx.db.crawledPage.findMany({ where, orderBy: [{ depth: "asc" }, { url: "asc" }], skip: (page - 1) * pageSize, take: pageSize, select: { id: true, url: true, statusCode: true, title: true, indexable: true, indexabilityReason: true, wordCount: true, inlinks: true, depth: true, responseTimeMs: true, carriedForward: true } }),
  ]);
  const href = makeHref(`/audits/${crawlId}`, sp);
  const prevHealth = baseline?.healthScore;

  return (
    <>
      <PageHeader
        eyebrow={<><Link href="/audits?tab=crawls" className="hover:text-fg">Crawl history</Link> / {crawl.website.name}</>}
        title={`${crawl.mode === "FULL" ? "Full" : "Incremental"} crawl · ${fmtDate(crawl.createdAt, true)}`}
        description={<span className="flex items-center gap-2"><Badge tone={jobTone(crawl.status)}>{crawl.status.toLowerCase()}</Badge>{crawl.startedAt && crawl.finishedAt && <span>took {fmtDuration(crawl.finishedAt.getTime() - crawl.startedAt.getTime())}</span>}<span>· triggered by {s.triggeredBy ?? "manual"}</span></span>}
        actions={crawl.status === "SUCCEEDED" && <ButtonLink href={`/api/export/crawl/${crawl.id}`} prefetch={false}><Download className="size-3.5" />Pages CSV</ButtonLink>}
      />
      {active && job && <Card className="mb-5 p-4"><JobProgress jobId={job.id} initial={job} /></Card>}
      {crawl.status === "FAILED" && <Notice tone="bad" title="Crawl failed" className="mb-5">{s.error ?? job?.error ?? "Unknown error"}</Notice>}
      {s.rendering?.active && <Notice tone="info" title="JavaScript rendering was used" className="mb-5">This site builds its content in the browser, so pages were rendered in a headless browser before auditing ({s.rendering.reasons.join("; ")}). Crawlers that don&apos;t run JavaScript see much less. See the &ldquo;Main content only appears after JavaScript runs&rdquo; findings.</Notice>}
      {s.rendering?.error && <Notice tone="warn" title="JavaScript rendering unavailable" className="mb-5">{s.rendering.error} Results reflect the raw HTML only, which can under-report content on single-page apps.</Notice>}
      {s.limitReached && <Notice tone="warn" title="Page limit reached" className="mb-5">The crawl stopped at the configured maximum pages. Raise the limit in the website settings for full coverage; findings like orphan pages may be incomplete.</Notice>}

      {crawl.status === "SUCCEEDED" && (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Card className="flex items-center gap-4 p-3.5 lg:col-span-1">
              <ScoreRing value={crawl.healthScore} label="Health score" size={64} />
              <div>
                <div className="text-xs text-fg-muted">Health (internal)</div>
                {prevHealth != null && crawl.healthScore != null && <div className={cn("text-xs font-medium tabular", crawl.healthScore >= prevHealth ? "text-good" : "text-bad")}>{crawl.healthScore >= prevHealth ? "+" : ""}{(crawl.healthScore - prevHealth).toFixed(1)} vs previous</div>}
              </div>
            </Card>
            <MetricTile label="URLs" value={fmtInt(s.totalUrls)} provenance="measured" source={s.carriedForward ? `${fmtInt(s.carriedForward)} carried forward` : "crawler"} />
            <MetricTile label="Indexable pages" value={fmtInt(s.indexablePages)} provenance="measured" source="crawler" />
            <MetricTile label="Errors (4xx/5xx/failed)" value={fmtInt(s.errorPages)} provenance="measured" source="crawler" />
            <MetricTile label="New · regressed · resolved" value={<span><span className="text-bad">{s.newFindings ?? 0}</span> · <span className="text-warn">{s.regressed ?? 0}</span> · <span className="text-good">{s.resolved ?? 0}</span></span>} provenance="internal" source="vs previous crawl" />
          </div>

          <div className="mb-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
            <Card>
              <CardHeader title="Before / after by issue type" description={baseline ? `Compared with the crawl from ${fmtDate(baseline.createdAt, true)}` : "No earlier crawl to compare with."} />
              <Table>
                <THead><tr><TH>Issue</TH><TH align="right">Before</TH><TH align="right">After</TH><TH align="right">Change</TH></tr></THead>
                <tbody>
                  {cmp.rows.map((r) => {
                    const def = ISSUES[r.issueType as IssueType];
                    return (
                      <TR key={r.issueType}>
                        <TD><Link href={`/audits?websiteId=${crawl.websiteId}&issueType=${r.issueType}&status=ALL`} className="hover:text-accent">{def?.title ?? r.issueType}</Link></TD>
                        <TD align="right" className="text-fg-muted">{baseline ? r.before : "—"}</TD>
                        <TD align="right">{r.after}</TD>
                        <TD align="right" className={cn("font-medium", r.delta < 0 ? "text-good" : r.delta > 0 ? "text-bad" : "text-fg-subtle")}>{baseline ? (r.delta > 0 ? `+${r.delta}` : r.delta) : "—"}</TD>
                      </TR>
                    );
                  })}
                </tbody>
              </Table>
            </Card>
            <div className="space-y-5">
              <Card>
                <CardHeader title="robots.txt & sitemaps" />
                <CardBody className="space-y-2 text-[13px]">
                  <div className="flex justify-between"><span className="text-fg-muted">robots.txt</span><span>{s.robotsStatus == null ? "unreachable" : `HTTP ${s.robotsStatus}`}</span></div>
                  <div className="flex justify-between"><span className="text-fg-muted">URLs in sitemaps</span><span className="tabular">{fmtInt(s.sitemapUrls)}</span></div>
                  <div className="flex justify-between"><span className="text-fg-muted">Blocked by robots</span><span className="tabular">{fmtInt(s.blockedByRobots)}</span></div>
                  <div className="flex justify-between"><span className="text-fg-muted">Outbound links checked</span><span className="tabular">{fmtInt(s.externalLinksChecked)}</span></div>
                  <ul className="space-y-1 border-t border-border pt-2">
                    {(s.sitemaps ?? []).map((m) => (
                      <li key={m.url} className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate text-fg-muted" title={m.url}>{m.url.replace(/^https?:\/\/[^/]+/, "")}</span>
                        {m.error ? <Badge tone="bad" title={m.error}>{m.status ?? "error"}</Badge> : <Badge tone="good">{m.isIndex ? `index · ${m.urlCount}` : `${m.urlCount} URLs`}</Badge>}
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
              <Card><CardBody className="text-2xs text-fg-subtle">{s.healthFormula}</CardBody></Card>
            </div>
          </div>
        </>
      )}

      {total > 0 || sp.q || sp.status || sp.indexable ? (
        <Card>
          <CardHeader title="Crawled URLs" />
          <FilterBar q={sp.q} qPlaceholder="Filter URLs" values={sp} filters={[
            { name: "status", label: "Status", options: ["2xx", "3xx", "4xx", "5xx"].map((v) => ({ value: v, label: v })) },
            { name: "indexable", label: "Indexable", options: [{ value: "yes", label: "Indexable" }, { value: "no", label: "Not indexable" }] },
          ]} />
          <Table>
            <THead><tr><TH>URL</TH><TH>Status</TH><TH>Indexability</TH><TH align="right">Words</TH><TH align="right">Inlinks</TH><TH align="right">Depth</TH><TH align="right">Time</TH></tr></THead>
            <tbody>
              {pages.map((p) => (
                <TR key={p.id}>
                  <TD className="max-w-md"><div className="truncate font-medium" title={p.url}>{p.url.replace(/^https?:\/\/[^/]+/, "") || "/"}</div><div className="truncate text-2xs text-fg-subtle">{p.title ?? "—"}{p.carriedForward && " · carried forward"}</div></TD>
                  <TD>{!p.statusCode && p.indexabilityReason?.startsWith("Blocked") ? <Badge>blocked</Badge> : <Badge tone={!p.statusCode ? "bad" : p.statusCode < 300 ? "good" : p.statusCode < 400 ? "info" : "bad"}>{p.statusCode ?? "error"}</Badge>}</TD>
                  <TD className="text-xs">{p.indexable ? <span className="text-good">Indexable</span> : <span className="text-fg-muted">{p.indexabilityReason}</span>}</TD>
                  <TD align="right">{fmtInt(p.wordCount)}</TD>
                  <TD align="right">{p.inlinks}</TD>
                  <TD align="right">{p.depth}</TD>
                  <TD align="right" className="text-xs text-fg-muted">{p.responseTimeMs != null ? `${p.responseTimeMs}ms` : "—"}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
          <Pagination page={page} pages={Math.max(1, Math.ceil(total / pageSize))} total={total} pageSize={pageSize} href={href} />
        </Card>
      ) : crawl.status === "SUCCEEDED" ? <Notice tone="info">Page-level details for this crawl have been pruned (only the 5 most recent crawls keep them). The summary and findings above remain.</Notice> : null}
    </>
  );
}

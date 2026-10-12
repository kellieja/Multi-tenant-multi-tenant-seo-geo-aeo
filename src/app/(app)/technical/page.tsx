import Link from "next/link";
import { Gauge } from "lucide-react";
import { requireStaffContext } from "@/lib/auth/context";
import { PageHeader, EmptyState, Notice } from "@/components/ui/page";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/form";
import { Button, ButtonLink } from "@/components/ui/button";
import { SourceTag, MetricTile } from "@/components/ui/metric";
import { Table, THead, TH, TR, TD } from "@/components/ui/table";
import { ActionButton } from "@/components/ui/action-form";
import { ColumnChart } from "@/components/charts/charts";
import { BarList } from "@/components/charts/bars";
import { JobProgress } from "@/components/jobs/job-progress";
import { fmtDate, fmtInt, fmtRelative } from "@/lib/format";
import { cn } from "@/lib/cn";
import { runPsiAction } from "./actions";

export const metadata = { title: "Technical SEO" };

const cwvTone = (v: number | null, good: number, poor: number) => (v == null ? "text-fg-subtle" : v <= good ? "text-good" : v <= poor ? "text-warn" : "text-bad");

export default async function TechnicalPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireStaffContext();
  const sites = await ctx.db.website.findMany({ where: { status: { not: "ARCHIVED" }, ...(ctx.websiteScope ? { id: { in: ctx.websiteScope } } : {}) }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const websiteId = sp.websiteId && sites.some((s) => s.id === sp.websiteId) ? sp.websiteId : sites[0]?.id;

  const header = (
    <PageHeader
      title="Technical SEO"
      description="Crawlability, indexability, status codes, structured data and Core Web Vitals for one website."
      actions={sites.length > 0 && (
        <form method="get" className="flex gap-2">
          <Select name="websiteId" defaultValue={websiteId} aria-label="Website" className="w-auto">{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
          <Button type="submit">View</Button>
        </form>
      )}
    />
  );
  if (!websiteId) return <>{header}<Card><EmptyState title="No websites" action={<ButtonLink href="/websites">Add website</ButtonLink>} /></Card></>;

  const crawl = await ctx.db.crawl.findFirst({ where: { websiteId, status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" } });
  const [psi, psiJob, pages, techFindings] = await Promise.all([
    ctx.db.pageSpeedResult.findMany({ where: { websiteId }, orderBy: { fetchedAt: "desc" }, take: 60 }),
    ctx.db.job.findFirst({ where: { websiteId, type: "psi-check" }, orderBy: { queuedAt: "desc" } }),
    crawl ? ctx.db.crawledPage.findMany({ where: { crawlId: crawl.id }, select: { statusCode: true, indexable: true, indexabilityReason: true, depth: true, responseTimeMs: true, structuredData: true, hreflang: true } }) : Promise.resolve([]),
    ctx.db.auditFinding.groupBy({ by: ["category"], where: { websiteId, status: { in: ["OPEN", "REGRESSED", "IN_PROGRESS"] } }, _count: true }),
  ]);
  type P = { statusCode: number | null; indexable: boolean; indexabilityReason: string | null; depth: number; responseTimeMs: number | null; structuredData: { types?: string[]; valid?: boolean }[]; hreflang: unknown[] };
  const ps = pages as unknown as P[];
  const s = (crawl?.summary ?? {}) as { robotsStatus?: number | null; sitemapUrls?: number; sitemaps?: { url: string; status: number | null; error?: string }[]; blockedByRobots?: number };

  // Latest PSI result per url+strategy
  const latestPsi = new Map<string, (typeof psi)[number]>();
  for (const r of psi) if (!latestPsi.has(`${r.url}|${r.strategy}`)) latestPsi.set(`${r.url}|${r.strategy}`, r);
  const psiRows = [...latestPsi.values()].sort((a, b) => a.url.localeCompare(b.url) || a.strategy.localeCompare(b.strategy));
  const psiActive = psiJob && (psiJob.status === "QUEUED" || psiJob.status === "RUNNING");

  const statusBuckets = ["2xx", "3xx", "4xx", "5xx", "not fetched"].map((b) => ({
    label: b,
    count: ps.filter((p) => (b === "not fetched" ? p.statusCode == null : p.statusCode != null && Math.floor(p.statusCode / 100) === Number(b[0]))).length,
  }));
  const reasons = new Map<string, number>();
  for (const p of ps) if (!p.indexable) reasons.set(p.indexabilityReason ?? "Unknown", (reasons.get(p.indexabilityReason ?? "Unknown") ?? 0) + 1);
  const depthDist = Array.from({ length: 8 }, (_, d) => ({ label: d === 7 ? "7+" : String(d), count: ps.filter((p) => (d === 7 ? p.depth >= 7 : p.depth === d)).length }));
  const times = ps.map((p) => p.responseTimeMs).filter((t): t is number => t != null).sort((a, b) => a - b);
  const pct = (q: number) => (times.length ? times[Math.min(times.length - 1, Math.floor(q * times.length))] : null);
  const schemaTypes = new Map<string, number>();
  let schemaInvalid = 0;
  for (const p of ps) for (const sd of p.structuredData ?? []) { if (sd.valid === false) schemaInvalid++; for (const t of sd.types ?? []) schemaTypes.set(t, (schemaTypes.get(t) ?? 0) + 1); }
  const hreflangPages = ps.filter((p) => (p.hreflang?.length ?? 0) > 0).length;

  return (
    <>
      {header}
      {!crawl ? (
        <Card className="mb-5"><EmptyState icon={<Gauge className="size-5" />} title="No completed crawl for this website" description="Technical metrics come from the crawler. Run a crawl to populate this page." action={<ButtonLink href={`/audits?websiteId=${websiteId}`} variant="primary">Go to audits</ButtonLink>} /></Card>
      ) : (
        <>
          <p className="mb-3 text-xs text-fg-subtle">From the crawl on {fmtDate(crawl.finishedAt, true)} · <Link className="text-accent hover:underline" href={`/audits/${crawl.id}`}>crawl details</Link></p>
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricTile label="Indexable URLs" value={`${fmtInt(ps.filter((p) => p.indexable).length)} / ${fmtInt(ps.length)}`} provenance="measured" source="crawler" />
            <MetricTile label="robots.txt" value={s.robotsStatus == null ? "Unreachable" : `HTTP ${s.robotsStatus}`} provenance="measured" source={`${fmtInt(s.blockedByRobots)} URLs blocked`} />
            <MetricTile label="Sitemap URLs" value={fmtInt(s.sitemapUrls)} provenance="measured" source={`${s.sitemaps?.filter((m) => !m.error).length ?? 0} readable sitemap(s)`} />
            <MetricTile label="Server response p50 / p90" value={times.length ? `${pct(0.5)} / ${pct(0.9)} ms` : "—"} provenance="measured" source="crawler, single location" />
          </div>
          <div className="mb-5 grid gap-5 lg:grid-cols-3">
            <Card><CardHeader title="Status codes" actions={<SourceTag kind="measured" source="crawler" />} /><CardBody><ColumnChart data={statusBuckets} xKey="label" yKey="count" label="URLs" height={180} colors={["var(--chart-2)", "var(--chart-1)", "var(--chart-3)", "var(--chart-5)", "var(--chart-muted)"]} /></CardBody></Card>
            <Card><CardHeader title="Why URLs aren't indexable" /><CardBody>{reasons.size ? <BarList items={[...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }))} /> : <p className="py-6 text-center text-[13px] text-fg-muted">All crawled URLs are indexable.</p>}</CardBody></Card>
            <Card><CardHeader title="Click depth from homepage" description="Pages deeper than 3 clicks get less internal authority." /><CardBody><ColumnChart data={depthDist} xKey="label" yKey="count" label="Pages" height={180} /></CardBody></Card>
          </div>
          <div className="mb-5 grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader title="Structured data coverage" description={`${schemaInvalid} invalid JSON-LD block${schemaInvalid === 1 ? "" : "s"}. Valid schema doesn't guarantee rich results.`} />
              <CardBody>{schemaTypes.size ? <BarList items={[...schemaTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, value]) => ({ label, value, hint: "pages" }))} /> : <p className="py-6 text-center text-[13px] text-fg-muted">No structured data found on crawled pages.</p>}</CardBody>
            </Card>
            <Card>
              <CardHeader title="Open technical issues by category" actions={<Link href={`/audits?websiteId=${websiteId}`} className="text-xs text-accent hover:underline">All findings</Link>} />
              <CardBody>
                {techFindings.length ? <BarList items={techFindings.sort((a, b) => b._count - a._count).map((c) => ({ label: c.category, value: c._count, href: `/audits?websiteId=${websiteId}&category=${encodeURIComponent(c.category)}` }))} /> : <p className="py-6 text-center text-[13px] text-fg-muted">No open issues.</p>}
                <p className="mt-3 text-2xs text-fg-subtle">International: {hreflangPages} page{hreflangPages === 1 ? "" : "s"} with hreflang annotations.</p>
              </CardBody>
            </Card>
          </div>
        </>
      )}

      <Card>
        <CardHeader
          title="Core Web Vitals & PageSpeed"
          description="Field data is real-user Chrome UX Report data (28-day window) and only exists when Google has enough samples. Lab data is a single Lighthouse run, useful for diagnosis but not what users experience."
          actions={ctx.can("audits:run") && <ActionButton action={runPsiAction} fields={{ websiteId }} size="sm" variant="primary" disabled={Boolean(psiActive)}>Run PageSpeed check</ActionButton>}
        />
        {psiJob && (psiActive || psiJob.status === "FAILED") && <div className="border-b border-border px-4 py-3"><JobProgress jobId={psiJob.id} initial={psiJob} /></div>}
        {psiRows.length === 0 ? (
          <EmptyState title="No PageSpeed data yet" description="Runs PageSpeed Insights for the homepage and top pages (by Search Console clicks, else internal links), mobile and desktop. Works without an API key at low volume; add a key in Integrations for reliable quota." />
        ) : (
          <Table>
            <THead><tr><TH>URL</TH><TH>Device</TH><TH align="right">Field LCP</TH><TH align="right">Field INP</TH><TH align="right">Field CLS</TH><TH>Field verdict</TH><TH align="right">Lab score</TH><TH align="right">Lab LCP</TH><TH>Checked</TH></tr></THead>
            <tbody>
              {psiRows.map((r) => (
                <TR key={r.id}>
                  <TD className="max-w-xs truncate text-xs" >{r.url.replace(/^https?:\/\/[^/]+/, "") || "/"}</TD>
                  <TD><Badge>{r.strategy}</Badge></TD>
                  <TD align="right" className={cwvTone(r.fieldLcpMs, 2500, 4000)}>{r.fieldLcpMs != null ? `${(r.fieldLcpMs / 1000).toFixed(1)}s` : "no data"}</TD>
                  <TD align="right" className={cwvTone(r.fieldInpMs, 200, 500)}>{r.fieldInpMs != null ? `${Math.round(r.fieldInpMs)}ms` : "no data"}</TD>
                  <TD align="right" className={cwvTone(r.fieldCls, 0.1, 0.25)}>{r.fieldCls != null ? r.fieldCls.toFixed(2) : "no data"}</TD>
                  <TD>{r.fieldCategory ? <Badge tone={r.fieldCategory === "FAST" ? "good" : r.fieldCategory === "AVERAGE" ? "warn" : "bad"}>{r.fieldCategory.toLowerCase()}</Badge> : <span className="text-2xs text-fg-subtle">insufficient samples</span>}</TD>
                  <TD align="right" className={cn("font-medium", r.performanceScore == null ? "" : r.performanceScore >= 0.9 ? "text-good" : r.performanceScore >= 0.5 ? "text-warn" : "text-bad")}>{r.performanceScore != null ? Math.round(r.performanceScore * 100) : "—"}</TD>
                  <TD align="right" className="text-xs text-fg-muted">{r.lcpMs != null ? `${(r.lcpMs / 1000).toFixed(1)}s` : "—"}</TD>
                  <TD className="text-xs text-fg-muted">{fmtRelative(r.fetchedAt)}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
        {psiRows.length > 0 && <div className="flex justify-between border-t border-border px-4 py-2"><SourceTag kind="measured" source="Chrome UX Report (field)" /><SourceTag kind="measured" source="Lighthouse via PSI (lab)" /></div>}
      </Card>
      {!ctx.can("audits:run") && <Notice tone="info" className="mt-4">You have read-only access.</Notice>}
    </>
  );
}


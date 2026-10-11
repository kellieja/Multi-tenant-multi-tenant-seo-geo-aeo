import Link from "next/link";
import { Download, Globe, Plug, ScanSearch } from "lucide-react";
import { requireOrgContext } from "@/lib/auth/context";
import { getDashboard } from "@/server/dashboard";
import { PageHeader, EmptyState } from "@/components/ui/page";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { MetricTile, UnavailableTile, SourceTag } from "@/components/ui/metric";
import { ButtonLink, Button } from "@/components/ui/button";
import { Select, Input } from "@/components/ui/form";
import { TrendChart, ColumnChart, GainLossChart } from "@/components/charts/charts";
import { BarList, SegmentBar, ScoreRing } from "@/components/charts/bars";
import { fmtCompact, fmtDec, fmtInt, fmtPct, pctChange, fmtDate } from "@/lib/format";

export const metadata = { title: "Executive Dashboard" };

const SEV_COLORS: Record<string, string> = { CRITICAL: "var(--bad)", HIGH: "var(--chart-5)", MEDIUM: "var(--warn)", LOW: "var(--info)", INFO: "var(--chart-muted)" };

export default async function Dashboard({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireOrgContext();
  const d = await getDashboard(ctx, sp);
  const clients = ctx.role === "CLIENT" ? [] : await ctx.db.client.findMany({ where: { archivedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  const qs = new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as [string, string][]).toString();
  const gsc = d.searchConsole;
  const t = gsc.totals;
  const pv = gsc.previous;
  const staff = ctx.role !== "CLIENT";

  if (d.sites.length === 0 && !sp.websiteId && !sp.clientId) {
    return (
      <>
        <PageHeader title="Executive Dashboard" />
        <Card>
          <EmptyState
            icon={<Globe className="size-5" />}
            title="Add a website to populate the dashboard"
            description="Every number here comes from your crawls and connected services. Nothing is estimated or invented, so the dashboard stays empty until there is real data."
            action={staff && <ButtonLink href="/websites" variant="primary">Add website</ButtonLink>}
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Executive Dashboard"
        description={<>{fmtDate(d.period.from)} – {fmtDate(d.period.to)} · compared with the previous {d.period.days} days · {d.sites.length} website{d.sites.length === 1 ? "" : "s"}</>}
        actions={<ButtonLink href={`/api/export/dashboard?${qs}`} prefetch={false}><Download className="size-3.5" />Export CSV</ButtonLink>}
      />

      <form method="get" className="mb-5 flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-border bg-surface px-3 py-2.5">
        <Select name="range" defaultValue={d.filter.range} aria-label="Date range" className="w-auto">
          <option value="7d">Last 7 days</option>
          <option value="28d">Last 28 days</option>
          <option value="90d">Last 90 days</option>
          <option value="180d">Last 6 months</option>
          <option value="365d">Last 12 months</option>
          <option value="custom">Custom range</option>
        </Select>
        <Input type="date" name="from" defaultValue={sp.from} aria-label="From" className="w-auto" />
        <Input type="date" name="to" defaultValue={sp.to} aria-label="To" className="w-auto" />
        <Select name="websiteId" defaultValue={sp.websiteId ?? ""} aria-label="Website" className="w-auto max-w-56">
          <option value="">All websites</option>
          {d.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        {clients.length > 0 && (
          <Select name="clientId" defaultValue={sp.clientId ?? ""} aria-label="Client" className="w-auto">
            <option value="">All clients</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        )}
        <Button type="submit">Apply</Button>
        <span className="ml-auto text-2xs text-fg-subtle">Search Console data typically lags 2–3 days.</span>
      </form>

      {/* Organic search KPIs */}
      <section aria-label="Organic search" className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {gsc.available && t ? (
          <>
            <MetricTile label="Organic clicks" value={fmtCompact(t.clicks)} delta={pctChange(t.clicks, pv?.clicks)} provenance="measured" source="Search Console" updatedAt={gsc.lastSync} />
            <MetricTile label="Impressions" value={fmtCompact(t.impressions)} delta={pctChange(t.impressions, pv?.impressions)} provenance="measured" source="Search Console" />
            <MetricTile label="Click-through rate" value={fmtPct(t.ctr, 2)} delta={pctChange(t.ctr, pv?.ctr)} provenance="measured" source="Search Console" />
            <MetricTile label="Average position" value={fmtDec(t.position)} delta={pctChange(t.position, pv?.position)} invertDelta provenance="measured" source="Search Console" />
          </>
        ) : (
          ["Organic clicks", "Impressions", "Click-through rate", "Average position"].map((l) => (
            <UnavailableTile key={l} label={l} reason="Search Console isn't connected or synced for these sites." href={staff ? "/integrations" : undefined} />
          ))
        )}
      </section>

      <div className="mb-5 grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Organic clicks" description="Daily clicks vs. the same number of days immediately before." actions={<SourceTag kind="measured" source="Google Search Console" updatedAt={gsc.lastSync} />} />
          <CardBody>
            {gsc.available ? (
              <TrendChart data={gsc.series} dataKey="clicks" compareKey="prevClicks" label="Clicks" />
            ) : (
              <EmptyState icon={<Plug className="size-5" />} title="No Search Console data" description="Connect Google Search Console to see clicks, impressions, CTR and position trends." action={staff && <ButtonLink href="/integrations" size="sm">Connect Search Console</ButtonLink>} />
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Clicks by website" description="Drill into a site for its own trends." />
          <CardBody>
            {gsc.bySite.length ? (
              <BarList items={gsc.bySite.slice(0, 10).map((s) => ({ label: s.name, value: s.clicks ?? 0, href: `/dashboard?${new URLSearchParams({ ...Object.fromEntries(Object.entries(sp).filter(([, v]) => v) as [string, string][]), websiteId: s.id })}` }))} />
            ) : <p className="py-6 text-center text-[13px] text-fg-muted">No per-site click data for this period.</p>}
          </CardBody>
        </Card>
      </div>

      {gsc.available && (
        <div className="mb-5 grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title="Impressions" actions={<SourceTag kind="measured" source="Search Console" />} />
            <CardBody><TrendChart data={gsc.series} dataKey="impressions" label="Impressions" height={180} /></CardBody>
          </Card>
          <Card>
            <CardHeader title="Average position" description="Lower is better; axis is inverted." actions={<SourceTag kind="measured" source="Search Console" />} />
            <CardBody><TrendChart data={gsc.series} dataKey="position" label="Avg. position" fmt="pos" height={180} invertY /></CardBody>
          </Card>
        </div>
      )}

      {/* Rankings, technical, backlinks */}
      <div className="mb-5 grid gap-5 lg:grid-cols-3">
        <Card>
          <CardHeader title="Ranking distribution" description={d.rankings.available ? `${fmtInt(d.rankings.tracked)} tracked keywords, latest check per keyword` : undefined} actions={d.rankings.available && <SourceTag kind="measured" source="rank tracker" updatedAt={d.rankings.lastObserved} />} />
          <CardBody>
            {d.rankings.available ? (
              <>
                <ColumnChart data={d.rankings.distribution} xKey="label" yKey="count" label="Keywords" height={170} />
                <dl className="mt-3 grid grid-cols-4 gap-2 text-center">
                  {[["Entered top 100", d.rankings.gained, "text-good"], ["Dropped out", d.rankings.lost, "text-bad"], ["Improved", d.rankings.improved, "text-good"], ["Declined", d.rankings.declined, "text-bad"]].map(([l, v, c]) => (
                    <div key={l as string}><dt className="text-2xs text-fg-subtle">{l}</dt><dd className={`text-sm font-semibold tabular ${c}`}>{fmtInt(v as number)}</dd></div>
                  ))}
                </dl>
              </>
            ) : (
              <EmptyState title="No rank tracking yet" description="Add keywords and connect a rank-tracking provider (DataForSEO) to track positions." action={staff && <ButtonLink href="/keywords" size="sm">Set up keywords</ButtonLink>} className="py-8" />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Technical SEO health" description={d.technical.available ? `${d.technical.crawledSites} crawled site${d.technical.crawledSites === 1 ? "" : "s"} · last crawl ${fmtDate(d.technical.lastCrawl)}` : undefined} actions={d.technical.available && <SourceTag kind="internal" source="crawler" />} />
          <CardBody>
            {d.technical.available ? (
              <>
                <div className="flex items-center gap-4">
                  <ScoreRing value={d.technical.avgHealth} label="Average health score" size={72} />
                  <dl className="grid flex-1 grid-cols-2 gap-2">
                    <div><dt className="text-2xs text-fg-subtle">Indexable pages</dt><dd className="text-sm font-semibold tabular">{fmtInt(d.technical.indexablePages)}</dd></div>
                    <div><dt className="text-2xs text-fg-subtle">Error pages (4xx/5xx)</dt><dd className="text-sm font-semibold tabular">{fmtInt(d.technical.crawlErrors)}</dd></div>
                  </dl>
                </div>
                <p className="mt-3 mb-2 text-xs text-fg-muted">Open issues by severity</p>
                <SegmentBar segments={d.technical.findings.map((f) => ({ label: f.severity.toLowerCase(), value: f.count, color: SEV_COLORS[f.severity] }))} />
                <p className="mt-3 text-2xs text-fg-subtle">Health is an internal score from crawl findings. It is not a Google metric.</p>
              </>
            ) : (
              <EmptyState icon={<ScanSearch className="size-5" />} title="No completed crawls" description="Run a crawl to audit pages for technical issues." action={staff && <ButtonLink href="/audits" size="sm">Go to audits</ButtonLink>} className="py-8" />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Backlinks" description={d.backlinks.available ? `${fmtInt(d.backlinks.referringDomains)} active referring domains` : undefined} actions={d.backlinks.available && <SourceTag kind="estimate" source="backlink index" />} />
          <CardBody>
            {d.backlinks.available ? (
              <>
                <div className="mb-3 grid grid-cols-2 gap-2">
                  <div><div className="text-2xs text-fg-subtle">New links</div><div className="text-sm font-semibold tabular text-good">+{fmtInt(d.backlinks.gained)} <span className="text-2xs font-normal text-fg-subtle">prev {fmtInt(d.backlinks.gainedPrev)}</span></div></div>
                  <div><div className="text-2xs text-fg-subtle">Lost links</div><div className="text-sm font-semibold tabular text-bad">−{fmtInt(d.backlinks.lost)} <span className="text-2xs font-normal text-fg-subtle">prev {fmtInt(d.backlinks.lostPrev)}</span></div></div>
                </div>
                <GainLossChart data={d.backlinks.velocity} height={130} />
                {d.backlinks.quality && (
                  <div className="mt-3">
                    <SegmentBar segments={[
                      { label: "High rank", value: d.backlinks.quality.high, color: "var(--chart-1)" },
                      { label: "Mid", value: d.backlinks.quality.mid, color: "var(--chart-2)" },
                      { label: "Low", value: d.backlinks.quality.low, color: "var(--chart-muted)" },
                    ]} />
                    <p className="mt-1.5 text-2xs text-fg-subtle">Referring-domain rank from {d.backlinks.quality.source}: a third-party indicator, not a Google ranking factor.</p>
                  </div>
                )}
              </>
            ) : (
              <EmptyState title="No backlink data" description="Import backlinks from CSV or connect DataForSEO to monitor new and lost links." action={staff && <ButtonLink href="/backlinks" size="sm">Open backlinks</ButtonLink>} className="py-8" />
            )}
          </CardBody>
        </Card>
      </div>

      {/* Operations & AI search */}
      <section aria-label="Operations" className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-6">
        {d.analytics.available ? (
          <MetricTile label="Organic sessions" value={fmtCompact(d.analytics.organicSessions)} delta={pctChange(d.analytics.organicSessions, d.analytics.previous)} provenance="measured" source="GA4" updatedAt={d.analytics.lastSync} />
        ) : <UnavailableTile label="Organic sessions" reason="GA4 not connected." href={staff ? "/integrations" : undefined} />}
        <MetricTile label="SEO tasks completed" value={fmtInt(d.work.tasksDone)} delta={pctChange(d.work.tasksDone, d.work.tasksDonePrev)} provenance="internal" source="task log" />
        <MetricTile label="Content approved / applied" value={fmtInt(d.work.contentApplied + d.work.siteChangesApplied)} provenance="internal" source="change log" />
        {d.aeo.available ? (
          <MetricTile label="AEO readiness" value={fmtDec(d.aeo.avgScore, 0)} provenance="internal" source={`${fmtInt(d.aeo.pages)} pages`} />
        ) : <UnavailableTile label="AEO readiness" reason="No AEO assessments yet." href={staff ? "/aeo" : undefined} cta="Assess" />}
        {d.geo.available ? (
          <MetricTile label="AI answer brand mentions" value={fmtPct(d.geo.mentionRate, 0)} provenance="sampled" source={`${fmtInt(d.geo.observations)} checks · ${d.geo.platforms.join(", ")}`} updatedAt={d.geo.lastObserved} />
        ) : <UnavailableTile label="AI answer brand mentions" reason="No GEO prompt checks in this period." href={staff ? "/geo" : undefined} cta="Set up" />}
        {d.automation.total > 0 ? (
          <MetricTile label="Automation success" value={fmtPct(d.automation.succeeded / Math.max(1, d.automation.succeeded + d.automation.failed), 0)} provenance="internal" source={`${d.automation.succeeded} ok · ${d.automation.failed} failed`} />
        ) : <UnavailableTile label="Automation success" reason="No workflow runs in this period." href={staff ? "/automation" : undefined} cta="Automate" />}
      </section>
    </>
  );
}

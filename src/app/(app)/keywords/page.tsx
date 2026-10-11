import Link from "next/link";
import { Download, RefreshCw, TrendingUp } from "lucide-react";
import { requireOrgContext } from "@/lib/auth/context";
import { listKeywords, searchConsoleInsights } from "@/server/keywords";
import { resolveSite, SitePicker } from "@/components/data/site-picker";
import { PageHeader, EmptyState, Notice } from "@/components/ui/page";
import { Card, CardHeader } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { SourceTag } from "@/components/ui/metric";
import { Table, THead, TH, TR, TD, Pagination, makeHref, SortTH } from "@/components/ui/table";
import { FilterBar } from "@/components/data/filter-bar";
import { ActionButton } from "@/components/ui/action-form";
import { ColumnChart } from "@/components/charts/charts";
import { fmtDec, fmtInt, fmtPct, fmtRelative, fmtDate } from "@/lib/format";
import { cn } from "@/lib/cn";
import { metricsAction, rankCheckAction } from "./actions";
import { AddKeywords, KeywordIdeas, TrackQueries, BulkDelete } from "./forms";

export const metadata = { title: "Keywords & Rankings" };

const intentTone = { INFORMATIONAL: "info", COMMERCIAL: "accent", TRANSACTIONAL: "good", NAVIGATIONAL: "neutral", UNKNOWN: "neutral" } as const;

export default async function KeywordsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireOrgContext();
  const { sites, site } = await resolveSite(ctx, sp.websiteId);
  const header = <PageHeader title="Keywords & Rankings" description="Tracked keyword positions from a licensed SERP provider, plus first-party Search Console query data. Every metric shows its source." actions={<SitePicker sites={sites} current={site?.id} preserve={{ tab: sp.tab }} />} />;
  if (!site) return <>{header}<Card><EmptyState title="Add a website first" action={<ButtonLink href="/websites">Websites</ButtonLink>} /></Card></>;
  const tab = ["tracked", "gsc", "opportunities", "cannibalization"].includes(sp.tab ?? "") ? sp.tab! : "tracked";
  const canWrite = ctx.can("keywords:write");
  const dfs = await ctx.db.integrationConnection.findFirst({ where: { provider: "DATAFORSEO", websiteId: null, status: "CONNECTED" } });
  const q = (t: string) => `/keywords?websiteId=${site.id}&tab=${t}`;

  return (
    <>
      {header}
      <TabNav active={tab} tabs={[{ key: "tracked", label: "Tracked keywords" }, { key: "gsc", label: "Search Console queries" }, { key: "opportunities", label: "Opportunities & declines" }, { key: "cannibalization", label: "Cannibalization" }].map((t) => ({ ...t, href: q(t.key) }))} />
      {tab === "tracked" && <Tracked />}
      {tab !== "tracked" && <Gsc />}
    </>
  );

  async function Tracked() {
    const data = await listKeywords(ctx, { ...sp, websiteId: site!.id });
    const href = makeHref("/keywords", { ...sp, websiteId: site!.id, tab: "tracked" });
    const dist = [
      ["1–3", (p: number) => p <= 3], ["4–10", (p: number) => p >= 4 && p <= 10], ["11–20", (p: number) => p >= 11 && p <= 20], ["21–100", (p: number) => p > 20],
    ] as const;
    const allObs = await ctx.db.keyword.findMany({ where: { websiteId: site!.id }, select: { observations: { orderBy: { observedAt: "desc" }, take: 1, select: { position: true, observedAt: true } } } });
    const latest = allObs.map((k) => k.observations[0]).filter(Boolean);
    const lastCheck = latest.reduce<Date | null>((m, o) => (!m || o.observedAt > m ? o.observedAt : m), null);
    return (
      <>
        <div className="mb-4 flex flex-wrap gap-2">
          {canWrite && <AddKeywords websiteId={site!.id} groups={data.groups} />}
          {canWrite && dfs && <KeywordIdeas websiteId={site!.id} />}
          {canWrite && <ActionButton action={rankCheckAction} fields={{ websiteId: site!.id }}><RefreshCw className="size-3.5" />Check rankings now</ActionButton>}
          {canWrite && dfs && <ActionButton action={metricsAction} fields={{ websiteId: site!.id }}>Refresh volume & intent</ActionButton>}
          <ButtonLink href={`/api/export/keywords?websiteId=${site!.id}`} prefetch={false} variant="ghost"><Download className="size-3.5" />CSV</ButtonLink>
        </div>
        {!dfs && <Notice tone="info" className="mb-4">Rank tracking uses DataForSEO (licensed SERP data). We don&apos;t scrape search engines. <Link className="text-accent hover:underline" href="/integrations">Connect it</Link> to record positions; until then, see real positions in the Search Console tab.</Notice>}
        {data.total === 0 && !sp.q && !sp.group && !sp.intent ? (
          <Card><EmptyState icon={<TrendingUp className="size-5" />} title="No tracked keywords" description="Add keywords manually, import a CSV, or track queries straight from Search Console." /></Card>
        ) : (
          <>
            {latest.length > 0 && (
              <div className="mb-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <Card><CardHeader title="Position distribution" actions={<SourceTag kind="measured" source="DataForSEO SERP" updatedAt={lastCheck} />} /><div className="p-4"><ColumnChart data={[...dist.map(([label, f]) => ({ label, count: latest.filter((o) => o.position != null && f(o.position)).length })), { label: ">100", count: latest.filter((o) => o.position == null).length }]} xKey="label" yKey="count" label="Keywords" height={170} /></div></Card>
                <Card className="p-4 text-[13px] text-fg-muted">
                  <p><b className="text-fg">{fmtInt(data.total)}</b> keywords tracked. Positions are a single live check per keyword, location and device. Results vary by user, location and personalisation.</p>
                  <p className="mt-2">Mismatch flags show where the ranking URL differs from the target URL you mapped. That can point to cannibalization or the wrong page ranking.</p>
                </Card>
              </div>
            )}
            <Card>
              <FilterBar q={sp.q} qPlaceholder="Search keywords" values={sp} preserve={{ tab: "tracked", websiteId: site!.id, sort: sp.sort }} filters={[
                ...(data.groups.length ? [{ name: "group", label: "Group", options: data.groups.map((g) => ({ value: g, label: g })) }] : []),
                { name: "intent", label: "Intent", options: ["INFORMATIONAL", "COMMERCIAL", "TRANSACTIONAL", "NAVIGATIONAL", "UNKNOWN"].map((i) => ({ value: i, label: i.toLowerCase() })) },
              ]} />
              {canWrite && <div className="border-b border-border px-4 py-2"><BulkDelete ids={data.rows.map((r) => r.id)} /></div>}
              <Table>
                <THead><tr>
                  <SortTH label="Keyword" field="phrase" sort={data.filter.sort} dir="asc" href={href} />
                  <SortTH label="Position" field="position" sort={data.filter.sort} dir="asc" href={href} align="right" />
                  <SortTH label="Change" field="change" sort={data.filter.sort} dir="asc" href={href} align="right" />
                  <TH>Ranking URL</TH><TH>Intent</TH>
                  <SortTH label="Volume (est.)" field="volume" sort={data.filter.sort} dir="desc" href={href} align="right" />
                  <TH>SERP features</TH><TH>Checked</TH>
                </tr></THead>
                <tbody>
                  {data.rows.map((k) => (
                    <TR key={k.id}>
                      <TD><Link href={`/keywords/${k.id}`} className="font-medium hover:text-accent">{k.phrase}</Link><div className="text-2xs text-fg-subtle">{[k.group, k.device, ...k.tags].filter(Boolean).join(" · ")}</div></TD>
                      <TD align="right" className="font-semibold">{k.current ? k.current.position ?? ">100" : "—"}</TD>
                      <TD align="right" className={cn("text-xs font-medium", k.change == null || k.change === 0 ? "text-fg-subtle" : k.change > 0 ? "text-good" : "text-bad")}>{k.change == null ? "—" : k.change > 0 ? `▲ ${k.change}` : k.change < 0 ? `▼ ${-k.change}` : "–"}</TD>
                      <TD className="max-w-[220px]"><div className="truncate text-xs text-fg-muted" title={k.current?.url ?? ""}>{k.current?.url?.replace(/^https?:\/\/[^/]+/, "") || "—"}</div>{k.mismatch && <Badge tone="warn" title={`Target: ${k.targetUrl}`}>≠ target URL</Badge>}</TD>
                      <TD><Badge tone={intentTone[k.intent]} title={`Source: ${k.intentSource ?? "rules"}`}>{k.intent.toLowerCase()}</Badge></TD>
                      <TD align="right" className="text-xs">{k.searchVolume != null ? fmtInt(k.searchVolume) : "—"}</TD>
                      <TD className="max-w-[160px] truncate text-2xs text-fg-subtle">{k.current?.serpFeatures.join(", ") || "—"}</TD>
                      <TD className="text-xs text-fg-muted">{fmtRelative(k.current?.observedAt)}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
              <Pagination page={data.filter.page} pages={data.pages} total={data.total} pageSize={data.pageSize} href={href} />
            </Card>
          </>
        )}
      </>
    );
  }

  async function Gsc() {
    const ins = await searchConsoleInsights(ctx, site!.id);
    if (!ins) return <Card><EmptyState title="No Search Console data for this website" description="Connect Search Console in Integrations. Queries, opportunities, declines and cannibalization come from your first-party data." action={ctx.can("integrations:manage") && <ButtonLink href="/integrations">Connect Search Console</ButtonLink>} /></Card>;
    const tracked = new Set((await ctx.db.keyword.findMany({ where: { websiteId: site!.id }, select: { phrase: true } })).map((k) => k.phrase));
    const period = `${fmtDate(ins.period.start)} – ${fmtDate(ins.period.end)}`;
    const src = <SourceTag kind="measured" source={`Search Console · ${period}`} />;
    if (tab === "gsc") return (
      <Card>
        <CardHeader title={`Top queries (${fmtInt(ins.totalQueries)} total)`} description="Anonymised queries are excluded by Google, so totals here are lower than site totals." actions={src} />
        <QueryTable rows={ins.top} tracked={tracked} />
      </Card>
    );
    if (tab === "opportunities") return (
      <div className="space-y-5">
        <Card>
          <CardHeader title="Striking distance (positions 4–20)" description="Queries with real impressions where a modest improvement could reach the top 3. Prioritise by impressions." actions={src} />
          <QueryTable rows={ins.strikingDistance} tracked={tracked} />
        </Card>
        <Card>
          <CardHeader title="Declining queries" description="Clicks fell more than 30% vs the previous 28 days." actions={src} />
          {ins.declining.length === 0 ? <p className="px-4 py-6 text-[13px] text-fg-muted">No significant declines.</p> : (
            <Table>
              <THead><tr><TH>Query</TH><TH align="right">Clicks now</TH><TH align="right">Before</TH><TH align="right">Avg. position</TH><TH>Top page</TH></tr></THead>
              <tbody>{ins.declining.map((qr) => <TR key={qr.query}><TD className="font-medium">{qr.query}</TD><TD align="right">{qr.clicks}</TD><TD align="right" className="text-fg-muted">{qr.prevClicks}</TD><TD align="right">{fmtDec(qr.position)}</TD><TD className="max-w-xs truncate text-xs text-fg-muted">{[...qr.pages].sort((a, b) => b.impressions - a.impressions)[0]?.page.replace(/^https?:\/\/[^/]+/, "")}</TD></TR>)}</tbody>
            </Table>
          )}
        </Card>
      </div>
    );
    return (
      <Card>
        <CardHeader title="Keyword cannibalization" description="Queries where two or more of your pages each receive at least 15% of impressions. Consider consolidating or differentiating intent." actions={src} />
        {ins.cannibalization.length === 0 ? <p className="px-4 py-6 text-[13px] text-fg-muted">No cannibalization detected in this period.</p> : (
          <Table>
            <THead><tr><TH>Query</TH><TH align="right">Impressions</TH><TH>Competing pages (impression share · avg. position)</TH></tr></THead>
            <tbody>{ins.cannibalization.map((c) => (
              <TR key={c.query}><TD className="font-medium align-top">{c.query}</TD><TD align="right" className="align-top">{fmtInt(c.impressions)}</TD>
                <TD><ul className="space-y-0.5 py-1.5">{c.competing.map((p) => <li key={p.page} className="flex justify-between gap-4 text-xs"><span className="truncate text-fg-muted">{p.page.replace(/^https?:\/\/[^/]+/, "")}</span><span className="shrink-0 tabular">{fmtPct(p.impressions / c.impressions, 0)} · {fmtDec(p.position)}</span></li>)}</ul></TD>
              </TR>
            ))}</tbody>
          </Table>
        )}
      </Card>
    );
  }

  function QueryTable({ rows, tracked }: { rows: { query: string; clicks: number; impressions: number; ctr: number; position: number | null }[]; tracked: Set<string> }) {
    if (!rows.length) return <p className="px-4 py-6 text-[13px] text-fg-muted">Nothing to show for this period.</p>;
    const untracked = rows.filter((r) => !tracked.has(r.query.toLowerCase())).slice(0, 50).map((r) => r.query);
    return (
      <>
        {canWrite && untracked.length > 0 && <div className="flex justify-end border-b border-border px-4 py-2"><TrackQueries websiteId={site!.id} queries={untracked} /></div>}
        <Table>
          <THead><tr><TH>Query</TH><TH align="right">Clicks</TH><TH align="right">Impressions</TH><TH align="right">CTR</TH><TH align="right">Avg. position</TH><TH /></tr></THead>
          <tbody>{rows.map((r) => (
            <TR key={r.query}>
              <TD className="font-medium">{r.query}</TD><TD align="right">{fmtInt(r.clicks)}</TD><TD align="right">{fmtInt(r.impressions)}</TD><TD align="right">{fmtPct(r.ctr)}</TD><TD align="right">{fmtDec(r.position)}</TD>
              <TD align="right">{tracked.has(r.query.toLowerCase()) ? <Badge tone="good">tracked</Badge> : canWrite ? <TrackQueries websiteId={site!.id} queries={[r.query]} /> : null}</TD>
            </TR>
          ))}</tbody>
        </Table>
      </>
    );
  }
}

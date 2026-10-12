import { Swords } from "lucide-react";
import { requireStaffContext } from "@/lib/auth/context";
import { resolveSite, SitePicker } from "@/components/data/site-picker";
import { PageHeader, EmptyState } from "@/components/ui/page";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ButtonLink } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SourceTag } from "@/components/ui/metric";
import { Table, THead, TH, TR, TD } from "@/components/ui/table";
import { ActionButton } from "@/components/ui/action-form";
import { fmtInt, fmtRelative } from "@/lib/format";
import type { GapAnalysis } from "@/server/competitors";
import { gapAction, removeCompetitorAction } from "./actions";
import { AddCompetitor, SuggestCompetitors } from "./forms";
import { TrackQueries } from "../keywords/forms";

export const metadata = { title: "Competitor Intelligence" };

export default async function CompetitorsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireStaffContext();
  const { sites, site } = await resolveSite(ctx, sp.websiteId);
  const header = <PageHeader title="Competitor Intelligence" description="Track competitor domains, find keyword gaps and link gaps, and compare brand visibility in AI answers." actions={<SitePicker sites={sites} current={site?.id} />} />;
  if (!site) return <>{header}<Card><EmptyState title="Add a website first" action={<ButtonLink href="/websites">Websites</ButtonLink>} /></Card></>;
  const [competitors, dfs, tracked] = await Promise.all([
    ctx.db.competitor.findMany({ where: { websiteId: site.id }, orderBy: { createdAt: "asc" } }),
    ctx.db.integrationConnection.findFirst({ where: { provider: "DATAFORSEO", websiteId: null, status: "CONNECTED" } }),
    ctx.db.keyword.findMany({ where: { websiteId: site.id }, select: { phrase: true } }),
  ]);
  const trackedSet = new Set(tracked.map((t) => t.phrase));
  const canWrite = ctx.can("keywords:write");
  const active = competitors.find((c) => c.id === sp.competitorId) ?? competitors.find((c) => c.analysis) ?? competitors[0];
  const gap = active?.analysis as GapAnalysis | null | undefined;

  return (
    <>
      {header}
      {canWrite && (
        <Card className="mb-5">
          <CardHeader title="Add a competitor" />
          <CardBody className="space-y-4"><AddCompetitor websiteId={site.id} />{dfs && <SuggestCompetitors websiteId={site.id} />}</CardBody>
        </Card>
      )}
      {competitors.length === 0 ? <Card><EmptyState icon={<Swords className="size-5" />} title="No competitors yet" description="Competitors power keyword-gap and link-gap analysis, and GEO share-of-voice comparisons." /></Card> : (
        <div className="grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
          <Card className="self-start">
            <CardHeader title={`Competitors (${competitors.length})`} />
            <ul className="divide-y divide-border">
              {competitors.map((c) => (
                <li key={c.id} className={`flex items-center justify-between gap-2 px-4 py-2.5 ${active?.id === c.id ? "bg-accent-soft" : ""}`}>
                  <a href={`/competitors?websiteId=${site.id}&competitorId=${c.id}`} className="min-w-0">
                    <div className="truncate text-[13px] font-medium">{c.name ?? c.domain}</div>
                    <div className="text-2xs text-fg-subtle">{c.domain} · {c.analyzedAt ? `analysed ${fmtRelative(c.analyzedAt)}` : "not analysed"}</div>
                  </a>
                  {canWrite && <ActionButton action={removeCompetitorAction} fields={{ id: c.id }} size="sm" variant="ghost" confirm={`Remove ${c.domain}?`}>Remove</ActionButton>}
                </li>
              ))}
            </ul>
          </Card>
          {active && (
            <div className="space-y-5">
              <Card>
                <CardHeader title={`Keyword gap vs ${active.domain}`} description={gap ? `${fmtInt(gap.competitorKeywords)} competitor and ${fmtInt(gap.ourKeywords)} ${site.domain} ranking keywords compared · cost $${gap.cost.toFixed(3)}` : "Find keywords the competitor ranks for in the top 20 that you don't rank for at all, or where they outrank you."}
                  actions={<div className="flex items-center gap-2">{gap && <SourceTag kind="estimate" source="DataForSEO Labs" updatedAt={gap.computedAt} />}{canWrite && dfs && <ActionButton action={gapAction} fields={{ id: active.id }} size="sm" variant="primary">{gap ? "Re-run" : "Run gap analysis"}</ActionButton>}</div>} />
                {!dfs && !gap && <CardBody><p className="text-[13px] text-fg-muted">Keyword-gap data needs DataForSEO. Connect it in Integrations.</p></CardBody>}
                {gap && (
                  <div className="grid gap-0 lg:grid-cols-2 lg:divide-x lg:divide-border">
                    <div>
                      <div className="flex items-center justify-between border-b border-border px-4 py-2 text-xs font-semibold">Missing ({gap.missing.length}){canWrite && gap.missing.length > 0 && <TrackQueries websiteId={site.id} queries={gap.missing.filter((m) => !trackedSet.has(m.keyword)).slice(0, 50).map((m) => m.keyword)} />}</div>
                      <Table><THead><tr><TH>Keyword</TH><TH align="right">Volume (est.)</TH><TH align="right">Their pos.</TH></tr></THead>
                        <tbody>{gap.missing.slice(0, 100).map((m) => <TR key={m.keyword}><TD>{m.keyword}{trackedSet.has(m.keyword) && <Badge tone="good" className="ml-1.5">tracked</Badge>}</TD><TD align="right">{m.volume ?? "—"}</TD><TD align="right">{m.theirPosition}</TD></TR>)}</tbody></Table>
                    </div>
                    <div>
                      <div className="border-b border-border px-4 py-2 text-xs font-semibold">They outrank you ({gap.behind.length})</div>
                      <Table><THead><tr><TH>Keyword</TH><TH align="right">You</TH><TH align="right">Them</TH></tr></THead>
                        <tbody>{gap.behind.slice(0, 100).map((m) => <TR key={m.keyword}><TD>{m.keyword}</TD><TD align="right">{m.ourPosition}</TD><TD align="right">{m.theirPosition}</TD></TR>)}</tbody></Table>
                    </div>
                  </div>
                )}
              </Card>
              <Card>
                <CardHeader title="More competitor analyses" />
                <CardBody className="flex flex-wrap gap-2 text-[13px]">
                  <ButtonLink href={`/backlinks?websiteId=${site.id}&tab=pipeline`} size="sm">Link gap → backlink opportunities</ButtonLink>
                  <ButtonLink href={`/geo?websiteId=${site.id}`} size="sm">Share of voice in AI answers</ButtonLink>
                  <ButtonLink href={`/content?websiteId=${site.id}&tab=compare`} size="sm">Compare a page with a competitor page</ButtonLink>
                </CardBody>
              </Card>
            </div>
          )}
        </div>
      )}
    </>
  );
}

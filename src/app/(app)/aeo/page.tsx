import Link from "next/link";
import { MessageSquareQuote } from "lucide-react";
import { requireStaffContext } from "@/lib/auth/context";
import { resolveSite, SitePicker } from "@/components/data/site-picker";
import { PageHeader, EmptyState, Notice } from "@/components/ui/page";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { SourceTag, MetricTile } from "@/components/ui/metric";
import { Table, THead, TH, TR, TD } from "@/components/ui/table";
import { ActionButton } from "@/components/ui/action-form";
import { ScoreRing } from "@/components/charts/bars";
import { fmtDate, fmtInt, fmtRelative } from "@/lib/format";
import type { AeoCheck } from "@/server/aeo";
import { SUPPORTED_SCHEMA_TYPES } from "@/audit/schema";
import { aeoJobAction, draftAnswerAction } from "./actions";
import { OppStatus, SchemaValidator } from "./forms";

export const metadata = { title: "AEO Optimization" };

export default async function AeoPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireStaffContext();
  const { sites, site } = await resolveSite(ctx, sp.websiteId);
  const header = <PageHeader title="AEO Optimization" description="Make content easy for answer engines to understand, quote and cite: question coverage, concise answers, structure, authorship and valid markup." actions={<SitePicker sites={sites} current={site?.id} preserve={{ tab: sp.tab }} />} />;
  if (!site) return <>{header}<Card><EmptyState title="Add a website first" action={<ButtonLink href="/websites">Websites</ButtonLink>} /></Card></>;
  const tab = ["opportunities", "pages", "schema"].includes(sp.tab ?? "") ? sp.tab! : "opportunities";
  const canWrite = ctx.can("content:write");
  const [dfs, ai] = await Promise.all([
    ctx.db.integrationConnection.findFirst({ where: { provider: "DATAFORSEO", websiteId: null, status: "CONNECTED" } }),
    ctx.db.integrationConnection.findFirst({ where: { provider: { in: ["ANTHROPIC", "OPENAI", "GEMINI", "PERPLEXITY"] }, websiteId: null, status: "CONNECTED" } }),
  ]);
  const latest = await ctx.db.aeoAssessment.findMany({ where: { websiteId: site.id }, orderBy: { assessedAt: "desc" }, distinct: ["url"], take: 200 });
  const avg = latest.length ? latest.reduce((s, a) => s + a.score, 0) / latest.length : null;
  const oppCount = await ctx.db.aeoOpportunity.count({ where: { websiteId: site.id, status: { in: ["OPEN", "IN_PROGRESS"] } } });

  return (
    <>
      {header}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="flex items-center gap-4 p-3.5"><ScoreRing value={avg} label="AEO readiness" size={60} /><div><div className="text-xs text-fg-muted">Avg. readiness</div><SourceTag kind="internal" /></div></Card>
        <MetricTile label="Pages assessed" value={fmtInt(latest.length)} provenance="internal" source={latest[0] ? `latest ${fmtRelative(latest[0].assessedAt)}` : "none yet"} />
        <MetricTile label="Open question opportunities" value={fmtInt(oppCount)} provenance="measured" source="GSC / keywords" />
        <Card className="flex flex-col justify-center gap-2 p-3.5">
          {canWrite && <ActionButton action={aeoJobAction} fields={{ websiteId: site.id, type: "assess" }} size="sm">Assess key pages</ActionButton>}
          {canWrite && <ActionButton action={aeoJobAction} fields={{ websiteId: site.id, type: "opportunities", paa: dfs ? "1" : "0" }} size="sm" variant="primary">Find question opportunities</ActionButton>}
        </Card>
      </div>
      <TabNav active={tab} tabs={[{ key: "opportunities", label: "Question opportunities" }, { key: "pages", label: "Page assessments" }, { key: "schema", label: "Schema validator" }].map((t) => ({ ...t, href: `/aeo?websiteId=${site.id}&tab=${t.key}` }))} />
      {tab === "opportunities" && <Opps />}
      {tab === "pages" && <Pages />}
      {tab === "schema" && <Schema />}
    </>
  );

  async function Opps() {
    const opps = await ctx.db.aeoOpportunity.findMany({ where: { websiteId: site!.id, ...(sp.status ? { status: sp.status } : { status: { in: ["OPEN", "IN_PROGRESS"] } }) }, orderBy: { createdAt: "desc" }, take: 200 });
    opps.sort((a, b) => Number((b.evidence as { impressions?: number }).impressions ?? 0) - Number((a.evidence as { impressions?: number }).impressions ?? 0));
    if (!opps.length) return <Card><EmptyState icon={<MessageSquareQuote className="size-5" />} title="No question opportunities yet" description={<>Opportunities come from question-style Search Console queries, tracked informational keywords{dfs ? " and People Also Ask results" : ""}. Connect Search Console or add question keywords, then click “Find question opportunities”.</>} /></Card>;
    return (
      <div className="space-y-3">
        {!ai && <Notice tone="info">Connect an AI provider in <Link className="text-accent hover:underline" href="/integrations">Integrations</Link> to draft answer sections grounded in your page content.</Notice>}
        {opps.map((o) => {
          const ev = o.evidence as Record<string, unknown>;
          const gaps = o.contentGaps as string[];
          return (
            <Card key={o.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold">{o.question}</h3>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-fg-subtle">
                    <Badge tone="info">{o.intent.toLowerCase()}</Badge>
                    <span>{o.source}</span>
                    {ev.impressions != null && <span>· {fmtInt(Number(ev.impressions))} impressions, {fmtInt(Number(ev.clicks))} clicks, avg pos {String(ev.avgPosition)} ({String(ev.period)})</span>}
                    {ev.position != null && <span>· tracked position {String(ev.position)}</span>}
                    {o.rankingUrl ? <span>· ranking URL <a href={o.rankingUrl} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">{o.rankingUrl.replace(/^https?:\/\/[^/]+/, "") || "/"}</a></span> : <span>· no ranking page</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {canWrite && ai && o.rankingUrl && <ActionButton action={draftAnswerAction} fields={{ id: o.id }} size="sm">Draft answer (AI)</ActionButton>}
                  {canWrite && <OppStatus id={o.id} status={o.status} />}
                </div>
              </div>
              <div className="mt-3 grid gap-3 text-[13px] md:grid-cols-2">
                <div><div className="mb-1 text-xs font-semibold">Recommended answer format</div><p className="text-fg-muted">{o.recommendedFormat}</p><div className="mt-2 mb-1 text-xs font-semibold">Suggested change</div><p className="text-fg-muted">{o.suggestedChanges}</p></div>
                <div><div className="mb-1 text-xs font-semibold">Content gaps (from evidence)</div>{gaps.length ? <ul className="list-disc space-y-0.5 pl-4 text-xs text-fg-muted">{gaps.map((g) => <li key={g}>{g}</li>)}</ul> : <p className="text-xs text-good">No gaps detected on the ranking page.</p>}</div>
              </div>
            </Card>
          );
        })}
        <p className="text-2xs text-fg-subtle">Improving answer formatting can make content easier to quote; it does not guarantee featured snippets or AI citations.</p>
      </div>
    );
  }

  async function Pages() {
    if (!latest.length) return <Card><EmptyState title="No pages assessed yet" description="Assess your most important pages (by Search Console clicks, else internal links) for answer-engine readiness." /></Card>;
    return (
      <Card>
        <CardHeader title="Latest assessment per page" actions={<SourceTag kind="internal" source="AEO readiness checks" />} />
        <div className="divide-y divide-border">
          {[...latest].sort((a, b) => a.score - b.score).map((a) => {
            const checks = ((a.checks as unknown as { checks?: AeoCheck[] }).checks ?? []).filter((c) => c.applicable);
            const failing = checks.filter((c) => !c.pass);
            return (
              <details key={a.id} className="group">
                <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-2.5">
                  <span className={`w-10 text-right text-sm font-semibold tabular ${a.score >= 80 ? "text-good" : a.score >= 50 ? "text-warn" : "text-bad"}`}>{Math.round(a.score)}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px]">{a.url.replace(/^https?:\/\/[^/]+/, "") || "/"}</span>
                  <span className="text-2xs text-fg-subtle">{failing.length} to improve · {fmtDate(a.assessedAt)}</span>
                </summary>
                <ul className="space-y-1.5 border-t border-border bg-surface-2 px-4 py-3">
                  {checks.map((c) => (
                    <li key={c.key} className="flex gap-2 text-xs">
                      <span className={c.pass ? "text-good" : "text-bad"}>{c.pass ? "✓" : "✗"}</span>
                      <span className="w-64 shrink-0 font-medium">{c.label} <span className="font-normal text-fg-subtle">×{c.weight}</span></span>
                      <span className="text-fg-muted">{c.detail}</span>
                    </li>
                  ))}
                </ul>
              </details>
            );
          })}
        </div>
      </Card>
    );
  }

  function Schema() {
    return (
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card><CardHeader title="Validate JSON-LD" description="Checks Google-documented required properties for supported rich-result types and flags missing recommended ones." /><CardBody><SchemaValidator /></CardBody></Card>
        <Card><CardHeader title="Supported types" /><CardBody><div className="flex flex-wrap gap-1">{SUPPORTED_SCHEMA_TYPES.map((t) => <Badge key={t}>{t}</Badge>)}</div><p className="mt-3 text-2xs text-fg-subtle">Only mark up content that is visible on the page. Markup describing content users can&apos;t see violates Google&apos;s guidelines.</p></CardBody></Card>
      </div>
    );
  }
}

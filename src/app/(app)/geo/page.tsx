import Link from "next/link";
import { Sparkles } from "lucide-react";
import { requireOrgContext } from "@/lib/auth/context";
import { geoSummary, entityAudit, PLATFORM_LABEL } from "@/server/geo";
import { AI_PROVIDERS, type AiProviderId } from "@/integrations/ai";
import { resolveSite, SitePicker } from "@/components/data/site-picker";
import { PageHeader, EmptyState, Notice } from "@/components/ui/page";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { MetricTile, SourceTag } from "@/components/ui/metric";
import { Table, THead, TH, TR, TD, Pagination, makeHref } from "@/components/ui/table";
import { ActionButton } from "@/components/ui/action-form";
import { MultiLineChart } from "@/components/charts/charts";
import { BarList, SegmentBar } from "@/components/charts/bars";
import { fmtDate, fmtInt, fmtPct } from "@/lib/format";
import { runSetAction, toggleSetAction } from "./actions";
import { PromptSetDialog } from "./forms";

export const metadata = { title: "GEO & AI Visibility" };

export default async function GeoPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireOrgContext();
  const { sites, site } = await resolveSite(ctx, sp.websiteId);
  const header = <PageHeader title="GEO & AI Visibility" description="How often AI assistants mention and cite your brand for the questions your customers ask, measured with official APIs and recorded with full evidence." actions={<SitePicker sites={sites} current={site?.id} preserve={{ tab: sp.tab }} />} />;
  if (!site) return <>{header}<Card><EmptyState title="Add a website first" action={<ButtonLink href="/websites">Websites</ButtonLink>} /></Card></>;
  const tab = ["overview", "prompts", "observations", "entity"].includes(sp.tab ?? "") ? sp.tab! : "overview";
  const connected = await ctx.db.integrationConnection.findMany({ where: { websiteId: null, provider: { in: AI_PROVIDERS }, status: "CONNECTED" }, select: { provider: true } });
  const platforms = AI_PROVIDERS.map((p) => ({ id: p, label: PLATFORM_LABEL[p], connected: connected.some((c) => c.provider === p) }));
  const canWrite = ctx.can("geo:write");

  return (
    <>
      {header}
      {!connected.length && <Notice tone="info" className="mb-4" title="Connect at least one AI platform">GEO checks call official APIs (Perplexity Sonar returns cited sources; Claude, OpenAI and Gemini can search the web). Add keys in <Link className="text-accent hover:underline" href="/integrations">Integrations</Link>. We never scrape consumer chat apps.</Notice>}
      <TabNav active={tab} tabs={[{ key: "overview", label: "Visibility" }, { key: "prompts", label: "Prompt sets" }, { key: "observations", label: "Observations" }, { key: "entity", label: "Entity & authority" }].map((t) => ({ ...t, href: `/geo?websiteId=${site.id}&tab=${t.key}` }))} />
      {tab === "overview" && <Overview />}
      {tab === "prompts" && <Prompts />}
      {tab === "observations" && <Observations />}
      {tab === "entity" && <Entity />}
    </>
  );

  async function Overview() {
    const s = await geoSummary(ctx, site!.id, Number(sp.days ?? 90));
    if (!s.samples) return <Card><EmptyState icon={<Sparkles className="size-5" />} title="No AI visibility samples yet" description="Create a prompt set with the questions customers ask, choose platforms, and run it. Each answer is stored with the platform, model, date, response, citations and methodology." action={canWrite && <ButtonLink href={`/geo?websiteId=${site!.id}&tab=prompts`} variant="primary">Set up prompts</ButtonLink>} /></Card>;
    return (
      <>
        <Notice tone="warn" className="mb-5">These metrics come from {fmtInt(s.samples)} sampled API answers over the last 90 days. They indicate trends, not universal visibility. Answers vary by user, location, time and session.</Notice>
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricTile label="Brand mentioned in answers" value={fmtPct(s.mentionRate, 0)} provenance="sampled" source={`${fmtInt(s.samples)} answers`} updatedAt={s.lastObserved} />
          <MetricTile label="Your site cited as a source" value={fmtPct(s.citationRate, 0)} provenance="sampled" source="citation URLs" />
          <MetricTile label="Prompts with no brand mention" value={fmtInt(s.gaps.length)} provenance="sampled" source="content opportunities" />
          <Card className="p-3.5"><div className="text-xs text-fg-muted">Sentiment when mentioned</div><div className="mt-2"><SegmentBar segments={[{ label: "positive", value: s.sentiment.positive, color: "var(--good)" }, { label: "neutral", value: s.sentiment.neutral, color: "var(--chart-muted)" }, { label: "negative", value: s.sentiment.negative, color: "var(--bad)" }]} /></div><div className="mt-1"><SourceTag kind="internal" source="lexicon classifier" /></div></Card>
        </div>
        <div className="mb-5 grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card><CardHeader title="Mention & citation rate by week" actions={<SourceTag kind="sampled" />} /><CardBody>{s.trend.length > 1 ? <MultiLineChart data={s.trend} series={[{ key: "mentionRate", label: "Mention rate" }, { key: "citationRate", label: "Citation rate" }]} fmt="pct" height={220} /> : <p className="py-10 text-center text-[13px] text-fg-muted">Trends appear after runs in at least two different weeks.</p>}</CardBody></Card>
          <Card><CardHeader title="Share of voice" description="Answers mentioning each brand" actions={<SourceTag kind="sampled" />} /><CardBody><BarList items={s.shareOfVoice.map((x) => ({ label: x.own ? `${x.name} (you)` : x.name, value: x.count }))} /></CardBody></Card>
        </div>
        <div className="mb-5 grid gap-5 lg:grid-cols-3">
          <Card>
            <CardHeader title="By platform" />
            <Table><THead><tr><TH>Platform</TH><TH align="right">Samples</TH><TH align="right">Mentioned</TH><TH align="right">Cited</TH></tr></THead>
              <tbody>{s.platforms.map((p) => <TR key={p.platform}><TD className="text-xs">{p.label}</TD><TD align="right">{p.samples}</TD><TD align="right">{fmtPct(p.mentionRate, 0)}</TD><TD align="right">{fmtPct(p.citationRate, 0)}</TD></TR>)}</tbody></Table>
          </Card>
          <Card><CardHeader title="Most cited domains" description="Sources AI answers lean on for these topics" /><CardBody><BarList items={s.topCitedDomains} /></CardBody></Card>
          <Card><CardHeader title="Your pages cited" /><CardBody>{s.ownCitedPages.length ? <BarList items={s.ownCitedPages.map((p) => ({ label: p.label.replace(/^https?:\/\/[^/]+/, "") || "/", value: p.value }))} /> : <p className="text-[13px] text-fg-muted">None of your pages were cited in these samples.</p>}</CardBody></Card>
        </div>
        {s.gaps.length > 0 && (
          <Card>
            <CardHeader title="Unanswered: prompts where your brand never appeared" description="Candidates for new or improved content. Check whether competitors are mentioned and which sources are cited." />
            <Table><THead><tr><TH>Prompt</TH><TH align="right">Samples</TH><TH>Competitors mentioned instead</TH></tr></THead>
              <tbody>{s.gaps.map((g) => <TR key={g.query}><TD>{g.query}</TD><TD align="right">{g.samples}</TD><TD className="text-xs">{g.competitorsMentioned.join(", ") || "—"}</TD></TR>)}</tbody></Table>
          </Card>
        )}
      </>
    );
  }

  async function Prompts() {
    const sets = await ctx.db.geoPromptSet.findMany({ where: { websiteId: site!.id }, include: { prompts: true }, orderBy: { createdAt: "asc" } });
    return (
      <div className="space-y-4">
        {canWrite && <PromptSetDialog websiteId={site!.id} platforms={platforms} />}
        {sets.length === 0 ? <Card><EmptyState title="No prompt sets" description="Group prompts by audience or market (e.g. “Buyers in Ohio”)." /></Card> : sets.map((s) => (
          <Card key={s.id}>
            <CardHeader title={s.name} description={`${s.prompts.length} prompts × ${s.platforms.length} platform(s) · market ${s.market} · ${s.schedule ? `schedule ${s.schedule} UTC` : "manual"}`}
              actions={canWrite && <div className="flex gap-1">
                <ActionButton action={runSetAction} fields={{ id: s.id }} size="sm" variant="primary">Run now</ActionButton>
                <PromptSetDialog websiteId={site!.id} platforms={platforms} initial={{ id: s.id, name: s.name, market: s.market, language: s.language, platforms: s.platforms, competitorTerms: s.competitorTerms, prompts: s.prompts.map((p) => p.text), schedule: s.schedule }} />
                <ActionButton action={toggleSetAction} fields={{ id: s.id, enabled: s.enabled ? "0" : "1" }} size="sm" variant="ghost">{s.enabled ? "Pause schedule" : "Resume schedule"}</ActionButton>
              </div>} />
            <CardBody>
              <div className="mb-2 flex flex-wrap gap-1">{s.platforms.map((p) => <Badge key={p} tone="accent">{PLATFORM_LABEL[p as AiProviderId] ?? p}</Badge>)}{s.competitorTerms.map((c) => <Badge key={c}>{c}</Badge>)}</div>
              <ul className="list-disc space-y-0.5 pl-4 text-[13px] text-fg-muted">{s.prompts.map((p) => <li key={p.id}>{p.text}</li>)}</ul>
            </CardBody>
          </Card>
        ))}
      </div>
    );
  }

  async function Observations() {
    const page = Math.max(1, Number(sp.page ?? 1));
    const where = { websiteId: site!.id, ...(sp.platform ? { platform: sp.platform } : {}), ...(sp.mentioned === "yes" ? { brandMentioned: true } : sp.mentioned === "no" ? { brandMentioned: false } : {}) };
    const [total, rows] = await Promise.all([ctx.db.geoObservation.count({ where }), ctx.db.geoObservation.findMany({ where, orderBy: { observedAt: "desc" }, skip: (page - 1) * 25, take: 25 })]);
    if (!total) return <Card><EmptyState title="No observations yet" /></Card>;
    return (
      <div className="space-y-2">
        <div className="flex gap-3 text-xs">{[["", "All"], ["yes", "Mentioned"], ["no", "Not mentioned"]].map(([v, l]) => <Link key={v} href={`/geo?websiteId=${site!.id}&tab=observations${v ? `&mentioned=${v}` : ""}`} className={(sp.mentioned ?? "") === v ? "font-semibold" : "text-fg-muted"}>{l}</Link>)}</div>
        {rows.map((o) => (
          <details key={o.id} className="rounded-[var(--radius-card)] border border-border bg-surface">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-2.5 text-[13px]">
              <span className="min-w-0 flex-1 truncate font-medium">{o.query}</span>
              <Badge>{PLATFORM_LABEL[o.platform as AiProviderId] ?? o.platform}</Badge>
              <Badge tone={o.brandMentioned ? "good" : "neutral"}>{o.brandMentioned ? "mentioned" : "not mentioned"}</Badge>
              {o.brandCited && <Badge tone="accent">cited</Badge>}
              {o.sentiment && <Badge tone={o.sentiment === "positive" ? "good" : o.sentiment === "negative" ? "bad" : "neutral"}>{o.sentiment}</Badge>}
              <span className="text-2xs text-fg-subtle">{fmtDate(o.observedAt, true)}</span>
            </summary>
            <div className="grid gap-4 border-t border-border p-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <div><div className="mb-1 text-xs font-semibold">Response ({o.model})</div><pre className="scroll-thin max-h-80 overflow-y-auto whitespace-pre-wrap font-sans text-xs leading-relaxed text-fg-muted">{o.responseText}</pre></div>
              <div className="space-y-3 text-xs">
                <div><div className="mb-1 font-semibold">Cited sources</div>{(o.citations as { url: string; title?: string }[]).length ? <ul className="space-y-0.5">{(o.citations as { url: string; title?: string }[]).map((c) => <li key={c.url} className="truncate"><a href={c.url} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">{c.title || c.url}</a></li>)}</ul> : <p className="text-fg-subtle">No citations returned.</p>}</div>
                <div><div className="mb-1 font-semibold">Competitors</div>{Object.entries(o.competitorMentions as Record<string, { mentioned: boolean; cited: boolean }>).map(([n, v]) => <div key={n}>{n}: {v.mentioned ? "mentioned" : "—"}{v.cited ? ", cited" : ""}</div>)}</div>
                <div><div className="mb-1 font-semibold">Methodology</div><p className="text-fg-subtle">{o.methodology}</p></div>
              </div>
            </div>
          </details>
        ))}
        <Pagination page={page} pages={Math.max(1, Math.ceil(total / 25))} total={total} pageSize={25} href={makeHref("/geo", { ...sp, websiteId: site!.id, tab: "observations" })} />
      </div>
    );
  }

  async function Entity() {
    const audit = await entityAudit(ctx, site!.id);
    if (!audit) return <Card><EmptyState title="Crawl the site first" description="Entity checks read the structured data found by the crawler." action={<ButtonLink href={`/audits?websiteId=${site!.id}`}>Go to audits</ButtonLink>} /></Card>;
    return (
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Organization entity consistency" description="Consistent, well-linked entity data helps search and AI systems recognise who you are." actions={<Link className="text-xs text-accent hover:underline" href={`/audits/${audit.crawlId}`}>from latest crawl</Link>} />
          <ul className="divide-y divide-border">{audit.checks.map((c) => <li key={c.label} className="flex gap-3 px-4 py-2.5 text-[13px]"><span className={c.pass ? "text-good" : "text-bad"}>{c.pass ? "✓" : "✗"}</span><span className="flex-1"><span className="font-medium">{c.label}</span><span className="block text-xs text-fg-muted">{c.detail}</span></span></li>)}</ul>
        </Card>
        <Card>
          <CardHeader title="Authority signals to strengthen" />
          <CardBody className="space-y-2 text-[13px] text-fg-muted">
            <p>• Author pages with real credentials, linked from articles (see AEO → author checks).</p>
            <p>• Consistent name, address and profiles across your site, Google Business Profile and directories.</p>
            <p>• Earned mentions on sources AI answers already cite for your topics (see “Most cited domains”), and pursue them via the backlink pipeline.</p>
            <p>• Original data, clear definitions and concise answers that are easy to quote with attribution.</p>
            <p className="text-2xs text-fg-subtle">These are general practices; no tactic guarantees inclusion in AI answers.</p>
          </CardBody>
        </Card>
      </div>
    );
  }
}

export const dynamic = "force-dynamic";

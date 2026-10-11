import Link from "next/link";
import { Check, X, PenLine } from "lucide-react";
import { requireOrgContext } from "@/lib/auth/context";
import { resolveSite, SitePicker } from "@/components/data/site-picker";
import { PageHeader, EmptyState, Notice } from "@/components/ui/page";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { SourceTag } from "@/components/ui/metric";
import { Table, THead, TH, TR, TD } from "@/components/ui/table";
import { ActionButton } from "@/components/ui/action-form";
import { fmtInt, fmtRelative } from "@/lib/format";
import { SUGGESTION_KINDS, claimsToVerify, type ContentAnalysis, type ContentBrief, type ContentComparison } from "@/server/content-studio";
import { AnalyzeForm, CompareForm, BriefForm, EditSuggestion } from "./forms";
import { metadataJobAction, suggestionStatusAction, proposeSuggestionAction } from "./actions";

export const metadata = { title: "Content Studio" };

const TABS = [
  { key: "suggestions", label: "Review queue" },
  { key: "analyze", label: "Analyze" },
  { key: "compare", label: "Compare" },
  { key: "briefs", label: "Briefs" },
];

export default async function ContentPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireOrgContext();
  const { sites, site } = await resolveSite(ctx, sp.websiteId);
  const header = <PageHeader title="Content Studio" description="Analyze pages, compare with competitors, draft briefs and review AI suggestions. Nothing is published without approval." actions={<SitePicker sites={sites} current={site?.id} preserve={{ tab: sp.tab }} />} />;
  if (!site) return <>{header}<Card><EmptyState title="Add a website first" action={<ButtonLink href="/websites">Websites</ButtonLink>} /></Card></>;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "suggestions";
  const canWrite = ctx.can("content:write");
  const [ai, dfs, wp, pendingCount] = await Promise.all([
    ctx.db.integrationConnection.findFirst({ where: { provider: { in: ["ANTHROPIC", "OPENAI", "GEMINI", "PERPLEXITY"] }, websiteId: null, status: "CONNECTED" } }),
    ctx.db.integrationConnection.findFirst({ where: { provider: "DATAFORSEO", websiteId: null, status: "CONNECTED" } }),
    ctx.db.integrationConnection.findFirst({ where: { provider: "WORDPRESS", websiteId: site.id, status: "CONNECTED" } }),
    ctx.db.contentSuggestion.count({ where: { websiteId: site.id, kind: { in: ["METADATA", "AEO_ANSWER", "BRIEF"] }, status: { in: ["SUGGESTED", "EDITED"] } } }),
  ]);
  const href = (t: string, extra = "") => `/content?websiteId=${site.id}&tab=${t}${extra}`;

  return (
    <>
      {header}
      <TabNav active={tab} tabs={TABS.map((t) => ({ ...t, href: href(t.key), count: t.key === "suggestions" ? pendingCount : undefined }))} />
      {tab === "suggestions" && <Suggestions />}
      {tab === "analyze" && <Analyze />}
      {tab === "compare" && <Compare />}
      {tab === "briefs" && <Briefs />}
    </>
  );

  async function load(kind: string) {
    if (!sp.id) return null;
    return ctx.db.contentSuggestion.findFirst({ where: { id: sp.id, websiteId: site!.id, kind } });
  }

  async function History({ kind, tabKey }: { kind: string; tabKey: string }) {
    const rows = await ctx.db.contentSuggestion.findMany({ where: { websiteId: site!.id, kind }, orderBy: { createdAt: "desc" }, take: 15, select: { id: true, url: true, input: true, createdAt: true } });
    if (!rows.length) return null;
    return (
      <Card>
        <CardHeader title="Recent" />
        <ul className="divide-y divide-border text-[13px]">
          {rows.map((r) => {
            const inp = r.input as { keyword?: string | null; competitorUrl?: string };
            return (
              <li key={r.id}><Link href={href(tabKey, `&id=${r.id}`)} className={`flex items-center justify-between gap-3 px-4 py-2 hover:bg-surface-hover ${r.id === sp.id ? "bg-surface-2" : ""}`}>
                <span className="truncate">{inp.keyword ?? r.url?.replace(/^https?:\/\//, "") ?? "Pasted text"}{inp.competitorUrl ? ` vs ${new URL(inp.competitorUrl).hostname}` : ""}</span>
                <span className="shrink-0 text-2xs text-fg-subtle">{fmtRelative(r.createdAt)}</span>
              </Link></li>
            );
          })}
        </ul>
      </Card>
    );
  }

  async function Analyze() {
    const row = await load("ANALYSIS");
    const a = row ? (JSON.parse(row.output) as ContentAnalysis) : null;
    return (
      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        <div className="space-y-4">
          {canWrite && <Card><CardHeader title="Analyze a page or draft" /><CardBody><AnalyzeForm websiteId={site!.id} defaultUrl={sp.url} /></CardBody></Card>}
          <History kind="ANALYSIS" tabKey="analyze" />
        </div>
        {a ? <AnalysisView a={a} /> : <Card><EmptyState icon={<PenLine className="size-5" />} title="No analysis selected" description="Analyze a live URL or paste a draft to check structure, readability, keyword placement and duplication against your crawled pages." /></Card>}
      </div>
    );
  }

  async function Compare() {
    const row = await load("COMPARE");
    const c = row ? (JSON.parse(row.output) as ContentComparison) : null;
    return (
      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        <div className="space-y-4">
          {canWrite && <Card><CardHeader title="Compare with a competitor page" /><CardBody><CompareForm websiteId={site!.id} /></CardBody></Card>}
          <History kind="COMPARE" tabKey="compare" />
        </div>
        {c ? <ComparisonView c={c} /> : <Card><EmptyState title="No comparison selected" description="Compare your page with a page that outranks it: headings, topics, terms, structured data and readability." /></Card>}
      </div>
    );
  }

  async function Briefs() {
    const row = await load("BRIEF");
    const sources = [dfs ? "DataForSEO SERP" : null, "Search Console queries (if synced)", "your crawled pages"].filter(Boolean).join(", ");
    return (
      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        <div className="space-y-4">
          {canWrite && (ai
            ? <Card><CardHeader title="New content brief" /><CardBody><BriefForm websiteId={site!.id} sources={sources} /></CardBody></Card>
            : <Notice tone="info" title="Connect an AI provider">Briefs are drafted by your connected AI provider and grounded in real data. Add an Anthropic, OpenAI, Gemini or Perplexity key in <Link href="/integrations" className="text-accent hover:underline">Integrations</Link>.</Notice>)}
          {!dfs && <p className="text-2xs text-fg-subtle">Without DataForSEO the brief won&apos;t include current search results. We don&apos;t scrape search engines.</p>}
          <History kind="BRIEF" tabKey="briefs" />
        </div>
        {row ? <BriefView brief={JSON.parse(row.output) as ContentBrief} meta={{ provider: row.provider, model: row.model, created: row.createdAt, sources: ((row.input as { sources?: string[] }).sources ?? []) }} /> : <Card><EmptyState title="No brief selected" description="Briefs include title options, an outline, FAQs, entities, internal links from your own pages and claims a writer must verify." /></Card>}
      </div>
    );
  }

  async function Suggestions() {
    const status = sp.status === "done" ? ["APPROVED", "REJECTED", "APPLIED"] : ["SUGGESTED", "EDITED", "APPROVED"];
    const rows = await ctx.db.contentSuggestion.findMany({ where: { websiteId: site!.id, kind: { in: ["METADATA", "AEO_ANSWER"] }, status: { in: status as never } }, orderBy: { createdAt: "desc" }, take: 100 });
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-1 text-xs">
            <Link href={href("suggestions")} className={`rounded-md px-2.5 py-1 ${sp.status !== "done" ? "bg-surface-2 font-medium" : "text-fg-muted"}`}>To review</Link>
            <Link href={href("suggestions", "&status=done")} className={`rounded-md px-2.5 py-1 ${sp.status === "done" ? "bg-surface-2 font-medium" : "text-fg-muted"}`}>Decided</Link>
          </div>
          {canWrite && ai && <ActionButton action={metadataJobAction} fields={{ websiteId: site!.id }} size="sm" variant="primary">Draft titles &amp; metas for flagged pages</ActionButton>}
        </div>
        {!ai && <Notice tone="info">AI suggestions need a connected AI provider (<Link href="/integrations" className="text-accent hover:underline">Integrations</Link>). Analysis and comparison work without one.</Notice>}
        {!rows.length ? <Card><EmptyState title="Nothing to review" description="AI-drafted titles, meta descriptions and answer sections appear here for human review before anything reaches the site." /></Card> : rows.map((s) => {
          const out = JSON.parse(s.output) as { title?: string; metaDescription?: string; rationale?: string; heading?: string; answer?: string; gaps?: string[] };
          const inp = s.input as { currentTitle?: string | null; currentMetaDescription?: string | null; question?: string };
          const body = s.kind === "METADATA" ? `${out.title ?? ""} ${out.metaDescription ?? ""}` : out.answer ?? "";
          const claims = claimsToVerify(body);
          return (
            <Card key={s.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5 text-2xs text-fg-subtle">
                    <Badge tone="info">{SUGGESTION_KINDS[s.kind] ?? s.kind}</Badge>
                    <Badge tone={s.status === "APPROVED" ? "good" : s.status === "REJECTED" ? "bad" : s.status === "APPLIED" ? "accent" : "neutral"}>{s.status.toLowerCase()}</Badge>
                    {s.url && <a href={s.url} target="_blank" rel="noreferrer noopener" className="truncate text-accent hover:underline">{s.url.replace(/^https?:\/\/[^/]+/, "") || "/"}</a>}
                    <span>· {s.provider}{s.model ? ` / ${s.model}` : ""} · {fmtRelative(s.createdAt)}</span>
                  </div>
                  {s.kind === "AEO_ANSWER" && inp.question && <h3 className="mt-1.5 text-sm font-semibold">{inp.question}</h3>}
                </div>
                {canWrite && s.status !== "APPLIED" && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {s.status !== "APPROVED" && <EditSuggestion id={s.id} kind={s.kind} title={out.title} metaDescription={out.metaDescription} text={out.answer} />}
                    {s.status !== "REJECTED" && s.status !== "APPROVED" && <ActionButton action={suggestionStatusAction} fields={{ id: s.id, status: "REJECTED" }} size="sm" variant="ghost"><X className="size-3.5" />Reject</ActionButton>}
                    {s.status !== "APPROVED" && <ActionButton action={suggestionStatusAction} fields={{ id: s.id, status: "APPROVED" }} size="sm"><Check className="size-3.5" />Approve</ActionButton>}
                    {s.status === "APPROVED" && s.kind === "METADATA" && (wp
                      ? <ActionButton action={proposeSuggestionAction} fields={{ id: s.id }} size="sm" variant="primary">Propose to live site</ActionButton>
                      : <span className="text-2xs text-fg-subtle">Connect WordPress to propose it, or copy it into your CMS</span>)}
                    {(s.status === "APPROVED" || s.status === "REJECTED") && <ActionButton action={suggestionStatusAction} fields={{ id: s.id, status: "SUGGESTED" }} size="sm" variant="ghost">Reopen</ActionButton>}
                  </div>
                )}
              </div>
              {s.kind === "METADATA" ? (
                <div className="mt-3 grid gap-3 text-[13px] md:grid-cols-2">
                  <div><div className="mb-1 text-xs font-semibold text-fg-muted">Current</div><p>{inp.currentTitle ?? <i className="text-fg-subtle">no title</i>}</p><p className="mt-1 text-fg-muted">{inp.currentMetaDescription ?? <i className="text-fg-subtle">no meta description</i>}</p></div>
                  <div><div className="mb-1 text-xs font-semibold text-fg-muted">Suggested</div><p>{out.title} <span className="text-2xs text-fg-subtle">({out.title?.length ?? 0})</span></p><p className="mt-1 text-fg-muted">{out.metaDescription} <span className="text-2xs text-fg-subtle">({out.metaDescription?.length ?? 0})</span></p>{out.rationale && <p className="mt-2 text-2xs text-fg-subtle">{out.rationale}</p>}</div>
                </div>
              ) : (
                <div className="mt-3 text-[13px]">
                  {out.heading && <div className="font-medium">{out.heading}</div>}
                  <p className="mt-1 whitespace-pre-line text-fg-muted">{out.answer}</p>
                  {!!out.gaps?.length && <p className="mt-2 text-2xs text-warn">Needs facts from you: {out.gaps.join("; ")}</p>}
                </div>
              )}
              {claims.length > 0 && <div className="mt-3 rounded-md bg-warn-soft px-3 py-2 text-xs"><b>Verify before approving:</b><ul className="mt-1 list-disc space-y-0.5 pl-4">{claims.map((c) => <li key={c}>{c}</li>)}</ul></div>}
            </Card>
          );
        })}
      </div>
    );
  }
}

function CheckList({ items }: { items: { label: string; pass: boolean; detail: string }[] }) {
  return (
    <ul className="divide-y divide-border">
      {items.map((c) => (
        <li key={c.label} className="flex items-start gap-2.5 px-4 py-2 text-[13px]">
          {c.pass ? <Check className="mt-0.5 size-3.5 shrink-0 text-good" aria-label="Pass" /> : <X className="mt-0.5 size-3.5 shrink-0 text-bad" aria-label="Fail" />}
          <div className="min-w-0"><div>{c.label}</div><div className="truncate text-2xs text-fg-subtle">{c.detail}</div></div>
        </li>
      ))}
    </ul>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return <div><div className="text-2xs text-fg-subtle">{label}</div><div className="text-lg font-semibold tabular">{value}</div>{sub && <div className="text-2xs text-fg-muted">{sub}</div>}</div>;
}

function AnalysisView({ a }: { a: ContentAnalysis }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={a.title ?? (a.url ? a.url : "Pasted draft")} description={a.url ?? undefined} actions={<SourceTag kind="internal" source="content checks" />} />
        <CardBody className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Words" value={fmtInt(a.wordCount)} sub={`${a.paragraphs} paragraphs`} />
          <Stat label="Readability" value={a.readability ?? "–"} sub={`${a.readabilityLabel} · estimate`} />
          <Stat label="Headings" value={a.headings.length} sub={`${a.questionHeadings} phrased as questions`} />
          <Stat label="Links" value={`${a.internalLinks} / ${a.externalLinks}`} sub="internal / external" />
        </CardBody>
      </Card>
      {a.duplicates.length > 0 && <Notice tone="warn" title="Similar content already on your site">{a.duplicates.map((d) => <div key={d.url}><a href={d.url} className="text-accent hover:underline" target="_blank" rel="noreferrer noopener">{d.url}</a> {d.exact ? "(identical text)" : `(near-duplicate, distance ${d.distance})`}</div>)}</Notice>}
      <div className="grid gap-4 md:grid-cols-2">
        <Card><CardHeader title="Content checks" /><CheckList items={a.checks} /></Card>
        {a.keyword ? <Card><CardHeader title={`Keyword: “${a.keyword}”`} /><CheckList items={a.keywordChecks} /></Card> : <Card><CardHeader title="Most used terms" /><CardBody><TermList terms={a.terms} /></CardBody></Card>}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card><CardHeader title="Heading outline" /><CardBody>{a.headings.length ? <ol className="space-y-0.5 text-[13px]">{a.headings.map((h, i) => <li key={i} style={{ paddingLeft: (h.level - 1) * 14 }}><span className="mr-1.5 text-2xs text-fg-subtle">H{h.level}</span>{h.text}</li>)}</ol> : <p className="text-[13px] text-fg-muted">No headings found.</p>}</CardBody></Card>
        {a.keyword && <Card><CardHeader title="Most used terms" /><CardBody><TermList terms={a.terms} /></CardBody></Card>}
      </div>
    </div>
  );
}

function TermList({ terms }: { terms: { term: string; count: number; per1k: number }[] }) {
  if (!terms.length) return <p className="text-[13px] text-fg-muted">Not enough text.</p>;
  return <div className="flex flex-wrap gap-1">{terms.slice(0, 30).map((t) => <Badge key={t.term} title={`${t.count} uses, ${t.per1k} per 1,000 words`}>{t.term} <span className="ml-1 text-fg-subtle">{t.count}</span></Badge>)}</div>;
}

function ComparisonView({ c }: { c: ContentComparison }) {
  const rows: [string, React.ReactNode, React.ReactNode][] = [
    ["Words", fmtInt(c.own.wordCount), fmtInt(c.competitor.wordCount)],
    ["Subheadings (H2–H6)", c.own.headings.filter((h) => h.level > 1).length, c.competitor.headings.filter((h) => h.level > 1).length],
    ["Question headings", c.own.questionHeadings, c.competitor.questionHeadings],
    ["Readability (Flesch, estimate)", c.own.readability ?? "–", c.competitor.readability ?? "–"],
    ["Images", c.own.images, c.competitor.images],
    ["Structured data", c.own.schemaTypes.join(", ") || "none", c.competitor.schemaTypes.join(", ") || "none"],
    ["Title", c.own.title ?? "–", c.competitor.title ?? "–"],
  ];
  return (
    <div className="space-y-4">
      <Card><CardHeader title="Summary" actions={<SourceTag kind="internal" source="fetched pages" />} /><CardBody><ul className="list-disc space-y-1 pl-4 text-[13px]">{c.summary.map((s) => <li key={s}>{s}</li>)}</ul></CardBody></Card>
      <Card>
        <Table>
          <THead><tr><TH>Metric</TH><TH><a href={c.own.url!} className="hover:underline" target="_blank" rel="noreferrer noopener">Your page</a></TH><TH><a href={c.competitor.url!} className="hover:underline" target="_blank" rel="noreferrer noopener">{new URL(c.competitor.url!).hostname}</a></TH></tr></THead>
          <tbody>{rows.map(([k, a, b]) => <TR key={k}><TD className="text-fg-muted">{k}</TD><TD>{a}</TD><TD>{b}</TD></TR>)}</tbody>
        </Table>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card><CardHeader title="Topics the competitor covers" description="Their H2/H3s with little overlap with your headings" /><CardBody>{c.missingTopics.length ? <ul className="list-disc space-y-0.5 pl-4 text-[13px]">{c.missingTopics.map((t) => <li key={t}>{t}</li>)}</ul> : <p className="text-[13px] text-good">No uncovered topics found.</p>}</CardBody></Card>
        <Card><CardHeader title="Frequent terms you don't use" /><CardBody>{c.missingTerms.length ? <div className="flex flex-wrap gap-1">{c.missingTerms.map((t) => <Badge key={t.term}>{t.term}</Badge>)}</div> : <p className="text-[13px] text-good">No notable term gaps.</p>}<p className="mt-3 text-2xs text-fg-subtle">Use terms where they genuinely help readers; don&apos;t stuff them in.</p></CardBody></Card>
      </div>
    </div>
  );
}

function BriefView({ brief, meta }: { brief: ContentBrief; meta: { provider: string; model: string | null; created: Date; sources: string[] } }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Content brief" description={`Drafted by ${meta.provider}${meta.model ? ` / ${meta.model}` : ""} ${fmtRelative(meta.created)} · grounded in ${meta.sources.join(", ") || "no external data"}`} actions={<SourceTag kind="estimate" source="AI draft, needs review" />} />
        <CardBody className="space-y-3 text-[13px]">
          <div><div className="text-xs font-semibold">Search intent</div><p className="text-fg-muted">{brief.searchIntent}</p></div>
          <div><div className="text-xs font-semibold">Title options</div><ul className="list-disc pl-4">{brief.titleOptions?.map((t) => <li key={t}>{t} <span className="text-2xs text-fg-subtle">({t.length})</span></li>)}</ul></div>
          <div><div className="text-xs font-semibold">Meta description</div><p className="text-fg-muted">{brief.metaDescription} <span className="text-2xs text-fg-subtle">({brief.metaDescription?.length ?? 0})</span></p></div>
          <div><div className="text-xs font-semibold">Length</div><p className="text-fg-muted">{brief.wordCountGuidance}</p></div>
        </CardBody>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card><CardHeader title="Outline" /><CardBody><ol className="space-y-1.5 text-[13px]">{brief.outline.map((o, i) => <li key={i} style={{ paddingLeft: o.level === 3 ? 16 : 0 }}><span className="mr-1.5 text-2xs text-fg-subtle">H{o.level}</span>{o.text}{o.notes && <div className="text-2xs text-fg-subtle">{o.notes}</div>}</li>)}</ol></CardBody></Card>
        <div className="space-y-4">
          <Card><CardHeader title="FAQs" /><CardBody>{brief.faqs?.length ? <ul className="space-y-2 text-[13px]">{brief.faqs.map((f) => <li key={f.question}><div className="font-medium">{f.question}</div><div className="text-2xs text-fg-muted">{f.answerGuidance}</div></li>)}</ul> : <p className="text-[13px] text-fg-muted">None</p>}</CardBody></Card>
          <Card><CardHeader title="Internal links (from your crawled pages)" /><CardBody>{brief.internalLinks?.length ? <ul className="space-y-1 text-[13px]">{brief.internalLinks.map((l) => <li key={l.url}><span className="font-medium">{l.anchor}</span> → <a className="text-accent hover:underline" href={l.url} target="_blank" rel="noreferrer noopener">{l.url.replace(/^https?:\/\/[^/]+/, "") || "/"}</a></li>)}</ul> : <p className="text-[13px] text-fg-muted">None suggested.</p>}</CardBody></Card>
        </div>
      </div>
      {!!brief.entities?.length && <Card><CardHeader title="Entities & concepts to cover" /><CardBody><div className="flex flex-wrap gap-1">{brief.entities.map((e) => <Badge key={e}>{e}</Badge>)}</div></CardBody></Card>}
      {!!brief.claimsToVerify?.length && <Notice tone="warn" title="Claims the writer must verify"><ul className="mt-1 list-disc pl-4 text-xs">{brief.claimsToVerify.map((c) => <li key={c}>{c}</li>)}</ul></Notice>}
    </div>
  );
}

export const dynamic = "force-dynamic";

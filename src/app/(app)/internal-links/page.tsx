import Link from "next/link";
import { Check, Network, X } from "lucide-react";
import { requireStaffContext } from "@/lib/auth/context";
import { liveConnectorType } from "@/server/site-changes";
import { resolveSite, SitePicker } from "@/components/data/site-picker";
import { PageHeader, EmptyState, Notice } from "@/components/ui/page";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tabs";
import { Badge, jobTone } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { MetricTile, SourceTag } from "@/components/ui/metric";
import { Table, THead, TH, TR, TD } from "@/components/ui/table";
import { ActionButton } from "@/components/ui/action-form";
import { BarList } from "@/components/charts/bars";
import { JobProgress } from "@/components/jobs/job-progress";
import { fmtInt, fmtRelative } from "@/lib/format";
import { linkGraphStats } from "@/server/internal-links";
import { runLinkAnalysisAction, linkStatusAction, proposeLinkAction } from "./actions";

export const metadata = { title: "Internal Linking" };

const path = (u: string) => u.replace(/^https?:\/\/[^/]+/, "") || "/";

export default async function InternalLinksPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireStaffContext();
  const { sites, site } = await resolveSite(ctx, sp.websiteId);
  const header = <PageHeader title="Internal Linking" description="Contextual link suggestions from your own content, orphan pages and link depth. Links are added only after review and approval." actions={<SitePicker sites={sites} current={site?.id} preserve={{ tab: sp.tab }} />} />;
  if (!site) return <>{header}<Card><EmptyState title="Add a website first" action={<ButtonLink href="/websites">Websites</ButtonLink>} /></Card></>;
  const tab = sp.tab === "graph" ? "graph" : "suggestions";
  const canWrite = ctx.can("content:write");
  const [stats, job, counts, wp] = await Promise.all([
    linkGraphStats(site.id),
    ctx.db.job.findFirst({ where: { websiteId: site.id, type: "internal-links" }, orderBy: { queuedAt: "desc" } }),
    ctx.db.internalLinkSuggestion.groupBy({ by: ["status"], where: { websiteId: site.id }, _count: true }),
    liveConnectorType(ctx.org.id, site),
  ]);
  if (!stats) return <>{header}<Card><EmptyState icon={<Network className="size-5" />} title="Crawl the site first" description="Internal link analysis reads the link graph and paragraph text from the latest crawl." action={<ButtonLink href={`/audits?websiteId=${site.id}`}>Go to audits</ButtonLink>} /></Card></>;
  const count = (s: string) => counts.find((c) => c.status === s)?._count ?? 0;
  const active = job && ["QUEUED", "RUNNING"].includes(job.status);
  const href = (t: string, extra = "") => `/internal-links?websiteId=${site.id}&tab=${t}${extra}`;

  return (
    <>
      {header}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile label="Indexable pages" value={fmtInt(stats.total)} provenance="measured" source="latest crawl" updatedAt={stats.finishedAt ?? undefined} />
        <MetricTile label="Orphan pages" value={fmtInt(stats.orphans.length)} provenance="measured" source="no internal links found" />
        <MetricTile label="Deeper than 3 clicks" value={fmtInt(stats.deep)} provenance="measured" source="from the homepage" />
        <Card className="flex flex-col justify-center gap-2 p-3.5">
          {active ? <JobProgress jobId={job.id} initial={job} compact /> : (
            <>
              {canWrite && <ActionButton action={runLinkAnalysisAction} fields={{ websiteId: site.id }} size="sm" variant="primary">Find link opportunities</ActionButton>}
              <div className="text-2xs text-fg-subtle">{job ? <>Last run {fmtRelative(job.queuedAt)} · <Badge tone={jobTone(job.status)}>{job.status.toLowerCase()}</Badge>{job.error && <span className="text-bad"> {job.error}</span>}</> : "Not run yet"}</div>
            </>
          )}
        </Card>
      </div>
      <TabNav active={tab} tabs={[{ key: "suggestions", label: "Suggestions", count: count("SUGGESTED") + count("APPROVED") }, { key: "graph", label: "Link graph" }].map((t) => ({ ...t, href: href(t.key) }))} />
      {tab === "suggestions" ? <Suggestions /> : <Graph />}
    </>
  );

  async function Suggestions() {
    const view = ["SUGGESTED", "APPROVED", "APPLIED", "REJECTED"].includes(sp.status ?? "") ? sp.status! : "SUGGESTED";
    const rows = await ctx.db.internalLinkSuggestion.findMany({ where: { websiteId: site!.id, status: view as never }, orderBy: { score: "desc" }, take: 200 });
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1 text-xs">
          {[["SUGGESTED", "To review"], ["APPROVED", "Accepted"], ["APPLIED", "Applied"], ["REJECTED", "Rejected"]].map(([k, l]) => (
            <Link key={k} href={href("suggestions", `&status=${k}`)} className={`rounded-md px-2.5 py-1 ${view === k ? "bg-surface-2 font-medium" : "text-fg-muted"}`}>{l} <span className="text-fg-subtle">{count(k)}</span></Link>
          ))}
        </div>
        {view === "APPROVED" && !wp && <Notice tone="info">Add accepted links in your CMS. The next crawl and link analysis will detect them and mark them applied. Or create a change pack (Automation → Change packs), or connect WordPress, a File host (SFTP/FTPS) or GitHub in <Link href="/integrations" className="text-accent hover:underline">Integrations</Link> to propose changes directly, with approval, backup and rollback.</Notice>}
        {!rows.length ? <Card><EmptyState title={view === "SUGGESTED" ? "No suggestions to review" : "Nothing here"} description={view === "SUGGESTED" ? "Run “Find link opportunities”. Suggestions come from paragraphs on your pages that mention another page's tracked keyword, Search Console queries, H1 or title, and that don't already link to it." : undefined} /></Card> : (
          <Card>
            <Table>
              <THead><tr><TH>Source page → target page</TH><TH>Context</TH><TH align="right">Score</TH>{canWrite && <TH align="right"><span className="sr-only">Actions</span></TH>}</tr></THead>
              <tbody>
                {rows.map((s) => {
                  const i = s.sourceParagraph.toLowerCase().indexOf(s.anchor.toLowerCase());
                  const ctxText = i >= 0
                    ? <>{i > 120 ? "…" : ""}{s.sourceParagraph.slice(Math.max(0, i - 120), i)}<mark className="rounded bg-accent-soft px-0.5 text-fg">{s.sourceParagraph.slice(i, i + s.anchor.length)}</mark>{s.sourceParagraph.slice(i + s.anchor.length, i + s.anchor.length + 120)}…</>
                    : s.sourceParagraph.slice(0, 240);
                  return (
                    <TR key={s.id}>
                      <TD className="max-w-64 align-top">
                        <a href={s.sourceUrl} target="_blank" rel="noreferrer noopener" className="block truncate text-accent hover:underline">{path(s.sourceUrl)}</a>
                        <div className="truncate text-2xs text-fg-muted">→ <a href={s.targetUrl} target="_blank" rel="noreferrer noopener" className="hover:underline">{path(s.targetUrl)}</a></div>
                      </TD>
                      <TD className="max-w-xl align-top text-xs"><p className="text-fg-muted">{ctxText}</p><p className="mt-1 text-2xs text-fg-subtle">{s.rationale}</p></TD>
                      <TD align="right" className="align-top tabular">{s.score}</TD>
                      {canWrite && (
                        <TD align="right" className="align-top">
                          <div className="flex justify-end gap-1">
                            {s.status === "SUGGESTED" && <>
                              <ActionButton action={linkStatusAction} fields={{ id: s.id, status: "REJECTED" }} size="sm" variant="ghost" aria-label="Reject"><X className="size-3.5" /></ActionButton>
                              <ActionButton action={linkStatusAction} fields={{ id: s.id, status: "APPROVED" }} size="sm"><Check className="size-3.5" />Accept</ActionButton>
                            </>}
                            {s.status === "APPROVED" && (s.changeId
                              ? <Link href="/automation?tab=changes" className="text-xs text-accent hover:underline">Awaiting approval</Link>
                              : <>
                                {wp && <ActionButton action={proposeLinkAction} fields={{ id: s.id }} size="sm" variant="primary">Propose to site</ActionButton>}
                                <ActionButton action={linkStatusAction} fields={{ id: s.id, status: "SUGGESTED" }} size="sm" variant="ghost">Undo</ActionButton>
                              </>)}
                            {s.status === "REJECTED" && <ActionButton action={linkStatusAction} fields={{ id: s.id, status: "SUGGESTED" }} size="sm" variant="ghost">Reopen</ActionButton>}
                          </div>
                        </TD>
                      )}
                    </TR>
                  );
                })}
              </tbody>
            </Table>
          </Card>
        )}
        <p className="text-2xs text-fg-subtle">Score combines how well the phrase matches the target (keyword &gt; query &gt; H1 &gt; title), how few links the target has, and the source page&apos;s own internal links. It is an internal prioritisation score, not a ranking prediction.</p>
      </div>
    );
  }

  function Graph() {
    const s = stats!;
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader title="Pages by internal links received" actions={<SourceTag kind="measured" source="latest crawl" />} /><CardBody><BarList items={s.buckets} /></CardBody></Card>
        <Card><CardHeader title="Most linked pages" /><CardBody><BarList items={s.top.map((p) => ({ label: path(p.url), value: p.inlinks }))} /></CardBody></Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Pages that need more internal links" description="Fewest internal links first; orphan pages are reachable only via sitemap or external links." />
          <Table>
            <THead><tr><TH>Page</TH><TH align="right">Internal links in</TH><TH align="right">Click depth</TH><TH>In sitemap</TH></tr></THead>
            <tbody>{[...s.orphans, ...s.weak.filter((w) => !s.orphans.some((o) => o.url === w.url))].slice(0, 25).map((p) => (
              <TR key={p.url}><TD className="max-w-md"><a href={p.url} target="_blank" rel="noreferrer noopener" className="block truncate hover:underline">{p.title ?? path(p.url)}</a><div className="truncate text-2xs text-fg-subtle">{path(p.url)}</div></TD><TD align="right" className="tabular">{p.inlinks === 0 ? <Badge tone="warn">orphan</Badge> : p.inlinks}</TD><TD align="right" className="tabular">{p.depth}</TD><TD>{p.inSitemap ? "yes" : "no"}</TD></TR>
            ))}</tbody>
          </Table>
        </Card>
      </div>
    );
  }
}

export const dynamic = "force-dynamic";

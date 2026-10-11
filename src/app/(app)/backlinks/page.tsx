import Link from "next/link";
import { Download, Link2, RefreshCw, ShieldCheck, Search } from "lucide-react";
import { requireOrgContext } from "@/lib/auth/context";
import { backlinkStats, listBacklinks } from "@/server/backlinks";
import { outreachReport, STAGES } from "@/server/outreach";
import { resolveSite, SitePicker } from "@/components/data/site-picker";
import { PageHeader, EmptyState, Notice } from "@/components/ui/page";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { MetricTile, SourceTag } from "@/components/ui/metric";
import { Table, THead, TH, TR, TD, Pagination, makeHref } from "@/components/ui/table";
import { FilterBar } from "@/components/data/filter-bar";
import { GainLossChart } from "@/components/charts/charts";
import { BarList, SegmentBar } from "@/components/charts/bars";
import { fmtDate, fmtInt, fmtRelative } from "@/lib/format";
import { ActionButton } from "@/components/ui/action-form";
import { queueAction, reviewDisavowAction } from "./actions";
import { AddBacklink, AddProspect, CampaignForm, DisavowForm, DraftForCampaign, DraftList, ImportBacklinks, ReplyForm, StageSelect, TemplateForm } from "./forms";

export const metadata = { title: "Backlink Intelligence" };

const statusTone = (s: string) => ({ ACTIVE: "good", LOST: "bad", BROKEN: "bad", REDIRECTED: "warn", UNVERIFIED: "neutral" } as const)[s as "ACTIVE"] ?? "neutral";
const TYPE_LABEL: Record<string, string> = { INDUSTRY_PUBLICATION: "Publication", RESOURCE_PAGE: "Resource page", ASSOCIATION: "Association", DIRECTORY: "Directory", PARTNER_SUPPLIER: "Partner/supplier", EDITORIAL_MENTION: "Editorial", UNLINKED_MENTION: "Unlinked mention", BROKEN_LINK: "Broken link", GUEST_CONTRIBUTION: "Contribution", COMPETITOR_GAP: "Competitor gap", PODCAST_INTERVIEW: "Podcast/interview", OTHER: "Other" };

export default async function BacklinksPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireOrgContext();
  const { sites, site } = await resolveSite(ctx, sp.websiteId);
  const header = (
    <PageHeader title="Backlink Intelligence" description="Backlink inventory, verification, link-gap discovery and an outreach CRM for sustainable link acquisition. No placements, rankings or authority gains are guaranteed."
      actions={<SitePicker sites={sites} current={site?.id} preserve={{ tab: sp.tab }} />} />
  );
  if (!site) return <>{header}<Card><EmptyState title="Add a website first" action={<ButtonLink href="/websites">Websites</ButtonLink>} /></Card></>;
  const tabs = ["overview", "links", "domains", "pipeline", "outreach", "disavow"];
  const tab = tabs.includes(sp.tab ?? "") ? sp.tab! : "overview";
  const canWrite = ctx.can("backlinks:write");
  const dfs = await ctx.db.integrationConnection.findFirst({ where: { provider: "DATAFORSEO", websiteId: null, status: "CONNECTED" } });
  const q = (t: string) => `/backlinks?websiteId=${site.id}&tab=${t}`;

  return (
    <>
      {header}
      <TabNav active={tab} tabs={[{ key: "overview", label: "Overview" }, { key: "links", label: "Backlinks" }, { key: "domains", label: "Referring domains" }, { key: "pipeline", label: "Opportunity pipeline" }, { key: "outreach", label: "Outreach" }, { key: "disavow", label: "Disavow" }].map((t) => ({ ...t, href: q(t.key) }))} />
      {tab === "overview" && <Overview />}
      {tab === "links" && <Links />}
      {tab === "domains" && <Domains />}
      {tab === "pipeline" && <Pipeline />}
      {tab === "outreach" && <Outreach />}
      {tab === "disavow" && <Disavow />}
    </>
  );

  async function Toolbar() {
    if (!canWrite) return null;
    return (
      <div className="mb-5 flex flex-wrap gap-2">
        <ImportBacklinks websiteId={site!.id} />
        <AddBacklink websiteId={site!.id} baseUrl={site!.baseUrl} />
        <ActionButton action={queueAction} fields={{ websiteId: site!.id, type: "backlink-verify" }}><ShieldCheck className="size-3.5" />Verify links now</ActionButton>
        {dfs ? <ActionButton action={queueAction} fields={{ websiteId: site!.id, type: "backlink-sync" }}><RefreshCw className="size-3.5" />Sync from DataForSEO</ActionButton>
          : <ButtonLink href="/integrations" variant="ghost">Connect DataForSEO for automatic discovery</ButtonLink>}
        <ButtonLink href={`/api/export/backlinks?websiteId=${site!.id}`} prefetch={false} variant="ghost"><Download className="size-3.5" />CSV</ButtonLink>
      </div>
    );
  }

  async function Overview() {
    const s = await backlinkStats(ctx, site!.id);
    const total = Object.values(s.byStatus).reduce((a, b) => a + b, 0);
    if (!total) return (<><Toolbar /><Card><EmptyState icon={<Link2 className="size-5" />} title="No backlinks tracked yet" description="Import a backlink export (Search Console → Links, or any SEO tool), add links manually, or connect DataForSEO to discover them. We then verify each link on the live page." /></Card></>);
    const gained90 = s.velocity.reduce((a, v) => a + v.gained, 0);
    const lost90 = Math.abs(s.velocity.reduce((a, v) => a + v.lost, 0));
    return (
      <>
        <Toolbar />
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricTile label="Live backlinks" value={fmtInt((s.byStatus.ACTIVE ?? 0) + (s.byStatus.UNVERIFIED ?? 0))} provenance="estimate" source={`${fmtInt(s.byStatus.ACTIVE ?? 0)} verified by us`} />
          <MetricTile label="Referring domains" value={fmtInt(s.totalDomains)} provenance="estimate" source={s.lastSync ? `synced ${fmtRelative(s.lastSync)}` : "imported/manual"} />
          <MetricTile label="New links (90d)" value={`+${fmtInt(gained90)}`} provenance="estimate" source="first-seen dates" />
          <MetricTile label="Lost links (90d)" value={`−${fmtInt(lost90)}`} provenance="measured" source="provider + our verification" />
        </div>
        <div className="mb-5 grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card><CardHeader title="Link velocity (weekly)" description="New vs lost backlinks over the last 13 weeks." /><CardBody><GainLossChart data={s.velocity} height={200} /></CardBody></Card>
          <Card>
            <CardHeader title="Link status" actions={<SourceTag kind="measured" source="our verification" />} />
            <CardBody className="space-y-4">
              <SegmentBar segments={["ACTIVE", "UNVERIFIED", "REDIRECTED", "BROKEN", "LOST"].map((k, i) => ({ label: k.toLowerCase(), value: s.byStatus[k] ?? 0, color: ["var(--good)", "var(--chart-muted)", "var(--warn)", "var(--chart-5)", "var(--bad)"][i] }))} />
              <div><div className="mb-1.5 text-xs text-fg-muted">Follow vs nofollow</div><SegmentBar segments={s.byRel.map((r, i) => ({ label: r.label, value: r.value, color: `var(--chart-${i + 1})` }))} /></div>
            </CardBody>
          </Card>
        </div>
        <div className="grid gap-5 lg:grid-cols-3">
          <Card><CardHeader title="Anchor text distribution" description="Heavy exact-match concentration can look unnatural." /><CardBody><BarList items={s.anchors.map((a) => ({ label: a.label.slice(0, 60), value: a.value }))} /></CardBody></Card>
          <Card><CardHeader title="Most linked pages" /><CardBody><BarList items={s.targets.map((t) => ({ label: t.label.replace(/^https?:\/\/[^/]+/, "") || "/", value: t.value }))} /></CardBody></Card>
          <Card><CardHeader title="Top referring domains" actions={<SourceTag kind="estimate" source={s.domains.some((d) => d.providerRank != null) ? "DataForSEO rank" : "link counts"} />} /><CardBody><BarList items={s.domains.slice(0, 10).map((d) => ({ label: d.domain, value: d.providerRank ?? d.backlinks, hint: d.providerRank != null ? "rank" : "links" }))} /><p className="mt-2 text-2xs text-fg-subtle">Domain rank is a third-party indicator (0–1000), not a Google ranking factor.</p></CardBody></Card>
        </div>
      </>
    );
  }

  async function Links() {
    const data = await listBacklinks(ctx, { ...sp, websiteId: site!.id });
    const href = makeHref("/backlinks", { ...sp, tab: "links", websiteId: site!.id });
    return (
      <>
        <Toolbar />
        <Card>
          <FilterBar q={sp.q} qPlaceholder="Search source, target or anchor" values={sp} preserve={{ tab: "links", websiteId: site!.id }} filters={[
            { name: "status", label: "Status", options: ["ACTIVE", "UNVERIFIED", "REDIRECTED", "BROKEN", "LOST"].map((s) => ({ value: s, label: s.toLowerCase() })) },
            { name: "rel", label: "Rel", options: ["follow", "nofollow", "ugc", "sponsored"].map((s) => ({ value: s, label: s })) },
          ]} />
          {data.rows.length === 0 ? <EmptyState title="No backlinks match" /> : (
            <>
              <Table>
                <THead><tr><TH>Linking page</TH><TH>Anchor → target</TH><TH>Rel</TH><TH>Status</TH><TH align="right">Rank</TH><TH>First seen</TH><TH>Verified</TH></tr></THead>
                <tbody>
                  {data.rows.map((b) => (
                    <TR key={b.id}>
                      <TD className="max-w-xs"><a href={b.sourceUrl} target="_blank" rel="noreferrer noopener" className="block truncate font-medium hover:underline">{b.sourceDomain}</a><div className="truncate text-2xs text-fg-subtle">{b.sourceUrl.replace(/^https?:\/\/[^/]+/, "")}</div></TD>
                      <TD className="max-w-xs"><div className="truncate text-xs">“{b.anchor || "—"}”</div><div className="truncate text-2xs text-fg-subtle">→ {b.targetUrl.replace(/^https?:\/\/[^/]+/, "") || "/"}</div></TD>
                      <TD><Badge tone={b.rel === "follow" ? "info" : "neutral"}>{b.rel}</Badge></TD>
                      <TD><Badge tone={statusTone(b.status)}>{b.status.toLowerCase()}</Badge>{b.verifyNote && <div className="mt-0.5 max-w-[220px] truncate text-2xs text-fg-subtle" title={b.verifyNote}>{b.verifyNote}</div>}</TD>
                      <TD align="right" className="text-xs">{b.providerRank ?? "—"}</TD>
                      <TD className="text-xs text-fg-muted">{fmtDate(b.firstSeenAt)}<div className="text-2xs">{b.source}</div></TD>
                      <TD className="text-xs text-fg-muted">{fmtRelative(b.lastVerifiedAt)}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
              <Pagination page={data.filter.page} pages={data.pages} total={data.total} pageSize={50} href={href} />
            </>
          )}
        </Card>
      </>
    );
  }

  async function Domains() {
    const page = Math.max(1, Number(sp.page ?? 1));
    const [total, rows] = await Promise.all([ctx.db.referringDomain.count({ where: { websiteId: site!.id } }), ctx.db.referringDomain.findMany({ where: { websiteId: site!.id }, orderBy: [{ lostAt: { sort: "asc", nulls: "first" } }, { providerRank: { sort: "desc", nulls: "last" } }, { backlinks: "desc" }], skip: (page - 1) * 50, take: 50 })]);
    return (
      <Card>
        <CardHeader title={`Referring domains (${fmtInt(total)})`} description="Quality indicators come from the backlink provider and are estimates, not Google signals." />
        {rows.length === 0 ? <EmptyState title="No referring domains yet" /> : (
          <>
            <Table>
              <THead><tr><TH>Domain</TH><TH align="right">Live links</TH><TH align="right">Provider rank</TH><TH>First seen</TH><TH>Status</TH></tr></THead>
              <tbody>{rows.map((d) => (
                <TR key={d.id}>
                  <TD className="font-medium">{d.domain}</TD><TD align="right">{d.backlinks}</TD><TD align="right">{d.providerRank ?? "—"}</TD>
                  <TD className="text-xs text-fg-muted">{fmtDate(d.firstSeenAt)}</TD>
                  <TD>{d.lostAt ? <Badge tone="bad">lost {fmtDate(d.lostAt)}</Badge> : <Badge tone="good">live</Badge>}</TD>
                </TR>
              ))}</tbody>
            </Table>
            <Pagination page={page} pages={Math.max(1, Math.ceil(total / 50))} total={total} pageSize={50} href={makeHref("/backlinks", { ...sp, tab: "domains", websiteId: site!.id })} />
          </>
        )}
      </Card>
    );
  }

  async function Pipeline() {
    const prospects = await ctx.db.outreachProspect.findMany({ where: { websiteId: site!.id }, orderBy: [{ relevanceScore: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }] });
    const competitors = await ctx.db.competitor.count({ where: { websiteId: site!.id } });
    const cols = STAGES.filter((s) => s !== "REJECTED");
    return (
      <>
        {canWrite && (
          <div className="mb-4 flex flex-wrap gap-2">
            <AddProspect websiteId={site!.id} baseUrl={site!.baseUrl} />
            {dfs && competitors > 0 && <ActionButton action={queueAction} fields={{ websiteId: site!.id, type: "link-gap" }}><Search className="size-3.5" />Find competitor link gaps</ActionButton>}
            {dfs && site!.brandTerms.length > 0 && <ActionButton action={queueAction} fields={{ websiteId: site!.id, type: "unlinked-mentions" }}><Search className="size-3.5" />Find unlinked brand mentions</ActionButton>}
            {!dfs && <span className="self-center text-xs text-fg-subtle">Connect DataForSEO for link-gap and brand-mention discovery. Manual prospects work without it.</span>}
            {dfs && !competitors && <Link href={`/competitors?websiteId=${site!.id}`} className="self-center text-xs text-accent hover:underline">Add competitors to enable link-gap discovery</Link>}
          </div>
        )}
        {prospects.length === 0 ? <Card><EmptyState title="No opportunities yet" description="Add prospect pages (resource pages, publications, associations, partners, podcasts…) or run discovery. Each is researched for relevance, broken links and public contacts." /></Card> : (
          <div className="scroll-thin -mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
            {cols.map((stage) => {
              const items = prospects.filter((p) => p.stage === stage);
              return (
                <div key={stage} className="w-72 shrink-0">
                  <div className="mb-2 flex items-center justify-between px-1 text-xs font-semibold uppercase tracking-wider text-fg-subtle"><span>{stage.toLowerCase()}</span><span className="tabular">{items.length}</span></div>
                  <div className="space-y-2">
                    {items.map((p) => (
                      <Card key={p.id} className="p-3">
                        <div className="flex items-start justify-between gap-2">
                          <a href={p.url} target="_blank" rel="noreferrer noopener" className="min-w-0 truncate text-[13px] font-medium hover:underline">{p.domain}</a>
                          {p.relevanceScore != null && <span className="shrink-0 rounded bg-accent-soft px-1.5 text-2xs font-semibold tabular text-accent" title="Relevance (internal score)">{Math.round(p.relevanceScore)}</span>}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1"><Badge>{TYPE_LABEL[p.type]}</Badge>{p.contactEmail ? <Badge tone="good">contact</Badge> : <Badge tone="warn">no contact</Badge>}</div>
                        {p.relevanceReason && <p className="mt-1.5 line-clamp-3 text-2xs text-fg-muted">{p.relevanceReason}</p>}
                        {p.nextFollowUpAt && <p className="mt-1 text-2xs text-warn">Follow up {fmtRelative(p.nextFollowUpAt)}</p>}
                        {p.acquiredLinkUrl && <p className="mt-1 truncate text-2xs text-fg-subtle">Link: {p.acquiredLinkUrl}</p>}
                        {canWrite && <div className="mt-2 flex flex-wrap items-center gap-1"><StageSelect id={p.id} stage={p.stage} />{["CONTACTED", "NEGOTIATING"].includes(p.stage) && <ReplyForm id={p.id} />}</div>}
                      </Card>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </>
    );
  }

  async function Outreach() {
    const [templates, campaigns, report] = await Promise.all([
      ctx.db.outreachTemplate.findMany({ orderBy: { createdAt: "asc" } }),
      ctx.db.outreachCampaign.findMany({ where: { websiteId: site!.id }, orderBy: { createdAt: "desc" } }),
      outreachReport(ctx, site!.id),
    ]);
    const prospects = await ctx.db.outreachProspect.findMany({ where: { websiteId: site!.id, stage: { in: ["DISCOVERED", "QUALIFIED", "CONTACTED"] } }, select: { id: true, domain: true, contactEmail: true, stage: true } });
    const messages = await ctx.db.outreachMessage.findMany({ where: { direction: "OUTBOUND", prospect: { websiteId: site!.id } }, orderBy: { createdAt: "desc" }, take: 100, include: { prospect: { select: { domain: true, contactEmail: true, campaignId: true } } } });
    return (
      <div className="space-y-5">
        <Notice tone="info" title="Responsible outreach">Every send needs approval from someone other than the requester, sending is capped per day, and contacts come only from publicly listed addresses or what you enter. Bulk link schemes, comment spam and paid-link networks aren&apos;t supported.</Notice>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricTile label="Emails sent" value={fmtInt(report.sent)} provenance="measured" source="outreach log" />
          <MetricTile label="Replies logged" value={fmtInt(report.replies)} provenance="measured" source="outreach log" />
          <MetricTile label="Links acquired" value={fmtInt((report.byStage.ACQUIRED ?? 0) + (report.byStage.VERIFIED ?? 0))} provenance="internal" source="pipeline" />
          <MetricTile label="Verified live" value={fmtInt(report.byStage.VERIFIED ?? 0)} provenance="measured" source="link verification" />
        </div>
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="space-y-5">
            {canWrite && <Card><CardHeader title="New campaign" /><CardBody>{templates.length ? <CampaignForm websiteId={site!.id} templates={templates} /> : <p className="text-xs text-fg-muted">Create a template first →</p>}</CardBody></Card>}
            {campaigns.map((c) => {
              const drafts = messages.filter((m) => m.prospect.campaignId === c.id);
              return (
                <Card key={c.id}>
                  <CardHeader title={c.name} description={`Template: ${templates.find((t) => t.id === c.templateId)?.name ?? "—"} · follow up after ${c.followUpDays} days`} actions={<Badge tone="info">{c.status.toLowerCase()}</Badge>} />
                  <CardBody className="space-y-4">
                    {canWrite && <DraftForCampaign campaignId={c.id} prospects={prospects} />}
                    {drafts.length > 0 && <DraftList drafts={drafts.map((d) => ({ id: d.id, subject: d.subject, body: d.body, status: d.status, to: d.prospect.contactEmail, domain: d.prospect.domain }))} />}
                  </CardBody>
                </Card>
              );
            })}
          </div>
          <div className="space-y-5">
            {canWrite && <Card><CardHeader title="New template" /><CardBody><TemplateForm /></CardBody></Card>}
            {templates.map((t) => (
              <details key={t.id} className="rounded-[var(--radius-card)] border border-border bg-surface">
                <summary className="cursor-pointer px-4 py-2.5 text-[13px] font-medium">{t.name}</summary>
                <div className="border-t border-border p-4">{canWrite ? <TemplateForm initial={t} /> : <pre className="whitespace-pre-wrap text-xs">{t.body}</pre>}</div>
              </details>
            ))}
          </div>
        </div>
      </div>
    );
  }

  async function Disavow() {
    const entries = await ctx.db.disavowEntry.findMany({ where: { websiteId: site!.id }, orderBy: { createdAt: "desc" } });
    const canReview = ctx.can("approvals:decide");
    return (
      <div className="space-y-5">
        <Notice tone="warn" title="Use with caution">Google ignores most low-quality links on its own. Disavow only links you are confident are manipulative and may be harming the site. Entries are exported only after a reviewer explicitly includes them.</Notice>
        {canWrite && <Card><CardHeader title="Add an entry for review" /><CardBody><DisavowForm websiteId={site!.id} /></CardBody></Card>}
        <Card>
          <CardHeader title="Entries" actions={<ButtonLink href={`/api/export/disavow?websiteId=${site!.id}`} prefetch={false} size="sm"><Download className="size-3.5" />disavow.txt</ButtonLink>} />
          {entries.length === 0 ? <EmptyState title="No entries" /> : (
            <Table>
              <THead><tr><TH>Value</TH><TH>Reason</TH><TH>Review</TH>{canReview && <TH />}</tr></THead>
              <tbody>{entries.map((e) => (
                <TR key={e.id}>
                  <TD className="font-mono text-xs">{e.value}</TD><TD className="text-xs text-fg-muted">{e.reason}</TD>
                  <TD>{e.reviewedAt ? <Badge tone={e.included ? "bad" : "neutral"}>{e.included ? "included" : "excluded"} · {fmtDate(e.reviewedAt)}</Badge> : <Badge tone="warn">needs review</Badge>}</TD>
                  {canReview && <TD align="right"><div className="flex justify-end gap-1"><ActionButton action={reviewDisavowAction} fields={{ id: e.id, include: "1" }} size="sm">Include</ActionButton><ActionButton action={reviewDisavowAction} fields={{ id: e.id, include: "0" }} size="sm" variant="ghost">Exclude</ActionButton></div></TD>}
                </TR>
              ))}</tbody>
            </Table>
          )}
        </Card>
      </div>
    );
  }
}

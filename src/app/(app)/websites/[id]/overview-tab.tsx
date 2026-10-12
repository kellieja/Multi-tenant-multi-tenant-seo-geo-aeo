import Link from "next/link";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Notice } from "@/components/ui/page";
import { Badge, jobTone, connectionTone } from "@/components/ui/badge";
import { JOB_TYPES, type JobType } from "@/lib/jobs/types";
import { fmtInt, fmtPct, fmtRelative } from "@/lib/format";
import { SourceTag, type Provenance } from "@/components/ui/metric";
import type { TabProps } from "./tabs";

export async function OverviewTab({ ctx, site, sp }: TabProps) {
  const [jobs, connections] = await Promise.all([
    ctx.db.job.findMany({ where: { websiteId: site.id }, orderBy: { queuedAt: "desc" }, take: 8 }),
    ctx.db.integrationConnection.findMany({ where: { OR: [{ websiteId: site.id }, { websiteId: null }] }, select: { id: true, provider: true, status: true, websiteId: true, lastSyncAt: true } }),
  ]);
  const staff = ctx.role !== "CLIENT";
  const w = { websiteId: site.id };
  const [crawl, openFindings, keywords, backlinks, aeo, geo, linkSugs, contentSugs] = await Promise.all([
    ctx.db.crawl.findFirst({ where: { ...w, status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" }, select: { healthScore: true, finishedAt: true } }),
    ctx.db.auditFinding.count({ where: { ...w, status: { in: ["OPEN", "REGRESSED", "IN_PROGRESS"] } } }),
    ctx.db.keyword.count({ where: w }),
    ctx.db.backlink.count({ where: { ...w, status: "ACTIVE" } }),
    ctx.db.aeoAssessment.findMany({ where: w, orderBy: { assessedAt: "desc" }, distinct: ["url"], take: 200, select: { score: true } }),
    ctx.db.geoObservation.findMany({ where: { ...w, observedAt: { gte: new Date(Date.now() - 90 * 86400_000) } }, select: { brandMentioned: true }, take: 2000 }),
    ctx.db.internalLinkSuggestion.count({ where: { ...w, status: "SUGGESTED" } }),
    ctx.db.contentSuggestion.count({ where: { ...w, kind: { in: ["METADATA", "AEO_ANSWER"] }, status: { in: ["SUGGESTED", "EDITED"] } } }),
  ]);
  const modules: { label: string; href: string; value: string; kind: Provenance; source: string }[] = [
    { label: "SEO audit", href: `/audits?websiteId=${site.id}`, value: crawl?.healthScore != null ? `${fmtInt(crawl.healthScore)} health · ${fmtInt(openFindings)} open` : "No crawl yet", kind: "internal", source: crawl?.finishedAt ? `crawl ${fmtRelative(crawl.finishedAt)}` : "crawler" },
    { label: "Keywords & rankings", href: `/keywords?websiteId=${site.id}`, value: keywords ? `${fmtInt(keywords)} tracked` : "None tracked", kind: "measured", source: "rank tracker" },
    { label: "Backlinks", href: `/backlinks?websiteId=${site.id}`, value: backlinks ? `${fmtInt(backlinks)} active links` : "No data", kind: "estimate", source: "imports / provider" },
    { label: "AEO readiness", href: `/aeo?websiteId=${site.id}`, value: aeo.length ? `${fmtInt(aeo.reduce((a, b) => a + b.score, 0) / aeo.length)} avg · ${aeo.length} pages` : "Not assessed", kind: "internal", source: "AEO checks" },
    { label: "AI visibility", href: `/geo?websiteId=${site.id}`, value: geo.length ? `${fmtPct(geo.filter((g) => g.brandMentioned).length / geo.length, 0)} mention rate` : "No samples", kind: "sampled", source: `${geo.length} answers, 90 days` },
    ...(staff ? [
      { label: "Internal linking", href: `/internal-links?websiteId=${site.id}`, value: `${fmtInt(linkSugs)} to review`, kind: "internal" as const, source: "link analysis" },
      { label: "Content Studio", href: `/content?websiteId=${site.id}`, value: `${fmtInt(contentSugs)} to review`, kind: "internal" as const, source: "suggestions" },
      { label: "Technical SEO", href: `/technical?websiteId=${site.id}`, value: "Core Web Vitals & indexability", kind: "measured" as const, source: "PSI / crawler" },
    ] : []),
  ];
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {modules.map((m) => (
          <Link key={m.label} href={m.href} className="rounded-[var(--radius-card)] border border-border bg-surface px-3.5 py-3 transition-colors hover:border-border-strong hover:bg-surface-2">
            <div className="text-xs text-fg-muted">{m.label}</div>
            <div className="mt-1 truncate text-[15px] font-semibold">{m.value}</div>
            <SourceTag kind={m.kind} source={m.source} className="mt-1" />
          </Link>
        ))}
      </div>
      {sp.new && (
        <Notice tone="good" title="Website added">
          Next: run a first crawl to get real audit findings, then connect Search Console in <Link className="text-accent hover:underline" href="/integrations">Integrations</Link> for clicks and impressions.
        </Notice>
      )}
      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader title="Recent background jobs" />
          <CardBody className="p-0">
            {jobs.length === 0 ? (
              <p className="px-4 py-6 text-[13px] text-fg-muted">No jobs have run for this website yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {jobs.map((j) => (
                  <li key={j.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium">{JOB_TYPES[j.type as JobType]?.label ?? j.type}</div>
                      <div className="truncate text-xs text-fg-subtle">{j.error ?? j.progressMessage ?? ""}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-xs text-fg-subtle">{fmtRelative(j.queuedAt)}</span>
                      <Badge tone={jobTone(j.status)}>{j.status.toLowerCase()}</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Data connections" description="Site-level and workspace-wide connections that feed this website." actions={<Link href="/integrations" className="text-xs text-accent hover:underline">Manage</Link>} />
          <CardBody className="p-0">
            {connections.length === 0 ? (
              <p className="px-4 py-6 text-[13px] text-fg-muted">Nothing connected yet. Crawling and audits work without integrations; Search Console, GA4 and rank data need them.</p>
            ) : (
              <ul className="divide-y divide-border">
                {connections.map((c) => (
                  <li key={c.id} className="flex items-center justify-between px-4 py-2.5 text-[13px]">
                    <span>{c.provider.replace(/_/g, " ").toLowerCase()} {c.websiteId ? "" : <span className="text-xs text-fg-subtle">(workspace)</span>}</span>
                    <span className="flex items-center gap-2"><span className="text-xs text-fg-subtle">synced {fmtRelative(c.lastSyncAt)}</span><Badge tone={connectionTone(c.status)}>{c.status.toLowerCase()}</Badge></span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

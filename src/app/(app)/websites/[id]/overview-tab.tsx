import Link from "next/link";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Notice } from "@/components/ui/page";
import { Badge, jobTone, connectionTone } from "@/components/ui/badge";
import { JOB_TYPES, type JobType } from "@/lib/jobs/types";
import { fmtRelative } from "@/lib/format";
import type { TabProps } from "./tabs";

export async function OverviewTab({ ctx, site, sp }: TabProps) {
  const [jobs, connections] = await Promise.all([
    ctx.db.job.findMany({ where: { websiteId: site.id }, orderBy: { queuedAt: "desc" }, take: 8 }),
    ctx.db.integrationConnection.findMany({ where: { OR: [{ websiteId: site.id }, { websiteId: null }] }, select: { id: true, provider: true, status: true, websiteId: true, lastSyncAt: true } }),
  ]);
  return (
    <div className="space-y-5">
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

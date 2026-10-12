import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffContext } from "@/lib/auth/context";
import { PageHeader } from "@/components/ui/page";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge, severityTone } from "@/components/ui/badge";
import { SourceTag } from "@/components/ui/metric";
import { ActionButton } from "@/components/ui/action-form";
import { fmtDate } from "@/lib/format";
import { prisma } from "@/lib/db/client";
import { setFindingStatusAction, createTaskAction } from "../../actions";
import type { PriorityFactor } from "@/audit/priority";
import { ProposeChange } from "../propose";

export const metadata = { title: "Finding" };

export default async function FindingDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireStaffContext();
  const f = await ctx.db.auditFinding.findUnique({ where: { id }, include: { website: true, events: { orderBy: { createdAt: "desc" } }, tasks: true } });
  if (!f || (ctx.websiteScope && !ctx.websiteScope.includes(f.websiteId))) notFound();
  const users = await prisma.user.findMany({ where: { id: { in: f.events.map((e) => e.userId).filter(Boolean) as string[] } }, select: { id: true, name: true } });
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const factors = (f.priorityFactors ?? []) as unknown as PriorityFactor[];
  const canWrite = ctx.can("findings:write");

  return (
    <>
      <PageHeader
        eyebrow={<><Link href={`/audits?websiteId=${f.websiteId}`} className="hover:text-fg">{f.website.name} findings</Link></>}
        title={<span className="flex flex-wrap items-center gap-2"><Badge tone={severityTone(f.severity)}>{f.severity.toLowerCase()}</Badge>{f.title}</span>}
        description={<a href={f.url} target="_blank" rel="noreferrer noopener" className="break-all hover:underline">{f.url}</a>}
        actions={canWrite && (
          <>
            {f.status !== "RESOLVED" && <ActionButton action={setFindingStatusAction} fields={{ id: f.id, status: "RESOLVED" }} successMessage="Marked resolved">Mark resolved</ActionButton>}
            {f.status !== "IGNORED" && <ActionButton action={setFindingStatusAction} fields={{ id: f.id, status: "IGNORED" }} variant="ghost">Ignore</ActionButton>}
            {(f.status === "RESOLVED" || f.status === "IGNORED") && <ActionButton action={setFindingStatusAction} fields={{ id: f.id, status: "OPEN" }}>Reopen</ActionButton>}
            {ctx.can("tasks:write") && f.tasks.every((t) => t.status === "DONE" || t.status === "CANCELLED") && <ActionButton action={createTaskAction} fields={{ id: f.id }} variant="primary">Create task</ActionButton>}
          </>
        )}
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-5">
          <Card>
            <CardHeader title="What's wrong" actions={<span className="text-xs text-fg-subtle">{f.category}</span>} />
            <CardBody className="space-y-3 text-[13px] leading-relaxed">
              <p>{f.description}</p>
              <div><div className="mb-1 text-xs font-semibold">Recommended fix</div><p className="text-fg-muted">{f.recommendation}</p></div>
              <div><div className="mb-1 text-xs font-semibold">Suggested implementation</div><p className="text-fg-muted">{f.implementation}</p></div>
              <div className="flex flex-wrap gap-2 pt-1">
                <Badge tone={f.automatable ? "accent" : "neutral"}>{f.automatable ? "Can be automated via CMS connector" : "Manual fix"}</Badge>
                <Badge tone={f.requiresApproval ? "warn" : "neutral"}>{f.requiresApproval ? "Requires approval before any site change" : "No approval needed"}</Badge>
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Evidence" description="Captured by the crawler on the most recent crawl where this was detected." actions={<SourceTag kind="measured" source="crawler" updatedAt={f.lastSeenAt} />} />
            <CardBody><pre className="scroll-thin max-h-[420px] overflow-auto rounded-md bg-bg-sunken p-3 font-mono text-xs leading-relaxed text-fg-muted">{JSON.stringify(f.evidence, null, 2)}</pre></CardBody>
          </Card>
        </div>
        <div className="space-y-5">
          <Card>
            <CardHeader title={`Priority ${Math.round(f.priorityScore)}`} description="Why this finding ranks where it does." actions={<SourceTag kind="internal" />} />
            <CardBody className="space-y-3">
              {factors.map((fa) => (
                <div key={fa.key}>
                  <div className="flex items-center justify-between text-xs"><span className="font-medium">{fa.label}</span><span className="tabular text-fg-muted">{fa.value.toFixed(2)}{fa.weight !== 1 ? ` × ${fa.weight.toFixed(2)}` : " (multiplier)"}</span></div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-hover"><div className="h-full bg-accent" style={{ width: `${fa.value * 100}%` }} /></div>
                  <p className="mt-0.5 text-2xs text-fg-subtle">{fa.explanation}</p>
                </div>
              ))}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Status & history" actions={<Badge>{f.status.toLowerCase().replace("_", " ")}</Badge>} />
            <CardBody>
              <ol className="relative space-y-3 border-l border-border pl-4">
                {f.events.map((e) => (
                  <li key={e.id} className="text-xs">
                    <span className="absolute -left-[5px] mt-1 size-2 rounded-full bg-border-strong" />
                    <div className="font-medium">{e.fromStatus ? `${e.fromStatus.toLowerCase()} → ` : ""}{e.toStatus.toLowerCase()}</div>
                    <div className="text-fg-subtle">{fmtDate(e.createdAt, true)} · {e.userId ? userName.get(e.userId) ?? "user" : "crawler"}{e.note ? ` · ${e.note}` : ""}</div>
                  </li>
                ))}
              </ol>
              <div className="mt-3 text-2xs text-fg-subtle">First seen {fmtDate(f.firstSeenAt)} · last seen {fmtDate(f.lastSeenAt)}{f.crawlId && <> · <Link className="text-accent hover:underline" href={`/audits/${f.crawlId}`}>latest crawl</Link></>}</div>
            </CardBody>
          </Card>
          {f.automatable && ctx.can("findings:write") && ["missing_title", "duplicate_title", "title_length", "missing_meta_description", "duplicate_meta_description", "meta_description_length"].includes(f.issueType) && (
            <Card>
              <CardHeader title="Propose a fix" description={f.website.cmsType === "WORDPRESS" ? "Sent to the approval queue, then applied through the WordPress connector." : "Live changes need a WordPress site with a connected WordPress integration."} />
              <CardBody>{f.website.cmsType === "WORDPRESS" ? <ProposeChange websiteId={f.websiteId} url={f.url} findingId={f.id} defaultField={f.issueType.includes("title") ? "title" : "meta_description"} /> : <p className="text-xs text-fg-muted">Set the website CMS to WordPress and connect it in Integrations. Or use Content Studio to draft copy for manual publishing.</p>}</CardBody>
            </Card>
          )}
          {f.tasks.length > 0 && (
            <Card>
              <CardHeader title="Tasks" />
              <CardBody className="space-y-1 text-xs">{f.tasks.map((t) => <div key={t.id} className="flex justify-between"><span className="truncate">{t.title}</span><Badge>{t.status.toLowerCase()}</Badge></div>)}</CardBody>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

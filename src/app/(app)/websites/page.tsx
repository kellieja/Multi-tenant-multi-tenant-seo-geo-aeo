import Link from "next/link";
import { Globe, Pause, Play, Archive, ArchiveRestore } from "lucide-react";
import { requireOrgContext } from "@/lib/auth/context";
import { listWebsites } from "@/server/websites";
import { PageHeader, EmptyState, Notice } from "@/components/ui/page";
import { Card } from "@/components/ui/card";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Table, THead, TH, TR, TD, Pagination, SortTH, makeHref } from "@/components/ui/table";
import { FilterBar } from "@/components/data/filter-bar";
import { ActionButton } from "@/components/ui/action-form";
import { SourceTag } from "@/components/ui/metric";
import { fmtInt, fmtRelative } from "@/lib/format";
import { AddWebsiteDialog, ImportCsvDialog } from "./dialogs";
import { setStatusAction } from "./actions";
import { cn } from "@/lib/cn";

export const metadata = { title: "Websites" };

type SP = Record<string, string | undefined>;

export default async function WebsitesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const ctx = await requireOrgContext();
  const list = await listWebsites(ctx, sp);
  const ids = list.rows.map((r) => r.id);
  const since = new Date(Date.now() - 28 * 86400_000);

  const [clients, facets, lastCrawls, openFindings, gsc] = await Promise.all([
    ctx.db.client.findMany({ where: { archivedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    ctx.db.website.findMany({ select: { project: true, folder: true, industry: true }, where: ctx.websiteScope ? { id: { in: ctx.websiteScope } } : {} }),
    ctx.db.crawl.findMany({
      where: { websiteId: { in: ids }, status: "SUCCEEDED" },
      orderBy: { finishedAt: "desc" },
      distinct: ["websiteId"],
      select: { websiteId: true, healthScore: true, finishedAt: true, pagesCrawled: true },
    }),
    ctx.db.auditFinding.groupBy({ by: ["websiteId"], where: { websiteId: { in: ids }, status: { in: ["OPEN", "REGRESSED"] } }, _count: true }),
    ctx.db.searchConsoleDaily.groupBy({ by: ["websiteId"], where: { websiteId: { in: ids }, date: { gte: since } }, _sum: { clicks: true } }),
  ]);
  const crawlBy = new Map(lastCrawls.map((c) => [c.websiteId, c]));
  const findingsBy = new Map(openFindings.map((f) => [f.websiteId, f._count]));
  const clicksBy = new Map(gsc.map((g) => [g.websiteId, g._sum.clicks ?? 0]));
  const uniq = (k: "project" | "folder" | "industry") => [...new Set(facets.map((f) => f[k]).filter(Boolean) as string[])].sort();
  const href = makeHref("/websites", sp);
  const canWrite = ctx.can("websites:write");
  const totalAll = facets.length;

  return (
    <>
      <PageHeader
        title="Websites"
        description="Every site in this workspace with its latest crawl health, open issues and Search Console clicks."
        actions={canWrite && (<><ImportCsvDialog /><AddWebsiteDialog clients={clients} /></>)}
      />
      {sp.welcome && totalAll === 0 && (
        <Notice tone="info" title="Workspace created" className="mb-4">
          Add your first website to start. Then run a crawl from its page and connect Google Search Console in Integrations.
        </Notice>
      )}
      <Card>
        <FilterBar
          q={sp.q}
          qPlaceholder="Search name, domain or tag"
          values={sp}
          preserve={{ sort: sp.sort, dir: sp.dir }}
          filters={[
            { name: "status", label: "Status", options: [{ value: "ACTIVE", label: "Active" }, { value: "PAUSED", label: "Paused" }, { value: "ARCHIVED", label: "Archived" }, { value: "ALL", label: "Any (incl. archived)" }] },
            ...(clients.length ? [{ name: "clientId", label: "Client", options: clients.map((c) => ({ value: c.id, label: c.name })) }] : []),
            ...(uniq("project").length ? [{ name: "project", label: "Project", options: uniq("project").map((v) => ({ value: v, label: v })) }] : []),
            ...(uniq("folder").length ? [{ name: "folder", label: "Folder", options: uniq("folder").map((v) => ({ value: v, label: v })) }] : []),
            ...(uniq("industry").length ? [{ name: "industry", label: "Industry", options: uniq("industry").map((v) => ({ value: v, label: v })) }] : []),
          ]}
        />
        {list.rows.length === 0 ? (
          totalAll === 0 ? (
            <EmptyState
              icon={<Globe className="size-5" />}
              title="No websites yet"
              description="Add a website manually or import a list from CSV. Each site keeps its own settings, credentials, keywords, backlinks and history."
              action={canWrite && (<><AddWebsiteDialog clients={clients} /><ImportCsvDialog /></>)}
            />
          ) : (
            <EmptyState title="No websites match these filters" action={<Link className="text-[13px] text-accent hover:underline" href="/websites">Clear filters</Link>} />
          )
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <SortTH label="Website" field="name" sort={sp.sort ?? "name"} dir={sp.dir ?? "asc"} href={href} />
                  <TH>Client / group</TH>
                  <TH>Status</TH>
                  <TH align="right">Health <span className="normal-case tracking-normal">(internal)</span></TH>
                  <TH align="right">Open issues</TH>
                  <TH align="right">Clicks 28d</TH>
                  <SortTH label="Updated" field="updatedAt" sort={sp.sort} dir={sp.dir} href={href} />
                  {canWrite && <TH align="right"><span className="sr-only">Actions</span></TH>}
                </tr>
              </THead>
              <tbody>
                {list.rows.map((w) => {
                  const crawl = crawlBy.get(w.id);
                  const clicks = clicksBy.get(w.id);
                  return (
                    <TR key={w.id}>
                      <TD>
                        <Link href={`/websites/${w.id}`} className="group flex items-center gap-2.5">
                          <img src={`https://www.google.com/s2/favicons?domain=${w.domain}&sz=32`} alt="" className="size-4 rounded-sm" loading="lazy" />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-fg group-hover:text-accent">{w.name}</span>
                            <span className="block truncate text-xs text-fg-subtle">{w.domain}</span>
                          </span>
                        </Link>
                      </TD>
                      <TD>
                        <div className="text-fg-muted">{w.client?.name ?? "—"}</div>
                        <div className="flex flex-wrap gap-1 pt-0.5">
                          {[w.project, w.folder].filter(Boolean).map((v) => <Badge key={v}>{v}</Badge>)}
                          {w.tags.slice(0, 3).map((t) => <Badge key={t} tone="accent">{t}</Badge>)}
                        </div>
                      </TD>
                      <TD>
                        <StatusDot tone={w.status === "ACTIVE" ? "good" : w.status === "PAUSED" ? "warn" : "neutral"} label={w.status.toLowerCase()} />
                      </TD>
                      <TD align="right">
                        {crawl?.healthScore != null ? (
                          <span className={cn("font-medium", crawl.healthScore >= 80 ? "text-good" : crawl.healthScore >= 60 ? "text-warn" : "text-bad")} title={`Last crawl ${fmtRelative(crawl.finishedAt)}, ${crawl.pagesCrawled} pages`}>
                            {Math.round(crawl.healthScore)}
                          </span>
                        ) : <span className="text-xs text-fg-subtle">not crawled</span>}
                      </TD>
                      <TD align="right">{crawl ? fmtInt(findingsBy.get(w.id) ?? 0) : "—"}</TD>
                      <TD align="right">{clicks != null ? fmtInt(clicks) : <span className="text-xs text-fg-subtle">GSC not synced</span>}</TD>
                      <TD className="text-xs text-fg-muted">{fmtRelative(w.updatedAt)}</TD>
                      {canWrite && (
                        <TD align="right">
                          <div className="flex justify-end gap-1">
                            {w.status === "ACTIVE" && (
                              <ActionButton action={setStatusAction} fields={{ id: w.id, status: "PAUSED" }} variant="ghost" size="icon" aria-label={`Pause ${w.name}`} title="Pause"><Pause className="size-3.5" /></ActionButton>
                            )}
                            {w.status === "PAUSED" && (
                              <ActionButton action={setStatusAction} fields={{ id: w.id, status: "ACTIVE" }} variant="ghost" size="icon" aria-label={`Resume ${w.name}`} title="Resume"><Play className="size-3.5" /></ActionButton>
                            )}
                            {w.status !== "ARCHIVED" ? (
                              <ActionButton action={setStatusAction} fields={{ id: w.id, status: "ARCHIVED" }} variant="ghost" size="icon" aria-label={`Archive ${w.name}`} title="Archive" confirm={`Archive ${w.domain}? Its history is kept and it can be restored.`}><Archive className="size-3.5" /></ActionButton>
                            ) : (
                              <ActionButton action={setStatusAction} fields={{ id: w.id, status: "ACTIVE" }} variant="ghost" size="icon" aria-label={`Restore ${w.name}`} title="Restore"><ArchiveRestore className="size-3.5" /></ActionButton>
                            )}
                          </div>
                        </TD>
                      )}
                    </TR>
                  );
                })}
              </tbody>
            </Table>
            <div className="flex items-center justify-between border-t border-border px-4 pt-2 text-2xs">
              <SourceTag kind="internal" source="health score from latest crawl" />
              <SourceTag kind="measured" source="clicks from Google Search Console" />
            </div>
            <Pagination page={list.page} pages={list.pages} total={list.total} pageSize={list.pageSize} href={href} />
          </>
        )}
      </Card>
    </>
  );
}

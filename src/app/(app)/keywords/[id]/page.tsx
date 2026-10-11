import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgContext } from "@/lib/auth/context";
import { PageHeader } from "@/components/ui/page";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SourceTag } from "@/components/ui/metric";
import { Table, THead, TH, TR, TD } from "@/components/ui/table";
import { TrendChart } from "@/components/charts/charts";
import { fmtDate } from "@/lib/format";
import { KeywordEdit } from "./edit";

export const metadata = { title: "Keyword" };

export default async function KeywordDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireOrgContext();
  const k = await ctx.db.keyword.findUnique({ where: { id }, include: { observations: { orderBy: { observedAt: "asc" }, take: 365 } } });
  if (!k || (ctx.websiteScope && !ctx.websiteScope.includes(k.websiteId))) notFound();
  const gsc = await ctx.db.searchConsoleQuery.groupBy({ by: ["date"], where: { websiteId: k.websiteId, query: k.phrase }, _sum: { clicks: true, impressions: true }, _avg: { position: true }, orderBy: { date: "asc" } });
  return (
    <>
      <PageHeader eyebrow={<Link href={`/keywords?websiteId=${k.websiteId}`} className="hover:text-fg">Keywords</Link>} title={k.phrase}
        description={<span className="flex flex-wrap gap-2"><Badge>{k.intent.toLowerCase()} ({k.intentSource ?? "rules"})</Badge><Badge>{k.device}</Badge><Badge>location {k.locationCode}</Badge>{k.searchVolume != null && <Badge tone="warn">{k.searchVolume} searches/mo (estimate)</Badge>}</span>} />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-5">
          <Card>
            <CardHeader title="Ranking history" description="Lower is better; checks where the site wasn't in the top 100 show as gaps." actions={<SourceTag kind="measured" source="DataForSEO SERP" />} />
            <CardBody>{k.observations.length ? <TrendChart data={k.observations.map((o) => ({ date: o.observedAt.toISOString().slice(0, 10), position: o.position }))} dataKey="position" label="Position" fmt="int" invertY height={220} /> : <p className="py-8 text-center text-[13px] text-fg-muted">Not checked yet.</p>}</CardBody>
          </Card>
          {gsc.length > 0 && (
            <Card>
              <CardHeader title="Search Console for this exact query" actions={<SourceTag kind="measured" source="Search Console" />} />
              <CardBody><TrendChart data={gsc.map((g) => ({ date: g.date.toISOString().slice(0, 10), clicks: g._sum.clicks ?? 0 }))} dataKey="clicks" label="Clicks" height={180} /></CardBody>
            </Card>
          )}
          <Card>
            <CardHeader title="Observations" />
            <Table>
              <THead><tr><TH>Checked</TH><TH align="right">Position</TH><TH>URL</TH><TH>SERP features</TH></tr></THead>
              <tbody>{[...k.observations].reverse().slice(0, 50).map((o) => <TR key={o.id}><TD className="text-xs">{fmtDate(o.observedAt, true)}</TD><TD align="right">{o.position ?? ">100"}</TD><TD className="max-w-xs truncate text-xs text-fg-muted">{o.url ?? "—"}</TD><TD className="text-2xs text-fg-subtle">{o.serpFeatures.join(", ")}</TD></TR>)}</tbody>
            </Table>
          </Card>
        </div>
        {ctx.can("keywords:write") && <Card className="self-start"><CardHeader title="Mapping & grouping" /><CardBody><KeywordEdit k={{ id: k.id, group: k.group, targetUrl: k.targetUrl, tags: k.tags }} /></CardBody></Card>}
      </div>
    </>
  );
}

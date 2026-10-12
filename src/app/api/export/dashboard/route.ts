import { getOrgContextOrThrow } from "@/lib/auth/context";
import { getDashboard } from "@/server/dashboard";
import { httpStatusFor } from "@/lib/errors";
import { toCsv } from "@/lib/csv";

export async function GET(req: Request) {
  try {
    const ctx = await getOrgContextOrThrow();
    const sp = Object.fromEntries(new URL(req.url).searchParams);
    const d = await getDashboard(ctx, sp);
    const rows: (string | number | null)[][] = [
      ["section", "metric", "value", "previous_period", "source", "provenance"],
    ];
    const t = d.searchConsole.totals;
    const p = d.searchConsole.previous;
    if (t) {
      rows.push(["search_console", "clicks", t.clicks, p?.clicks ?? null, "Google Search Console", "measured"]);
      rows.push(["search_console", "impressions", t.impressions, p?.impressions ?? null, "Google Search Console", "measured"]);
      rows.push(["search_console", "ctr", t.ctr, p?.ctr ?? null, "Google Search Console", "measured"]);
      rows.push(["search_console", "avg_position", t.position, p?.position ?? null, "Google Search Console", "measured"]);
    }
    if (d.analytics.available) rows.push(["ga4", "organic_sessions", d.analytics.organicSessions, d.analytics.previous ?? null, "Google Analytics 4", "measured"]);
    for (const b of d.rankings.distribution) rows.push(["rankings", `positions_${b.label}`, b.count, null, "rank tracker", "measured"]);
    rows.push(["rankings", "entered_top100", d.rankings.gained, null, "rank tracker", "measured"]);
    rows.push(["rankings", "dropped_out", d.rankings.lost, null, "rank tracker", "measured"]);
    if (d.technical.available) rows.push(["technical", "avg_health_score", d.technical.avgHealth, null, "crawler", "internal"]);
    for (const f of d.technical.findings) rows.push(["technical", `open_${f.severity.toLowerCase()}`, f.count, null, "crawler", "internal"]);
    rows.push(["backlinks", "new_links", d.backlinks.gained, d.backlinks.gainedPrev, "backlink index", "estimate"]);
    rows.push(["backlinks", "lost_links", d.backlinks.lost, d.backlinks.lostPrev, "backlink index", "estimate"]);
    rows.push(["backlinks", "referring_domains", d.backlinks.referringDomains, null, "backlink index", "estimate"]);
    rows.push(["work", "tasks_completed", d.work.tasksDone, d.work.tasksDonePrev, "task log", "internal"]);
    if (d.aeo.available) rows.push(["aeo", "avg_readiness_score", d.aeo.avgScore, null, "AEO assessment", "internal"]);
    if (d.geo.available) {
      rows.push(["geo", "brand_mention_rate", d.geo.mentionRate, null, d.geo.platforms.join("|"), "sampled"]);
      rows.push(["geo", "brand_citation_rate", d.geo.citationRate, null, d.geo.platforms.join("|"), "sampled"]);
    }
    rows.push([], ["date", "clicks", "impressions", "ctr", "avg_position", "prev_period_clicks"]);
    for (const s of d.searchConsole.series) rows.push([s.date, s.clicks, s.impressions, s.ctr, s.position, s.prevClicks]);
    const name = `dashboard_${d.period.from.toISOString().slice(0, 10)}_${d.period.to.toISOString().slice(0, 10)}.csv`;
    return new Response(toCsv(rows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"` } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: httpStatusFor(err) });
  }
}

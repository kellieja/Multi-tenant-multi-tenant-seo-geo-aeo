import { getOrgContextOrThrow } from "@/lib/auth/context";
import { httpStatusFor } from "@/lib/errors";
import { csvResponse } from "@/lib/csv";
import { getReportForViewer, readReportData } from "@/server/reports";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getOrgContextOrThrow();
    const report = await getReportForViewer(ctx, (await params).id);
    const d = readReportData(report);
    const db = d.dashboard;
    const rows: (string | number | null)[][] = [["scope", "section", "metric", "value", "previous_period", "provenance", "source"]];
    const all = "all websites";
    const t = db.searchConsole.totals, p = db.searchConsole.previous;
    if (t) for (const k of ["clicks", "impressions", "ctr", "position"] as const) rows.push([all, "search_console", k, t[k], p?.[k] ?? null, "measured", "Google Search Console"]);
    if (db.analytics.available) rows.push([all, "ga4", "organic_sessions", db.analytics.organicSessions, db.analytics.previous ?? null, "measured", "Google Analytics 4"]);
    if (db.technical.available) rows.push([all, "technical", "avg_health_score", db.technical.avgHealth, null, "internal", "crawler"]);
    for (const b of db.rankings.distribution) rows.push([all, "rankings", `positions_${b.label}`, b.count, null, "measured", "rank tracker"]);
    rows.push([all, "backlinks", "referring_domains", db.backlinks.referringDomains, null, "estimate", "backlink index"]);
    rows.push([all, "work", "tasks_completed", db.work.tasksDone, db.work.tasksDonePrev, "internal", "task log"]);
    for (const s of d.sites) {
      rows.push([s.domain, "technical", "health_score", s.health?.score ?? null, s.health?.previous ?? null, "internal", "crawler"]);
      for (const [k, v] of Object.entries(s.openFindings)) rows.push([s.domain, "technical", `open_${k}`, v, null, "internal", "crawler"]);
      rows.push([s.domain, "technical", "resolved_in_period", s.resolvedInPeriod, null, "internal", "crawler"]);
      for (const q of s.topQueries) rows.push([s.domain, "top_query", q.query, q.clicks, null, "measured", "Google Search Console"]);
      for (const m of [...s.movers.improved, ...s.movers.declined]) rows.push([s.domain, "keyword_movement", m.phrase, m.to, m.from, "measured", "rank tracker"]);
      rows.push([s.domain, "work", "tasks_completed", s.tasksDone, null, "internal", "task log"]);
      rows.push([s.domain, "work", "site_changes_applied", s.changesApplied, null, "internal", "change log"]);
    }
    return csvResponse(rows, `${report.title.replace(/[^\w.-]+/g, "_").slice(0, 80)}.csv`);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: httpStatusFor(err) });
  }
}

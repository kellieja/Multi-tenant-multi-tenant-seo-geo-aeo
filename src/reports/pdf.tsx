// Explicit React import: this module also runs in the worker (tsx) and tests, which use the classic JSX transform.
import React from "react";
import { Document, Page, Text, View, Image, Svg, Polyline, Line, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import type { Report } from "@prisma/client";
import { safeFetch } from "@/lib/net/safe-fetch";
import { fmtInt, fmtPct, fmtDec, pctChange } from "@/lib/format";
import { readReportData, type ReportData, type ReportSite } from "@/server/reports";

const INK = "#1d1f24";
const MUTED = "#5f6470";
const SUBTLE = "#8b909b";
const RULE = "#e3e4e8";
const GOOD = "#1f7a4d";
const BAD = "#b42318";

const s = StyleSheet.create({
  page: { paddingTop: 36, paddingBottom: 48, paddingHorizontal: 40, fontSize: 9, color: INK, fontFamily: "Helvetica", lineHeight: 1.35 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingBottom: 12, borderBottomWidth: 2, marginBottom: 16 },
  brand: { fontSize: 11, fontFamily: "Helvetica-Bold" },
  title: { fontSize: 18, fontFamily: "Helvetica-Bold", lineHeight: 1.2, marginBottom: 6 },
  sub: { color: MUTED, fontSize: 9 },
  h2: { fontSize: 12, fontFamily: "Helvetica-Bold", marginTop: 14, marginBottom: 6 },
  h3: { fontSize: 10, fontFamily: "Helvetica-Bold", marginTop: 8, marginBottom: 4 },
  grid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -4 },
  tile: { width: "25%", padding: 4 },
  tileInner: { borderWidth: 1, borderColor: RULE, borderRadius: 4, padding: 8, minHeight: 58 },
  tileLabel: { fontSize: 7.5, color: MUTED, marginBottom: 3 },
  tileValue: { fontSize: 14, fontFamily: "Helvetica-Bold" },
  tileSource: { fontSize: 6.5, color: SUBTLE, marginTop: 3 },
  row: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: RULE, paddingVertical: 3 },
  th: { fontSize: 7.5, color: MUTED, fontFamily: "Helvetica-Bold" },
  notes: { borderLeftWidth: 3, paddingLeft: 8, paddingVertical: 4, marginTop: 6, color: INK },
  footer: { position: "absolute", bottom: 20, left: 40, right: 40, flexDirection: "row", justifyContent: "space-between", fontSize: 7, color: SUBTLE },
  muted: { color: MUTED },
});

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

function Delta({ cur, prev, invert }: { cur: number | null | undefined; prev: number | null | undefined; invert?: boolean }) {
  const d = pctChange(cur, prev);
  if (d == null || !Number.isFinite(d)) return null;
  const good = invert ? d < 0 : d > 0;
  return <Text style={{ fontSize: 7.5, color: d === 0 ? MUTED : good ? GOOD : BAD }}>{d > 0 ? "+" : ""}{(d * 100).toFixed(1)}% vs previous period</Text>;
}

function Tile({ label, value, source, children }: { label: string; value: string; source: string; children?: React.ReactNode }) {
  return (
    <View style={s.tile} wrap={false}>
      <View style={s.tileInner}>
        <Text style={s.tileLabel}>{label}</Text>
        <Text style={s.tileValue}>{value}</Text>
        {children}
        <Text style={s.tileSource}>{source}</Text>
      </View>
    </View>
  );
}

function TrendChart({ series, color }: { series: { date: string; clicks: number; prevClicks: number | null }[]; color: string }) {
  const W = 515, H = 110;
  if (series.length < 2) return null;
  const max = Math.max(1, ...series.map((p) => Math.max(p.clicks, p.prevClicks ?? 0)));
  const pt = (i: number, v: number) => `${((i / (series.length - 1)) * W).toFixed(1)},${(H - (v / max) * (H - 8)).toFixed(1)}`;
  const prev = series.every((p) => p.prevClicks != null) ? series.map((p, i) => pt(i, p.prevClicks!)).join(" ") : null;
  return (
    <View wrap={false}>
      <Svg width={W} height={H + 4}>
        <Line x1={0} y1={H} x2={W} y2={H} stroke={RULE} strokeWidth={1} />
        {prev && <Polyline points={prev} fill="none" stroke={SUBTLE} strokeWidth={1.2} strokeDasharray="3 2" />}
        <Polyline points={series.map((p, i) => pt(i, p.clicks)).join(" ")} fill="none" stroke={color} strokeWidth={2} />
      </Svg>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 2 }}>
        <Text style={s.muted}>{day(series[0].date)}</Text>
        <Text style={s.muted}>Solid: clicks per day{prev ? " · dashed: previous period" : ""} · peak {fmtInt(max)}</Text>
        <Text style={s.muted}>{day(series[series.length - 1].date)}</Text>
      </View>
    </View>
  );
}

function Table({ cols, rows }: { cols: { label: string; width: string; align?: "right" }[]; rows: (string | number)[][] }) {
  return (
    <View>
      <View style={s.row}>{cols.map((c) => <Text key={c.label} style={[s.th, { width: c.width, textAlign: c.align ?? "left" }]}>{c.label}</Text>)}</View>
      {rows.map((r, i) => (
        <View key={i} style={s.row} wrap={false}>{r.map((v, j) => <Text key={j} style={{ width: cols[j].width, textAlign: cols[j].align ?? "left" }}>{String(v)}</Text>)}</View>
      ))}
    </View>
  );
}

const pos = (p: number | null) => (p == null ? "not in top 100" : `#${p}`);

function SiteSection({ site, color }: { site: ReportSite; color: string }) {
  const hs = site.health;
  return (
    <View break>
      <Text style={[s.h2, { color }]}>{site.name}</Text>
      <Text style={[s.sub, { marginBottom: 6 }]}>{site.domain}</Text>
      <View style={s.grid}>
        <Tile label="Site health score" value={hs?.score != null ? fmtInt(hs.score) : "No crawl yet"} source={hs?.crawledAt ? `Internal score · crawl ${day(hs.crawledAt)}${hs.afterPeriod ? " (after period)" : ""}` : "Internal score"}>
          {hs?.previous != null && hs.score != null && <Text style={{ fontSize: 7.5, color: hs.score >= hs.previous ? GOOD : BAD }}>{hs.score >= hs.previous ? "+" : ""}{fmtDec(hs.score - hs.previous)} vs previous crawl</Text>}
        </Tile>
        <Tile label="Open critical / high issues" value={`${site.openFindings.critical} / ${site.openFindings.high}`} source={`${site.openFindings.medium} medium, ${site.openFindings.low} low · crawler`} />
        <Tile label="Issues resolved this period" value={fmtInt(site.resolvedInPeriod)} source="Confirmed by re-crawl" />
        <Tile label="Work completed" value={fmtInt(site.tasksDone)} source={`${site.changesApplied} approved site change(s) applied`} />
      </View>
      {site.topIssues.length > 0 && <>
        <Text style={s.h3}>Highest-priority open issues</Text>
        <Table cols={[{ label: "Issue", width: "70%" }, { label: "Severity", width: "15%" }, { label: "Pages", width: "15%", align: "right" }]} rows={site.topIssues.map((i) => [i.title, i.severity.toLowerCase(), i.pages])} />
      </>}
      {site.topQueries.length > 0 && <>
        <Text style={s.h3}>Top search queries (Google Search Console)</Text>
        <Table cols={[{ label: "Query", width: "55%" }, { label: "Clicks", width: "15%", align: "right" }, { label: "Impressions", width: "15%", align: "right" }, { label: "Avg. position", width: "15%", align: "right" }]} rows={site.topQueries.map((q) => [q.query, fmtInt(q.clicks), fmtInt(q.impressions), fmtDec(q.position)])} />
      </>}
      {(site.movers.improved.length > 0 || site.movers.declined.length > 0) && <>
        <Text style={s.h3}>Keyword movement (rank tracker)</Text>
        <Table cols={[{ label: "Keyword", width: "50%" }, { label: "Start of period", width: "25%", align: "right" }, { label: "End of period", width: "25%", align: "right" }]} rows={[...site.movers.improved, ...site.movers.declined].map((m) => [m.phrase, pos(m.from), pos(m.to)])} />
      </>}
      {site.completedTasks.length > 0 && <>
        <Text style={s.h3}>Completed work</Text>
        {site.completedTasks.map((t) => <Text key={t}>· {t}</Text>)}
      </>}
    </View>
  );
}

function ReportDocument({ title, notes, data, logo }: { title: string; notes: string | null; data: ReportData; logo: { data: Buffer; format: "png" | "jpg" } | null }) {
  const d = data.dashboard;
  const color = /^#[0-9a-f]{6}$/i.test(data.brand.color) ? data.brand.color : "#2F5BEA";
  const gsc = d.searchConsole;
  const t = gsc.totals, p = gsc.previous;
  const top10 = d.rankings.distribution.filter((b) => ["1–3", "4–10", "1-3", "4-10"].includes(b.label)).reduce((n, b) => n + b.count, 0);
  return (
    <Document title={title} author={data.brand.name} creator={data.brand.name} producer={data.brand.name}>
      <Page size="A4" style={s.page}>
        <View style={[s.header, { borderBottomColor: color }]} fixed>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt attribute */}
            {logo && <Image src={logo} style={{ height: 22, marginRight: 8 }} />}
            <Text style={s.brand}>{data.brand.name}</Text>
          </View>
          <Text style={s.sub}>{day(data.period.from)} – {day(data.period.to)}</Text>
        </View>
        <Text style={s.title}>{title}</Text>
        <Text style={s.sub}>{data.scope.clientName ? `${data.scope.clientName} · ` : ""}{data.sites.length} website(s): {data.sites.map((x) => x.domain).join(", ")}</Text>

        <Text style={[s.h2, { color }]}>Summary</Text>
        <View style={s.grid}>
          {t ? <>
            <Tile label="Organic clicks" value={fmtInt(t.clicks)} source="Measured · Google Search Console"><Delta cur={t.clicks} prev={p?.clicks} /></Tile>
            <Tile label="Impressions" value={fmtInt(t.impressions)} source="Measured · Google Search Console"><Delta cur={t.impressions} prev={p?.impressions} /></Tile>
            <Tile label="Click-through rate" value={fmtPct(t.ctr)} source="Measured · Google Search Console"><Delta cur={t.ctr} prev={p?.ctr} /></Tile>
            <Tile label="Average position" value={fmtDec(t.position)} source="Measured · Google Search Console"><Delta cur={t.position} prev={p?.position} invert /></Tile>
          </> : <Tile label="Search Console" value="Not connected" source="Connect Google Search Console for traffic data" />}
          <Tile label="Organic sessions" value={d.analytics.available ? fmtInt(d.analytics.organicSessions) : "Not connected"} source="Measured · Google Analytics 4">{d.analytics.available && <Delta cur={d.analytics.organicSessions} prev={d.analytics.previous} />}</Tile>
          <Tile label="Average site health" value={d.technical.avgHealth != null ? fmtInt(d.technical.avgHealth) : "No crawl yet"} source="Internal score · site crawler" />
          <Tile label="Keywords in top 10" value={d.rankings.available ? `${fmtInt(top10)} of ${fmtInt(d.rankings.tracked)}` : "Not tracked"} source="Measured · rank tracker" />
          <Tile label="Referring domains" value={d.backlinks.available ? fmtInt(d.backlinks.referringDomains) : "No data"} source={`Estimate · backlink index · +${d.backlinks.gained} / -${d.backlinks.lost} links`} />
          {d.aeo.available && <Tile label="AEO readiness" value={fmtInt(d.aeo.avgScore)} source={`Internal score · ${d.aeo.pages} pages`} />}
          {d.geo.available && <Tile label="AI answers mentioning brand" value={fmtPct(d.geo.mentionRate, 0)} source={`Sampled · ${d.geo.observations} answers`} />}
          <Tile label="Tasks completed" value={fmtInt(d.work.tasksDone)} source="Internal · task log"><Delta cur={d.work.tasksDone} prev={d.work.tasksDonePrev} /></Tile>
        </View>

        {t && gsc.series.length > 1 && <>
          <Text style={[s.h2, { color }]}>Organic clicks</Text>
          <TrendChart series={gsc.series as { date: string; clicks: number; prevClicks: number | null }[]} color={color} />
        </>}

        {notes && <>
          <Text style={[s.h2, { color }]}>Commentary</Text>
          <Text style={[s.notes, { borderLeftColor: color }]}>{notes}</Text>
        </>}

        {data.sites.map((site) => <SiteSection key={site.id} site={site} color={color} />)}

        <View style={s.footer} fixed>
          <Text>Generated {day(data.generatedAt)}. Measured = first-party data; estimate = third-party index; internal = our own scoring; sampled = AI answer samples.</Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

/** Fetches the org logo through the SSRF guard. Only PNG/JPEG up to 1 MB; anything else is skipped. */
async function loadLogo(url: string | null): Promise<{ data: Buffer; format: "png" | "jpg" } | null> {
  if (!url) return null;
  try {
    const r = await safeFetch(url, { maxBytes: 1024 * 1024, timeoutMs: 8000, headers: { accept: "image/png,image/jpeg" } });
    if (r.status !== 200 || r.truncated) return null;
    const b = r.raw;
    if (b[0] === 0x89 && b[1] === 0x50) return { data: b, format: "png" };
    if (b[0] === 0xff && b[1] === 0xd8) return { data: b, format: "jpg" };
  } catch { /* logo is optional */ }
  return null;
}

export async function renderReportPdf(report: Pick<Report, "title" | "notes" | "data">): Promise<Buffer> {
  const data = readReportData(report);
  const logo = await loadLogo(data.brand.logoUrl);
  return renderToBuffer(<ReportDocument title={report.title} notes={report.notes} data={data} logo={logo} />);
}

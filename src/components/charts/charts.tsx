"use client";

import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import { fmtCompact, fmtDec, fmtInt, fmtPct } from "@/lib/format";

export const SERIES = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)"];

type Fmt = "int" | "compact" | "pct" | "dec" | "pos";
const format = (v: unknown, f: Fmt = "int") => {
  if (v == null || typeof v !== "number") return "—";
  return { int: fmtInt, compact: fmtCompact, pct: (n: number) => fmtPct(n), dec: (n: number) => fmtDec(n), pos: (n: number) => fmtDec(n, 1) }[f](v);
};

const shortDate = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
};

interface TipEntry { dataKey?: string | number; value?: unknown; color?: string; name?: string | number }
function ChartTooltip({ active, payload, label, fmt, labels, dateLabel = true }: { active?: boolean; payload?: TipEntry[]; label?: string | number; fmt?: Fmt; labels?: Record<string, string>; dateLabel?: boolean }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="min-w-36 rounded-md border border-border bg-surface px-2.5 py-2 text-xs shadow-lg">
      <div className="mb-1 font-medium text-fg">{dateLabel && typeof label === "string" && /^\d{4}-/.test(label) ? shortDate(label) : label}</div>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center justify-between gap-4 text-fg-muted">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-sm" style={{ background: p.color }} />
            {labels?.[String(p.dataKey)] ?? p.name}
          </span>
          <span className="font-medium tabular text-fg">{format(typeof p.value === "number" ? Math.abs(p.value) : p.value, fmt)}</span>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <svg width="14" height="8" aria-hidden><line x1="0" y1="4" x2="14" y2="4" stroke={i.color} strokeWidth="2" strokeDasharray={i.dashed ? "3 2" : undefined} /></svg>
          {i.label}
        </span>
      ))}
    </div>
  );
}

const axisProps = { tickLine: false, axisLine: false, fontSize: 11 } as const;

/** One measure over time with optional previous-period overlay (dashed, muted). Single y-axis by design. */
export function TrendChart({
  data, dataKey, compareKey, fmt = "int", height = 240, label, compareLabel = "Previous period", invertY,
}: {
  data: Record<string, unknown>[];
  dataKey: string;
  compareKey?: string;
  fmt?: Fmt;
  height?: number;
  label: string;
  compareLabel?: string;
  invertY?: boolean;
}) {
  const gid = `g-${dataKey}`;
  return (
    <div>
      {compareKey && <div className="mb-2"><Legend items={[{ label, color: "var(--chart-1)" }, { label: compareLabel, color: "var(--chart-muted)", dashed: true }]} /></div>}
      <div style={{ height }} role="img" aria-label={`${label} over time`}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.18} />
                <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={32} {...axisProps} />
            <YAxis width={44} tickFormatter={(v) => format(v, fmt === "pct" ? "pct" : "compact")} reversed={invertY} domain={invertY ? ["dataMin", "dataMax"] : [0, "auto"]} {...axisProps} />
            <Tooltip content={<ChartTooltip fmt={fmt} labels={{ [dataKey]: label, ...(compareKey ? { [compareKey]: compareLabel } : {}) }} />} cursor={{ stroke: "var(--border-strong)", strokeWidth: 1 }} />
            {compareKey && <Area type="monotone" dataKey={compareKey} stroke="var(--chart-muted)" strokeDasharray="4 3" strokeWidth={1.5} fill="none" connectNulls dot={false} isAnimationActive={false} />}
            <Area type="monotone" dataKey={dataKey} stroke="var(--chart-1)" strokeWidth={2} fill={`url(#${gid})`} connectNulls={false} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Multiple entities over time (e.g. clicks per website). Colour follows entity order passed in. */
export function MultiLineChart({ data, series, fmt = "int", height = 240, invertY }: { data: Record<string, unknown>[]; series: { key: string; label: string }[]; fmt?: Fmt; height?: number; invertY?: boolean }) {
  return (
    <div>
      <div className="mb-2"><Legend items={series.map((s, i) => ({ label: s.label, color: SERIES[i % SERIES.length] }))} /></div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={32} {...axisProps} />
            <YAxis width={44} reversed={invertY} domain={invertY ? [1, "dataMax"] : [0, "auto"]} tickFormatter={(v) => format(v, "compact")} {...axisProps} />
            <Tooltip content={<ChartTooltip fmt={fmt} labels={Object.fromEntries(series.map((s) => [s.key, s.label]))} />} cursor={{ stroke: "var(--border-strong)" }} />
            {series.slice(0, 6).map((s, i) => (
              <Line key={s.key} type="monotone" dataKey={s.key} stroke={SERIES[i]} strokeWidth={2} dot={false} connectNulls activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Magnitude across categories, single hue (sequential job). */
export function ColumnChart({ data, xKey, yKey, label, fmt = "int", height = 200, color = "var(--chart-1)", colors }: { data: Record<string, unknown>[]; xKey: string; yKey: string; label: string; fmt?: Fmt; height?: number; color?: string; colors?: string[] }) {
  return (
    <div style={{ height }} role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: 0 }} barCategoryGap="22%">
          <CartesianGrid vertical={false} />
          <XAxis dataKey={xKey} {...axisProps} interval={0} />
          <YAxis width={40} allowDecimals={false} tickFormatter={(v) => format(v, "compact")} {...axisProps} />
          <Tooltip content={<ChartTooltip fmt={fmt} dateLabel={false} labels={{ [yKey]: label }} />} cursor={{ fill: "var(--surface-hover)" }} />
          <Bar dataKey={yKey} radius={[4, 4, 0, 0]} fill={color} stroke="var(--surface)" strokeWidth={2}>
            {colors && data.map((_, i) => <Cell key={i} fill={colors[i] ?? color} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Polarity over time: gained above zero, lost below (diverging around a neutral baseline). */
export function GainLossChart({ data, height = 200, gainedLabel = "Gained", lostLabel = "Lost" }: { data: { date: string; gained: number; lost: number }[]; height?: number; gainedLabel?: string; lostLabel?: string }) {
  return (
    <div>
      <div className="mb-2"><Legend items={[{ label: gainedLabel, color: "var(--chart-2)" }, { label: lostLabel, color: "var(--chart-3)" }]} /></div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} stackOffset="sign" margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={32} {...axisProps} />
            <YAxis width={36} allowDecimals={false} tickFormatter={(v) => fmtInt(Math.abs(v))} {...axisProps} />
            <ReferenceLine y={0} stroke="var(--border-strong)" />
            <Tooltip content={<ChartTooltip labels={{ gained: gainedLabel, lost: lostLabel }} />} cursor={{ fill: "var(--surface-hover)" }} />
            <Bar dataKey="gained" stackId="a" fill="var(--chart-2)" radius={[3, 3, 0, 0]} />
            <Bar dataKey="lost" stackId="a" fill="var(--chart-3)" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function Sparkline({ data, dataKey, height = 32 }: { data: Record<string, unknown>[]; dataKey: string; height?: number }) {
  return (
    <div style={{ height }} aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <Line type="monotone" dataKey={dataKey} stroke="var(--chart-1)" strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

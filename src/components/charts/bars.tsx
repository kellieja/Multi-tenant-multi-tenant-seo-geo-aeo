import Link from "next/link";
import { cn } from "@/lib/cn";
import { fmtInt } from "@/lib/format";

/** Ranked horizontal bars (server-rendered, no JS). Values are text-ink, bar carries magnitude. */
export function BarList({ items, format = fmtInt, className }: { items: { label: string; value: number; href?: string; hint?: string }[]; format?: (n: number) => string; className?: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className={cn("space-y-1.5", className)}>
      {items.map((i) => {
        const body = (
          <>
            <div className="absolute inset-y-0 left-0 rounded bg-accent-soft transition-[width] duration-500" style={{ width: `${(i.value / max) * 100}%` }} />
            <span className="relative truncate text-fg">{i.label}{i.hint && <span className="ml-1.5 text-fg-subtle">{i.hint}</span>}</span>
            <span className="relative font-medium tabular text-fg">{format(i.value)}</span>
          </>
        );
        const cls = "relative flex h-7 items-center justify-between gap-3 overflow-hidden rounded px-2 text-[13px]";
        return <li key={i.label}>{i.href ? <Link href={i.href} className={cn(cls, "hover:bg-surface-hover")}>{body}</Link> : <div className={cls}>{body}</div>}</li>;
      })}
    </ul>
  );
}

/** Single stacked proportion bar with labelled segments (2px gaps between fills). */
export function SegmentBar({ segments, className }: { segments: { label: string; value: number; color: string }[]; className?: string }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  return (
    <div className={className}>
      <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full bg-surface-hover">
        {total > 0 && segments.filter((s) => s.value > 0).map((s) => (
          <div key={s.label} title={`${s.label}: ${fmtInt(s.value)}`} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {segments.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
            <span className="size-2 rounded-sm" style={{ background: s.color }} />
            {s.label} <span className="font-medium tabular text-fg">{fmtInt(s.value)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Ring gauge for an internal 0–100 score. */
export function ScoreRing({ value, size = 64, label }: { value: number | null; size?: number; label: string }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  const color = value == null ? "var(--chart-muted)" : v >= 80 ? "var(--good)" : v >= 60 ? "var(--warn)" : "var(--bad)";
  return (
    <svg width={size} height={size} role="img" aria-label={`${label}: ${value == null ? "no data" : Math.round(v)}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-hover)" strokeWidth="6" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${(v / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="fill-[var(--fg)] text-sm font-semibold">{value == null ? "—" : Math.round(v)}</text>
    </svg>
  );
}

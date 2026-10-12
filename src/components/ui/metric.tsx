import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "@/lib/cn";
import { fmtPct, fmtRelative } from "@/lib/format";

/**
 * Data provenance labels. Every number in the product carries one so that
 * measured data, third-party estimates and internal scores are never confused.
 */
export type Provenance = "measured" | "estimate" | "internal" | "sampled";

const PROV: Record<Provenance, { label: string; cls: string; help: string }> = {
  measured: { label: "Measured", cls: "text-good", help: "First-party data reported by the connected service." },
  estimate: { label: "Estimate", cls: "text-warn", help: "Third-party estimate. Not first-party measured data." },
  internal: { label: "Internal score", cls: "text-info", help: "Calculated by this platform. Not a Google metric." },
  sampled: { label: "Sampled", cls: "text-fg-muted", help: "Based on a limited sample of checks; results vary by user, time and location." },
};

export function SourceTag({ kind, source, updatedAt, className }: { kind: Provenance; source?: string; updatedAt?: Date | string | null; className?: string }) {
  const p = PROV[kind];
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap text-2xs text-fg-subtle", className)} title={`${p.help}${source ? ` Source: ${source}.` : ""}`}>
      <span className={cn("font-medium", p.cls)}>{p.label}</span>
      {source && <span>· {source}</span>}
      {updatedAt !== undefined && <span>· {fmtRelative(updatedAt)}</span>}
    </span>
  );
}

export function Delta({ value, invert, className }: { value: number | null; invert?: boolean; className?: string }) {
  if (value == null || !Number.isFinite(value)) return <span className={cn("text-2xs text-fg-subtle", className)} title="No data in the comparison period">—</span>;
  const good = invert ? value < 0 : value > 0;
  const flat = Math.abs(value) < 0.0005;
  const Icon = flat ? Minus : value > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium tabular", flat ? "text-fg-subtle" : good ? "text-good" : "text-bad", className)}>
      <Icon className="size-3" />
      {fmtPct(Math.abs(value))}
    </span>
  );
}

export function MetricTile({
  label, value, delta, invertDelta, provenance, source, updatedAt, footer, className, href,
}: {
  label: string;
  value: React.ReactNode;
  delta?: number | null;
  invertDelta?: boolean;
  provenance: Provenance;
  source?: string;
  updatedAt?: Date | string | null;
  footer?: React.ReactNode;
  className?: string;
  href?: string;
}) {
  const inner = (
    <>
      <div className="truncate text-xs text-fg-muted" title={label}>{label}</div>
      <div className="mt-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[22px] font-semibold tracking-[-0.02em] text-fg tabular">{value}</span>
        {delta !== undefined && <Delta value={delta} invert={invertDelta} className="shrink-0" />}
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <SourceTag kind={provenance} source={source} updatedAt={updatedAt} className="min-w-0 truncate" />
        {footer}
      </div>
    </>
  );
  const cls = cn("block rounded-[var(--radius-card)] border border-border bg-surface px-3.5 py-3", href && "transition-colors hover:border-border-strong hover:bg-surface-2", className);
  return href ? <a href={href} className={cls}>{inner}</a> : <div className={cls}>{inner}</div>;
}

/** Placeholder tile used when the data source isn't connected: never shows a fake number. */
export function UnavailableTile({ label, reason, href, cta }: { label: string; reason: string; href?: string; cta?: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-border bg-surface-2 px-3.5 py-3">
      <div className="text-xs text-fg-muted">{label}</div>
      <div className="mt-1.5 text-[22px] font-semibold text-fg-subtle">—</div>
      <div className="mt-1.5 text-2xs text-fg-subtle">
        {reason}
        {href && (
          <>
            {" "}
            <a className="font-medium text-accent hover:underline" href={href}>{cta ?? "Connect"}</a>
          </>
        )}
      </div>
    </div>
  );
}

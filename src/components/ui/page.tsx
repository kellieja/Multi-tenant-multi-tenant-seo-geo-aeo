import { cn } from "@/lib/cn";

export function PageHeader({
  title, description, actions, eyebrow, className,
}: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; eyebrow?: React.ReactNode; className?: string }) {
  return (
    <header className={cn("mb-5 flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-xs text-fg-subtle">{eyebrow}</div>}
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-fg">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-[13px] text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function EmptyState({
  icon, title, description, action, className,
}: { icon?: React.ReactNode; title: string; description?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      {icon && <div className="mb-3 flex size-10 items-center justify-center rounded-lg border border-border bg-surface-2 text-fg-muted">{icon}</div>}
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {description && <div className="mt-1 max-w-md text-[13px] text-fg-muted">{description}</div>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function Notice({ tone = "info", title, children, className }: { tone?: "info" | "warn" | "bad" | "good"; title?: string; children: React.ReactNode; className?: string }) {
  const tones = {
    info: "border-info/25 bg-info-soft",
    warn: "border-warn/30 bg-warn-soft",
    bad: "border-bad/30 bg-bad-soft",
    good: "border-good/30 bg-good-soft",
  };
  const text = { info: "text-info", warn: "text-warn", bad: "text-bad", good: "text-good" };
  return (
    <div role={tone === "bad" ? "alert" : "status"} className={cn("rounded-lg border px-3.5 py-2.5 text-[13px]", tones[tone], className)}>
      {title && <div className={cn("mb-0.5 font-semibold", text[tone])}>{title}</div>}
      <div className="text-fg-muted">{children}</div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-surface-hover", className)} />;
}

export function ProgressBar({ value, tone = "accent", className, label }: { value: number; tone?: "accent" | "good" | "warn" | "bad"; className?: string; label?: string }) {
  const color = { accent: "bg-accent", good: "bg-good", warn: "bg-warn", bad: "bg-bad" }[tone];
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-hover", className)} role="progressbar" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className={cn("h-full rounded-full transition-[width] duration-500", color)} style={{ width: `${v}%` }} />
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-border bg-surface-2 px-1 font-mono text-2xs text-fg-muted">{children}</kbd>;
}

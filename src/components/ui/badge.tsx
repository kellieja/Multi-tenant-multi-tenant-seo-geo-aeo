import { cn } from "@/lib/cn";

export type Tone = "neutral" | "good" | "warn" | "bad" | "info" | "accent";

const tones: Record<Tone, string> = {
  neutral: "bg-surface-hover text-fg-muted border-border",
  good: "bg-good-soft text-good border-transparent",
  warn: "bg-warn-soft text-warn border-transparent",
  bad: "bg-bad-soft text-bad border-transparent",
  info: "bg-info-soft text-info border-transparent",
  accent: "bg-accent-soft text-accent border-transparent",
};

export function Badge({ tone = "neutral", className, children, title }: { tone?: Tone; className?: string; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex h-5 items-center gap-1 rounded border px-1.5 text-2xs font-medium whitespace-nowrap", tones[tone], className)}>
      {children}
    </span>
  );
}

const dotTones: Record<Tone, string> = {
  neutral: "bg-fg-subtle", good: "bg-good", warn: "bg-warn", bad: "bg-bad", info: "bg-info", accent: "bg-accent",
};

export function StatusDot({ tone = "neutral", pulse, label }: { tone?: Tone; pulse?: boolean; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
      <span className="relative flex size-2">
        {pulse && <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", dotTones[tone])} />}
        <span className={cn("relative inline-flex size-2 rounded-full", dotTones[tone])} />
      </span>
      {label}
    </span>
  );
}

export const severityTone = (s: string): Tone =>
  ({ CRITICAL: "bad", HIGH: "bad", MEDIUM: "warn", LOW: "info", INFO: "neutral" } as Record<string, Tone>)[s] ?? "neutral";

export const jobTone = (s: string): Tone =>
  ({ QUEUED: "neutral", RUNNING: "info", SUCCEEDED: "good", FAILED: "bad", CANCELLED: "neutral" } as Record<string, Tone>)[s] ?? "neutral";

export const connectionTone = (s: string): Tone =>
  ({ CONNECTED: "good", PENDING: "warn", ERROR: "bad", DISCONNECTED: "neutral", UNAVAILABLE: "neutral" } as Record<string, Tone>)[s] ?? "neutral";

import Link from "next/link";
import { cn } from "@/lib/cn";

export function TabNav({ tabs, active }: { tabs: { href: string; label: string; key: string; count?: number }[]; active: string }) {
  return (
    <nav className="scroll-thin -mx-1 mb-5 flex gap-0.5 overflow-x-auto border-b border-border px-1" aria-label="Sections">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? "page" : undefined}
          className={cn(
            "relative -mb-px flex h-9 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 text-[13px] transition-colors",
            t.key === active ? "border-accent font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg",
          )}
        >
          {t.label}
          {t.count != null && <span className="rounded bg-surface-hover px-1 text-2xs tabular text-fg-muted">{t.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

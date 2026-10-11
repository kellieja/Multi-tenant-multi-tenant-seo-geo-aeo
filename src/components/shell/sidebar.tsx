"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  LayoutDashboard, Globe, ScanSearch, TrendingUp, Gauge, Network, Swords, MessageSquareQuote, Sparkles,
  Link2, PenLine, Workflow, FileBarChart, Plug, Settings, Menu, X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { NavItem } from "./nav";
import { Logo } from "./logo";

const ICONS = { LayoutDashboard, Globe, ScanSearch, TrendingUp, Gauge, Network, Swords, MessageSquareQuote, Sparkles, Link2, PenLine, Workflow, FileBarChart, Plug, Settings };

export function Sidebar({ groups, orgSwitcher, badges }: { groups: { label: string; items: NavItem[] }[]; orgSwitcher: React.ReactNode; badges?: Record<string, number> }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);

  const nav = (
    <nav aria-label="Primary" className="scroll-thin flex-1 space-y-5 overflow-y-auto px-3 py-4">
      {groups.map((g) => (
        <div key={g.label}>
          <div className="mb-1 px-2 text-2xs font-medium uppercase tracking-wider text-fg-subtle">{g.label}</div>
          <ul className="space-y-px">
            {g.items.map((item) => {
              const Icon = ICONS[item.icon as keyof typeof ICONS];
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              const badge = badges?.[item.href];
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "group flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors",
                      active ? "bg-surface text-fg shadow-[0_0_0_1px_var(--border)]" : "text-fg-muted hover:bg-surface-hover hover:text-fg",
                    )}
                  >
                    <Icon className={cn("size-4 shrink-0", active ? "text-accent" : "text-fg-subtle group-hover:text-fg-muted")} strokeWidth={1.75} />
                    <span className="truncate">{item.label}</span>
                    {!!badge && <span className="ml-auto rounded bg-accent-soft px-1.5 text-2xs font-medium tabular text-accent">{badge}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <>
      <button
        className="fixed left-3 top-3 z-40 flex size-8 items-center justify-center rounded-md border border-border bg-surface lg:hidden"
        aria-label="Open navigation"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Menu className="size-4" />
      </button>
      {open && <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setOpen(false)} aria-hidden />}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-border bg-bg-sunken transition-transform duration-200 lg:sticky lg:top-0 lg:z-auto lg:h-dvh lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-14 items-center justify-between border-b border-border px-4">
          <Link href="/dashboard" aria-label="Home"><Logo /></Link>
          <button className="lg:hidden" aria-label="Close navigation" onClick={() => setOpen(false)}><X className="size-4" /></button>
        </div>
        <div className="border-b border-border p-3">{orgSwitcher}</div>
        {nav}
      </aside>
    </>
  );
}

"use client";

import { useId } from "react";
import { cn } from "@/lib/cn";

/** Popover-API menu. Anchored under its trigger with fixed positioning computed on toggle. */
export function PopoverMenu({
  trigger, children, align = "end", className, triggerClassName, label,
}: { trigger: React.ReactNode; children: React.ReactNode; align?: "start" | "end"; className?: string; triggerClassName?: string; label: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <>
      <button
        popoverTarget={id}
        aria-label={label}
        className={triggerClassName}
        onClick={(e) => {
          const el = document.getElementById(id);
          if (!el) return;
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          el.style.top = `${r.bottom + 6}px`;
          if (align === "end") {
            el.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
            el.style.left = "auto";
          } else {
            el.style.left = `${r.left}px`;
            el.style.right = "auto";
          }
        }}
      >
        {trigger}
      </button>
      <div
        id={id}
        popover="auto"
        className={cn("app-popover fixed m-0 min-w-52 rounded-lg border border-border bg-surface p-1 text-[13px] text-fg shadow-xl", className)}
        style={{ inset: "unset" }}
      >
        {children}
      </div>
    </>
  );
}

export function MenuItem({ children, href, onClick, danger }: { children: React.ReactNode; href?: string; onClick?: () => void; danger?: boolean }) {
  const cls = cn("flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-surface-hover", danger && "text-bad");
  return href ? <a href={href} className={cls}>{children}</a> : <button type="submit" onClick={onClick} className={cls}>{children}</button>;
}

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2.5 pb-1 pt-1.5 text-2xs font-medium uppercase tracking-wider text-fg-subtle">{children}</div>;
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-border" />;
}

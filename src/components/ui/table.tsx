import Link from "next/link";
import { ChevronLeft, ChevronRight, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { cn } from "@/lib/cn";

export function Table({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("scroll-thin overflow-x-auto", className)}>
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  );
}

export function THead({ children }: { children: React.ReactNode }) {
  return <thead className="border-b border-border bg-surface-2 text-left text-2xs font-medium uppercase tracking-wider text-fg-subtle">{children}</thead>;
}

export function TH({ children, className, align }: { children?: React.ReactNode; className?: string; align?: "right" | "center" }) {
  return (
    <th scope="col" className={cn("h-8 px-3 font-medium whitespace-nowrap first:pl-4 last:pr-4", align === "right" && "text-right", align === "center" && "text-center", className)}>
      {children}
    </th>
  );
}

/** Sortable column header that writes ?sort=&dir= into the URL. */
export function SortTH({
  label, field, sort, dir, href, align,
}: { label: string; field: string; sort?: string; dir?: string; href: (p: Record<string, string>) => string; align?: "right" }) {
  const active = sort === field;
  const nextDir = active && dir === "desc" ? "asc" : "desc";
  const Icon = !active ? ArrowUpDown : dir === "desc" ? ArrowDown : ArrowUp;
  return (
    <TH align={align}>
      <Link href={href({ sort: field, dir: nextDir, page: "1" })} className={cn("inline-flex items-center gap-1 hover:text-fg", active && "text-fg")} aria-sort={active ? (dir === "desc" ? "descending" : "ascending") : undefined}>
        {label}
        <Icon className="size-3" />
      </Link>
    </TH>
  );
}

export function TR({ children, className }: { children: React.ReactNode; className?: string }) {
  return <tr className={cn("border-b border-border last:border-0 transition-colors hover:bg-surface-2", className)}>{children}</tr>;
}

export function TD({ children, className, align, colSpan }: { children?: React.ReactNode; className?: string; align?: "right" | "center"; colSpan?: number }) {
  return (
    <td colSpan={colSpan} className={cn("h-10 px-3 align-middle first:pl-4 last:pr-4", align === "right" && "text-right tabular", align === "center" && "text-center", className)}>
      {children}
    </td>
  );
}

export function Pagination({
  page, pages, total, href, pageSize,
}: { page: number; pages: number; total: number; pageSize: number; href: (p: Record<string, string>) => string }) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs text-fg-muted">
      <span className="tabular">
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
      </span>
      <div className="flex items-center gap-1">
        <PageLink disabled={page <= 1} href={href({ page: String(page - 1) })} label="Previous page"><ChevronLeft className="size-3.5" /></PageLink>
        <span className="px-2 tabular">Page {page} of {pages}</span>
        <PageLink disabled={page >= pages} href={href({ page: String(page + 1) })} label="Next page"><ChevronRight className="size-3.5" /></PageLink>
      </div>
    </nav>
  );
}

function PageLink({ disabled, href, label, children }: { disabled: boolean; href: string; label: string; children: React.ReactNode }) {
  if (disabled) return <span aria-disabled className="flex size-7 items-center justify-center rounded-md opacity-40">{children}</span>;
  return <Link href={href} aria-label={label} className="flex size-7 items-center justify-center rounded-md border border-border hover:bg-surface-hover">{children}</Link>;
}

/** Builds hrefs that preserve existing search params. */
export function makeHref(pathname: string, current: Record<string, string | string[] | undefined>) {
  return (patch: Record<string, string>) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(current)) if (typeof v === "string" && v) sp.set(k, v);
    for (const [k, v] of Object.entries(patch)) v ? sp.set(k, v) : sp.delete(k);
    const s = sp.toString();
    return s ? `${pathname}?${s}` : pathname;
  };
}

import { PRODUCT_NAME } from "@/lib/brand";

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <svg viewBox="0 0 24 24" className="size-6" aria-hidden>
        <rect width="24" height="24" rx="6" fill="var(--fg)" />
        <path d="M6 15.5c1.6 1.3 3.6 2 6 2 3 0 5-1.3 5-3.4 0-4.4-10.6-2.4-10.6-7 0-2 2-3.3 4.9-3.3 2 0 3.7.6 5.1 1.6" stroke="var(--bg)" strokeWidth="2" fill="none" strokeLinecap="round" />
        <circle cx="18" cy="18" r="2" fill="var(--accent)" />
      </svg>
      {!compact && <span className="text-sm font-semibold tracking-tight text-fg">{PRODUCT_NAME}</span>}
    </span>
  );
}

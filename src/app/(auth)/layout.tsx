import { PRODUCT_NAME } from "@/lib/brand";
import { Logo } from "@/components/shell/logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_minmax(0,560px)]">
      <aside className="relative hidden overflow-hidden border-r border-border bg-bg-sunken lg:flex lg:flex-col lg:justify-between lg:p-10">
        <Logo />
        <div className="max-w-md">
          <p className="text-2xl font-semibold leading-tight tracking-[-0.02em] text-fg">
            Search operations for every site you manage — measured, prioritised and automated with guardrails.
          </p>
          <ul className="mt-6 space-y-2 text-[13px] text-fg-muted">
            <li>· Real crawls and audits with evidence for every finding</li>
            <li>· Search Console and GA4 data, clearly labelled by source</li>
            <li>· Approval-gated automation. Nothing ships to a live site unreviewed.</li>
          </ul>
        </div>
        <p className="text-xs text-fg-subtle">© {new Date().getFullYear()} {PRODUCT_NAME}</p>
        <svg aria-hidden className="pointer-events-none absolute -right-24 top-1/3 size-[420px] text-border" viewBox="0 0 200 200" fill="none" stroke="currentColor">
          {Array.from({ length: 9 }, (_, i) => <circle key={i} cx="100" cy="100" r={12 + i * 11} strokeWidth=".6" />)}
        </svg>
      </aside>
      <main className="flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}

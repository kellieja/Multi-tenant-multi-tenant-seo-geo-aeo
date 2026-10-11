import { forwardRef, type ButtonHTMLAttributes } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md" | "icon";

const base =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-[background-color,border-color,color,box-shadow] duration-150 disabled:pointer-events-none disabled:opacity-50 select-none";
const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:brightness-110 shadow-[inset_0_1px_0_rgb(255_255_255/0.15)]",
  secondary: "border border-border bg-surface text-fg hover:bg-surface-hover hover:border-border-strong",
  ghost: "text-fg-muted hover:text-fg hover:bg-surface-hover",
  danger: "bg-bad text-white hover:brightness-110",
  subtle: "bg-surface-hover text-fg hover:bg-border",
};
const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-xs",
  md: "h-8.5 px-3 text-[13px]",
  icon: "h-8 w-8 text-sm",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "secondary", size = "md", loading, disabled, children, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(base, variants[variant], sizes[size], className)}
      {...props}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
});

export function ButtonLink({
  href, variant = "secondary", size = "md", className, children, ...rest
}: { href: string; variant?: Variant; size?: Size; className?: string; children: React.ReactNode; prefetch?: boolean; target?: string }) {
  return (
    <Link href={href} className={cn(base, variants[variant], sizes[size], className)} {...rest}>
      {children}
    </Link>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn("size-3.5 animate-spin", className)} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity=".25" strokeWidth="2" />
      <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

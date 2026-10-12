import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const field =
  "w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle transition-colors hover:border-border-strong focus:border-accent focus:outline-none focus:ring-3 focus:ring-[var(--ring)] disabled:opacity-60 aria-[invalid=true]:border-bad";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={cn(field, "h-8.5", className)} {...p} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) {
  return <textarea ref={ref} className={cn(field, "min-h-20 py-2 leading-relaxed", className)} {...p} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...p }, ref) {
  return (
    <select ref={ref} className={cn(field, "h-8.5 appearance-none bg-[length:12px] bg-[right_8px_center] bg-no-repeat pr-7", className)}
      style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='none' stroke='%23888' stroke-width='1.5'%3E%3Cpath d='M3 4.5l3 3 3-3'/%3E%3C/svg%3E\")" }}
      {...p}>
      {children}
    </select>
  );
});

export function Field({
  label, htmlFor, hint, error, children, className,
}: { label: string; htmlFor?: string; hint?: React.ReactNode; error?: string; children: React.ReactNode; className?: string }) {
  const help = error ? <p className="text-xs text-bad">{error}</p> : hint ? <p className="text-xs text-fg-subtle">{hint}</p> : null;
  // Without an explicit htmlFor, wrap the control in the label so it is always programmatically associated.
  if (!htmlFor) {
    return (
      <div className={cn("space-y-1.5", className)}>
        <label className="block space-y-1.5">
          <span className="block text-xs font-medium text-fg">{label}</span>
          {children}
        </label>
        {help}
      </div>
    );
  }
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="block text-xs font-medium text-fg">
        {label}
      </label>
      {children}
      {help}
    </div>
  );
}

export function Checkbox({ label, hint, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-[13px]">
      <input type="checkbox" className="mt-0.5 size-3.5 accent-[var(--accent)]" {...p} />
      <span>
        <span className="text-fg">{label}</span>
        {hint && <span className="block text-xs text-fg-subtle">{hint}</span>}
      </span>
    </label>
  );
}

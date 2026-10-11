"use client";

import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button, type ButtonProps } from "./button";

/**
 * Native modal <dialog> with light dismiss (closedby="any" + fallback for
 * browsers without it). Controlled via `open`/`onClose` or uncontrolled via `trigger`.
 */
export function Dialog({
  title, description, children, trigger, triggerProps, open: openProp, onClose, size = "md", footer,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode | ((close: () => void) => React.ReactNode);
  trigger?: React.ReactNode;
  triggerProps?: ButtonProps;
  open?: boolean;
  onClose?: () => void;
  size?: "sm" | "md" | "lg" | "xl";
  footer?: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [internalOpen, setInternalOpen] = useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : internalOpen;
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    const d = ref.current;
    if (!d || "closedBy" in HTMLDialogElement.prototype) return;
    const onClick = (e: MouseEvent) => {
      if (e.target !== d) return;
      const r = d.getBoundingClientRect();
      const inside = r.top <= e.clientY && e.clientY <= r.bottom && r.left <= e.clientX && e.clientX <= r.right;
      if (!inside) d.close();
    };
    d.addEventListener("click", onClick);
    return () => d.removeEventListener("click", onClick);
  }, []);

  const close = () => {
    if (controlled) onClose?.();
    else setInternalOpen(false);
  };

  const widths = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" };

  return (
    <>
      {trigger && (
        <Button {...triggerProps} onClick={() => setInternalOpen(true)}>
          {trigger}
        </Button>
      )}
      <dialog
        ref={ref}
        closedby="any"
        aria-labelledby={titleId}
        onClose={close}
        className={cn("app-dialog m-auto w-[calc(100%-2rem)] rounded-xl border border-border bg-surface p-0 text-fg shadow-2xl", widths[size])}
      >
        {open && (
          <div className="flex max-h-[85vh] flex-col">
            <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
              <div>
                <h2 id={titleId} className="text-sm font-semibold">{title}</h2>
                {description && <p className="mt-1 text-[13px] text-fg-muted">{description}</p>}
              </div>
              <Button variant="ghost" size="icon" onClick={close} aria-label="Close dialog" className="-mr-2 -mt-1">
                <X className="size-4" />
              </Button>
            </div>
            <div className="scroll-thin overflow-y-auto px-5 py-4">{typeof children === "function" ? children(close) : children}</div>
            {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
          </div>
        )}
      </dialog>
    </>
  );
}

"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";
import { cn } from "@/lib/cn";

type ToastTone = "good" | "bad" | "info";
interface ToastItem { id: number; tone: ToastTone; message: string }

const Ctx = createContext<(message: string, tone?: ToastTone) => void>(() => undefined);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((message: string, tone: ToastTone = "good") => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s.slice(-3), { id, tone, message }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), tone === "bad" ? 8000 : 4000);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
        {items.map((t) => {
          const Icon = t.tone === "good" ? CheckCircle2 : t.tone === "bad" ? AlertTriangle : Info;
          return (
            <div key={t.id} className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-3 text-[13px] shadow-lg">
              <Icon className={cn("mt-0.5 size-4 shrink-0", t.tone === "good" ? "text-good" : t.tone === "bad" ? "text-bad" : "text-info")} />
              <span className="flex-1 text-fg">{t.message}</span>
              <button aria-label="Dismiss" onClick={() => setItems((s) => s.filter((x) => x.id !== t.id))} className="text-fg-subtle hover:text-fg">
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);

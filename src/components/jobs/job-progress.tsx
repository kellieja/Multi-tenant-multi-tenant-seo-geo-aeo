"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { ProgressBar } from "@/components/ui/page";
import { Badge, jobTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface JobState { status: string; progress: number; progressMessage: string | null; error: string | null }

/** Polls /api/jobs/:id while a job is active and refreshes the page when it finishes. */
export function JobProgress({ jobId, initial, cancellable = true, compact }: { jobId: string; initial: JobState; cancellable?: boolean; compact?: boolean }) {
  const [state, setState] = useState(initial);
  const router = useRouter();
  const active = state.status === "QUEUED" || state.status === "RUNNING";
  const wasActive = useRef(active);

  useEffect(() => {
    if (!active) return;
    let stop = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
        if (res.ok) {
          const j = (await res.json()) as JobState;
          if (!stop) setState(j);
        }
      } catch { /* transient */ }
    };
    const t = setInterval(poll, 2000);
    return () => { stop = true; clearInterval(t); };
  }, [jobId, active]);

  useEffect(() => {
    if (wasActive.current && !active) router.refresh();
    wasActive.current = active;
  }, [active, router]);

  const cancel = async () => {
    await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
    setState((s) => ({ ...s, status: "CANCELLED" }));
  };

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <Badge tone={jobTone(state.status)}>{state.status.toLowerCase()}</Badge>
        {active && <span className="tabular text-xs text-fg-muted">{state.progress}%</span>}
        {active && cancellable && !compact && (
          <Button size="sm" variant="ghost" onClick={cancel} aria-label="Cancel job"><X className="size-3" />Cancel</Button>
        )}
      </div>
      {active && <ProgressBar value={state.status === "QUEUED" ? 2 : state.progress} className="mt-1.5" label="Job progress" />}
      {!compact && (state.error || state.progressMessage) && (
        <p className={`mt-1 text-xs ${state.status === "FAILED" ? "text-bad" : "text-fg-subtle"}`}>
          {state.status === "QUEUED" && !state.error ? "Waiting for a worker. If this persists, check that the worker process is running (pnpm worker)." : state.error ?? state.progressMessage}
        </p>
      )}
    </div>
  );
}

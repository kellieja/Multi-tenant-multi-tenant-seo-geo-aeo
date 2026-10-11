"use client";

import Link from "next/link";
import { ActionForm } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/form";
import { fmtDate } from "@/lib/format";
import { decideApprovalAction, taskStatusAction, taskAssignAction } from "./actions";

const kindLabel: Record<string, string> = { SITE_CHANGE: "Live site change", OUTREACH_SEND: "Outreach send", CONTENT_PUBLISH: "Content publish", WORKFLOW_ACTION: "Workflow action" };

export function ApprovalCard({ approval: a, canDecide }: { approval: { id: string; kind: string; summary: string; status: string; payload: Record<string, unknown>; createdAt: string; requestedBy: string; decidedBy: string | null; note: string | null; expiresAt: string | null }; canDecide: boolean }) {
  const p = a.payload as { before?: string; after?: string; url?: string; messageIds?: string[]; action?: { type: string } };
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2"><Badge tone="accent">{kindLabel[a.kind] ?? a.kind}</Badge><Badge tone={a.status === "PENDING" ? "warn" : a.status === "APPROVED" ? "good" : "neutral"}>{a.status.toLowerCase()}</Badge></div>
          <p className="mt-1.5 text-[13px] font-medium">{a.summary}</p>
          <p className="text-2xs text-fg-subtle">Requested by {a.requestedBy} · {fmtDate(a.createdAt, true)}{a.expiresAt && a.status === "PENDING" ? ` · expires ${fmtDate(a.expiresAt)}` : ""}{a.decidedBy ? ` · decided by ${a.decidedBy}` : ""}{a.note ? ` · “${a.note}”` : ""}</p>
        </div>
      </div>
      {(p.before !== undefined || p.after !== undefined) && (
        <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
          <div className="rounded-md border border-bad/20 bg-bad-soft p-2.5"><div className="mb-1 text-2xs font-semibold uppercase tracking-wider text-bad">Current</div><div className="whitespace-pre-wrap break-words text-fg">{p.before || "(empty)"}</div></div>
          <div className="rounded-md border border-good/20 bg-good-soft p-2.5"><div className="mb-1 text-2xs font-semibold uppercase tracking-wider text-good">Proposed</div><div className="whitespace-pre-wrap break-words text-fg">{p.after}</div></div>
        </div>
      )}
      {p.messageIds && <p className="mt-2 text-xs text-fg-muted">{p.messageIds.length} email{p.messageIds.length === 1 ? "" : "s"} · <Link className="text-accent hover:underline" href="/backlinks?tab=outreach">review drafts</Link></p>}
      {a.status === "PENDING" && canDecide && (
        <ActionForm action={decideApprovalAction} className="mt-3 flex flex-wrap items-center gap-2">
          {({ pending }) => (
            <>
              <input type="hidden" name="id" value={a.id} />
              <Input name="note" placeholder="Note (optional)" className="max-w-xs" aria-label="Decision note" />
              <Button type="submit" name="decision" value="APPROVED" variant="primary" size="sm" loading={pending}>Approve</Button>
              <Button type="submit" name="decision" value="REJECTED" size="sm" disabled={pending}>Reject</Button>
            </>
          )}
        </ActionForm>
      )}
    </Card>
  );
}

export function TaskRow({ task: t, members, canWrite }: { task: { id: string; title: string; priority: number; status: string; source: string; findingId: string | null; assigneeId: string | null; visibleToClient: boolean; website: string; createdAt: string }; members: { id: string; name: string }[]; canWrite: boolean }) {
  return (
    <tr className="border-b border-border last:border-0 hover:bg-surface-2">
      <td className="h-11 px-3 pl-4 text-right tabular text-xs">{t.priority}</td>
      <td className="px-3"><div className="max-w-lg truncate font-medium">{t.findingId ? <Link href={`/audits/findings/${t.findingId}`} className="hover:text-accent">{t.title}</Link> : t.title}</div><div className="text-2xs text-fg-subtle">{t.source}</div></td>
      <td className="px-3 text-xs">{t.website}</td>
      <td className="px-3">
        {canWrite ? (
          <ActionForm action={taskAssignAction} className="flex items-center gap-1.5">
            <input type="hidden" name="id" value={t.id} />
            <Select name="assigneeId" defaultValue={t.assigneeId ?? ""} onChange={(e) => e.currentTarget.form?.requestSubmit()} className="h-7 w-auto text-xs" aria-label="Assignee">
              <option value="">Unassigned</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
            <label className="flex items-center gap-1 text-2xs text-fg-subtle" title="Show in client portal"><input type="checkbox" name="visibleToClient" defaultChecked={t.visibleToClient} onChange={(e) => e.currentTarget.form?.requestSubmit()} className="accent-[var(--accent)]" />client</label>
          </ActionForm>
        ) : <span className="text-xs">{members.find((m) => m.id === t.assigneeId)?.name ?? "—"}</span>}
      </td>
      <td className="px-3">
        {canWrite ? (
          <ActionForm action={taskStatusAction}>
            <input type="hidden" name="id" value={t.id} />
            <Select name="status" defaultValue={t.status} onChange={(e) => e.currentTarget.form?.requestSubmit()} className="h-7 w-auto text-xs" aria-label="Status">
              <option value="TODO">To do</option><option value="IN_PROGRESS">In progress</option><option value="DONE">Done</option><option value="CANCELLED">Cancelled</option>
            </Select>
          </ActionForm>
        ) : <Badge>{t.status.toLowerCase()}</Badge>}
      </td>
      <td className="px-3 pr-4 text-xs text-fg-muted">{fmtDate(t.createdAt)}</td>
    </tr>
  );
}

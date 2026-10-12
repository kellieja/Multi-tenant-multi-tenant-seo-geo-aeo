"use client";

import Link from "next/link";
import { useState } from "react";
import { ActionForm } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Badge, severityTone } from "@/components/ui/badge";
import { Select } from "@/components/ui/form";
import { fmtRelative } from "@/lib/format";
import { setFindingStatusAction, createTaskAction } from "./actions";

export interface FindingRow {
  id: string;
  title: string;
  url: string;
  severity: string;
  status: string;
  category: string;
  priorityScore: number;
  automatable: boolean;
  lastSeenAt: string;
  website: { name: string };
}

const statusTone = (s: string) => ({ OPEN: "warn", IN_PROGRESS: "info", RESOLVED: "good", IGNORED: "neutral", REGRESSED: "bad" } as const)[s as "OPEN"] ?? "neutral";

export type SortLinks = Record<string, { href: string; active: boolean; dir: string }>;

function SortLink({ label, field, sorts }: { label: string; field: string; sorts: SortLinks }) {
  const s = sorts[field];
  if (!s) return <>{label}</>;
  return <Link href={s.href} className={s.active ? "text-fg" : "hover:text-fg"}>{label}{s.active ? (s.dir === "desc" ? " ↓" : " ↑") : ""}</Link>;
}

export function FindingsTable({ rows, canWrite, showSite, sorts }: { rows: FindingRow[]; canWrite: boolean; showSite: boolean; sorts: SortLinks }) {
  const sortHeader = (label: string, field: string) => <SortLink label={label} field={field} sorts={sorts} />;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const all = rows.length > 0 && selected.size === rows.length;
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const ids = [...selected];

  return (
    <>
      {canWrite && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-accent-soft px-4 py-2 text-[13px]">
          <span className="font-medium">{selected.size} selected</span>
          <ActionForm action={setFindingStatusAction} onSuccess={() => setSelected(new Set())} className="flex items-center gap-2">
            {({ pending }) => (
              <>
                {ids.map((id) => <input key={id} type="hidden" name="id" value={id} />)}
                <Select name="status" aria-label="New status" className="h-7 w-auto text-xs">
                  <option value="IN_PROGRESS">Mark in progress</option><option value="RESOLVED">Mark resolved</option><option value="IGNORED">Ignore</option><option value="OPEN">Reopen</option>
                </Select>
                <Button type="submit" size="sm" loading={pending}>Update</Button>
              </>
            )}
          </ActionForm>
          <ActionForm action={createTaskAction} onSuccess={() => setSelected(new Set())}>
            {({ pending }) => (<>{ids.map((id) => <input key={id} type="hidden" name="id" value={id} />)}<Button type="submit" size="sm" loading={pending}>Create tasks</Button></>)}
          </ActionForm>
        </div>
      )}
      <div className="scroll-thin overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead className="border-b border-border bg-surface-2 text-left text-2xs font-medium uppercase tracking-wider text-fg-subtle">
            <tr>
              {canWrite && <th className="w-8 pl-4"><input type="checkbox" aria-label="Select all" checked={all} onChange={() => setSelected(all ? new Set() : new Set(rows.map((r) => r.id)))} className="accent-[var(--accent)]" /></th>}
              <th className="h-8 px-3">{sortHeader("Priority", "priorityScore")}</th>
              <th className="px-3">{sortHeader("Issue", "severity")}</th>
              <th className="px-3">{sortHeader("URL", "url")}</th>
              {showSite && <th className="px-3">Website</th>}
              <th className="px-3">Status</th>
              <th className="px-3 pr-4">{sortHeader("Last seen", "lastSeenAt")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                {canWrite && <td className="pl-4"><input type="checkbox" aria-label={`Select ${r.title}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} className="accent-[var(--accent)]" /></td>}
                <td className="h-11 px-3 tabular">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-10 overflow-hidden rounded-full bg-surface-hover"><div className="h-full bg-accent" style={{ width: `${Math.min(100, r.priorityScore)}%` }} /></div>
                    <span className="text-xs font-medium">{Math.round(r.priorityScore)}</span>
                  </div>
                </td>
                <td className="px-3">
                  <Link href={`/audits/findings/${r.id}`} className="flex items-center gap-2 hover:text-accent">
                    <Badge tone={severityTone(r.severity)}>{r.severity.toLowerCase()}</Badge>
                    <span className="font-medium">{r.title}</span>
                    {r.automatable && <Badge tone="accent" title="A CMS connector can apply a fix after approval">automatable</Badge>}
                  </Link>
                  <div className="mt-0.5 text-2xs text-fg-subtle">{r.category}</div>
                </td>
                <td className="max-w-[320px] px-3"><a href={r.url} target="_blank" rel="noreferrer noopener" className="block truncate text-xs text-fg-muted hover:text-fg hover:underline" title={r.url}>{r.url.replace(/^https?:\/\//, "")}</a></td>
                {showSite && <td className="px-3 text-xs text-fg-muted">{r.website.name}</td>}
                <td className="px-3"><Badge tone={statusTone(r.status)}>{r.status.toLowerCase().replace("_", " ")}</Badge></td>
                <td className="px-3 pr-4 text-xs text-fg-muted">{fmtRelative(r.lastSeenAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

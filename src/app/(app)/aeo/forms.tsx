"use client";

import { useState } from "react";
import { ActionForm } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/form";
import { Notice } from "@/components/ui/page";
import type { SchemaIssue } from "@/audit/schema";
import { oppStatusAction, validateSchemaAction } from "./actions";

export function OppStatus({ id, status }: { id: string; status: string }) {
  return (
    <ActionForm action={oppStatusAction}>
      <input type="hidden" name="id" value={id} />
      <Select name="status" defaultValue={status} onChange={(e) => e.currentTarget.form?.requestSubmit()} className="h-7 w-auto text-xs" aria-label="Status">
        <option value="OPEN">Open</option><option value="IN_PROGRESS">In progress</option><option value="DONE">Done</option><option value="DISMISSED">Dismissed</option>
      </Select>
    </ActionForm>
  );
}

export function SchemaValidator() {
  const [issues, setIssues] = useState<SchemaIssue[] | null>(null);
  return (
    <ActionForm action={validateSchemaAction} refresh={false} onSuccess={(d) => setIssues(d.issues)} className="space-y-3">
      {({ pending }) => (
        <>
          <Textarea name="json" rows={12} className="font-mono text-xs" placeholder={'{\n  "@context": "https://schema.org",\n  "@type": "FAQPage",\n  "mainEntity": [...]\n}'} aria-label="JSON-LD" />
          <Button type="submit" variant="primary" loading={pending}>Validate</Button>
          {issues && (issues.length === 0 ? <Notice tone="good" title="No issues found">Required properties for supported types are present. Valid markup doesn&apos;t guarantee rich results; Google decides eligibility.</Notice> : (
            <Notice tone={issues.some((i) => i.severity === "error") ? "bad" : "warn"} title={`${issues.filter((i) => i.severity === "error").length} error(s), ${issues.filter((i) => i.severity === "warning").length} warning(s)`}>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">{issues.map((i, n) => <li key={n}><b>{i.severity}</b>: {i.message}</li>)}</ul>
            </Notice>
          ))}
        </>
      )}
    </ActionForm>
  );
}

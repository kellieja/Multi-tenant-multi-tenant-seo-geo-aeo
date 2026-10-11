"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ActionForm, fieldError } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/form";
import { analyzeAction, compareAction, briefAction, editSuggestionAction } from "./actions";

const go = (router: ReturnType<typeof useRouter>, websiteId: string, tab: string) => (d: { id: string }) => router.push(`/content?websiteId=${websiteId}&tab=${tab}&id=${d.id}`);

export function AnalyzeForm({ websiteId, defaultUrl }: { websiteId: string; defaultUrl?: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"url" | "text">("url");
  return (
    <ActionForm action={analyzeAction} refresh={false} onSuccess={go(router, websiteId, "analyze")} className="space-y-3">
      {({ pending, state }) => (
        <>
          <input type="hidden" name="websiteId" value={websiteId} />
          <div role="radiogroup" aria-label="Source" className="inline-flex rounded-md border border-border p-0.5 text-xs">
            {(["url", "text"] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={`rounded px-2.5 py-1 ${mode === m ? "bg-surface-2 font-medium text-fg" : "text-fg-muted"}`}>{m === "url" ? "Live URL" : "Paste text"}</button>
            ))}
          </div>
          {mode === "url"
            ? <Field label="Page URL" error={fieldError(state, "url")} hint="Fetched once, respecting robots.txt."><Input name="url" type="url" defaultValue={defaultUrl} placeholder="https://example.com/page" required /></Field>
            : <Field label="Draft text" error={fieldError(state, "text") ?? fieldError(state, "url")} hint="Use # / ## at the start of a line for headings; blank lines separate paragraphs."><Textarea name="text" rows={10} required minLength={50} /></Field>}
          <Field label="Target keyword (optional)" error={fieldError(state, "keyword")}><Input name="keyword" maxLength={120} /></Field>
          <Button type="submit" variant="primary" loading={pending}>Analyze</Button>
        </>
      )}
    </ActionForm>
  );
}

export function CompareForm({ websiteId }: { websiteId: string }) {
  const router = useRouter();
  return (
    <ActionForm action={compareAction} refresh={false} onSuccess={go(router, websiteId, "compare")} className="space-y-3">
      {({ pending, state }) => (
        <>
          <input type="hidden" name="websiteId" value={websiteId} />
          <Field label="Your page URL" error={fieldError(state, "url")}><Input name="url" type="url" required /></Field>
          <Field label="Competitor page URL" error={fieldError(state, "competitorUrl")} hint="Both pages are fetched once, respecting each site's robots.txt."><Input name="competitorUrl" type="url" required /></Field>
          <Field label="Target keyword (optional)"><Input name="keyword" maxLength={120} /></Field>
          <Button type="submit" variant="primary" loading={pending}>Compare</Button>
        </>
      )}
    </ActionForm>
  );
}

export function BriefForm({ websiteId, sources }: { websiteId: string; sources: string }) {
  const router = useRouter();
  return (
    <ActionForm action={briefAction} refresh={false} onSuccess={go(router, websiteId, "briefs")} className="space-y-3">
      {({ pending, state }) => (
        <>
          <input type="hidden" name="websiteId" value={websiteId} />
          <Field label="Target keyword or topic" error={fieldError(state, "keyword")}><Input name="keyword" required maxLength={120} /></Field>
          <Field label="Existing page to improve (optional)" error={fieldError(state, "url")}><Input name="url" type="url" /></Field>
          <Field label="Audience (optional)"><Input name="audience" maxLength={300} placeholder="e.g. facilities managers comparing repair contracts" /></Field>
          <p className="text-2xs text-fg-subtle">Grounded in: {sources}</p>
          <Button type="submit" variant="primary" loading={pending}>{pending ? "Drafting… (can take a minute)" : "Generate brief"}</Button>
        </>
      )}
    </ActionForm>
  );
}

export function EditSuggestion({ id, kind, title, metaDescription, text }: { id: string; kind: string; title?: string; metaDescription?: string; text?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Edit</Button>
      <Dialog title="Edit suggestion" open={open} onClose={() => setOpen(false)} size="lg">
        <ActionForm action={editSuggestionAction} onSuccess={() => setOpen(false)} className="space-y-3">
          {({ pending, state }) => (
            <>
              <input type="hidden" name="id" value={id} />
              {kind === "METADATA" ? (
                <>
                  <Field label="Title" error={fieldError(state, "title")} hint="30–60 characters"><Input name="title" defaultValue={title} maxLength={120} /></Field>
                  <Field label="Meta description" error={fieldError(state, "metaDescription")} hint="70–155 characters"><Textarea name="metaDescription" rows={3} defaultValue={metaDescription} maxLength={320} /></Field>
                </>
              ) : (
                <Field label="Answer" error={fieldError(state, "_")}><Textarea name="text" rows={10} defaultValue={text} /></Field>
              )}
              <div className="flex justify-end"><Button type="submit" variant="primary" loading={pending}>Save</Button></div>
            </>
          )}
        </ActionForm>
      </Dialog>
    </>
  );
}

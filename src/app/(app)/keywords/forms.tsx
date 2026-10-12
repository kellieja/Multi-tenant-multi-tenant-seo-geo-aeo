"use client";

import { useState } from "react";
import { Plus, Lightbulb } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { ActionForm } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { addKeywordsAction, ideasAction, trackQueriesAction, deleteKeywordsAction } from "./actions";

export function AddKeywords({ websiteId, groups }: { websiteId: string; groups: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}><Plus className="size-3.5" />Add keywords</Button>
      <Dialog title="Add keywords" open={open} onClose={() => setOpen(false)} size="lg" description="One per line, or CSV with columns phrase, group, tags, target_url, device. Intent is pre-classified with rules (labelled) and can be refreshed from DataForSEO.">
        <ActionForm action={addKeywordsAction} onSuccess={() => setOpen(false)} className="space-y-3">
          {({ pending }) => (
            <>
              <input type="hidden" name="websiteId" value={websiteId} />
              <Field label="Keywords"><Textarea name="keywords" rows={8} placeholder={"widget maintenance\nwidget repair near me\nbest industrial widgets"} /></Field>
              <Field label="…or upload CSV"><Input type="file" name="file" accept=".csv,text/csv,text/plain" className="py-1.5" /></Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Group (optional)"><Input name="group" list="kw-groups" /><datalist id="kw-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist></Field>
                <Field label="Device"><Select name="device"><option value="desktop">Desktop</option><option value="mobile">Mobile</option></Select></Field>
              </div>
              <div className="flex justify-end"><Button type="submit" variant="primary" loading={pending}>Add</Button></div>
            </>
          )}
        </ActionForm>
      </Dialog>
    </>
  );
}

export function KeywordIdeas({ websiteId }: { websiteId: string }) {
  const [open, setOpen] = useState(false);
  const [ideas, setIdeas] = useState<{ keyword: string; volume: number | null; difficulty: number | null; intent: string | null }[]>([]);
  return (
    <>
      <Button onClick={() => setOpen(true)}><Lightbulb className="size-3.5" />Keyword ideas</Button>
      <Dialog title="Keyword research" open={open} onClose={() => setOpen(false)} size="xl" description="Ideas from DataForSEO Labs. Volume and difficulty are third-party estimates.">
        <ActionForm action={ideasAction} refresh={false} onSuccess={(d) => setIdeas(d.ideas)} className="mb-4 flex gap-2">
          {({ pending }) => (<><input type="hidden" name="websiteId" value={websiteId} /><Input name="seeds" placeholder="Seed keywords, comma separated" required /><Button type="submit" loading={pending}>Find ideas</Button></>)}
        </ActionForm>
        {ideas.length > 0 && (
          <ActionForm action={trackQueriesAction} onSuccess={() => setOpen(false)} className="space-y-3">
            {({ pending }) => (
              <>
                <input type="hidden" name="websiteId" value={websiteId} />
                <div className="scroll-thin max-h-96 overflow-y-auto rounded-md border border-border">
                  <table className="w-full text-[13px]"><thead className="bg-surface-2 text-left text-2xs uppercase text-fg-subtle"><tr><th className="w-8 p-2" /><th className="p-2">Keyword</th><th className="p-2 text-right">Volume (est.)</th><th className="p-2 text-right">Difficulty</th><th className="p-2">Intent</th></tr></thead>
                    <tbody>{ideas.map((i) => <tr key={i.keyword} className="border-t border-border"><td className="p-2"><input type="checkbox" name="query" value={i.keyword} aria-label={i.keyword} className="accent-[var(--accent)]" /></td><td className="p-2">{i.keyword}</td><td className="p-2 text-right tabular">{i.volume ?? "—"}</td><td className="p-2 text-right tabular">{i.difficulty ?? "—"}</td><td className="p-2 text-xs">{i.intent ?? "—"}</td></tr>)}</tbody>
                  </table>
                </div>
                <Button type="submit" variant="primary" loading={pending}>Track selected</Button>
              </>
            )}
          </ActionForm>
        )}
      </Dialog>
    </>
  );
}

export function TrackQueries({ websiteId, queries }: { websiteId: string; queries: string[] }) {
  return (
    <ActionForm action={trackQueriesAction}>
      {({ pending }) => (<><input type="hidden" name="websiteId" value={websiteId} />{queries.map((q) => <input key={q} type="hidden" name="query" value={q} />)}<Button type="submit" size="sm" loading={pending}>Track {queries.length === 1 ? "" : `all ${queries.length}`}</Button></>)}
    </ActionForm>
  );
}

export function BulkDelete({ ids }: { ids: string[] }) {
  const [sel, setSel] = useState<string[]>([]);
  return (
    <ActionForm action={deleteKeywordsAction} onSuccess={() => setSel([])} className="flex items-center gap-2">
      {({ pending }) => (
        <>
          <Checkbox label="Select all on page" checked={sel.length === ids.length && ids.length > 0} onChange={(e) => setSel(e.target.checked ? ids : [])} />
          {sel.map((id) => <input key={id} type="hidden" name="id" value={id} />)}
          {sel.length > 0 && <Button type="submit" size="sm" variant="danger" loading={pending} onClick={(e) => { if (!confirm(`Remove ${sel.length} keywords and their ranking history?`)) e.preventDefault(); }}>Remove {sel.length}</Button>}
        </>
      )}
    </ActionForm>
  );
}

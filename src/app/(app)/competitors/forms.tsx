"use client";

import { useState } from "react";
import { ActionForm, fieldError } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { addCompetitorAction, suggestAction } from "./actions";

export function AddCompetitor({ websiteId }: { websiteId: string }) {
  return (
    <ActionForm action={addCompetitorAction} resetOnSuccess className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
      {({ pending, state }) => (
        <>
          <input type="hidden" name="websiteId" value={websiteId} />
          <Field label="Competitor domain" error={fieldError(state, "domain")}><Input name="domain" required placeholder="competitor.com" /></Field>
          <Field label="Name"><Input name="name" /></Field>
          <Field label="Brand terms" hint="Used for GEO share-of-voice"><Input name="brandTerms" placeholder="Comma separated" /></Field>
          <Button type="submit" variant="primary" loading={pending}>Add</Button>
        </>
      )}
    </ActionForm>
  );
}

export function SuggestCompetitors({ websiteId }: { websiteId: string }) {
  const [items, setItems] = useState<{ domain: string; sharedKeywords: number | null; avgPosition: number | null }[] | null>(null);
  return (
    <div>
      <ActionForm action={suggestAction} refresh={false} onSuccess={(d) => setItems(d.items)}>
        {({ pending }) => (<><input type="hidden" name="websiteId" value={websiteId} /><Button type="submit" size="sm" loading={pending}>Suggest organic competitors (DataForSEO)</Button></>)}
      </ActionForm>
      {items && (
        <ul className="mt-3 space-y-1">
          {items.length === 0 ? <li className="text-xs text-fg-muted">No suggestions.</li> : items.map((i) => (
            <li key={i.domain} className="flex items-center justify-between gap-2 text-[13px]">
              <span>{i.domain} <span className="text-2xs text-fg-subtle">{i.sharedKeywords ?? "?"} shared keywords (estimate)</span></span>
              <ActionForm action={addCompetitorAction} onSuccess={() => setItems((s) => s?.filter((x) => x.domain !== i.domain) ?? null)}>
                {({ pending }) => (<><input type="hidden" name="websiteId" value={websiteId} /><input type="hidden" name="domain" value={i.domain} /><Button type="submit" size="sm" loading={pending}>Add</Button></>)}
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

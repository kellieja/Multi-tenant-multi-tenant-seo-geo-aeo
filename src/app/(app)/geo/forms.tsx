"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { ActionForm, fieldError } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Textarea } from "@/components/ui/form";
import { Notice } from "@/components/ui/page";
import { savePromptSetAction } from "./actions";

export interface SetValues { id?: string; name: string; market: string; language: string; platforms: string[]; competitorTerms: string[]; prompts: string[]; schedule: string | null }

export function PromptSetDialog({ websiteId, platforms, initial, label }: { websiteId: string; platforms: { id: string; label: string; connected: boolean }[]; initial?: SetValues; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={initial ? "sm" : "md"} variant={initial ? "ghost" : "primary"} onClick={() => setOpen(true)}>{!initial && <Plus className="size-3.5" />}{label ?? (initial ? "Edit" : "New prompt set")}</Button>
      <Dialog title={initial ? "Edit prompt set" : "New prompt set"} open={open} onClose={() => setOpen(false)} size="lg" description="Write the questions your customers actually ask AI assistants. Avoid putting your brand name in the prompt; that would bias results.">
        <ActionForm action={savePromptSetAction} onSuccess={() => setOpen(false)} className="space-y-3">
          {({ pending, state }) => (
            <>
              <input type="hidden" name="websiteId" value={websiteId} />
              {initial?.id && <input type="hidden" name="id" value={initial.id} />}
              <div className="grid gap-3 sm:grid-cols-[1fr_100px_100px]">
                <Field label="Name" error={fieldError(state, "name")}><Input name="name" defaultValue={initial?.name} required /></Field>
                <Field label="Market" error={fieldError(state, "market")}><Input name="market" defaultValue={initial?.market ?? "US"} maxLength={2} /></Field>
                <Field label="Language"><Input name="language" defaultValue={initial?.language ?? "en"} /></Field>
              </div>
              <div>
                <div className="mb-1.5 text-xs font-medium">Platforms</div>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {platforms.map((p) => <Checkbox key={p.id} name="platforms" value={p.id} defaultChecked={initial ? initial.platforms.includes(p.id) : p.connected} disabled={!p.connected} label={p.label} hint={p.connected ? undefined : "Not connected (add the API key in Integrations)"} />)}
                </div>
                {fieldError(state, "platforms") && <p className="mt-1 text-xs text-bad">{fieldError(state, "platforms")}</p>}
              </div>
              <Field label="Prompts (one per line)" error={fieldError(state, "prompts") ?? Object.entries((state && !state.ok && state.fieldErrors) || {}).find(([k]) => k.startsWith("prompts."))?.[1]}>
                <Textarea name="prompts" rows={7} defaultValue={initial?.prompts.join("\n")} placeholder={"What is the best industrial widget supplier in Ohio?\nHow often should industrial widgets be serviced?\nWhich widget brands are most reliable?"} required />
              </Field>
              <Field label="Extra competitor names to track" hint="Competitors added in Competitor Intelligence are included automatically."><Input name="competitorTerms" defaultValue={initial?.competitorTerms.join(", ")} placeholder="Comma separated" /></Field>
              <Field label="Schedule (cron, UTC, optional)" hint="e.g. 0 8 * * 1 = weekly on Monday. Every run costs API credits."><Input name="schedule" defaultValue={initial?.schedule ?? ""} className="font-mono" /></Field>
              <Notice tone="info">Results are samples. AI answers vary by user, location, time and session, and API answers can differ from consumer apps. Never read one run as your universal visibility.</Notice>
              <div className="flex justify-end"><Button type="submit" variant="primary" loading={pending}>Save</Button></div>
            </>
          )}
        </ActionForm>
      </Dialog>
    </>
  );
}

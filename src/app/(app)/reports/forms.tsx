"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { ActionForm, fieldError } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { createReportAction, saveScheduleAction, notesAction, sendReportAction } from "./actions";

interface Opt { id: string; name: string }

function ScopeFields({ sites, clients, state, selected, clientId }: { sites: Opt[]; clients: Opt[]; state: Parameters<typeof fieldError>[0]; selected?: string[]; clientId?: string | null }) {
  return (
    <>
      {clients.length > 0 && (
        <Field label="Client (optional)" hint="Limits the report to that client's websites.">
          <Select name="clientId" defaultValue={clientId ?? ""}><option value="">All clients</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        </Field>
      )}
      <fieldset>
        <legend className="mb-1.5 text-xs font-medium">Websites <span className="font-normal text-fg-subtle">(none selected = all in scope)</span></legend>
        <div className="grid max-h-40 gap-1.5 overflow-y-auto sm:grid-cols-2">{sites.map((s) => <Checkbox key={s.id} name="websiteIds" value={s.id} label={s.name} defaultChecked={selected?.includes(s.id)} />)}</div>
        {fieldError(state, "websiteIds") && <p className="mt-1 text-xs text-bad">{fieldError(state, "websiteIds")}</p>}
      </fieldset>
    </>
  );
}

export function NewReportDialog({ sites, clients, defaults }: { sites: Opt[]; clients: Opt[]; defaults: { from: string; to: string; title: string } }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}><Plus className="size-3.5" />New report</Button>
      <Dialog title="New report" open={open} onClose={() => setOpen(false)} size="lg" description="Numbers are frozen when the report is generated. Clients only see it after approval.">
        <ActionForm action={createReportAction} refresh={false} onSuccess={(d) => router.push(`/reports/${d.id}`)} className="space-y-3">
          {({ pending, state }) => (
            <>
              <Field label="Title" error={fieldError(state, "title")}><Input name="title" defaultValue={defaults.title} required /></Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="From" error={fieldError(state, "from")}><Input name="from" type="date" defaultValue={defaults.from} required /></Field>
                <Field label="To" error={fieldError(state, "to")}><Input name="to" type="date" defaultValue={defaults.to} required /></Field>
              </div>
              <ScopeFields sites={sites} clients={clients} state={state} />
              <Field label="Commentary (optional)" hint="Shown at the top of the report. You can edit it until the report is approved."><Textarea name="notes" rows={4} /></Field>
              <div className="flex justify-end"><Button type="submit" variant="primary" loading={pending}>Generate</Button></div>
            </>
          )}
        </ActionForm>
      </Dialog>
    </>
  );
}

export interface ScheduleValues { id: string; name: string; websiteIds: string[]; clientId: string | null; frequency: string; recipients: string[]; autoApprove: boolean }

export function ScheduleDialog({ sites, clients, canApprove, initial }: { sites: Opt[]; clients: Opt[]; canApprove: boolean; initial?: ScheduleValues }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={initial ? "sm" : "md"} variant={initial ? "ghost" : "primary"} onClick={() => setOpen(true)}>{initial ? "Edit" : <><Plus className="size-3.5" />New schedule</>}</Button>
      <Dialog title={initial ? "Edit schedule" : "New report schedule"} open={open} onClose={() => setOpen(false)} size="lg" description="Weekly reports cover Monday–Sunday and run Monday 06:00 UTC; monthly reports cover the previous calendar month and run on the 1st.">
        <ActionForm action={saveScheduleAction} onSuccess={() => setOpen(false)} className="space-y-3">
          {({ pending, state }) => (
            <>
              {initial && <input type="hidden" name="id" value={initial.id} />}
              <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
                <Field label="Name" error={fieldError(state, "name")}><Input name="name" defaultValue={initial?.name} required /></Field>
                <Field label="Frequency"><Select name="frequency" defaultValue={initial?.frequency ?? "MONTHLY"}><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option></Select></Field>
              </div>
              <ScopeFields sites={sites} clients={clients} state={state} selected={initial?.websiteIds} clientId={initial?.clientId} />
              <Field label="Email recipients (optional)" hint="Comma separated. Emails go out only after the report is approved." error={Object.entries((state && !state.ok && state.fieldErrors) || {}).find(([k]) => k.startsWith("recipients"))?.[1]}>
                <Input name="recipients" defaultValue={initial?.recipients.join(", ")} placeholder="client@example.com" />
              </Field>
              {canApprove && <Checkbox name="autoApprove" label="Approve automatically" hint="Skips human review: the report is approved and emailed as soon as it's generated." defaultChecked={initial?.autoApprove} />}
              <div className="flex justify-end"><Button type="submit" variant="primary" loading={pending}>Save</Button></div>
            </>
          )}
        </ActionForm>
      </Dialog>
    </>
  );
}

export function NotesForm({ id, notes }: { id: string; notes: string | null }) {
  return (
    <ActionForm action={notesAction} className="space-y-2">
      {({ pending }) => (
        <>
          <input type="hidden" name="id" value={id} />
          <Textarea name="notes" rows={5} defaultValue={notes ?? ""} aria-label="Commentary" placeholder="Summarise what changed and what's next. Shown at the top of the report." />
          <Button type="submit" size="sm" loading={pending}>Save commentary</Button>
        </>
      )}
    </ActionForm>
  );
}

export function SendForm({ id, defaultRecipients }: { id: string; defaultRecipients: string }) {
  return (
    <ActionForm action={sendReportAction} refresh={false} className="flex flex-wrap items-end gap-2">
      {({ pending, state }) => (
        <>
          <input type="hidden" name="id" value={id} />
          <Field label="Email the PDF to" error={fieldError(state, "_") ?? (state && !state.ok ? Object.values(state.fieldErrors ?? {})[0] : undefined)}><Input name="recipients" defaultValue={defaultRecipients} placeholder="client@example.com, …" className="w-72" /></Field>
          <Button type="submit" size="sm" loading={pending}>Send</Button>
        </>
      )}
    </ActionForm>
  );
}

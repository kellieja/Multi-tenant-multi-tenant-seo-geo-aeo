"use client";

import { useState } from "react";
import { Plus, Upload } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { ActionForm, ActionButton, fieldError } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import {
  addBacklinkAction, addProspectAction, campaignAction, disavowAction, draftAction, editDraftAction, importBacklinksAction,
  replyAction, requestSendAction, stageAction, templateAction,
} from "./actions";

export function ImportBacklinks({ websiteId }: { websiteId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}><Upload className="size-3.5" />Import CSV</Button>
      <Dialog title="Import backlinks" open={open} onClose={() => setOpen(false)} size="lg" description="Header row required with source_url and target_url (url_from / url_to exports from most tools also work). Optional: anchor, rel or nofollow, first_seen. Imported links start as unverified until checked.">
        <ActionForm action={importBacklinksAction} onSuccess={() => setOpen(false)} className="space-y-3">
          {({ pending }) => (
            <>
              <input type="hidden" name="websiteId" value={websiteId} />
              <Field label="CSV file"><Input type="file" name="file" accept=".csv,text/csv" className="py-1.5" /></Field>
              <Field label="…or paste CSV"><Textarea name="csv" rows={5} className="font-mono text-xs" placeholder={"source_url,target_url,anchor,rel\nhttps://blog.example/post,https://yoursite.com/guide,widget guide,follow"} /></Field>
              <div className="flex justify-end"><Button type="submit" variant="primary" loading={pending}>Import</Button></div>
            </>
          )}
        </ActionForm>
      </Dialog>
    </>
  );
}

export function AddBacklink({ websiteId, baseUrl }: { websiteId: string; baseUrl: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}><Plus className="size-3.5" />Add link</Button>
      <Dialog title="Add a backlink" open={open} onClose={() => setOpen(false)}>
        <ActionForm action={addBacklinkAction} onSuccess={() => setOpen(false)} className="space-y-3">
          {({ pending, state }) => (
            <>
              <input type="hidden" name="websiteId" value={websiteId} />
              <Field label="Linking page URL" error={fieldError(state, "sourceUrl")}><Input name="sourceUrl" type="url" required /></Field>
              <Field label="Your page it links to" error={fieldError(state, "targetUrl")}><Input name="targetUrl" type="url" defaultValue={baseUrl} required /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Anchor text"><Input name="anchor" /></Field>
                <Field label="Rel"><Select name="rel"><option value="follow">follow</option><option value="nofollow">nofollow</option><option value="ugc">ugc</option><option value="sponsored">sponsored</option></Select></Field>
              </div>
              <div className="flex justify-end"><Button type="submit" variant="primary" loading={pending}>Add</Button></div>
            </>
          )}
        </ActionForm>
      </Dialog>
    </>
  );
}

export function AddProspect({ websiteId, baseUrl }: { websiteId: string; baseUrl: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}><Plus className="size-3.5" />Add prospect</Button>
      <Dialog title="Add an outreach prospect" open={open} onClose={() => setOpen(false)} size="lg" description="Research fetches the page (respecting robots.txt), scores topical relevance against your tracked keywords, checks for broken outbound links and collects publicly listed contact emails only.">
        <ActionForm action={addProspectAction} onSuccess={() => setOpen(false)} className="space-y-3">
          {({ pending, state }) => (
            <>
              <input type="hidden" name="websiteId" value={websiteId} />
              <Field label="Prospect page URL" error={fieldError(state, "url")}><Input name="url" type="url" required placeholder="https://industry-blog.example/resources" /></Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Contact name"><Input name="contactName" /></Field>
                <Field label="Contact email" hint="Leave empty to use a publicly listed address if found." error={fieldError(state, "contactEmail")}><Input name="contactEmail" type="email" /></Field>
              </div>
              <Field label="Your page to pitch"><Input name="targetUrl" type="url" defaultValue={baseUrl} /></Field>
              <Field label="Notes"><Textarea name="notes" rows={2} /></Field>
              <Checkbox name="research" defaultChecked label="Research the page automatically" />
              <div className="flex justify-end"><Button type="submit" variant="primary" loading={pending}>Add prospect</Button></div>
            </>
          )}
        </ActionForm>
      </Dialog>
    </>
  );
}

export function StageSelect({ id, stage }: { id: string; stage: string }) {
  const [next, setNext] = useState(stage);
  return (
    <ActionForm action={stageAction} className="flex flex-wrap items-center gap-1.5">
      {({ pending }) => (
        <>
          <input type="hidden" name="id" value={id} />
          <Select name="stage" value={next} onChange={(e) => setNext(e.target.value)} className="h-7 w-auto text-xs" aria-label="Stage">
            {["DISCOVERED", "QUALIFIED", "CONTACTED", "RESPONDED", "NEGOTIATING", "ACQUIRED", "LOST", "REJECTED"].map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
            {stage === "VERIFIED" && <option value="VERIFIED" disabled>verified</option>}
          </Select>
          {next === "ACQUIRED" && stage !== "ACQUIRED" && <Input name="acquiredLinkUrl" placeholder="URL of the linking page" className="h-7 w-56 text-xs" required />}
          {next !== stage && <Button type="submit" size="sm" loading={pending}>Save</Button>}
        </>
      )}
    </ActionForm>
  );
}

export function ReplyForm({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Log reply</Button>
      <Dialog title="Record a reply" open={open} onClose={() => setOpen(false)}>
        <ActionForm action={replyAction} onSuccess={() => setOpen(false)} className="space-y-3">
          {({ pending }) => (<><input type="hidden" name="id" value={id} /><Textarea name="body" rows={6} required placeholder="Paste the reply" /><div className="flex justify-end"><Button type="submit" variant="primary" loading={pending}>Save</Button></div></>)}
        </ActionForm>
      </Dialog>
    </>
  );
}

export function TemplateForm({ initial }: { initial?: { id: string; name: string; subject: string; body: string } }) {
  return (
    <ActionForm action={templateAction} resetOnSuccess={!initial} className="space-y-3">
      {({ pending, state }) => (
        <>
          {initial && <input type="hidden" name="id" value={initial.id} />}
          <Field label="Name" error={fieldError(state, "name")}><Input name="name" defaultValue={initial?.name} required /></Field>
          <Field label="Subject" error={fieldError(state, "subject")}><Input name="subject" defaultValue={initial?.subject} required /></Field>
          <Field label="Body" hint="Variables: {{contact_name}} {{prospect_domain}} {{prospect_url}} {{target_url}} {{site_name}} {{site_domain}} {{sender_name}}" error={fieldError(state, "body")}>
            <Textarea name="body" rows={7} defaultValue={initial?.body} required />
          </Field>
          <Button type="submit" size="sm" variant="primary" loading={pending}>Save template</Button>
        </>
      )}
    </ActionForm>
  );
}

export function CampaignForm({ websiteId, templates }: { websiteId: string; templates: { id: string; name: string }[] }) {
  return (
    <ActionForm action={campaignAction} resetOnSuccess className="grid gap-3 sm:grid-cols-[1fr_1fr_120px_auto] sm:items-end">
      {({ pending }) => (
        <>
          <input type="hidden" name="websiteId" value={websiteId} />
          <Field label="Campaign name"><Input name="name" required /></Field>
          <Field label="Template"><Select name="templateId" required>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
          <Field label="Follow up after (days)"><Input name="followUpDays" type="number" min={2} max={30} defaultValue={5} /></Field>
          <Button type="submit" variant="primary" loading={pending} disabled={!templates.length}>Create</Button>
        </>
      )}
    </ActionForm>
  );
}

export function DraftForCampaign({ campaignId, prospects }: { campaignId: string; prospects: { id: string; domain: string; contactEmail: string | null; stage: string }[] }) {
  return (
    <ActionForm action={draftAction} className="space-y-2">
      {({ pending }) => (
        <>
          <input type="hidden" name="campaignId" value={campaignId} />
          <div className="scroll-thin max-h-44 space-y-1 overflow-y-auto rounded-md border border-border p-2">
            {prospects.length === 0 ? <p className="text-xs text-fg-muted">No eligible prospects.</p> : prospects.map((p) => <Checkbox key={p.id} name="prospectId" value={p.id} label={p.domain} hint={p.contactEmail ?? "no email: will be skipped"} />)}
          </div>
          <Button type="submit" size="sm" loading={pending}>Draft emails for selected</Button>
        </>
      )}
    </ActionForm>
  );
}

export function DraftList({ drafts }: { drafts: { id: string; subject: string; body: string; status: string; to: string | null; domain: string }[] }) {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <div className="space-y-2">
      {drafts.map((d) => (
        <details key={d.id} className="rounded-md border border-border">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[13px]">
            {d.status === "DRAFT" && <input type="checkbox" aria-label={`Select draft to ${d.domain}`} checked={selected.includes(d.id)} onChange={(e) => setSelected((s) => e.target.checked ? [...s, d.id] : s.filter((x) => x !== d.id))} onClick={(e) => e.stopPropagation()} className="accent-[var(--accent)]" />}
            <span className="font-medium">{d.domain}</span><span className="truncate text-xs text-fg-muted">{d.subject}</span>
            <Badge tone={d.status === "SENT" ? "good" : d.status === "PENDING_APPROVAL" ? "warn" : d.status === "FAILED" ? "bad" : "neutral"} className="ml-auto">{d.status.toLowerCase().replace("_", " ")}</Badge>
          </summary>
          <div className="border-t border-border p-3">
            <p className="mb-2 text-2xs text-fg-subtle">To: {d.to ?? "(no address)"}</p>
            {d.status === "DRAFT" ? (
              <ActionForm action={editDraftAction} className="space-y-2">
                {({ pending }) => (<><input type="hidden" name="id" value={d.id} /><Input name="subject" defaultValue={d.subject} /><Textarea name="body" rows={6} defaultValue={d.body} /><Button type="submit" size="sm" loading={pending}>Save draft</Button></>)}
              </ActionForm>
            ) : <pre className="whitespace-pre-wrap font-sans text-xs text-fg-muted">{d.body}</pre>}
          </div>
        </details>
      ))}
      {selected.length > 0 && (
        <ActionForm action={requestSendAction} onSuccess={() => setSelected([])}>
          {({ pending }) => (<>{selected.map((id) => <input key={id} type="hidden" name="messageId" value={id} />)}<Button type="submit" variant="primary" loading={pending}>Request approval to send {selected.length}</Button></>)}
        </ActionForm>
      )}
    </div>
  );
}

export function DisavowForm({ websiteId }: { websiteId: string }) {
  return (
    <ActionForm action={disavowAction} resetOnSuccess className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      {({ pending }) => (
        <>
          <input type="hidden" name="websiteId" value={websiteId} />
          <Field label="Domain or URL" hint="domain:example.com or a full URL"><Input name="value" required /></Field>
          <Field label="Reason"><Input name="reason" required placeholder="e.g. hacked page injecting links" /></Field>
          <Button type="submit" loading={pending}>Add for review</Button>
        </>
      )}
    </ActionForm>
  );
}

export { ActionButton };

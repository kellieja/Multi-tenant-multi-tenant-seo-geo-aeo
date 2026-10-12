"use client";

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { ActionForm, fieldError } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Notice } from "@/components/ui/page";
import type { ProviderDef } from "@/integrations/registry";
import { connectAction, googleConnectAction, googlePropertiesAction, selectPropertyAction } from "./actions";

export function ConnectDialog({ def, sites, missingEnv, appUrl }: { def: ProviderDef; sites: { id: string; name: string }[]; missingEnv: string[]; appUrl: string }) {
  const [open, setOpen] = useState(false);
  const blocked = missingEnv.length > 0;
  return (
    <>
      <Button size="sm" variant={blocked ? "secondary" : "primary"} onClick={() => setOpen(true)}>{blocked ? "Setup required" : "Connect"}</Button>
      <Dialog title={`Connect ${def.name}`} open={open} onClose={() => setOpen(false)} size="lg" description={def.description}>
        <div className="space-y-4">
          <div>
            <h3 className="mb-1.5 text-xs font-semibold">Setup</h3>
            <ol className="list-decimal space-y-1 pl-4 text-[13px] text-fg-muted">{def.setup.map((s) => <li key={s}>{s.replace("<APP_URL>", appUrl)}</li>)}</ol>
            {def.docsUrl && <a href={def.docsUrl} target="_blank" rel="noreferrer noopener" className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:underline">Provider documentation <ExternalLink className="size-3" /></a>}
          </div>
          {def.scopes && <div><h3 className="mb-1 text-xs font-semibold">Permissions requested (read-only)</h3><ul className="font-mono text-2xs text-fg-muted">{def.scopes.map((s) => <li key={s}>{s}</li>)}</ul></div>}
          {def.costNote && <Notice tone="warn">{def.costNote}</Notice>}
          {blocked ? (
            <Notice tone="warn" title="Server configuration required">This integration can&apos;t be connected until an administrator sets <code className="font-mono">{missingEnv.join(", ")}</code> in the server environment and restarts the app.</Notice>
          ) : def.auth === "oauth-google" ? (
            <ActionForm action={googleConnectAction} refresh={false} onSuccess={(d) => { window.location.href = d.url; }} className="space-y-3">
              {({ pending }) => (
                <>
                  <input type="hidden" name="provider" value={def.id} />
                  <Field label="Website" htmlFor="g-site"><Select id="g-site" name="websiteId">{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
                  <Button type="submit" variant="primary" loading={pending} disabled={!sites.length}>Continue to Google</Button>
                </>
              )}
            </ActionForm>
          ) : (
            <ActionForm action={connectAction} onSuccess={() => setOpen(false)} className="space-y-3">
              {({ pending, state }) => (
                <>
                  <input type="hidden" name="provider" value={def.id} />
                  {def.level === "website" && <Field label="Website" htmlFor="c-site"><Select id="c-site" name="websiteId">{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>}
                  {(def.fields ?? []).map((f) => (
                    <Field key={f.name} label={`${f.label}${f.optional ? " (optional)" : ""}`} htmlFor={`f-${f.name}`} hint={f.hint} error={fieldError(state, f.name)}>
                      {f.type === "select" ? (
                        <Select id={`f-${f.name}`} name={f.name}>{(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
                      ) : f.type === "textarea" ? (
                        <Textarea id={`f-${f.name}`} name={f.name} rows={4} placeholder={f.placeholder} required={!f.optional} autoComplete="off" className="font-mono text-xs" />
                      ) : (
                        <Input id={`f-${f.name}`} name={f.name} type={f.type} placeholder={f.placeholder} required={!f.optional} autoComplete="off" />
                      )}
                    </Field>
                  ))}
                  {state && !state.ok && <Notice tone="bad">{state.error}</Notice>}
                  <p className="text-2xs text-fg-subtle">Credentials are verified with a live API call, encrypted with AES-256-GCM and never sent back to the browser.</p>
                  <div className="flex justify-end"><Button type="submit" variant="primary" loading={pending}>Verify &amp; connect</Button></div>
                </>
              )}
            </ActionForm>
          )}
        </div>
      </Dialog>
    </>
  );
}

export function PropertyPicker({ connectionId, provider, autoOpen }: { connectionId: string; provider: string; autoOpen?: boolean }) {
  const [open, setOpen] = useState(Boolean(autoOpen));
  const [options, setOptions] = useState<{ id: string; name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || options) return;
    googlePropertiesAction(connectionId).then((r) => (r.ok ? setOptions(r.data) : setError(r.error)));
  }, [open, options, connectionId]);
  return (
    <>
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}>Choose property</Button>
      <Dialog title={provider === "GOOGLE_SEARCH_CONSOLE" ? "Choose Search Console property" : "Choose GA4 property"} open={open} onClose={() => setOpen(false)}>
        {error ? <Notice tone="bad">{error}</Notice> : !options ? <p className="text-[13px] text-fg-muted">Loading properties from Google…</p> : options.length === 0 ? (
          <Notice tone="warn">The connected Google account has no accessible properties. Ask a property owner to add this account, then reconnect.</Notice>
        ) : (
          <ActionForm action={selectPropertyAction} onSuccess={() => setOpen(false)} className="space-y-3">
            {({ pending }) => (
              <>
                <input type="hidden" name="connectionId" value={connectionId} />
                <Select name="property" aria-label="Property">{options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>
                <Button type="submit" variant="primary" loading={pending}>Save &amp; start first sync</Button>
              </>
            )}
          </ActionForm>
        )}
      </Dialog>
    </>
  );
}

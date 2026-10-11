"use client";

import { useRouter } from "next/navigation";
import { ActionForm, fieldError } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";
import { createWebsiteAction, updateWebsiteAction } from "./actions";

export interface WebsiteFormValues {
  id?: string;
  name?: string;
  baseUrl?: string;
  clientId?: string | null;
  project?: string | null;
  industry?: string | null;
  folder?: string | null;
  tags?: string[];
  brandTerms?: string[];
  cmsType?: string;
}

export function WebsiteForm({ clients, initial, onDone }: { clients: { id: string; name: string }[]; initial?: WebsiteFormValues; onDone?: () => void }) {
  const router = useRouter();
  const editing = Boolean(initial?.id);
  return (
    <ActionForm
      action={editing ? updateWebsiteAction : createWebsiteAction}
      onSuccess={(data) => {
        onDone?.();
        const id = (data as { id?: string } | undefined)?.id;
        if (!editing && id) router.push(`/websites/${id}?tab=overview&new=1`);
      }}
      className="space-y-4"
    >
      {({ pending, state }) => (
        <>
          {initial?.id && <input type="hidden" name="id" value={initial.id} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Website URL" htmlFor="url" error={fieldError(state, "url") ?? (state && !state.ok && /domain|URL|already/i.test(state.error) ? state.error : undefined)}>
              <Input id="url" name="url" placeholder="example.com" defaultValue={initial?.baseUrl} required autoFocus />
            </Field>
            <Field label="Display name" htmlFor="name" error={fieldError(state, "name")}>
              <Input id="name" name="name" placeholder="Example Co." defaultValue={initial?.name} required />
            </Field>
            <Field label="Client" htmlFor="clientId" hint={clients.length === 0 ? "Create clients in Settings → Clients, or via CSV import." : undefined}>
              <Select id="clientId" name="clientId" defaultValue={initial?.clientId ?? ""}>
                <option value="">No client</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="CMS" htmlFor="cmsType" hint="WordPress sites can be connected for approved changes.">
              <Select id="cmsType" name="cmsType" defaultValue={initial?.cmsType ?? "NONE"}>
                <option value="NONE">Not specified</option>
                <option value="WORDPRESS">WordPress</option>
                <option value="WEBFLOW">Webflow</option>
                <option value="SHOPIFY">Shopify</option>
                <option value="CUSTOM">Custom / other</option>
              </Select>
            </Field>
            <Field label="Project" htmlFor="project"><Input id="project" name="project" defaultValue={initial?.project ?? ""} /></Field>
            <Field label="Folder" htmlFor="folder"><Input id="folder" name="folder" defaultValue={initial?.folder ?? ""} /></Field>
            <Field label="Industry" htmlFor="industry"><Input id="industry" name="industry" defaultValue={initial?.industry ?? ""} /></Field>
            <Field label="Tags" htmlFor="tags" hint="Comma separated"><Input id="tags" name="tags" defaultValue={initial?.tags?.join(", ")} /></Field>
            <Field label="Brand terms" htmlFor="brandTerms" className="sm:col-span-2" hint="Names your brand is referred to by. Used for GEO mention tracking and unlinked-mention discovery.">
              <Input id="brandTerms" name="brandTerms" defaultValue={initial?.brandTerms?.join(", ")} placeholder="Example Co, ExampleCo" />
            </Field>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="submit" variant="primary" loading={pending}>{editing ? "Save changes" : "Add website"}</Button>
          </div>
        </>
      )}
    </ActionForm>
  );
}

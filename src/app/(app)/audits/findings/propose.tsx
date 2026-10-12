"use client";

import { ActionForm, fieldError } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Field, Select, Textarea } from "@/components/ui/form";
import { proposeChangeAction } from "../actions";

export function ProposeChange({ websiteId, url, findingId, defaultField }: { websiteId: string; url: string; findingId: string; defaultField: "title" | "meta_description" }) {
  return (
    <ActionForm action={proposeChangeAction} resetOnSuccess className="space-y-3">
      {({ pending, state }) => (
        <>
          <input type="hidden" name="websiteId" value={websiteId} />
          <input type="hidden" name="url" value={url} />
          <input type="hidden" name="findingId" value={findingId} />
          <Field label="Field" htmlFor="pc-field"><Select id="pc-field" name="field" defaultValue={defaultField}><option value="title">Title</option><option value="meta_description">Meta description</option></Select></Field>
          <Field label="New value" htmlFor="pc-value" error={fieldError(state, "value")}><Textarea id="pc-value" name="value" rows={3} required /></Field>
          <p className="text-2xs text-fg-subtle">The current value is read from WordPress and kept as a backup. Nothing changes until an approver accepts it.</p>
          <Button type="submit" size="sm" variant="primary" loading={pending}>Propose change</Button>
        </>
      )}
    </ActionForm>
  );
}

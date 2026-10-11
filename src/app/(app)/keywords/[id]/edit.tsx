"use client";

import { ActionForm, fieldError } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { updateKeywordAction } from "../actions";

export function KeywordEdit({ k }: { k: { id: string; group: string | null; targetUrl: string | null; tags: string[] } }) {
  return (
    <ActionForm action={updateKeywordAction} className="space-y-3">
      {({ pending, state }) => (
        <>
          <input type="hidden" name="id" value={k.id} />
          <Field label="Target URL" hint="The page you want to rank. Mismatches are flagged." error={fieldError(state, "_")}><Input name="targetUrl" type="url" defaultValue={k.targetUrl ?? ""} /></Field>
          <Field label="Group"><Input name="group" defaultValue={k.group ?? ""} /></Field>
          <Field label="Tags" hint="Comma separated"><Input name="tags" defaultValue={k.tags.join(", ")} /></Field>
          <Button type="submit" size="sm" variant="primary" loading={pending}>Save</Button>
        </>
      )}
    </ActionForm>
  );
}

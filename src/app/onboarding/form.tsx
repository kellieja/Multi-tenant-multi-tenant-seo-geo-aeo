"use client";

import { ActionForm, fieldError } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { createOrgAction } from "./actions";

export function OnboardingForm() {
  return (
    <ActionForm action={createOrgAction} refresh={false} className="mt-6 space-y-4">
      {({ pending, state }) => (
        <>
          <Field label="Workspace name" htmlFor="name" hint="Usually your agency or company name. Used on white-label reports." error={fieldError(state, "_")}>
            <Input id="name" name="name" required autoFocus placeholder="Northwind Digital" />
          </Field>
          <Button type="submit" variant="primary" className="w-full" loading={pending}>Create workspace</Button>
        </>
      )}
    </ActionForm>
  );
}

"use client";

import { ActionForm, fieldError } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { registerAction } from "../actions";

export function RegisterForm({ next }: { next?: string }) {
  return (
    <ActionForm action={registerAction} refresh={false} className="mt-6 space-y-4">
      {({ pending, state }) => (
        <>
          <input type="hidden" name="next" value={next ?? ""} />
          <Field label="Full name" htmlFor="name" error={fieldError(state, "name")}>
            <Input id="name" name="name" autoComplete="name" required autoFocus />
          </Field>
          <Field label="Work email" htmlFor="email" error={fieldError(state, "email")}>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </Field>
          <Field label="Password" htmlFor="password" error={fieldError(state, "password")} hint="At least 10 characters with a number or symbol.">
            <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} />
          </Field>
          <Button type="submit" variant="primary" className="w-full" loading={pending}>Create account</Button>
        </>
      )}
    </ActionForm>
  );
}

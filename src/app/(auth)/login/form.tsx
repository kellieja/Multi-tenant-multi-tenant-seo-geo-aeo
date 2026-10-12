"use client";

import { ActionForm, fieldError } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { loginAction } from "../actions";

export function LoginForm({ next }: { next?: string }) {
  return (
    <ActionForm action={loginAction} refresh={false} inlineError className="mt-6 space-y-4">
      {({ pending, state }) => (
        <>
          <input type="hidden" name="next" value={next ?? ""} />
          <Field label="Email" htmlFor="email" error={fieldError(state, "email")}>
            <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
          </Field>
          <Field label="Password" htmlFor="password" error={fieldError(state, "password")}>
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </Field>
          <Button type="submit" variant="primary" className="w-full" loading={pending}>Sign in</Button>
        </>
      )}
    </ActionForm>
  );
}

"use client";

import { useActionState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import type { ActionResult } from "@/lib/errors";
import { useToast } from "./toast";
import { Button, type ButtonProps } from "./button";
import { cn } from "@/lib/cn";

type ServerAction<T> = (prev: ActionResult<T> | null, formData: FormData) => Promise<ActionResult<T>>;

/**
 * Wraps a server action in a <form> with pending state, toast feedback and
 * field-level errors. Children may be a render function receiving state.
 */
export function ActionForm<T = undefined>({
  action, children, className, onSuccess, successMessage, refresh = true, resetOnSuccess, inlineError,
}: {
  action: ServerAction<T>;
  children: React.ReactNode | ((s: { pending: boolean; state: ActionResult<T> | null }) => React.ReactNode);
  className?: string;
  onSuccess?: (data: T) => void;
  successMessage?: string;
  refresh?: boolean;
  resetOnSuccess?: boolean;
  /** Show non-field errors inline instead of as a toast (auth forms, where a toast is easy to miss). */
  inlineError?: boolean;
}) {
  const toast = useToast();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  // Latest props in a ref so the wrapped action always sees current callbacks.
  const opts = useRef({ action, onSuccess, successMessage, refresh, resetOnSuccess, inlineError });
  opts.current = { action, onSuccess, successMessage, refresh, resetOnSuccess, inlineError };

  // Side effects run inside the action (not in an effect) so they still happen if the
  // action's revalidation unmounts this form, e.g. a "Create task" button that disappears.
  const wrapped = useCallback(async (prev: ActionResult<T> | null, fd: FormData) => {
    const o = opts.current;
    const res = await o.action(prev, fd);
    if (res.ok) {
      const msg = res.message ?? o.successMessage;
      if (msg) toast(msg, "good");
      if (o.resetOnSuccess) formRef.current?.reset();
      o.onSuccess?.(res.data);
      if (o.refresh) router.refresh();
    } else if (!o.inlineError && (!res.fieldErrors || Object.keys(res.fieldErrors).length === 0)) {
      toast(res.error, "bad");
    }
    return res;
  }, [toast, router]);

  const [state, formAction, pending] = useActionState(wrapped, null);

  return (
    <form ref={formRef} action={formAction} className={className}>
      {typeof children === "function" ? children({ pending, state }) : children}
      {state && !state.ok && (inlineError || (state.fieldErrors && Object.keys(state.fieldErrors).length > 0)) && (
        <p role="alert" className="mt-3 text-xs text-bad">{state.error}</p>
      )}
    </form>
  );
}

export function fieldError<T>(state: ActionResult<T> | null, name: string) {
  return state && !state.ok ? state.fieldErrors?.[name] : undefined;
}

/** A one-button form for row actions (pause, run, approve...). */
export function ActionButton<T = undefined>({
  action, fields, children, confirm, successMessage, className, ...btn
}: {
  action: ServerAction<T>;
  fields?: Record<string, string>;
  children: React.ReactNode;
  confirm?: string;
  successMessage?: string;
} & Omit<ButtonProps, "type" | "onClick">) {
  return (
    <ActionForm action={action} successMessage={successMessage} className={cn("inline-flex", className)}>
      {({ pending }) => (
        <>
          {fields && Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          <Button
            type="submit"
            loading={pending}
            onClick={(e) => {
              if (confirm && !window.confirm(confirm)) e.preventDefault();
            }}
            {...btn}
          >
            {children}
          </Button>
        </>
      )}
    </ActionForm>
  );
}

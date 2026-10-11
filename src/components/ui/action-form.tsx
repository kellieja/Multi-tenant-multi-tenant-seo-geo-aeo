"use client";

import { useActionState, useEffect, useRef } from "react";
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
  action, children, className, onSuccess, successMessage, refresh = true, resetOnSuccess,
}: {
  action: ServerAction<T>;
  children: React.ReactNode | ((s: { pending: boolean; state: ActionResult<T> | null }) => React.ReactNode);
  className?: string;
  onSuccess?: (data: T) => void;
  successMessage?: string;
  refresh?: boolean;
  resetOnSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const toast = useToast();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const last = useRef<ActionResult<T> | null>(null);

  useEffect(() => {
    if (!state || state === last.current) return;
    last.current = state;
    if (state.ok) {
      const msg = state.message ?? successMessage;
      if (msg) toast(msg, "good");
      if (resetOnSuccess) formRef.current?.reset();
      onSuccess?.(state.data);
      if (refresh) router.refresh();
    } else if (!state.fieldErrors || Object.keys(state.fieldErrors).length === 0) {
      toast(state.error, "bad");
    }
  }, [state, toast, router, onSuccess, successMessage, refresh, resetOnSuccess]);

  return (
    <form ref={formRef} action={formAction} className={className}>
      {typeof children === "function" ? children({ pending, state }) : children}
      {state && !state.ok && state.fieldErrors && Object.keys(state.fieldErrors).length > 0 && (
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

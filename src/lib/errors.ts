import { ZodError } from "zod";
import { ForbiddenError } from "@/lib/auth/rbac";
import { UnauthenticatedError } from "@/lib/auth/context";
import { TenantViolationError } from "@/lib/db/tenant";
import { RateLimitError } from "@/lib/rate-limit";

/** Errors whose message is safe and useful to show to the user. */
export class UserError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = "UserError";
  }
}

export class NotFoundError extends UserError {
  constructor(what = "Record") {
    super(`${what} not found`, 404);
  }
}

export type ActionResult<T = undefined> =
  | { ok: true; data: T; message?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export function toActionError(err: unknown): { ok: false; error: string; fieldErrors?: Record<string, string> } {
  if (err instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of err.issues) fieldErrors[issue.path.join(".") || "_"] = issue.message;
    return { ok: false, error: err.issues[0]?.message ?? "Invalid input", fieldErrors };
  }
  if (err instanceof UserError || err instanceof ForbiddenError || err instanceof RateLimitError || err instanceof UnauthenticatedError) {
    return { ok: false, error: err.message };
  }
  if (err instanceof TenantViolationError) {
    console.error("[tenant-violation]", err);
    return { ok: false, error: "Not permitted" };
  }
  // Next.js redirect/notFound signals must propagate.
  if (err && typeof err === "object" && "digest" in err && String((err as { digest: unknown }).digest).startsWith("NEXT_")) throw err;
  console.error("[action-error]", err);
  return { ok: false, error: "Something went wrong. The error has been logged." };
}

export function httpStatusFor(err: unknown): number {
  if (err instanceof ZodError) return 400;
  if (err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return 500;
}

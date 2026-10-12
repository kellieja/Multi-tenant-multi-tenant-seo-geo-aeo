"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { authenticate, registerUser } from "@/server/auth";
import { requestMeta, startSession, endSession } from "@/lib/auth/session";
import { rateLimit } from "@/lib/rate-limit";
import { toActionError, type ActionResult } from "@/lib/errors";

/** Only same-origin paths. Rejects "//host", "/\\host" (browsers treat "\\" as "/") and control characters. */
function safeNext(next: FormDataEntryValue | null) {
  const n = typeof next === "string" ? next : "";
  if (!n.startsWith("/") || /[\\\u0000-\u001f\u007f]/.test(n)) return "/dashboard";
  try {
    const u = new URL(n, "http://app.invalid");
    return u.origin === "http://app.invalid" ? `${u.pathname}${u.search}${u.hash}` : "/dashboard";
  } catch { return "/dashboard"; }
}

export async function loginAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  let next = "/dashboard";
  try {
    const { ip } = await requestMeta();
    const email = String(fd.get("email") ?? "").toLowerCase();
    await rateLimit(`login:ip:${ip ?? "unknown"}`, 30, 300, false);
    await rateLimit(`login:email:${email}`, 10, 300, false);
    const user = await authenticate({ email, password: fd.get("password") }, ip);
    const membership = await prisma.membership.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
    await startSession(user.id, membership?.organizationId ?? null);
    next = membership ? safeNext(fd.get("next")) : "/onboarding";
  } catch (err) {
    return toActionError(err);
  }
  redirect(next);
}

export async function registerAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  try {
    const { ip } = await requestMeta();
    await rateLimit(`register:ip:${ip ?? "unknown"}`, 10, 3600, false);
    const user = await registerUser({ name: fd.get("name"), email: fd.get("email"), password: fd.get("password") });
    await startSession(user.id, null);
  } catch (err) {
    return toActionError(err);
  }
  const next = safeNext(fd.get("next"));
  redirect(next.startsWith("/invite/") ? next : "/onboarding");
}

export async function logoutAction() {
  await endSession();
  redirect("/login");
}

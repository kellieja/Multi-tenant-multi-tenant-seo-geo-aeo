"use server";

import { revalidatePath } from "next/cache";
import { getOrgContextOrThrow, assertWebsiteAccess } from "@/lib/auth/context";
import { enqueueJob } from "@/lib/jobs/queue";
import { toActionError, type ActionResult } from "@/lib/errors";

export async function runPsiAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    ctx.assert("audits:run");
    const websiteId = String(fd.get("websiteId"));
    await assertWebsiteAccess(ctx, websiteId);
    const { job, deduped } = await enqueueJob({ organizationId: ctx.org.id, websiteId, type: "psi-check", createdById: ctx.userId, dedupe: true });
    revalidatePath("/technical");
    if (job.status === "FAILED") return { ok: false, error: job.error ?? "Could not queue" };
    return { ok: true, data: undefined, message: deduped ? "A PageSpeed check is already running" : "PageSpeed check queued (homepage + top pages, mobile & desktop)" };
  } catch (e) { return toActionError(e); }
}

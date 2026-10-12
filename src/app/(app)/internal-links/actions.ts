"use server";

import { revalidatePath } from "next/cache";
import { getOrgContextOrThrow, assertWebsiteAccess } from "@/lib/auth/context";
import { enqueueJob } from "@/lib/jobs/queue";
import { toActionError, UserError, type ActionResult } from "@/lib/errors";
import { setLinkSuggestionStatus, proposeInternalLink } from "@/server/internal-links";

export async function runLinkAnalysisAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    ctx.assert("content:write");
    const websiteId = String(fd.get("websiteId"));
    await assertWebsiteAccess(ctx, websiteId);
    if (!(await ctx.db.crawl.findFirst({ where: { websiteId, status: "SUCCEEDED" }, select: { id: true } }))) throw new UserError("Run a crawl first");
    const { job, deduped } = await enqueueJob({ organizationId: ctx.org.id, websiteId, type: "internal-links", payload: {}, createdById: ctx.userId, dedupe: true });
    if (job.status === "FAILED") throw new UserError(job.error ?? "Could not queue");
    revalidatePath("/internal-links");
    return { ok: true, data: undefined, message: deduped ? "Already running" : "Link analysis queued" };
  } catch (e) { return toActionError(e); }
}

export async function linkStatusAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const status = String(fd.get("status"));
    if (!["APPROVED", "REJECTED", "SUGGESTED"].includes(status)) throw new UserError("Invalid status");
    await setLinkSuggestionStatus(await getOrgContextOrThrow(), String(fd.get("id")), status as "APPROVED" | "REJECTED" | "SUGGESTED");
    revalidatePath("/internal-links");
    return { ok: true, data: undefined, message: status === "APPROVED" ? "Accepted" : status === "REJECTED" ? "Rejected" : "Reopened" };
  } catch (e) { return toActionError(e); }
}

export async function proposeLinkAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    await proposeInternalLink(await getOrgContextOrThrow(), String(fd.get("id")));
    revalidatePath("/internal-links");
    return { ok: true, data: undefined, message: "Sent for site-change approval" };
  } catch (e) { return toActionError(e); }
}

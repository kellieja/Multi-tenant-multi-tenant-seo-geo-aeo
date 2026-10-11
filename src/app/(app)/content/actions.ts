"use server";

import { revalidatePath } from "next/cache";
import { getOrgContextOrThrow, assertWebsiteAccess } from "@/lib/auth/context";
import { enqueueJob } from "@/lib/jobs/queue";
import { toActionError, UserError, type ActionResult } from "@/lib/errors";
import { NoAiProviderError, getAiClient } from "@/integrations/ai";
import { analyzeContent, compareWithCompetitor, generateBrief, updateSuggestionStatus, editSuggestion, proposeSuggestionToSite } from "@/server/content-studio";

const str = (fd: FormData, k: string) => (fd.get(k) == null ? undefined : String(fd.get(k)));
const aiError = (e: unknown) => (e instanceof NoAiProviderError ? { ok: false as const, error: e.message } : toActionError(e));

export async function analyzeAction(_: unknown, fd: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const r = await analyzeContent(await getOrgContextOrThrow(), { websiteId: str(fd, "websiteId")!, url: str(fd, "url"), text: str(fd, "text"), keyword: str(fd, "keyword") });
    return { ok: true, data: { id: r.id } };
  } catch (e) { return toActionError(e); }
}

export async function compareAction(_: unknown, fd: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const r = await compareWithCompetitor(await getOrgContextOrThrow(), { websiteId: str(fd, "websiteId")!, url: str(fd, "url")!, competitorUrl: str(fd, "competitorUrl")!, keyword: str(fd, "keyword") });
    return { ok: true, data: { id: r.id } };
  } catch (e) { return toActionError(e); }
}

export async function briefAction(_: unknown, fd: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const r = await generateBrief(await getOrgContextOrThrow(), { websiteId: str(fd, "websiteId")!, keyword: str(fd, "keyword")!, url: str(fd, "url"), audience: str(fd, "audience") });
    return { ok: true, data: { id: r.id }, message: "Brief created" };
  } catch (e) { return aiError(e); }
}

export async function metadataJobAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    ctx.assert("content:write");
    const websiteId = String(fd.get("websiteId"));
    await assertWebsiteAccess(ctx, websiteId);
    if (!(await getAiClient(ctx.org.id))) throw new NoAiProviderError();
    const url = str(fd, "url");
    const { job, deduped } = await enqueueJob({ organizationId: ctx.org.id, websiteId, type: "metadata-suggest", payload: { urls: url ? [url] : undefined, limit: 10 }, createdById: ctx.userId, dedupe: !url });
    if (job.status === "FAILED") throw new UserError(job.error ?? "Could not queue");
    return { ok: true, data: undefined, message: deduped ? "Already running" : "Drafting suggestions in the background" };
  } catch (e) { return aiError(e); }
}

export async function suggestionStatusAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const status = String(fd.get("status"));
    if (!["APPROVED", "REJECTED", "SUGGESTED"].includes(status)) throw new UserError("Invalid status");
    await updateSuggestionStatus(await getOrgContextOrThrow(), String(fd.get("id")), status as "APPROVED" | "REJECTED" | "SUGGESTED");
    revalidatePath("/content");
    return { ok: true, data: undefined, message: status === "APPROVED" ? "Approved" : status === "REJECTED" ? "Rejected" : "Reopened" };
  } catch (e) { return toActionError(e); }
}

export async function editSuggestionAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    await editSuggestion(await getOrgContextOrThrow(), String(fd.get("id")), { title: str(fd, "title"), metaDescription: str(fd, "metaDescription"), text: str(fd, "text") });
    revalidatePath("/content");
    return { ok: true, data: undefined, message: "Saved. Review and approve when ready." };
  } catch (e) { return toActionError(e); }
}

export async function proposeSuggestionAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const r = await proposeSuggestionToSite(await getOrgContextOrThrow(), String(fd.get("id")));
    revalidatePath("/content");
    return { ok: true, data: undefined, message: `${r.proposed} change(s) sent for site-change approval` };
  } catch (e) { return toActionError(e); }
}

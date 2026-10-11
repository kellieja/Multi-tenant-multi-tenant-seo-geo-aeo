"use server";

import { revalidatePath } from "next/cache";
import type { OutreachStage } from "@prisma/client";
import { getOrgContextOrThrow, assertWebsiteAccess } from "@/lib/auth/context";
import { enqueueJob } from "@/lib/jobs/queue";
import { toActionError, UserError, type ActionResult } from "@/lib/errors";
import { addBacklink, addDisavow, importBacklinksCsv, reviewDisavow } from "@/server/backlinks";
import { addProspect, createCampaign, draftCampaignMessages, recordReply, requestSendApproval, saveTemplate, setProspectStage, updateDraft, STAGES } from "@/server/outreach";

const done = (message: string): ActionResult => { revalidatePath("/backlinks"); return { ok: true, data: undefined, message }; };
const site = (fd: FormData) => String(fd.get("websiteId") ?? "");

export async function importBacklinksAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const file = fd.get("file");
    const text = file instanceof File && file.size ? await file.text() : String(fd.get("csv") ?? "");
    const r = await importBacklinksCsv(await getOrgContextOrThrow(), site(fd), text);
    return done(`${r.created} added, ${r.updated} updated${r.skipped.length ? `, ${r.skipped.length} skipped (${r.skipped.slice(0, 2).map((s) => `row ${s.row}: ${s.reason}`).join("; ")})` : ""}`);
  } catch (e) { return toActionError(e); }
}

export async function addBacklinkAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try { await addBacklink(await getOrgContextOrThrow(), site(fd), { sourceUrl: fd.get("sourceUrl"), targetUrl: fd.get("targetUrl"), anchor: fd.get("anchor"), rel: fd.get("rel") }); return done("Backlink added. Run verification to confirm it's live."); } catch (e) { return toActionError(e); }
}

export async function queueAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    ctx.assert("backlinks:write");
    await assertWebsiteAccess(ctx, site(fd));
    const type = String(fd.get("type"));
    if (!["backlink-sync", "backlink-verify", "link-gap", "unlinked-mentions"].includes(type)) throw new UserError("Unknown job");
    const { job, deduped } = await enqueueJob({ organizationId: ctx.org.id, websiteId: site(fd), type: type as "backlink-sync", createdById: ctx.userId, dedupe: true });
    if (job.status === "FAILED") throw new UserError(job.error ?? "Could not queue");
    return done(deduped ? "Already running" : "Queued. Progress is shown in Automation Center → Background jobs.");
  } catch (e) { return toActionError(e); }
}

export async function disavowAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try { await addDisavow(await getOrgContextOrThrow(), site(fd), String(fd.get("value")), String(fd.get("reason") ?? "")); return done("Added for review. It is not exported until a reviewer includes it."); } catch (e) { return toActionError(e); }
}

export async function reviewDisavowAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try { await reviewDisavow(await getOrgContextOrThrow(), String(fd.get("id")), fd.get("include") === "1"); return done("Review saved"); } catch (e) { return toActionError(e); }
}

export async function addProspectAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const r = await addProspect(await getOrgContextOrThrow(), site(fd), { url: String(fd.get("url")), contactName: String(fd.get("contactName") ?? ""), contactEmail: String(fd.get("contactEmail") ?? ""), targetUrl: String(fd.get("targetUrl") ?? ""), notes: String(fd.get("notes") ?? ""), research: fd.get("research") === "on" });
    return done(`Prospect added${r.research ? ` (relevance ${r.research.relevanceScore}, ${r.research.contacts.length} public contact${r.research.contacts.length === 1 ? "" : "s"})` : ""}${r.duplicateDomain ? ". This domain already had another prospect." : ""}`);
  } catch (e) { return toActionError(e); }
}

export async function stageAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const stage = String(fd.get("stage")) as OutreachStage;
    if (!STAGES.includes(stage)) throw new UserError("Invalid stage");
    await setProspectStage(await getOrgContextOrThrow(), String(fd.get("id")), stage, { acquiredLinkUrl: String(fd.get("acquiredLinkUrl") ?? "") || undefined, note: String(fd.get("note") ?? "") || undefined });
    return done(stage === "ACQUIRED" ? "Marked acquired. The link will be verified automatically." : "Stage updated");
  } catch (e) { return toActionError(e); }
}

export async function replyAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try { await recordReply(await getOrgContextOrThrow(), String(fd.get("id")), String(fd.get("body") ?? "")); return done("Reply recorded"); } catch (e) { return toActionError(e); }
}

export async function templateAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try { await saveTemplate(await getOrgContextOrThrow(), { name: fd.get("name"), subject: fd.get("subject"), body: fd.get("body") }, String(fd.get("id") ?? "") || undefined); return done("Template saved"); } catch (e) { return toActionError(e); }
}

export async function campaignAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try { await createCampaign(await getOrgContextOrThrow(), site(fd), { name: String(fd.get("name")), templateId: String(fd.get("templateId") ?? "") || null, followUpDays: Number(fd.get("followUpDays") ?? 5) }); return done("Campaign created"); } catch (e) { return toActionError(e); }
}

export async function draftAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const r = await draftCampaignMessages(await getOrgContextOrThrow(), String(fd.get("campaignId")), fd.getAll("prospectId").map(String));
    return done(`${r.drafted} draft${r.drafted === 1 ? "" : "s"} created${r.skipped.length ? `; skipped ${r.skipped.length} (${r.skipped.slice(0, 2).join("; ")})` : ""}. Review them, then request send approval.`);
  } catch (e) { return toActionError(e); }
}

export async function editDraftAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try { await updateDraft(await getOrgContextOrThrow(), String(fd.get("id")), String(fd.get("subject")), String(fd.get("body"))); return done("Draft saved"); } catch (e) { return toActionError(e); }
}

export async function requestSendAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try { const a = await requestSendApproval(await getOrgContextOrThrow(), fd.getAll("messageId").map(String)); return done(`Approval requested (${a.summary}). Another approver must accept before anything is sent.`); } catch (e) { return toActionError(e); }
}

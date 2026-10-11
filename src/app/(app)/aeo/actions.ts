"use server";

import { revalidatePath } from "next/cache";
import { getOrgContextOrThrow, assertWebsiteAccess } from "@/lib/auth/context";
import { enqueueJob } from "@/lib/jobs/queue";
import { toActionError, UserError, type ActionResult } from "@/lib/errors";
import { draftAnswer } from "@/server/aeo";
import { validateStructuredData, type SchemaIssue } from "@/audit/schema";

const done = (message: string): ActionResult => { revalidatePath("/aeo"); return { ok: true, data: undefined, message }; };

export async function aeoJobAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    ctx.assert("content:write");
    const websiteId = String(fd.get("websiteId"));
    await assertWebsiteAccess(ctx, websiteId);
    const type = fd.get("type") === "opportunities" ? "aeo-opportunities" : "aeo-assess";
    const { job, deduped } = await enqueueJob({ organizationId: ctx.org.id, websiteId, type, payload: type === "aeo-opportunities" ? { paa: fd.get("paa") === "1" } : { limit: 30 }, createdById: ctx.userId, dedupe: true });
    if (job.status === "FAILED") throw new UserError(job.error ?? "Could not queue");
    return done(deduped ? "Already running" : type === "aeo-assess" ? "Assessment queued for up to 30 key pages" : "Finding question opportunities…");
  } catch (e) { return toActionError(e); }
}

export async function oppStatusAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    ctx.assert("content:write");
    const status = String(fd.get("status"));
    if (!["OPEN", "IN_PROGRESS", "DONE", "DISMISSED"].includes(status)) throw new UserError("Invalid status");
    await ctx.db.aeoOpportunity.update({ where: { id: String(fd.get("id")) }, data: { status } });
    return done("Status updated");
  } catch (e) { return toActionError(e); }
}

export async function draftAnswerAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const s = await draftAnswer(await getOrgContextOrThrow(), String(fd.get("id")));
    revalidatePath("/content");
    return { ok: true, data: undefined, message: `Draft created by ${s.provider} (${s.model}). Review it in Content Studio.` };
  } catch (e) { return toActionError(e); }
}

export async function validateSchemaAction(_: unknown, fd: FormData): Promise<ActionResult<{ issues: SchemaIssue[] }>> {
  try {
    await getOrgContextOrThrow();
    const raw = String(fd.get("json") ?? "").trim().replace(/^<script[^>]*>|<\/script>$/gi, "");
    let data: unknown;
    try { data = JSON.parse(raw); } catch (e) { throw new UserError(`Invalid JSON: ${(e as Error).message}`); }
    return { ok: true, data: { issues: validateStructuredData(data) } };
  } catch (e) { return toActionError(e); }
}

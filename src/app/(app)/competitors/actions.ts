"use server";

import { revalidatePath } from "next/cache";
import { getOrgContextOrThrow } from "@/lib/auth/context";
import { enqueueJob } from "@/lib/jobs/queue";
import { toActionError, UserError, type ActionResult } from "@/lib/errors";
import { addCompetitor, removeCompetitor, suggestCompetitors } from "@/server/competitors";
import { findConnection } from "@/integrations/connections";

const done = (message: string): ActionResult => { revalidatePath("/competitors"); return { ok: true, data: undefined, message }; };

export async function addCompetitorAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try { const c = await addCompetitor(await getOrgContextOrThrow(), String(fd.get("websiteId")), { domain: String(fd.get("domain") ?? ""), name: String(fd.get("name") ?? ""), brandTerms: String(fd.get("brandTerms") ?? "") }); return done(`${c.domain} added`); } catch (e) { return toActionError(e); }
}
export async function removeCompetitorAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try { await removeCompetitor(await getOrgContextOrThrow(), String(fd.get("id"))); return done("Competitor removed"); } catch (e) { return toActionError(e); }
}
export async function suggestAction(_: unknown, fd: FormData): Promise<ActionResult<{ items: { domain: string; sharedKeywords: number | null; avgPosition: number | null }[] }>> {
  try { return { ok: true, data: { items: await suggestCompetitors(await getOrgContextOrThrow(), String(fd.get("websiteId"))) } }; } catch (e) { return toActionError(e); }
}
export async function gapAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    ctx.assert("keywords:write");
    const comp = await ctx.db.competitor.findUnique({ where: { id: String(fd.get("id")) } });
    if (!comp) throw new UserError("Competitor not found");
    if (!(await findConnection(ctx.org.id, "DATAFORSEO", null))) throw new UserError("Keyword gap analysis needs DataForSEO");
    await enqueueJob({ organizationId: ctx.org.id, websiteId: comp.websiteId, type: "competitor-gap", payload: { competitorId: comp.id }, createdById: ctx.userId });
    return done("Gap analysis queued");
  } catch (e) { return toActionError(e); }
}

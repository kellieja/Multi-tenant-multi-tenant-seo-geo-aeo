"use server";

import { revalidatePath } from "next/cache";
import { getOrgContextOrThrow, assertWebsiteAccess } from "@/lib/auth/context";
import { enqueueJob } from "@/lib/jobs/queue";
import { toActionError, UserError, type ActionResult } from "@/lib/errors";
import { addKeywords, deleteKeywords, parseKeywordInput, queueRankCheck, trackGscQueries, updateKeyword } from "@/server/keywords";
import { findConnection } from "@/integrations/connections";
import { DataForSeoClient } from "@/integrations/dataforseo";
import { readSettings } from "@/server/websites";

const done = (message: string): ActionResult => { revalidatePath("/keywords"); return { ok: true, data: undefined, message }; };

export async function addKeywordsAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    const file = fd.get("file");
    const text = file instanceof File && file.size ? await file.text() : String(fd.get("keywords") ?? "");
    const rows = parseKeywordInput(text).map((r) => ({ ...r, group: r.group || String(fd.get("group") ?? "") || null, device: (String(fd.get("device") ?? "desktop") as "desktop") }));
    if (!rows.length) throw new UserError("Enter at least one keyword");
    const r = await addKeywords(ctx, String(fd.get("websiteId")), rows);
    return done(`${r.added} keyword${r.added === 1 ? "" : "s"} added${r.skipped ? `, ${r.skipped} duplicates/invalid skipped` : ""}`);
  } catch (e) { return toActionError(e); }
}

export async function trackQueriesAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try { const r = await trackGscQueries(await getOrgContextOrThrow(), String(fd.get("websiteId")), fd.getAll("query").map(String)); return done(`${r.added} quer${r.added === 1 ? "y" : "ies"} now tracked`); } catch (e) { return toActionError(e); }
}

export async function deleteKeywordsAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try { const n = await deleteKeywords(await getOrgContextOrThrow(), fd.getAll("id").map(String)); return done(`${n} removed`); } catch (e) { return toActionError(e); }
}

export async function updateKeywordAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    await updateKeyword(await getOrgContextOrThrow(), String(fd.get("id")), { group: String(fd.get("group") ?? "") || null, targetUrl: String(fd.get("targetUrl") ?? "") || null, tags: String(fd.get("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean) });
    return done("Keyword updated");
  } catch (e) { return toActionError(e); }
}

export async function rankCheckAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    if (!(await findConnection(ctx.org.id, "DATAFORSEO", null))) throw new UserError("Connect DataForSEO in Integrations to check rankings. Search Console positions are shown without it.");
    const { job, deduped } = await queueRankCheck(ctx, String(fd.get("websiteId")));
    if (job.status === "FAILED") throw new UserError(job.error ?? "Could not queue");
    return done(deduped ? "A rank check is already running" : "Rank check queued");
  } catch (e) { return toActionError(e); }
}

export async function metricsAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    ctx.assert("keywords:write");
    const websiteId = String(fd.get("websiteId"));
    await assertWebsiteAccess(ctx, websiteId);
    if (!(await findConnection(ctx.org.id, "DATAFORSEO", null))) throw new UserError("Search volume and intent data need DataForSEO");
    await enqueueJob({ organizationId: ctx.org.id, websiteId, type: "keyword-metrics", createdById: ctx.userId, dedupe: true });
    return done("Volume & intent refresh queued");
  } catch (e) { return toActionError(e); }
}

export async function ideasAction(_: unknown, fd: FormData): Promise<ActionResult<{ ideas: { keyword: string; volume: number | null; difficulty: number | null; intent: string | null }[] }>> {
  try {
    const ctx = await getOrgContextOrThrow();
    const site = await assertWebsiteAccess(ctx, String(fd.get("websiteId")));
    const conn = await findConnection(ctx.org.id, "DATAFORSEO", null);
    if (!conn) throw new UserError("Keyword research needs DataForSEO");
    const s = readSettings(site.settings);
    const seeds = String(fd.get("seeds") ?? "").split(/[\n,]/).map((x) => x.trim()).filter(Boolean).slice(0, 20);
    if (!seeds.length) throw new UserError("Enter at least one seed keyword");
    const dfs = new DataForSeoClient(conn);
    const items = await dfs.keywordIdeas(seeds, s.rankLocationCode, s.rankLanguageCode, 100);
    return { ok: true, data: { ideas: items.map((i) => ({ keyword: i.keyword, volume: i.keyword_info?.search_volume ?? null, difficulty: i.keyword_properties?.keyword_difficulty ?? null, intent: i.search_intent_info?.main_intent ?? null })) }, message: `${items.length} ideas (cost $${dfs.cost.toFixed(3)})` };
  } catch (e) { return toActionError(e); }
}

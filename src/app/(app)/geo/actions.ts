"use server";

import { revalidatePath } from "next/cache";
import { getOrgContextOrThrow } from "@/lib/auth/context";
import { toActionError, UserError, type ActionResult } from "@/lib/errors";
import { savePromptSet, runPromptSetNow } from "@/server/geo";
import type { AiProviderId } from "@/integrations/ai";

const done = (message: string): ActionResult => { revalidatePath("/geo"); return { ok: true, data: undefined, message }; };

export async function savePromptSetAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    const id = String(fd.get("id") ?? "") || undefined;
    await savePromptSet(ctx, String(fd.get("websiteId")), {
      name: String(fd.get("name") ?? ""), market: String(fd.get("market") ?? "US"), language: String(fd.get("language") ?? "en"),
      platforms: fd.getAll("platforms").map(String) as AiProviderId[],
      competitorTerms: String(fd.get("competitorTerms") ?? "").split(",").map((t) => t.trim()).filter(Boolean),
      prompts: String(fd.get("prompts") ?? "").split(/\r?\n/).map((p) => p.trim()).filter(Boolean),
      schedule: String(fd.get("schedule") ?? ""),
    }, id);
    return done(id ? "Prompt set saved" : "Prompt set created");
  } catch (e) { return toActionError(e); }
}

export async function runSetAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const r = await runPromptSetNow(await getOrgContextOrThrow(), String(fd.get("id")));
    if (r.job.status === "FAILED") throw new UserError(r.job.error ?? "Could not queue");
    return done(`Queued ${r.calls} prompt check${r.calls === 1 ? "" : "s"}. Each is a paid API call to the provider.`);
  } catch (e) { return toActionError(e); }
}

export async function toggleSetAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    ctx.assert("geo:write");
    await ctx.db.geoPromptSet.update({ where: { id: String(fd.get("id")) }, data: { enabled: fd.get("enabled") === "1" } });
    return done("Updated");
  } catch (e) { return toActionError(e); }
}

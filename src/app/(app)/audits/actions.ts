"use server";

import { revalidatePath } from "next/cache";
import type { FindingStatus } from "@prisma/client";
import { getOrgContextOrThrow } from "@/lib/auth/context";
import { toActionError, UserError, type ActionResult } from "@/lib/errors";
import { createTaskFromFinding, setFindingStatus, startCrawl } from "@/server/crawls";

export async function startCrawlAction(_: unknown, fd: FormData): Promise<ActionResult<{ crawlId: string }>> {
  try {
    const ctx = await getOrgContextOrThrow();
    const websiteId = String(fd.get("websiteId") ?? "");
    if (!websiteId) throw new UserError("Choose a website");
    const mode = fd.get("mode") === "INCREMENTAL" ? "INCREMENTAL" : "FULL";
    const { crawl, deduped } = await startCrawl(ctx, websiteId, mode);
    // No revalidatePath here: the client navigates to the crawl page, and revalidating would
    // unmount the dialog that issued this action before it can navigate.
    if (crawl.status === "FAILED") return { ok: false, error: ((crawl.summary as { error?: string }).error) ?? "Could not queue the crawl" };
    return { ok: true, data: { crawlId: crawl.id }, message: deduped ? "A crawl is already running for this site" : `${mode === "FULL" ? "Full" : "Incremental"} crawl queued` };
  } catch (e) {
    return toActionError(e);
  }
}

const STATUSES: FindingStatus[] = ["OPEN", "IN_PROGRESS", "RESOLVED", "IGNORED"];

export async function setFindingStatusAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    const status = String(fd.get("status")) as FindingStatus;
    if (!STATUSES.includes(status)) throw new UserError("Invalid status");
    const ids = fd.getAll("id").map(String).slice(0, 500);
    for (const id of ids) await setFindingStatus(ctx, id, status, String(fd.get("note") ?? "") || undefined);
    revalidatePath("/audits");
    return { ok: true, data: undefined, message: `${ids.length} finding${ids.length === 1 ? "" : "s"} marked ${status.toLowerCase().replace("_", " ")}` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function createTaskAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    const ids = fd.getAll("id").map(String).slice(0, 200);
    for (const id of ids) await createTaskFromFinding(ctx, id, String(fd.get("assigneeId") ?? "") || null);
    revalidatePath("/audits");
    return { ok: true, data: undefined, message: `${ids.length} task${ids.length === 1 ? "" : "s"} created` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function proposeChangeAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    const { proposeSiteChange } = await import("@/server/site-changes");
    await proposeSiteChange(ctx, { websiteId: String(fd.get("websiteId")), url: String(fd.get("url")), field: String(fd.get("field")) as "title", value: String(fd.get("value") ?? ""), source: "finding", findingId: String(fd.get("findingId") ?? "") || undefined });
    revalidatePath("/automation");
    return { ok: true, data: undefined, message: "Change proposed. It's in the approval queue with a backup of the current value." };
  } catch (e) {
    return toActionError(e);
  }
}

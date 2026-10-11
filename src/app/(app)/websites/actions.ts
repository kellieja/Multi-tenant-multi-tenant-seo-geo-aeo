"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getOrgContextOrThrow } from "@/lib/auth/context";
import { toActionError, type ActionResult } from "@/lib/errors";
import {
  createWebsite, deleteWebsite, importWebsitesCsv, setAssignments, setWebsiteStatus, updateWebsite,
  updateWebsiteSettings, type CsvImportResult,
} from "@/server/websites";

function websiteInput(fd: FormData) {
  return {
    name: String(fd.get("name") ?? ""),
    url: String(fd.get("url") ?? ""),
    clientId: String(fd.get("clientId") ?? "") || null,
    project: String(fd.get("project") ?? ""),
    industry: String(fd.get("industry") ?? ""),
    folder: String(fd.get("folder") ?? ""),
    tags: String(fd.get("tags") ?? ""),
    brandTerms: String(fd.get("brandTerms") ?? ""),
    cmsType: (String(fd.get("cmsType") ?? "NONE") || "NONE") as "NONE",
  };
}

export async function createWebsiteAction(_: unknown, fd: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await getOrgContextOrThrow();
    const site = await createWebsite(ctx, websiteInput(fd));
    revalidatePath("/websites");
    return { ok: true, data: { id: site.id }, message: `${site.domain} added` };
  } catch (err) {
    return toActionError(err);
  }
}

export async function updateWebsiteAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    await updateWebsite(ctx, String(fd.get("id")), websiteInput(fd));
    revalidatePath("/websites");
    return { ok: true, data: undefined, message: "Website updated" };
  } catch (err) {
    return toActionError(err);
  }
}

export async function setStatusAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    const status = String(fd.get("status")) as "ACTIVE" | "PAUSED" | "ARCHIVED";
    if (!["ACTIVE", "PAUSED", "ARCHIVED"].includes(status)) throw new Error("bad status");
    await setWebsiteStatus(ctx, String(fd.get("id")), status);
    revalidatePath("/websites");
    return { ok: true, data: undefined, message: { ACTIVE: "Website resumed", PAUSED: "Website paused. Scheduled jobs will skip it.", ARCHIVED: "Website archived" }[status] };
  } catch (err) {
    return toActionError(err);
  }
}

export async function deleteWebsiteAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    await deleteWebsite(ctx, String(fd.get("id")), String(fd.get("confirm") ?? ""));
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath("/websites");
  redirect("/websites");
}

export async function importCsvAction(_: unknown, fd: FormData): Promise<ActionResult<CsvImportResult>> {
  try {
    const ctx = await getOrgContextOrThrow();
    const file = fd.get("file");
    const text = file instanceof File && file.size > 0 ? await file.text() : String(fd.get("csv") ?? "");
    const result = await importWebsitesCsv(ctx, text);
    revalidatePath("/websites");
    return { ok: true, data: result, message: `Imported ${result.created} website${result.created === 1 ? "" : "s"}${result.skipped.length ? `, ${result.skipped.length} skipped` : ""}` };
  } catch (err) {
    return toActionError(err);
  }
}

export async function updateSettingsAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    const raw: Record<string, unknown> = {};
    for (const [k, v] of fd.entries()) if (k !== "id" && !k.startsWith("$")) raw[k] = v;
    raw.checkExternalLinks = fd.get("checkExternalLinks") === "on";
    await updateWebsiteSettings(ctx, String(fd.get("id")), raw);
    revalidatePath(`/websites/${fd.get("id")}`);
    return { ok: true, data: undefined, message: "Settings saved" };
  } catch (err) {
    return toActionError(err);
  }
}

export async function setAssignmentsAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    await setAssignments(ctx, String(fd.get("id")), fd.getAll("userId").map(String));
    return { ok: true, data: undefined, message: "Team assignments updated" };
  } catch (err) {
    return toActionError(err);
  }
}

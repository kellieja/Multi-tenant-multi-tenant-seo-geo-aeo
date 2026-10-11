"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getOrgContextOrThrow } from "@/lib/auth/context";
import { toActionError, type ActionResult } from "@/lib/errors";
import { writeAuditLog } from "@/lib/audit-log";
import { createReport, approveReport, updateReportNotes, deleteReport, sendReportNow, saveSchedule } from "@/server/reports";

const list = (fd: FormData, k: string) => fd.getAll(k).map(String).filter(Boolean);

export async function createReportAction(_: unknown, fd: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const r = await createReport(await getOrgContextOrThrow(), {
      title: String(fd.get("title") ?? ""), websiteIds: list(fd, "websiteIds"), clientId: String(fd.get("clientId") ?? ""),
      from: String(fd.get("from") ?? ""), to: String(fd.get("to") ?? ""), notes: String(fd.get("notes") ?? ""),
    });
    revalidatePath("/reports");
    return { ok: true, data: { id: r.id } };
  } catch (e) { return toActionError(e); }
}

export async function approveReportAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    await approveReport(await getOrgContextOrThrow(), String(fd.get("id")));
    revalidatePath("/reports");
    return { ok: true, data: undefined, message: "Approved. Clients with access can now see it." };
  } catch (e) { return toActionError(e); }
}

export async function notesAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    await updateReportNotes(await getOrgContextOrThrow(), String(fd.get("id")), String(fd.get("notes") ?? ""));
    revalidatePath("/reports");
    return { ok: true, data: undefined, message: "Commentary saved" };
  } catch (e) { return toActionError(e); }
}

export async function sendReportAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const n = await sendReportNow(await getOrgContextOrThrow(), String(fd.get("id")), String(fd.get("recipients") ?? ""));
    return { ok: true, data: undefined, message: `Sent to ${n} recipient(s)` };
  } catch (e) { return toActionError(e); }
}

export async function deleteReportAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    await deleteReport(await getOrgContextOrThrow(), String(fd.get("id")));
  } catch (e) { return toActionError(e); }
  revalidatePath("/reports");
  redirect("/reports");
}

export async function saveScheduleAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const id = String(fd.get("id") ?? "") || undefined;
    await saveSchedule(await getOrgContextOrThrow(), {
      name: String(fd.get("name") ?? ""), websiteIds: list(fd, "websiteIds"), clientId: String(fd.get("clientId") ?? ""),
      frequency: String(fd.get("frequency")) as "WEEKLY" | "MONTHLY", recipients: String(fd.get("recipients") ?? "").split(/[\s,;]+/).filter(Boolean), autoApprove: fd.get("autoApprove") === "on",
    }, id);
    revalidatePath("/reports");
    return { ok: true, data: undefined, message: id ? "Schedule updated" : "Schedule created" };
  } catch (e) { return toActionError(e); }
}

export async function toggleScheduleAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    ctx.assert("reports:write");
    const id = String(fd.get("id"));
    const enabled = fd.get("enabled") === "1";
    await ctx.db.reportSchedule.update({ where: { id }, data: { enabled } });
    await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: enabled ? "report_schedule.enable" : "report_schedule.disable", entityType: "ReportSchedule", entityId: id });
    revalidatePath("/reports");
    return { ok: true, data: undefined, message: enabled ? "Schedule resumed" : "Schedule paused" };
  } catch (e) { return toActionError(e); }
}

export async function deleteScheduleAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    ctx.assert("reports:approve");
    const id = String(fd.get("id"));
    await ctx.db.reportSchedule.delete({ where: { id } });
    await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: "report_schedule.delete", entityType: "ReportSchedule", entityId: id });
    revalidatePath("/reports");
    return { ok: true, data: undefined, message: "Schedule deleted" };
  } catch (e) { return toActionError(e); }
}

"use server";

import { revalidatePath } from "next/cache";
import type { TaskStatus } from "@prisma/client";
import { getOrgContextOrThrow } from "@/lib/auth/context";
import { toActionError, UserError, type ActionResult } from "@/lib/errors";
import { cancelJob } from "@/lib/jobs/queue";
import { deleteWorkflow, runWorkflowNow, saveWorkflow, setWorkflowEnabled } from "@/server/workflows";
import { decideApproval } from "@/server/approvals";
import { rollbackSiteChange } from "@/server/site-changes";

const ok = (message: string): ActionResult => { revalidatePath("/automation"); return { ok: true, data: undefined, message }; };

export async function saveWorkflowAction(_: unknown, fd: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await getOrgContextOrThrow();
    const input = JSON.parse(String(fd.get("definition") ?? "{}"));
    const id = String(fd.get("id") ?? "") || undefined;
    const wf = await saveWorkflow(ctx, input, id);
    revalidatePath("/automation");
    return { ok: true, data: { id: wf.id }, message: id ? "Workflow saved" : "Workflow created" };
  } catch (e) { return toActionError(e); }
}

export async function toggleWorkflowAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try { const on = fd.get("enabled") === "1"; await setWorkflowEnabled(await getOrgContextOrThrow(), String(fd.get("id")), on); return ok(on ? "Workflow resumed" : "Workflow paused"); } catch (e) { return toActionError(e); }
}

export async function runWorkflowAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try { const n = await runWorkflowNow(await getOrgContextOrThrow(), String(fd.get("id"))); return ok(`Queued ${n} run${n === 1 ? "" : "s"}`); } catch (e) { return toActionError(e); }
}

export async function deleteWorkflowAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try { await deleteWorkflow(await getOrgContextOrThrow(), String(fd.get("id"))); return ok("Workflow deleted"); } catch (e) { return toActionError(e); }
}

export async function decideApprovalAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const decision = fd.get("decision") === "APPROVED" ? "APPROVED" : "REJECTED";
    await decideApproval(await getOrgContextOrThrow(), String(fd.get("id")), decision, String(fd.get("note") ?? "") || undefined);
    return ok(decision === "APPROVED" ? "Approved. Execution has been queued." : "Rejected");
  } catch (e) { return toActionError(e); }
}

export async function cancelJobAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    ctx.assert("audits:run");
    const done = await cancelJob(ctx.org.id, String(fd.get("id")));
    if (!done) throw new UserError("Job is no longer running");
    return ok("Job cancelled");
  } catch (e) { return toActionError(e); }
}

export async function rollbackAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try { await rollbackSiteChange(await getOrgContextOrThrow(), String(fd.get("id"))); return ok("Change rolled back on the live site"); } catch (e) { return toActionError(e); }
}

export async function taskStatusAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    ctx.assert("tasks:write");
    const status = String(fd.get("status")) as TaskStatus;
    if (!["TODO", "IN_PROGRESS", "DONE", "CANCELLED"].includes(status)) throw new UserError("Invalid status");
    const task = await ctx.db.task.update({ where: { id: String(fd.get("id")) }, data: { status, completedAt: status === "DONE" ? new Date() : null } });
    if (status === "DONE" && task.findingId) {
      // Completing a task doesn't resolve its finding; the next crawl verifies the fix.
      await ctx.db.findingEvent.create({ data: { organizationId: ctx.org.id, findingId: task.findingId, toStatus: "IN_PROGRESS", note: "Task completed. Awaiting verification by the next crawl.", userId: ctx.userId } });
    }
    return ok("Task updated");
  } catch (e) { return toActionError(e); }
}

export async function taskAssignAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    ctx.assert("tasks:write");
    const assigneeId = String(fd.get("assigneeId") ?? "") || null;
    if (assigneeId && !(await ctx.db.membership.findFirst({ where: { userId: assigneeId } }))) throw new UserError("Unknown member");
    await ctx.db.task.update({ where: { id: String(fd.get("id")) }, data: { assigneeId, visibleToClient: fd.get("visibleToClient") === "on" } });
    return ok("Task updated");
  } catch (e) { return toActionError(e); }
}

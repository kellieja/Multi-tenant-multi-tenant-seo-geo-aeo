import type { Approval, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { OrgContext } from "@/lib/auth/context";
import { UserError } from "@/lib/errors";
import { writeAuditLog } from "@/lib/audit-log";
import { enqueueJob } from "@/lib/jobs/queue";
import { notify } from "./notifications";

export type ApprovalKind = "SITE_CHANGE" | "OUTREACH_SEND" | "CONTENT_PUBLISH" | "WORKFLOW_ACTION";

export async function requestApproval(input: {
  organizationId: string;
  websiteId?: string | null;
  kind: ApprovalKind;
  subjectType: string;
  subjectId: string;
  summary: string;
  payload?: Record<string, unknown>;
  requestedById?: string | null;
  expiresInDays?: number;
}): Promise<Approval> {
  const existing = await prisma.approval.findFirst({ where: { organizationId: input.organizationId, subjectType: input.subjectType, subjectId: input.subjectId, status: "PENDING" } });
  if (existing) return existing;
  const a = await prisma.approval.create({
    data: {
      organizationId: input.organizationId, websiteId: input.websiteId ?? null, kind: input.kind, subjectType: input.subjectType, subjectId: input.subjectId,
      summary: input.summary.slice(0, 500), payload: (input.payload ?? {}) as Prisma.InputJsonValue, requestedById: input.requestedById ?? null,
      expiresAt: new Date(Date.now() + (input.expiresInDays ?? 14) * 86400_000),
    },
  });
  const approvers = await prisma.membership.findMany({ where: { organizationId: input.organizationId, role: { in: ["OWNER", "ADMIN", "MANAGER"] } }, select: { userId: true } });
  await notify({ organizationId: input.organizationId, websiteId: input.websiteId, type: "approval_requested", severity: "info", title: "Approval needed", body: input.summary, link: "/automation?tab=approvals", userIds: approvers.map((m) => m.userId) });
  return a;
}

/** Server-side gate: throws unless a matching approval has been granted. Used by every apply path. */
export async function assertApproved(organizationId: string, approvalId: string | null | undefined, subjectType: string, subjectId: string) {
  if (!approvalId) throw new UserError("This change has not been approved");
  const a = await prisma.approval.findFirst({ where: { id: approvalId, organizationId } });
  if (!a || a.subjectType !== subjectType || a.subjectId !== subjectId) throw new UserError("Approval does not match this change");
  if (a.status !== "APPROVED") throw new UserError(`Approval is ${a.status.toLowerCase()}, not approved`);
  return a;
}

export async function decideApproval(ctx: OrgContext, approvalId: string, decision: "APPROVED" | "REJECTED", note?: string) {
  ctx.assert("approvals:decide");
  const a = await ctx.db.approval.findUnique({ where: { id: approvalId } });
  if (!a) throw new UserError("Approval not found");
  if (a.status !== "PENDING") throw new UserError(`Already ${a.status.toLowerCase()}`);
  if (a.expiresAt && a.expiresAt < new Date()) {
    await ctx.db.approval.update({ where: { id: a.id }, data: { status: "EXPIRED" } });
    throw new UserError("This approval request has expired");
  }
  if (a.requestedById && a.requestedById === ctx.userId && a.kind === "OUTREACH_SEND" && ctx.role !== "OWNER") {
    throw new UserError("Bulk outreach must be approved by someone other than the requester");
  }
  const updated = await ctx.db.approval.update({ where: { id: a.id }, data: { status: decision, decidedById: ctx.userId, decidedAt: new Date(), note: note?.slice(0, 1000) || null } });
  await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: `approval.${decision.toLowerCase()}`, entityType: "Approval", entityId: a.id, metadata: { kind: a.kind, subject: `${a.subjectType}:${a.subjectId}` } });

  if (decision === "APPROVED") await onApproved(updated, ctx.userId);
  else await onRejected(updated);
  return updated;
}

async function onApproved(a: Approval, userId: string) {
  if (a.kind === "SITE_CHANGE") {
    await prisma.siteChange.updateMany({ where: { id: a.subjectId, organizationId: a.organizationId, status: "PENDING_APPROVAL" }, data: { status: "APPROVED", approvalId: a.id } });
    await enqueueJob({ organizationId: a.organizationId, websiteId: a.websiteId, type: "site-change-apply", payload: { siteChangeId: a.subjectId }, createdById: userId });
  } else if (a.kind === "OUTREACH_SEND") {
    const ids = ((a.payload as { messageIds?: string[] }).messageIds ?? [a.subjectId]);
    await prisma.outreachMessage.updateMany({ where: { id: { in: ids }, organizationId: a.organizationId, status: "PENDING_APPROVAL" }, data: { status: "APPROVED", approvalId: a.id } });
    await enqueueJob({ organizationId: a.organizationId, websiteId: a.websiteId, type: "outreach-send", payload: { approvalId: a.id, messageIds: ids }, createdById: userId });
  } else if (a.kind === "CONTENT_PUBLISH") {
    await prisma.contentSuggestion.updateMany({ where: { id: a.subjectId, organizationId: a.organizationId }, data: { status: "APPROVED", approvalId: a.id } });
  } else if (a.kind === "WORKFLOW_ACTION") {
    const p = a.payload as { workflowId?: string; websiteId?: string | null; action?: unknown };
    if (p.workflowId) await enqueueJob({ organizationId: a.organizationId, websiteId: a.websiteId, type: "workflow-run", payload: { workflowId: p.workflowId, websiteId: p.websiteId ?? a.websiteId, approvedAction: p.action, approvalId: a.id, triggeredBy: "approval" }, createdById: userId });
  }
}

async function onRejected(a: Approval) {
  if (a.kind === "SITE_CHANGE") await prisma.siteChange.updateMany({ where: { id: a.subjectId, organizationId: a.organizationId }, data: { status: "REJECTED" } });
  if (a.kind === "OUTREACH_SEND") {
    const ids = ((a.payload as { messageIds?: string[] }).messageIds ?? [a.subjectId]);
    await prisma.outreachMessage.updateMany({ where: { id: { in: ids }, organizationId: a.organizationId }, data: { status: "DRAFT" } });
  }
  if (a.kind === "CONTENT_PUBLISH") await prisma.contentSuggestion.updateMany({ where: { id: a.subjectId, organizationId: a.organizationId }, data: { status: "REJECTED" } });
}

export async function expireApprovals(now: Date) {
  const r = await prisma.approval.updateMany({ where: { status: "PENDING", expiresAt: { lt: now } }, data: { status: "EXPIRED" } });
  return r.count;
}

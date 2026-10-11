import { z } from "zod";
import { prisma } from "@/lib/db/client";
import type { OrgContext } from "@/lib/auth/context";
import { assertWebsiteAccess } from "@/lib/auth/context";
import type { JobContext } from "@/lib/jobs/context";
import { UserError } from "@/lib/errors";
import { writeAuditLog } from "@/lib/audit-log";
import { findConnection } from "@/integrations/connections";
import { WordPressClient } from "@/integrations/wordpress";
import { assertApproved, requestApproval } from "./approvals";
import { notify } from "./notifications";

export const SITE_CHANGE_FIELDS = ["title", "meta_description", "content", "excerpt"] as const;

export const proposeSchema = z.object({
  websiteId: z.string(),
  url: z.string().url(),
  field: z.enum(SITE_CHANGE_FIELDS),
  value: z.string().trim().min(1, "Enter the new value").max(200_000),
  source: z.string().max(100).default("manual"),
  findingId: z.string().optional(),
});

/**
 * Proposes a change to a live page. Always stored with a backup of the current value
 * and routed through approval, so nothing reaches the site without a human decision.
 */
export async function proposeSiteChange(ctx: OrgContext | { orgId: string; userId: string | null }, input: z.input<typeof proposeSchema>) {
  const data = proposeSchema.parse(input);
  const orgId = "org" in ctx ? ctx.org.id : ctx.orgId;
  const userId = "org" in ctx ? ctx.userId : ctx.userId;
  if ("org" in ctx) { ctx.assert("findings:write"); await assertWebsiteAccess(ctx, data.websiteId); }
  const site = await prisma.website.findFirstOrThrow({ where: { id: data.websiteId, organizationId: orgId } });
  if (site.cmsType !== "WORDPRESS") throw new UserError("Live changes are supported for WordPress sites with a WordPress connection");
  const conn = await findConnection(orgId, "WORDPRESS", site.id);
  if (!conn || conn.status !== "CONNECTED") throw new UserError("Connect WordPress for this website in Integrations first");
  const wp = new WordPressClient(conn);
  const post = await wp.findByUrl(data.url);
  if (!post) throw new UserError("Couldn't find a WordPress post or page for that URL");
  const before = await wp.readField(post.type, post.id, data.field);
  if ((before ?? "") === data.value) throw new UserError("The new value is identical to the current value");
  const change = await prisma.siteChange.create({
    data: { organizationId: orgId, websiteId: site.id, connector: "wordpress", targetRef: `wp:${post.type}:${post.id}`, targetUrl: data.url, field: data.field, before, after: data.value, source: data.source, status: "PENDING_APPROVAL" },
  });
  const label = data.field.replace("_", " ");
  const approval = await requestApproval({
    organizationId: orgId, websiteId: site.id, kind: "SITE_CHANGE", subjectType: "SiteChange", subjectId: change.id, requestedById: userId,
    summary: `Change ${label} on ${data.url}`, payload: { field: data.field, before: before?.slice(0, 2000), after: data.value.slice(0, 2000), url: data.url, findingId: data.findingId },
  });
  const withApproval = await prisma.siteChange.update({ where: { id: change.id }, data: { approvalId: approval.id } });
  await writeAuditLog({ organizationId: orgId, userId, action: "site_change.propose", entityType: "SiteChange", entityId: change.id, metadata: { field: data.field, url: data.url } });
  return withApproval;
}

async function clientFor(change: { organizationId: string; websiteId: string }) {
  const conn = await findConnection(change.organizationId, "WORDPRESS", change.websiteId);
  if (!conn) throw new UserError("WordPress connection is missing or disconnected");
  return new WordPressClient(conn);
}

const parseRef = (ref: string) => {
  const [, type, id] = ref.split(":");
  return { type: type as "post" | "page", id: Number(id) };
};

/** Worker: applies an APPROVED change. The approval gate is re-checked here, server-side. */
export async function processSiteChangeApply(jc: JobContext) {
  const { siteChangeId } = jc.job.payload as { siteChangeId: string };
  const change = await prisma.siteChange.findUniqueOrThrow({ where: { id: siteChangeId } });
  if (change.organizationId !== jc.job.organizationId) throw new Error("Tenant mismatch");
  if (change.status !== "APPROVED") throw new UserError(`Change is ${change.status.toLowerCase()}; only approved changes can be applied`);
  await assertApproved(change.organizationId, change.approvalId, "SiteChange", change.id);
  const wp = await clientFor(change);
  const { type, id } = parseRef(change.targetRef);
  try {
    // Refresh the backup immediately before writing, in case the page was edited since proposal.
    const current = await wp.readField(type, id, change.field);
    // Full-content changes were computed from the content at proposal time; writing them over
    // later edits would silently discard someone's work, so require a fresh proposal instead.
    if (change.field === "content" && (current ?? "") !== (change.before ?? "")) {
      throw new UserError("The page content changed after this change was proposed. Reject it and propose it again so the edit is based on the current content.");
    }
    await wp.writeField(type, id, change.field, change.after);
    await prisma.siteChange.update({ where: { id: change.id }, data: { status: "APPLIED", appliedAt: new Date(), before: current, error: null } });
    await syncLinkedSuggestion(change.source, "APPLIED");
    await notify({ organizationId: change.organizationId, websiteId: change.websiteId, type: "site_change_applied", severity: "success", title: `Applied ${change.field.replace("_", " ")} change`, body: change.targetUrl ?? undefined, link: "/automation?tab=changes" });
    return { applied: true };
  } catch (err) {
    await prisma.siteChange.update({ where: { id: change.id }, data: { status: "FAILED", error: (err as Error).message.slice(0, 1000) } });
    throw err;
  }
}

export async function rollbackSiteChange(ctx: OrgContext, changeId: string) {
  ctx.assert("approvals:decide");
  const change = await ctx.db.siteChange.findUnique({ where: { id: changeId } });
  if (!change) throw new UserError("Change not found");
  if (change.status !== "APPLIED") throw new UserError("Only applied changes can be rolled back");
  if (change.before == null) throw new UserError("No backup value was recorded for this change");
  const wp = await clientFor(change);
  const { type, id } = parseRef(change.targetRef);
  await wp.writeField(type, id, change.field, change.before);
  await ctx.db.siteChange.update({ where: { id: change.id }, data: { status: "ROLLED_BACK", rolledBackAt: new Date() } });
  await syncLinkedSuggestion(change.source, "ROLLED_BACK");
  await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: "site_change.rollback", entityType: "SiteChange", entityId: change.id });
}

/** Keeps an internal-link suggestion's status in step with the site change made from it. */
async function syncLinkedSuggestion(source: string, status: "APPLIED" | "ROLLED_BACK") {
  const m = source.match(/^internal-link:(.+)$/);
  if (m) await prisma.internalLinkSuggestion.updateMany({ where: { id: m[1], changeId: { not: null } }, data: { status } });
}

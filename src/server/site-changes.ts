import { z } from "zod";
import type { IntegrationConnection, Website } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { OrgContext } from "@/lib/auth/context";
import { assertWebsiteAccess } from "@/lib/auth/context";
import type { JobContext } from "@/lib/jobs/context";
import { UserError } from "@/lib/errors";
import { sha256 } from "@/lib/crypto";
import { writeAuditLog } from "@/lib/audit-log";
import { setMetaDescription, setTitle } from "@/lib/html-edit";
import { findConnection, readSecret } from "@/integrations/connections";
import { WordPressClient } from "@/integrations/wordpress";
import { FileHostClient, type FileHostConfig, type FileHostSecret } from "@/integrations/filehost";
import { insertLink } from "./internal-links";
import { assertApproved, requestApproval } from "./approvals";
import { notify } from "./notifications";

export const SITE_CHANGE_FIELDS = ["title", "meta_description", "content", "excerpt"] as const;
export type SiteChangeField = (typeof SITE_CHANGE_FIELDS)[number];

/** What a change does, independent of the CMS that applies it. */
export type SiteEdit =
  | { kind: "title"; value: string }
  | { kind: "meta_description"; value: string }
  | { kind: "link"; anchor: string; href: string }
  /** A raw CMS field (WordPress only), e.g. full post content. */
  | { kind: "field"; field: SiteChangeField; value: string };

export const proposeSchema = z.object({
  websiteId: z.string(),
  url: z.string().url(),
  field: z.enum(SITE_CHANGE_FIELDS),
  value: z.string().trim().min(1, "Enter the new value").max(200_000),
  source: z.string().max(100).default("manual"),
  findingId: z.string().optional(),
});

type Actor = OrgContext | { orgId: string; userId: string | null };

type Connector =
  | { type: "wordpress"; client: WordPressClient }
  | { type: "filehost"; conn: IntegrationConnection };

/** Picks how this website's changes are applied: WordPress REST, or files over SFTP/FTPS. */
async function connectorFor(orgId: string, site: Website): Promise<Connector> {
  const wp = await findConnection(orgId, "WORDPRESS", site.id);
  if (wp?.status === "CONNECTED" && site.cmsType === "WORDPRESS") return { type: "wordpress", client: new WordPressClient(wp) };
  const fh = await findConnection(orgId, "FILE_HOST", site.id);
  if (fh?.status === "CONNECTED") return { type: "filehost", conn: fh };
  if (site.cmsType === "WORDPRESS") throw new UserError("Connect WordPress for this website in Integrations first");
  throw new UserError("Live changes need a connection for this website: WordPress, or a File host (SFTP/FTPS) for HTML sites. For other sites, use a change pack (Automation → Change packs).");
}

async function openFileHost(conn: IntegrationConnection) {
  return FileHostClient.open(readSecret<FileHostSecret>(conn), (conn.config ?? {}) as FileHostConfig);
}

const EDIT_LABEL = (e: SiteEdit) => (e.kind === "link" ? "internal link" : e.kind === "field" ? e.field.replace("_", " ") : e.kind.replace("_", " "));

/**
 * Proposes an edit to a live page. The connector reads the current state, the exact new state is
 * computed and stored with a backup, and the change waits for approval. Nothing is written yet.
 */
export async function proposeEdit(ctx: Actor, input: { websiteId: string; url: string; edit: SiteEdit; source?: string; findingId?: string }) {
  const orgId = "org" in ctx ? ctx.org.id : ctx.orgId;
  const userId = ctx.userId;
  if ("org" in ctx) { ctx.assert("findings:write"); await assertWebsiteAccess(ctx, input.websiteId); }
  const site = await prisma.website.findFirstOrThrow({ where: { id: input.websiteId, organizationId: orgId } });
  const edit = input.edit;
  const connector = await connectorFor(orgId, site);

  let targetRef: string; let field: string; let before: string | null; let after: string;
  if (connector.type === "wordpress") {
    const post = await connector.client.findByUrl(input.url);
    if (!post) throw new UserError("Couldn't find a WordPress post or page for that URL");
    targetRef = `wp:${post.type}:${post.id}`;
    if (edit.kind === "link") {
      field = "content";
      before = await connector.client.readField(post.type, post.id, "content");
      const updated = before ? insertLink(before, edit.anchor, edit.href) : null;
      if (!updated) throw new UserError(`Couldn't find “${edit.anchor}” in a paragraph of the stored WordPress content (it may come from a template or another block). Add the link manually.`);
      after = updated;
    } else {
      field = edit.kind === "field" ? edit.field : edit.kind;
      before = await connector.client.readField(post.type, post.id, field);
      after = edit.value;
    }
  } else {
    const client = await openFileHost(connector.conn);
    try {
      const file = await client.locate(new URL(input.url).pathname);
      targetRef = `file:${file.path}`;
      field = "file";
      before = file.html;
      if (edit.kind === "title") after = setTitle(file.html, edit.value);
      else if (edit.kind === "meta_description") after = setMetaDescription(file.html, edit.value);
      else if (edit.kind === "link") {
        const updated = insertLink(file.html, edit.anchor, edit.href);
        if (!updated) throw new UserError(`Couldn't find “${edit.anchor}” inside paragraph text in ${file.path}. Add the link manually.`);
        after = updated;
      } else throw new UserError("Only titles, meta descriptions and internal links can be changed on file-hosted sites");
    } finally {
      await client.close();
    }
  }
  if ((before ?? "") === after) throw new UserError("The new value is identical to the current value");

  const change = await prisma.siteChange.create({
    data: { organizationId: orgId, websiteId: site.id, connector: connector.type, targetRef, targetUrl: input.url, field, before, after, source: input.source ?? "manual", status: "PENDING_APPROVAL" },
  });
  const label = EDIT_LABEL(edit);
  const approval = await requestApproval({
    organizationId: orgId, websiteId: site.id, kind: "SITE_CHANGE", subjectType: "SiteChange", subjectId: change.id, requestedById: userId,
    summary: `Change ${label} on ${input.url}`,
    // The preview is truncated; the approval screen loads the full change, and afterHash binds the decision to this exact value.
    payload: { field, edit: edit.kind, before: before?.slice(0, 2000), after: after.slice(0, 2000), afterLength: after.length, afterHash: sha256(after), url: input.url, findingId: input.findingId },
  });
  const withApproval = await prisma.siteChange.update({ where: { id: change.id }, data: { approvalId: approval.id } });
  await writeAuditLog({ organizationId: orgId, userId, action: "site_change.propose", entityType: "SiteChange", entityId: change.id, metadata: { field, edit: edit.kind, url: input.url, connector: connector.type } });
  return withApproval;
}

/** Field-level proposal (used by findings "propose fix", content suggestions and workflows). */
export async function proposeSiteChange(ctx: Actor, input: z.input<typeof proposeSchema>) {
  const data = proposeSchema.parse(input);
  const edit: SiteEdit = data.field === "title" || data.field === "meta_description" ? { kind: data.field, value: data.value } : { kind: "field", field: data.field, value: data.value };
  return proposeEdit(ctx, { websiteId: data.websiteId, url: data.url, edit, source: data.source, findingId: data.findingId });
}

const parseWpRef = (ref: string) => {
  const [, type, id] = ref.split(":");
  return { type: type as "post" | "page", id: Number(id) };
};

async function connectionFor(change: { organizationId: string; websiteId: string; connector: string }) {
  const conn = await findConnection(change.organizationId, change.connector === "filehost" ? "FILE_HOST" : "WORDPRESS", change.websiteId);
  if (!conn) throw new UserError(`${change.connector === "filehost" ? "File host" : "WordPress"} connection is missing or disconnected`);
  return conn;
}

/** Worker: applies an APPROVED change. The approval gate is re-checked here, server-side. */
export async function processSiteChangeApply(jc: JobContext) {
  const { siteChangeId } = jc.job.payload as { siteChangeId: string };
  const change = await prisma.siteChange.findUniqueOrThrow({ where: { id: siteChangeId } });
  if (change.organizationId !== jc.job.organizationId) throw new Error("Tenant mismatch");
  if (change.status !== "APPROVED") throw new UserError(`Change is ${change.status.toLowerCase()}; only approved changes can be applied`);
  const approval = await assertApproved(change.organizationId, change.approvalId, "SiteChange", change.id);
  const approvedHash = (approval.payload as { afterHash?: string }).afterHash;
  if (approvedHash && approvedHash !== sha256(change.after)) throw new UserError("This change was modified after it was approved; it needs a new approval");
  const conn = await connectionFor(change);
  const stale = "The page changed after this change was proposed. Reject it and propose it again so the edit is based on the current content.";
  try {
    let current: string | null;
    if (change.connector === "filehost") {
      const client = await openFileHost(conn);
      try {
        const path = change.targetRef.replace(/^file:/, "");
        current = await client.read(path);
        // The whole file was computed from its state at proposal time; never overwrite later edits.
        if ((current ?? "") !== (change.before ?? "")) throw new UserError(stale);
        await client.write(path, change.after); // verified by reading back
      } finally {
        await client.close();
      }
    } else {
      const wp = new WordPressClient(conn);
      const { type, id } = parseWpRef(change.targetRef);
      // Refresh the backup immediately before writing, in case the page was edited since proposal.
      current = await wp.readField(type, id, change.field);
      if (change.field === "content" && (current ?? "") !== (change.before ?? "")) throw new UserError(stale);
      await wp.writeField(type, id, change.field, change.after);
    }
    await prisma.siteChange.update({ where: { id: change.id }, data: { status: "APPLIED", appliedAt: new Date(), before: current, error: null } });
    await syncLinkedSuggestion(change.source, "APPLIED");
    await notify({ organizationId: change.organizationId, websiteId: change.websiteId, type: "site_change_applied", severity: "success", title: `Applied ${change.field === "file" ? "file" : change.field.replace("_", " ")} change`, body: change.targetUrl ?? undefined, link: "/automation?tab=changes" });
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
  const conn = await connectionFor(change);
  if (change.connector === "filehost") {
    const client = await openFileHost(conn);
    try {
      const path = change.targetRef.replace(/^file:/, "");
      const current = await client.read(path);
      if ((current ?? "") !== change.after) throw new UserError("The file was edited after this change was applied; restoring the backup would discard those edits. Restore it manually if needed.");
      await client.write(path, change.before);
    } finally {
      await client.close();
    }
  } else {
    const { type, id } = parseWpRef(change.targetRef);
    await new WordPressClient(conn).writeField(type, id, change.field, change.before);
  }
  await ctx.db.siteChange.update({ where: { id: change.id }, data: { status: "ROLLED_BACK", rolledBackAt: new Date() } });
  await syncLinkedSuggestion(change.source, "ROLLED_BACK");
  await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: "site_change.rollback", entityType: "SiteChange", entityId: change.id });
}

/** Keeps an internal-link suggestion's status in step with the site change made from it. */
async function syncLinkedSuggestion(source: string, status: "APPLIED" | "ROLLED_BACK") {
  const m = source.match(/^internal-link:(.+)$/);
  if (m) await prisma.internalLinkSuggestion.updateMany({ where: { id: m[1], changeId: { not: null } }, data: { status } });
}

/** Which live-change connector a website has, if any (for showing "Propose to site" in the UI). */
export async function liveConnectorType(orgId: string, site: Pick<Website, "id" | "cmsType">): Promise<"wordpress" | "filehost" | null> {
  try {
    return (await connectorFor(orgId, site as Website)).type;
  } catch {
    return null;
  }
}

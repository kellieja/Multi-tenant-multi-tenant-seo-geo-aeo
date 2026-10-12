import { z } from "zod";
import type { IntegrationConnection, SiteChange, Website } from "@prisma/client";
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
import { GitHubClient, type GitHubConfig, type GitHubSecret } from "@/integrations/github";
import { addLinkInSource, branchNameFor, findInRepo, relativeHref, replaceMetadata } from "./github-edits";
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
  | { type: "filehost"; conn: IntegrationConnection }
  | { type: "github"; conn: IntegrationConnection };

/** Picks how this website's changes are applied: WordPress REST, files over SFTP/FTPS, or GitHub pull requests. */
async function connectorFor(orgId: string, site: Website): Promise<Connector> {
  const wp = await findConnection(orgId, "WORDPRESS", site.id);
  if (wp?.status === "CONNECTED" && site.cmsType === "WORDPRESS") return { type: "wordpress", client: new WordPressClient(wp) };
  const fh = await findConnection(orgId, "FILE_HOST", site.id);
  if (fh?.status === "CONNECTED") return { type: "filehost", conn: fh };
  const gh = await findConnection(orgId, "GITHUB", site.id);
  if (gh?.status === "CONNECTED") return { type: "github", conn: gh };
  if (site.cmsType === "WORDPRESS") throw new UserError("Connect WordPress for this website in Integrations first");
  throw new UserError("Live changes need a connection for this website: WordPress, a File host (SFTP/FTPS) for HTML sites, or GitHub for sites built from a repository. Otherwise use a change pack (Automation → Change packs).");
}

function openGitHub(conn: IntegrationConnection) {
  const sec = readSecret<GitHubSecret>(conn);
  const cfg = (conn.config ?? {}) as GitHubConfig;
  const gh = new GitHubClient(sec.token, sec.repository);
  const base = sec.baseBranch || cfg.baseBranch || cfg.defaultBranch || "main";
  return { gh, base, sitePath: sec.sitePath || cfg.sitePath || "", isDefaultBranch: base === (cfg.defaultBranch ?? base) };
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
  } else if (connector.type === "github") {
    const { gh, base, sitePath, isDefaultBranch } = openGitHub(connector.conn);
    let edit2;
    if (edit.kind === "title" || edit.kind === "meta_description") {
      // The current value comes from the latest crawl: that's the text to find in the source.
      const page = await prisma.crawledPage.findFirst({ where: { websiteId: site.id, url: input.url }, orderBy: { fetchedAt: "desc" }, select: { title: true, metaDescription: true } });
      const current = edit.kind === "title" ? page?.title : page?.metaDescription;
      if (!current) throw new UserError(`The page has no ${edit.kind === "title" ? "title" : "meta description"} in the latest crawl to locate in the source. Add it with a change pack (or crawl the site first).`);
      const files = await findInRepo(gh, base, [current, current.replace(/&/g, "&amp;")], { sitePath, isDefaultBranch });
      edit2 = replaceMetadata(files, current, edit.value, edit.kind);
    } else if (edit.kind === "link") {
      const sug = await prisma.internalLinkSuggestion.findFirst({ where: { websiteId: site.id, sourceUrl: input.url, anchor: edit.anchor, targetUrl: edit.href }, orderBy: { createdAt: "desc" }, select: { sourceParagraph: true } });
      const files = await findInRepo(gh, base, [edit.anchor], { sitePath, isDefaultBranch });
      edit2 = addLinkInSource(files, edit.anchor, relativeHref(edit.href), sug?.sourceParagraph ?? "");
    } else throw new UserError("Only titles, meta descriptions and internal links can be changed through GitHub");
    targetRef = `gh:${edit2.path}@${edit2.sha}`;
    field = "file";
    before = edit2.before;
    after = edit2.after;
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
    summary: connector.type === "github" ? `Open a pull request changing the ${label} of ${input.url} (${targetRef.replace(/^gh:|@.*$/g, "")})` : `Change ${label} on ${input.url}`,
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

const CONNECTOR_PROVIDER = { filehost: "FILE_HOST", github: "GITHUB", wordpress: "WORDPRESS" } as const;
const CONNECTOR_NAME = { filehost: "File host", github: "GitHub", wordpress: "WordPress" } as const;

async function connectionFor(change: { organizationId: string; websiteId: string; connector: string }) {
  const key = (change.connector in CONNECTOR_PROVIDER ? change.connector : "wordpress") as keyof typeof CONNECTOR_PROVIDER;
  const conn = await findConnection(change.organizationId, CONNECTOR_PROVIDER[key], change.websiteId);
  if (!conn) throw new UserError(`${CONNECTOR_NAME[key]} connection is missing or disconnected`);
  return conn;
}

const parseGhRef = (ref: string) => { const m = ref.match(/^gh:(.+)@([0-9a-f]+)$/); if (!m) throw new Error(`Bad GitHub target ${ref}`); return { path: m[1], sha: m[2] }; };

/** GitHub: an approved change is opened as a pull request; merging it on GitHub is the final step. */
async function openPullRequestFor(change: SiteChange, conn: IntegrationConnection, stale: string) {
  try {
    const { gh, base } = openGitHub(conn);
    const { path, sha } = parseGhRef(change.targetRef);
    const current = await gh.file(path, base);
    if (!current || current.sha !== sha) throw new UserError(stale);
    const branch = branchNameFor(change.id);
    await gh.createBranch(branch, await gh.branchSha(base));
    const what = change.targetUrl ? new URL(change.targetUrl).pathname : path;
    await gh.putFile(path, branch, change.after, sha, `SEO: update ${what}`);
    const pr = await gh.openPullRequest(branch, base, `SEO: update ${what}`, [
      `Approved in SearchOps (change ${change.id}).`, "", `Page: ${change.targetUrl ?? "n/a"}`, `File: \`${path}\``, "",
      "Only the lines in this diff change. After merging, redeploy the site if your host doesn't deploy from this branch automatically (for Replit: pull the change and redeploy).",
    ].join("\n"));
    await prisma.siteChange.update({ where: { id: change.id }, data: { status: "PR_OPEN", externalUrl: pr.url, error: null } });
    await notify({ organizationId: change.organizationId, websiteId: change.websiteId, type: "site_change_pr", severity: "info", title: "Pull request opened", body: pr.url, link: "/automation?tab=changes" });
    return { pullRequest: pr.url };
  } catch (err) {
    await prisma.siteChange.update({ where: { id: change.id }, data: { status: "FAILED", error: (err as Error).message.slice(0, 1000) } });
    throw err;
  }
}

/** Scheduler tick: follows GitHub pull requests opened for changes and reverts. */
export async function syncGitHubPullRequests() {
  const open = await prisma.siteChange.findMany({ where: { connector: "github", status: { in: ["PR_OPEN", "REVERT_PR_OPEN"] }, externalUrl: { not: null } }, take: 200 });
  let updated = 0;
  for (const c of open) {
    try {
      const conn = await connectionFor(c);
      const { gh } = openGitHub(conn);
      const num = Number(c.externalUrl!.match(/\/pull\/(\d+)/)?.[1]);
      if (!num) continue;
      const pr = await gh.pullRequest(num);
      const reverting = c.status === "REVERT_PR_OPEN";
      if (pr.merged) {
        await prisma.siteChange.update({ where: { id: c.id }, data: reverting ? { status: "ROLLED_BACK", rolledBackAt: new Date(pr.merged_at ?? Date.now()) } : { status: "APPLIED", appliedAt: new Date(pr.merged_at ?? Date.now()) } });
        await syncLinkedSuggestion(c.source, reverting ? "ROLLED_BACK" : "APPLIED");
        await notify({ organizationId: c.organizationId, websiteId: c.websiteId, type: "site_change_applied", severity: "success", title: reverting ? "Revert pull request merged" : "Pull request merged", body: `${c.externalUrl} — redeploy the site if it doesn't deploy automatically; the next crawl verifies the change.`, link: "/automation?tab=changes" });
        updated++;
      } else if (pr.state === "closed") {
        await prisma.siteChange.update({ where: { id: c.id }, data: reverting ? { status: "APPLIED" } : { status: "REJECTED", error: "Pull request closed without merging" } });
        updated++;
      }
    } catch (err) {
      console.warn("[github-sync]", c.id, (err as Error).message);
    }
  }
  return updated;
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
  if (change.connector === "github") return openPullRequestFor(change, conn, stale);
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
  if (change.connector === "github") {
    // Revert through a pull request too: nothing changes on the default branch without a merge.
    const { gh, base } = openGitHub(conn);
    const { path } = parseGhRef(change.targetRef);
    const current = await gh.file(path, base);
    if (!current || current.content !== change.after) throw new UserError("The file changed on GitHub after this change was merged; revert it manually there.");
    const branch = `${branchNameFor(change.id)}-revert`;
    await gh.createBranch(branch, await gh.branchSha(base));
    await gh.putFile(path, branch, change.before, current.sha, `Revert SEO change ${change.id}`);
    const pr = await gh.openPullRequest(branch, base, `Revert: SEO change to ${path}`, `Reverts the change approved in SearchOps (change ${change.id}). Merge to restore the previous version.`);
    await ctx.db.siteChange.update({ where: { id: change.id }, data: { status: "REVERT_PR_OPEN", externalUrl: pr.url } });
    await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: "site_change.rollback_pr", entityType: "SiteChange", entityId: change.id, metadata: { pr: pr.url } });
    return;
  }
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
export async function liveConnectorType(orgId: string, site: Pick<Website, "id" | "cmsType">): Promise<"wordpress" | "filehost" | "github" | null> {
  try {
    return (await connectorFor(orgId, site as Website)).type;
  } catch {
    return null;
  }
}

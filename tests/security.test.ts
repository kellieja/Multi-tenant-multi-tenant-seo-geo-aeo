import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/client";
import { toCsv } from "@/lib/csv";
import { clientIp } from "@/lib/auth/session";
import { safeSmtpOptions } from "@/lib/net/smtp";
import { changeRegion } from "@/lib/diff";
import { createWebsite } from "@/server/websites";
import { connectWithCredentials } from "@/server/integrations";
import { changeMemberRole, removeMember } from "@/server/orgs";
import { decideApproval } from "@/server/approvals";
import { proposeSiteChange, processSiteChangeApply } from "@/server/site-changes";
import { updateSuggestionStatus } from "@/server/content-studio";
import { proposeApprovedSuggestions } from "@/server/content-apply";
import * as queue from "@/lib/jobs/queue";
import { recoverOrphanedJobs, getQueue } from "@/lib/jobs/queue";
import type { JobContext } from "@/lib/jobs/context";
import { fakeWordPress } from "./fixtures/wordpress";
import { makeContext } from "./helpers";

const wp = fakeWordPress();
beforeAll(async () => { process.env.ALLOW_PRIVATE_NETWORK_FETCH = "true"; await wp.start(); });
afterAll(async () => { await wp.stop(); process.env.ALLOW_PRIVATE_NETWORK_FETCH = "false"; vi.restoreAllMocks(); });
const jc = (job: object) => ({ job: { attempts: 1, status: "RUNNING", type: "site-change-apply", ...job }, progress: async () => undefined, isCancelled: async () => false, log: () => undefined }) as unknown as JobContext;

describe("input hardening", () => {
  it("neutralises spreadsheet formulas, including ones that start with a negative number", () => {
    const csv = toCsv([["=HYPERLINK(\"x\")", "-1+cmd|' /C calc'!A0", "-12.5", "1e5", "+44 20", "@SUM(A1)", "plain"]]);
    expect(csv).toBe(`"'=HYPERLINK(""x"")",'-1+cmd|' /C calc'!A0,-12.5,1e5,'+44 20,'@SUM(A1),plain`);
  });

  it("takes the client IP from the trusted proxy hop, not the spoofable leftmost entry", () => {
    const h = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(h({ "x-vercel-forwarded-for": "198.51.100.4", "x-forwarded-for": "6.6.6.6" }))).toBe("198.51.100.4");
    expect(clientIp(h({ "x-real-ip": "192.0.2.1" }))).toBe("192.0.2.1");
  });

  it("only lets org-supplied SMTP URLs reach public mail servers on mail ports", async () => {
    const strict = { allowPrivate: false };
    await expect(safeSmtpOptions("smtp://u:p@10.0.0.5:587", strict)).rejects.toThrow(/public mail server/);
    await expect(safeSmtpOptions("smtp://169.254.169.254:25", strict)).rejects.toThrow(/public mail server/);
    await expect(safeSmtpOptions("smtp://8.8.8.8:6379", strict)).rejects.toThrow(/port/);
    await expect(safeSmtpOptions("http://8.8.8.8", strict)).rejects.toThrow(/smtp/);
    const o = await safeSmtpOptions("smtps://user%40x.com:p%40ss@8.8.8.8?proxy=socks://10.0.0.1", strict);
    expect(o).toMatchObject({ host: "8.8.8.8", port: 465, secure: true, auth: { user: "user@x.com", pass: "p@ss" } });
    expect(JSON.stringify(o)).not.toContain("proxy");
  });

  it("finds the exact changed region of a long field", () => {
    const before = `${"a".repeat(5000)}<p>lubrication intervals</p>${"b".repeat(5000)}`;
    const after = before.replace("lubrication intervals", '<a href="/g">lubrication intervals</a>');
    const r = changeRegion(before, after, 20);
    // The link wraps the anchor, so the region spans it: old text out, linked text in.
    expect(r.removed).toBe("lubrication intervals");
    expect(r.added).toBe('<a href="/g">lubrication intervals</a>');
    expect(r.prefixTruncated && r.suffixTruncated).toBe(true);
    expect(r.prefix.length).toBe(20);
  });
});

describe("authorization hardening", () => {
  it("only owners can demote or remove an owner", async () => {
    const owner = await makeContext();
    const owner2 = await makeContext("OWNER", { orgId: owner.org.id });
    const admin = await makeContext("ADMIN", { orgId: owner.org.id });
    await expect(changeMemberRole(admin, owner2.membership.id, "ANALYST", null)).rejects.toThrow(/Only owners/);
    await expect(removeMember(admin, owner2.membership.id)).rejects.toThrow(/Only owners/);
    await changeMemberRole(owner, owner2.membership.id, "ADMIN", null);
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: owner2.membership.id } })).role).toBe("ADMIN");
  });

  it("refuses to apply a site change that was altered after approval", async () => {
    vi.spyOn(queue, "enqueueJob").mockResolvedValue({ job: { id: "q", status: "QUEUED" }, deduped: false } as never);
    const owner = await makeContext();
    const site = await createWebsite(owner, { name: "WP sec", url: wp.origin, cmsType: "WORDPRESS" });
    await connectWithCredentials(owner, "WORDPRESS", { baseUrl: wp.origin, username: "editor", appPassword: "app pass" }, site.id);
    const original = wp.page.title;
    const change = await proposeSiteChange(owner, { websiteId: site.id, url: `${wp.origin}/about/`, field: "title", value: "Approved title" });
    const manager = await makeContext("MANAGER", { orgId: owner.org.id });
    await decideApproval(manager, change.approvalId!, "APPROVED");
    await prisma.siteChange.update({ where: { id: change.id }, data: { after: "Swapped after approval" } });
    await expect(processSiteChangeApply(jc({ id: "a", organizationId: owner.org.id, websiteId: site.id, payload: { siteChangeId: change.id } }))).rejects.toThrow(/modified after it was approved/);
    expect(wp.page.title).toBe(original);
  });

  it("does not auto-publish metadata that only an analyst approved", async () => {
    vi.spyOn(queue, "enqueueJob").mockResolvedValue({ job: { id: "q", status: "QUEUED" }, deduped: false } as never);
    const owner = await makeContext();
    const site = await createWebsite(owner, { name: "WP auto", url: `${wp.origin}/`, cmsType: "WORDPRESS" });
    await connectWithCredentials(owner, "WORDPRESS", { baseUrl: wp.origin, username: "editor", appPassword: "app pass" }, site.id);
    const analyst = await makeContext("ANALYST", { orgId: owner.org.id });
    const mk = () => prisma.contentSuggestion.create({ data: { organizationId: owner.org.id, websiteId: site.id, url: `${wp.origin}/about/`, kind: "METADATA", output: JSON.stringify({ title: `Title ${Math.random()}` }), provider: "ANTHROPIC" } });

    const byAnalyst = await mk();
    await updateSuggestionStatus(analyst, byAnalyst.id, "APPROVED");
    await proposeApprovedSuggestions(owner.org.id, site.id, { limit: 5, autoApprove: true, source: "test" });
    const c1 = await prisma.siteChange.findFirstOrThrow({ where: { websiteId: site.id }, orderBy: { createdAt: "desc" } });
    expect(c1.status).toBe("PENDING_APPROVAL");

    const byManager = await mk();
    const manager = await makeContext("MANAGER", { orgId: owner.org.id });
    await updateSuggestionStatus(manager, byManager.id, "APPROVED");
    await proposeApprovedSuggestions(owner.org.id, site.id, { limit: 5, autoApprove: true, source: "test" });
    const c2 = await prisma.siteChange.findFirstOrThrow({ where: { websiteId: site.id }, orderBy: { createdAt: "desc" } });
    expect(c2.id).not.toBe(c1.id);
    expect(c2.status).toBe("APPROVED");
  });
});

describe("job recovery", () => {
  it("re-queues lost QUEUED jobs and fails lost RUNNING ones", async () => {
    const owner = await makeContext();
    const old = new Date(Date.now() - 60 * 60_000);
    const queued = await prisma.job.create({ data: { organizationId: owner.org.id, type: "maintenance", status: "QUEUED", queuedAt: old } });
    const running = await prisma.job.create({ data: { organizationId: owner.org.id, type: "maintenance", status: "RUNNING", queuedAt: old, startedAt: old } });
    try {
      expect(await recoverOrphanedJobs()).toBeGreaterThanOrEqual(2);
      expect(await getQueue("default").getJob(queued.id)).toBeTruthy();
      expect((await prisma.job.findUniqueOrThrow({ where: { id: running.id } })).status).toBe("FAILED");
      expect((await prisma.job.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe("QUEUED");
    } finally {
      await (await getQueue("default").getJob(queued.id))?.remove().catch(() => undefined);
      await prisma.job.update({ where: { id: queued.id }, data: { status: "CANCELLED" } });
    }
  });
});

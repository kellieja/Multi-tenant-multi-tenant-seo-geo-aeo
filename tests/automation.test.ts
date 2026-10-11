import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/client";
import { saveWorkflow, processWorkflowRun, scheduleWorkflows, emitEvent, setWorkflowEnabled } from "@/server/workflows";
import { decideApproval } from "@/server/approvals";
import { proposeSiteChange, processSiteChangeApply, rollbackSiteChange } from "@/server/site-changes";
import { connectWithCredentials } from "@/server/integrations";
import { createWebsite } from "@/server/websites";
import { ForbiddenError } from "@/lib/auth/rbac";
import * as queue from "@/lib/jobs/queue";
import type { JobContext } from "@/lib/jobs/context";
import { makeContext } from "./helpers";
import { fakeWordPress } from "./fixtures/wordpress";

const wp = fakeWordPress();
beforeAll(async () => { process.env.ALLOW_PRIVATE_NETWORK_FETCH = "true"; await wp.start(); });
afterAll(async () => { await wp.stop(); process.env.ALLOW_PRIVATE_NETWORK_FETCH = "false"; vi.restoreAllMocks(); });

// Capture jobs instead of needing a live worker; tests invoke processors directly.
const queued: { type: string; payload?: Record<string, unknown>; websiteId?: string | null }[] = [];
vi.spyOn(queue, "enqueueJob").mockImplementation(async (input) => {
  queued.push(input);
  const job = await prisma.job.create({ data: { organizationId: input.organizationId, websiteId: input.websiteId ?? null, type: input.type, payload: (input.payload ?? {}) as object } });
  return { job, deduped: false };
});

const jc = (job: { id: string; organizationId: string; websiteId: string | null; payload: unknown; attempts?: number }) =>
  ({ job: { status: "RUNNING", progress: 0, type: "x", attempts: 1, ...job }, progress: async () => undefined, isCancelled: async () => false, log: () => undefined }) as unknown as JobContext;

async function seedFindings(orgId: string, websiteId: string) {
  for (const [i, sev] of (["CRITICAL", "HIGH", "LOW"] as const).entries()) {
    await prisma.auditFinding.create({ data: { organizationId: orgId, websiteId, fingerprint: `fp${i}${websiteId}`, issueType: "http_4xx", category: "x", severity: sev, url: `https://a.example.com/${i}`, title: `Issue ${i}`, description: "d", recommendation: "r", implementation: "i", priorityScore: 50 - i } });
  }
}

describe("workflow engine", () => {
  it("validates definitions", async () => {
    const ctx = await makeContext("MANAGER");
    await expect(saveWorkflow(ctx, { name: "x", mode: "DRY_RUN", trigger: { type: "schedule", cron: "every day!!" }, conditions: [], actions: [{ type: "run_crawl", params: {} }], scope: { type: "all" } })).rejects.toThrow(/cron/);
    await expect(saveWorkflow(ctx, { name: "x", mode: "DRY_RUN", trigger: { type: "manual" }, conditions: [], actions: [], scope: { type: "all" } })).rejects.toThrow(/at least one action/);
    const analyst = await makeContext("ANALYST", { orgId: ctx.org.id });
    await expect(saveWorkflow(analyst, { name: "x", mode: "DRY_RUN", trigger: { type: "manual" }, conditions: [], actions: [{ type: "run_crawl", params: {} }], scope: { type: "all" } })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("dry-run logs intended actions without side effects", async () => {
    const ctx = await makeContext("OWNER");
    const site = await createWebsite(ctx, { name: "A", url: "dry.example.com" });
    await seedFindings(ctx.org.id, site.id);
    const wf = await saveWorkflow(ctx, { name: "dry", mode: "DRY_RUN", trigger: { type: "manual" }, conditions: [], actions: [{ type: "create_tasks", params: { minSeverity: "HIGH", limit: 10 } }], scope: { type: "all" } });
    await processWorkflowRun(jc({ id: "j1", organizationId: ctx.org.id, websiteId: site.id, payload: { workflowId: wf.id, websiteId: site.id, triggeredBy: "manual" } }));
    expect(await ctx.db.task.count()).toBe(0);
    const ex = await ctx.db.workflowExecution.findFirstOrThrow({ where: { workflowId: wf.id } });
    expect(ex.status).toBe("SUCCEEDED");
    expect(JSON.stringify(ex.logs)).toContain("Would run: Create tasks");
  });

  it("automatic mode executes internal actions; failing conditions skip them", async () => {
    const ctx = await makeContext("OWNER");
    const site = await createWebsite(ctx, { name: "B", url: "auto.example.com" });
    await seedFindings(ctx.org.id, site.id);
    const skip = await saveWorkflow(ctx, { name: "cond", mode: "AUTOMATIC", trigger: { type: "manual" }, conditions: [{ field: "openCritical", op: "gt", value: 5 }], actions: [{ type: "create_tasks", params: { minSeverity: "HIGH" } }], scope: { type: "all" } });
    await processWorkflowRun(jc({ id: "j2", organizationId: ctx.org.id, websiteId: site.id, payload: { workflowId: skip.id, websiteId: site.id, triggeredBy: "manual" } }));
    expect(await ctx.db.task.count()).toBe(0);
    const run = await saveWorkflow(ctx, { name: "go", mode: "AUTOMATIC", trigger: { type: "manual" }, conditions: [{ field: "openCritical", op: "gte", value: 1 }], actions: [{ type: "create_tasks", params: { minSeverity: "HIGH", limit: 10 } }], scope: { type: "websites", ids: [site.id] } });
    await processWorkflowRun(jc({ id: "j3", organizationId: ctx.org.id, websiteId: site.id, payload: { workflowId: run.id, websiteId: site.id, triggeredBy: "manual" } }));
    expect(await ctx.db.task.count()).toBe(2); // CRITICAL + HIGH, not LOW
  });

  it("schedules due workflows, honours pause, and dispatches events to matching workflows", async () => {
    const ctx = await makeContext("OWNER");
    const site = await createWebsite(ctx, { name: "C", url: "sched.example.com" });
    const wf = await saveWorkflow(ctx, { name: "s", mode: "AUTOMATIC", trigger: { type: "schedule", cron: "*/5 * * * *" }, conditions: [], actions: [{ type: "run_pagespeed", params: {} }], scope: { type: "all" } });
    await prisma.workflow.update({ where: { id: wf.id }, data: { nextRunAt: new Date(Date.now() - 1000) } });
    queued.length = 0;
    await scheduleWorkflows(new Date());
    expect(queued.some((q) => q.type === "workflow-run" && q.websiteId === site.id)).toBe(true);
    expect((await prisma.workflow.findUniqueOrThrow({ where: { id: wf.id } })).nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    await setWorkflowEnabled(ctx, wf.id, false);
    await prisma.workflow.update({ where: { id: wf.id }, data: { nextRunAt: new Date(Date.now() - 1000) } });
    queued.length = 0;
    await scheduleWorkflows(new Date());
    expect(queued.filter((q) => (q.payload as { workflowId?: string })?.workflowId === wf.id)).toHaveLength(0);

    await saveWorkflow(ctx, { name: "e", mode: "AUTOMATIC", trigger: { type: "event", event: "crawl.completed" }, conditions: [], actions: [{ type: "notify", params: { channel: "in-app", message: "done" } }], scope: { type: "all" } });
    queued.length = 0;
    expect(await emitEvent(ctx.org.id, "crawl.completed", site.id)).toBe(1);
    expect(await emitEvent(ctx.org.id, "backlink.lost", site.id)).toBe(0);
  });
});

describe("approvals and live site changes", () => {
  it("cannot apply a change without approval; approved changes apply with backup and roll back", async () => {
    const owner = await makeContext("OWNER");
    const site = await createWebsite(owner, { name: "WP", url: wp.origin, cmsType: "WORDPRESS" });
    vi.stubGlobal("fetch", fetch); // testers for WP use safeFetch, not global fetch
    await connectWithCredentials(owner, "WORDPRESS", { baseUrl: wp.origin, username: "editor", appPassword: "app pass", metaDescriptionKey: "_seo_desc" }, site.id);

    const change = await proposeSiteChange(owner, { websiteId: site.id, url: `${wp.origin}/about/`, field: "meta_description", value: "New accurate description" });
    expect(change.status).toBe("PENDING_APPROVAL");
    expect(change.before).toBe("old description");
    const approval = await prisma.approval.findUniqueOrThrow({ where: { id: change.approvalId! } });
    expect(approval.status).toBe("PENDING");

    // Bypass attempt 1: run the apply job directly → refused, site untouched
    await expect(processSiteChangeApply(jc({ id: "x", organizationId: owner.org.id, websiteId: site.id, payload: { siteChangeId: change.id } }))).rejects.toThrow(/only approved changes/);
    // Bypass attempt 2: flip the row status without a real approval → still refused
    await prisma.siteChange.update({ where: { id: change.id }, data: { status: "APPROVED" } });
    await expect(processSiteChangeApply(jc({ id: "x", organizationId: owner.org.id, websiteId: site.id, payload: { siteChangeId: change.id } }))).rejects.toThrow(/pending, not approved/);
    await prisma.siteChange.update({ where: { id: change.id }, data: { status: "PENDING_APPROVAL" } });
    expect(wp.page.meta._seo_desc).toBe("old description");

    // Analysts can't approve
    const analyst = await makeContext("ANALYST", { orgId: owner.org.id });
    await expect(decideApproval(analyst, approval.id, "APPROVED")).rejects.toBeInstanceOf(ForbiddenError);

    // Manager approves → apply job queued → applying changes the live site
    const manager = await makeContext("MANAGER", { orgId: owner.org.id });
    queued.length = 0;
    await decideApproval(manager, approval.id, "APPROVED", "Looks good");
    const applyJob = queued.find((q) => q.type === "site-change-apply");
    expect(applyJob?.payload).toEqual({ siteChangeId: change.id });
    await processSiteChangeApply(jc({ id: "y", organizationId: owner.org.id, websiteId: site.id, payload: { siteChangeId: change.id } }));
    expect(wp.page.meta._seo_desc).toBe("New accurate description");
    expect((await prisma.siteChange.findUniqueOrThrow({ where: { id: change.id } })).status).toBe("APPLIED");

    await rollbackSiteChange(manager, change.id);
    expect(wp.page.meta._seo_desc).toBe("old description");
    expect((await prisma.siteChange.findUniqueOrThrow({ where: { id: change.id } })).status).toBe("ROLLED_BACK");
    await expect(decideApproval(manager, approval.id, "REJECTED")).rejects.toThrow(/Already approved/);
  });

  it("detects meta keys WordPress silently ignores", async () => {
    const owner = await makeContext("OWNER");
    const site = await createWebsite(owner, { name: "WP2", url: `${wp.origin}/`, cmsType: "WORDPRESS" });
    await connectWithCredentials(owner, "WORDPRESS", { baseUrl: wp.origin, username: "editor", appPassword: "app pass", metaDescriptionKey: "_unregistered" }, site.id);
    const change = await proposeSiteChange(owner, { websiteId: site.id, url: `${wp.origin}/about/`, field: "meta_description", value: "Will not stick" });
    await decideApproval(await makeContext("ADMIN", { orgId: owner.org.id }), change.approvalId!, "APPROVED");
    await expect(processSiteChangeApply(jc({ id: "z", organizationId: owner.org.id, websiteId: site.id, payload: { siteChangeId: change.id } }))).rejects.toThrow(/show_in_rest/);
    expect((await prisma.siteChange.findUniqueOrThrow({ where: { id: change.id } })).status).toBe("FAILED");
  });

  it("approval-mode workflows request approval for external actions instead of executing them", async () => {
    const ctx = await makeContext("OWNER");
    const site = await createWebsite(ctx, { name: "AP", url: "approve.example.com" });
    const wf = await saveWorkflow(ctx, { name: "ap", mode: "APPROVAL", trigger: { type: "manual" }, conditions: [], actions: [{ type: "propose_metadata_fixes", params: { limit: 5 } }], scope: { type: "all" } });
    await processWorkflowRun(jc({ id: "w", organizationId: ctx.org.id, websiteId: site.id, payload: { workflowId: wf.id, websiteId: site.id, triggeredBy: "manual" } }));
    const a = await ctx.db.approval.findFirstOrThrow({ where: { kind: "WORKFLOW_ACTION" } });
    expect(a.status).toBe("PENDING");
    expect(await ctx.db.siteChange.count()).toBe(0);
    // Running the approved-action path with a pending approval is refused
    await expect(processWorkflowRun(jc({ id: "w2", organizationId: ctx.org.id, websiteId: site.id, payload: { workflowId: wf.id, websiteId: site.id, triggeredBy: "approval", approvedAction: { type: "propose_metadata_fixes", params: {} }, approvalId: a.id } }))).rejects.toThrow(/not approved/);
  });
});

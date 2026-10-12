import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/client";
import { createWebsite } from "@/server/websites";
import {
  createReport, approveReport, listReportsForViewer, getReportForViewer, sendReport, sendReportNow, saveSchedule,
  scheduleReports, processReportJob, nextScheduleRun, previousPeriod, updateReportNotes, readReportData,
} from "@/server/reports";
import { renderReportPdf } from "@/reports/pdf";
import * as delivery from "@/server/delivery";
import * as queue from "@/lib/jobs/queue";
import type { JobContext } from "@/lib/jobs/context";
import { makeContext } from "./helpers";

afterAll(() => vi.restoreAllMocks());

const day = (s: string) => new Date(`${s}T00:00:00Z`);
const jc = (orgId: string, payload: object) => ({ job: { id: "r", organizationId: orgId, websiteId: null, type: "report-generate", payload, attempts: 1, status: "RUNNING" }, progress: async () => undefined, isCancelled: async () => false, log: () => undefined }) as unknown as JobContext;

async function seed() {
  const owner = await makeContext();
  const client = await prisma.client.create({ data: { organizationId: owner.org.id, name: `Client ${Date.now()}` } });
  const a = await createWebsite(owner, { name: "Alpha", url: `alpha-${Date.now()}.example.com` });
  const b = await createWebsite(owner, { name: "Beta", url: `beta-${Date.now()}.example.com` });
  await prisma.website.update({ where: { id: a.id }, data: { clientId: client.id } });
  for (let i = 0; i < 14; i++) {
    const date = day(`2026-09-${String(1 + i).padStart(2, "0")}`);
    await prisma.searchConsoleDaily.create({ data: { organizationId: owner.org.id, websiteId: a.id, date, clicks: 10 + i, impressions: 200, ctr: 0.05, position: 8 } });
    await prisma.searchConsoleQuery.create({ data: { organizationId: owner.org.id, websiteId: a.id, date, query: "widget repair", page: "https://a/x", clicks: 3, impressions: 40, ctr: 0.075, position: 6 } });
  }
  const k = await prisma.keyword.create({ data: { organizationId: owner.org.id, websiteId: a.id, phrase: "widget repair" } });
  await prisma.rankObservation.create({ data: { organizationId: owner.org.id, websiteId: a.id, keywordId: k.id, position: 15, source: "test", observedAt: day("2026-08-30") } });
  await prisma.rankObservation.create({ data: { organizationId: owner.org.id, websiteId: a.id, keywordId: k.id, position: 4, source: "test", observedAt: day("2026-09-10") } });
  await prisma.task.create({ data: { organizationId: owner.org.id, websiteId: a.id, title: "Fixed broken links", status: "DONE", completedAt: day("2026-09-05"), visibleToClient: true } });
  await prisma.task.create({ data: { organizationId: owner.org.id, websiteId: a.id, title: "Internal pricing review", status: "DONE", completedAt: day("2026-09-06") } });
  return { owner, client, a, b };
}

describe("reports", () => {
  it("freezes measured numbers with provenance-ready structure and renders a PDF", async () => {
    const { owner, a } = await seed();
    const r = await createReport(owner, { title: "September", websiteIds: [a.id], from: "2026-09-01", to: "2026-09-14" });
    const d = readReportData(r);
    expect(d.dashboard.searchConsole.totals?.clicks).toBe(Array.from({ length: 14 }, (_, i) => 10 + i).reduce((x, y) => x + y));
    expect(d.sites).toHaveLength(1);
    const s = d.sites[0];
    expect(s.topQueries[0]).toMatchObject({ query: "widget repair", clicks: 42 });
    expect(s.movers.improved).toEqual([{ phrase: "widget repair", from: 15, to: 4 }]);
    expect(s.completedTasks).toEqual(["Fixed broken links"]); // internal task not named
    expect(s.tasksDone).toBe(2);
    expect(d.brand.name).toBe(owner.org.name);

    // Later data doesn't change a generated report
    await prisma.searchConsoleDaily.create({ data: { organizationId: owner.org.id, websiteId: a.id, date: day("2026-09-15"), clicks: 9999, impressions: 1, ctr: 1, position: 1 } });
    expect(readReportData(await getReportForViewer(owner, r.id)).dashboard.searchConsole.totals?.clicks).toBe(d.dashboard.searchConsole.totals?.clicks);

    const pdf = await renderReportPdf(r);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(2000);
  });

  it("validates input and enforces roles", async () => {
    const { owner, a } = await seed();
    await expect(createReport(owner, { title: "x", from: "2026-09-10", to: "2026-09-01" })).rejects.toThrow();
    const analyst = await makeContext("ANALYST", { orgId: owner.org.id });
    const r = await createReport(analyst, { title: "By analyst", websiteIds: [a.id], from: "2026-09-01", to: "2026-09-14" });
    await expect(approveReport(analyst, r.id)).rejects.toThrow(/permission/i);
    const outsider = await makeContext();
    await expect(getReportForViewer(outsider, r.id)).rejects.toThrow(/not found/);
    await expect(createReport(outsider, { title: "Steal", websiteIds: [a.id], from: "2026-09-01", to: "2026-09-14" })).rejects.toThrow(/No websites/);
  });

  it("shows clients only approved reports inside their websites", async () => {
    const { owner, client, a, b } = await seed();
    const mine = await createReport(owner, { title: "Alpha only", websiteIds: [a.id], from: "2026-09-01", to: "2026-09-14" });
    const both = await createReport(owner, { title: "Agency-wide", websiteIds: [a.id, b.id], from: "2026-09-01", to: "2026-09-14" });
    const viewer = await makeContext("CLIENT", { orgId: owner.org.id, clientId: client.id });
    expect(await listReportsForViewer(viewer)).toEqual([]);
    await expect(getReportForViewer(viewer, mine.id)).rejects.toThrow(/not found/);
    await approveReport(owner, mine.id);
    await approveReport(owner, both.id);
    expect((await listReportsForViewer(viewer)).map((r) => r.id)).toEqual([mine.id]);
    await expect(getReportForViewer(viewer, both.id)).rejects.toThrow(/not found/);
    await expect(updateReportNotes(owner, mine.id, "late edit")).rejects.toThrow(/frozen/);
  });

  it("never emails an unapproved report", async () => {
    const send = vi.spyOn(delivery, "sendEmail").mockResolvedValue("msg-1");
    const { owner, a } = await seed();
    const r = await createReport(owner, { title: "Draft", websiteIds: [a.id], from: "2026-09-01", to: "2026-09-14" });
    await expect(sendReport(owner.org.id, r.id, ["c@example.com"])).rejects.toThrow(/Only approved/);
    await expect(sendReportNow(owner, r.id, "not-an-email")).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    await approveReport(owner, r.id);
    expect(await sendReportNow(owner, r.id, "c@example.com, d@example.com")).toBe(2);
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][1];
    expect(msg.to).toEqual(["c@example.com", "d@example.com"]);
    expect(msg.attachments?.[0].content.subarray(0, 5).toString()).toBe("%PDF-");
    send.mockRestore();
  });

  it("computes schedule periods and generates scheduled reports that wait for approval", async () => {
    expect(nextScheduleRun("WEEKLY", new Date("2026-10-07T10:00:00Z")).toISOString()).toBe("2026-10-12T06:00:00.000Z");
    expect(nextScheduleRun("MONTHLY", new Date("2026-10-01T05:00:00Z")).toISOString()).toBe("2026-10-01T06:00:00.000Z");
    expect(nextScheduleRun("MONTHLY", new Date("2026-10-01T07:00:00Z")).toISOString()).toBe("2026-11-01T06:00:00.000Z");
    expect(previousPeriod("WEEKLY", new Date("2026-10-12T06:00:00Z"))).toEqual({ from: day("2026-10-05"), to: day("2026-10-11") });
    expect(previousPeriod("MONTHLY", new Date("2026-10-01T06:00:00Z"))).toEqual({ from: day("2026-09-01"), to: day("2026-09-30") });

    const queued: { type: string; payload: Record<string, unknown> }[] = [];
    vi.spyOn(queue, "enqueueJob").mockImplementation(async (j) => { queued.push(j as never); return { job: { id: "q", status: "QUEUED" }, deduped: false } as never; });
    const send = vi.spyOn(delivery, "sendEmail").mockResolvedValue("m");
    const { owner, client } = await seed();
    const analyst = await makeContext("ANALYST", { orgId: owner.org.id });
    await expect(saveSchedule(analyst, { name: "Auto", frequency: "MONTHLY", autoApprove: true })).rejects.toThrow(/permission/i);
    const sched = await saveSchedule(owner, { name: "Monthly client", clientId: client.id, frequency: "MONTHLY", recipients: ["boss@client.example"] });
    await prisma.reportSchedule.update({ where: { id: sched.id }, data: { nextRunAt: new Date(Date.now() - 1000) } });
    expect(await scheduleReports(new Date())).toBeGreaterThanOrEqual(1);
    const job = queued.find((q) => q.payload.scheduleId === sched.id)!;
    expect((await prisma.reportSchedule.findUniqueOrThrow({ where: { id: sched.id } })).nextRunAt!.getTime()).toBeGreaterThan(Date.now());

    const res = await processReportJob(jc(owner.org.id, { ...job.payload, runAt: "2026-10-01T06:00:00Z" })) as { reportId: string };
    const rep = await prisma.report.findUniqueOrThrow({ where: { id: res.reportId } });
    expect(rep.status).toBe("GENERATED");
    expect(rep.periodStart.toISOString().slice(0, 10)).toBe("2026-09-01");
    expect(send).not.toHaveBeenCalled();
    expect(await prisma.notification.count({ where: { organizationId: owner.org.id, type: "report_ready" } })).toBeGreaterThan(0);

    // Approval queues the send to the schedule's recipients
    queued.length = 0;
    await approveReport(owner, rep.id);
    const sendJob = queued.find((q) => q.payload.sendReportId === rep.id)!;
    await processReportJob(jc(owner.org.id, sendJob.payload));
    expect(send).toHaveBeenCalledWith(owner.org.id, expect.objectContaining({ to: ["boss@client.example"] }));
    send.mockRestore();
  });
});

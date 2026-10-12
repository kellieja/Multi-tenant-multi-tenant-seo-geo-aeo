import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffContext } from "@/lib/auth/context";
import { PageHeader } from "@/components/ui/page";
import type { WorkflowInput } from "@/server/workflow-schema";
import { fmtRelative } from "@/lib/format";
import { WorkflowBuilder } from "../builder";

export const metadata = { title: "Workflow" };

export default async function EditWorkflow({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireStaffContext();
  ctx.assert("automation:write");
  const wf = await ctx.db.workflow.findUnique({ where: { id } });
  if (!wf) notFound();
  const [sites, clients] = await Promise.all([
    ctx.db.website.findMany({ where: { status: { not: "ARCHIVED" } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ctx.db.client.findMany({ where: { archivedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const initial: WorkflowInput = { name: wf.name, description: wf.description, mode: wf.mode, trigger: wf.trigger as WorkflowInput["trigger"], conditions: wf.conditions as WorkflowInput["conditions"], actions: wf.actions as WorkflowInput["actions"], scope: wf.scope as WorkflowInput["scope"], maxRetries: wf.maxRetries, notifyOn: wf.notifyOn as WorkflowInput["notifyOn"] };
  return (
    <>
      <PageHeader eyebrow={<Link href="/automation" className="hover:text-fg">Automation Center</Link>} title={wf.name} description={<>{wf.enabled ? "Active" : "Paused"} · last run {fmtRelative(wf.lastRunAt)}{wf.nextRunAt ? ` · next ${fmtRelative(wf.nextRunAt)}` : ""} · <Link className="text-accent hover:underline" href="/automation?tab=executions">execution log</Link></>} />
      <WorkflowBuilder id={wf.id} initial={initial} sites={sites} clients={clients} />
    </>
  );
}

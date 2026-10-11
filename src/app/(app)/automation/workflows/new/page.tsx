import Link from "next/link";
import { requireOrgContext } from "@/lib/auth/context";
import { PageHeader } from "@/components/ui/page";
import { TEMPLATES } from "@/server/workflow-schema";
import { WorkflowBuilder } from "../builder";

export const metadata = { title: "New workflow" };

export default async function NewWorkflow() {
  const ctx = await requireOrgContext();
  ctx.assert("automation:write");
  const [sites, clients] = await Promise.all([
    ctx.db.website.findMany({ where: { status: { not: "ARCHIVED" } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ctx.db.client.findMany({ where: { archivedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return (
    <>
      <PageHeader eyebrow={<Link href="/automation" className="hover:text-fg">Automation Center</Link>} title="New workflow" description="Trigger → conditions → actions. Workflows start in dry-run so you can check the execution log before anything changes." />
      <WorkflowBuilder sites={sites} clients={clients} templates={TEMPLATES} initial={{ name: "Untitled workflow", description: "", mode: "DRY_RUN", trigger: { type: "schedule", cron: "0 3 * * 1" }, conditions: [], actions: [{ type: "run_crawl", params: { mode: "INCREMENTAL" } }], scope: { type: "all" }, maxRetries: 2, notifyOn: ["FAILED"] }} />
    </>
  );
}

import { prisma } from "@/lib/db/client";
import { enqueueJob } from "@/lib/jobs/queue";
import { proposeSiteChange } from "./site-changes";

/**
 * Turns human-APPROVED metadata suggestions into proposed CMS changes. With autoApprove
 * (AUTOMATIC workflow + site "safe-auto" policy) the site change is approved by policy,
 * recorded as such, and applied; otherwise it waits in the approval queue.
 */
export async function proposeApprovedSuggestions(orgId: string, websiteId: string, opts: { limit: number; autoApprove: boolean; source: string }) {
  const suggestions = await prisma.contentSuggestion.findMany({ where: { organizationId: orgId, websiteId, kind: "METADATA", status: "APPROVED" }, take: opts.limit, orderBy: { updatedAt: "asc" } });
  let proposed = 0;
  for (const s of suggestions) {
    if (!s.url) continue;
    // Auto-approval of the site change is only allowed when the content itself was approved by someone
    // who may decide site changes; an analyst's approval still goes through the normal approval queue.
    const inp = (s.input ?? {}) as { approvedById?: string | null; approvedByCanDecide?: boolean };
    let trusted = false;
    if (opts.autoApprove && inp.approvedByCanDecide && inp.approvedById) {
      const m = await prisma.membership.findFirst({ where: { organizationId: orgId, userId: inp.approvedById }, select: { role: true } });
      trusted = !!m && ["OWNER", "ADMIN", "MANAGER"].includes(m.role);
    }
    const out = JSON.parse(s.output) as { title?: string; metaDescription?: string };
    const fields: ["title" | "meta_description", string | undefined][] = [["title", out.title], ["meta_description", out.metaDescription]];
    for (const [field, value] of fields) {
      if (!value) continue;
      try {
        const change = await proposeSiteChange({ orgId, userId: null }, { websiteId, url: s.url, field, value, source: opts.source });
        proposed++;
        if (opts.autoApprove && trusted && change.approvalId) {
          await prisma.approval.update({ where: { id: change.approvalId }, data: { status: "APPROVED", decidedAt: new Date(), note: `Auto-approved by site "safe-auto" policy. Content approved in suggestion ${s.id}.` } });
          await prisma.siteChange.update({ where: { id: change.id }, data: { status: "APPROVED" } });
          await enqueueJob({ organizationId: orgId, websiteId, type: "site-change-apply", payload: { siteChangeId: change.id } });
        }
      } catch (err) {
        console.warn("[propose] skipped", s.url, field, (err as Error).message);
      }
    }
    await prisma.contentSuggestion.update({ where: { id: s.id }, data: { status: "APPLIED" } });
  }
  return { proposed };
}

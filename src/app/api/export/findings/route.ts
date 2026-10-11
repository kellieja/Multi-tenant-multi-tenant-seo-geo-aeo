import { getOrgContextOrThrow } from "@/lib/auth/context";
import { findingFilterSchema, findingWhere } from "@/server/findings";
import { csvResponse } from "@/lib/csv";
import { httpStatusFor } from "@/lib/errors";

export async function GET(req: Request) {
  try {
    const ctx = await getOrgContextOrThrow();
    const f = findingFilterSchema.parse(Object.fromEntries(new URL(req.url).searchParams));
    const rows = await ctx.db.auditFinding.findMany({ where: findingWhere(ctx, f), orderBy: { priorityScore: "desc" }, take: 50_000, include: { website: { select: { domain: true } } } });
    return csvResponse(
      [["website", "url", "issue_type", "title", "category", "severity", "status", "priority_score", "automatable", "requires_approval", "recommendation", "first_seen", "last_seen", "evidence_json"],
        ...rows.map((r) => [r.website.domain, r.url, r.issueType, r.title, r.category, r.severity, r.status, r.priorityScore, r.automatable, r.requiresApproval, r.recommendation, r.firstSeenAt, r.lastSeenAt, JSON.stringify(r.evidence)])],
      `findings_${new Date().toISOString().slice(0, 10)}.csv`,
    );
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: httpStatusFor(err) });
  }
}

import { getOrgContextOrThrow, assertWebsiteAccess } from "@/lib/auth/context";
import { csvResponse } from "@/lib/csv";
import { httpStatusFor } from "@/lib/errors";

export async function GET(req: Request) {
  try {
    const ctx = await getOrgContextOrThrow();
    const websiteId = new URL(req.url).searchParams.get("websiteId") ?? "";
    const site = await assertWebsiteAccess(ctx, websiteId);
    const rows = await ctx.db.backlink.findMany({ where: { websiteId }, orderBy: { firstSeenAt: "desc" }, take: 100_000 });
    return csvResponse([["source_url", "source_domain", "target_url", "anchor", "rel", "status", "source", "provider_rank", "first_seen", "last_seen", "lost_at", "last_verified", "verify_note"],
      ...rows.map((b) => [b.sourceUrl, b.sourceDomain, b.targetUrl, b.anchor, b.rel, b.status, b.source, b.providerRank, b.firstSeenAt, b.lastSeenAt, b.lostAt, b.lastVerifiedAt, b.verifyNote])], `backlinks_${site.domain}.csv`);
  } catch (err) { return Response.json({ error: (err as Error).message }, { status: httpStatusFor(err) }); }
}

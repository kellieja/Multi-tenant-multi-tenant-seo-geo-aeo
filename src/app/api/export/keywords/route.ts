import { getOrgContextOrThrow, assertWebsiteAccess } from "@/lib/auth/context";
import { csvResponse } from "@/lib/csv";
import { httpStatusFor } from "@/lib/errors";

export async function GET(req: Request) {
  try {
    const ctx = await getOrgContextOrThrow();
    const websiteId = new URL(req.url).searchParams.get("websiteId") ?? "";
    const site = await assertWebsiteAccess(ctx, websiteId);
    const rows = await ctx.db.keyword.findMany({ where: { websiteId }, include: { observations: { orderBy: { observedAt: "desc" }, take: 2 } }, orderBy: { phrase: "asc" } });
    return csvResponse([["phrase", "group", "tags", "device", "location_code", "intent", "intent_source", "target_url", "position", "previous_position", "ranking_url", "checked_at", "search_volume_estimate", "volume_source"],
      ...rows.map((k) => [k.phrase, k.group, k.tags.join("|"), k.device, k.locationCode, k.intent, k.intentSource, k.targetUrl, k.observations[0]?.position ?? "", k.observations[1]?.position ?? "", k.observations[0]?.url, k.observations[0]?.observedAt, k.searchVolume, k.volumeSource])], `keywords_${site.domain}.csv`);
  } catch (err) { return Response.json({ error: (err as Error).message }, { status: httpStatusFor(err) }); }
}

import { getOrgContextOrThrow } from "@/lib/auth/context";
import { httpStatusFor } from "@/lib/errors";
import { dashboardFilterSchema, resolvePeriod } from "@/server/dashboard";
import { buildReportData } from "@/server/reports";
import { renderReportPdf } from "@/reports/pdf";

export const runtime = "nodejs";

/** One-off PDF of the dashboard as currently filtered. Not stored, so no approval step applies. */
export async function GET(req: Request) {
  try {
    const ctx = await getOrgContextOrThrow();
    ctx.assert("reports:read");
    const f = dashboardFilterSchema.parse(Object.fromEntries(new URL(req.url).searchParams));
    const p = resolvePeriod(f);
    const data = await buildReportData(ctx.org.id, ctx, { websiteIds: f.websiteId ? [f.websiteId] : [], clientId: f.clientId ?? null, from: p.from, to: p.to });
    const pdf = await renderReportPdf({ title: "Executive dashboard", notes: null, data: data as never });
    const name = `dashboard_${data.period.from.slice(0, 10)}_${data.period.to.slice(0, 10)}.pdf`;
    return new Response(new Uint8Array(pdf), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${name}"`, "cache-control": "private, no-store" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: httpStatusFor(err) });
  }
}

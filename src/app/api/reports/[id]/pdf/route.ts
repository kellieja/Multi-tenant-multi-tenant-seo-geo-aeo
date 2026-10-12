import { getOrgContextOrThrow } from "@/lib/auth/context";
import { httpStatusFor } from "@/lib/errors";
import { getReportForViewer } from "@/server/reports";
import { renderReportPdf } from "@/reports/pdf";

export const runtime = "nodejs";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getOrgContextOrThrow();
    const report = await getReportForViewer(ctx, (await params).id);
    const pdf = await renderReportPdf(report);
    const name = `${report.title.replace(/[^\w.-]+/g, "_").slice(0, 80)}.pdf`;
    return new Response(new Uint8Array(pdf), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${name}"`, "cache-control": "private, no-store" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: httpStatusFor(err) });
  }
}

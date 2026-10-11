import { getOrgContextOrThrow } from "@/lib/auth/context";
import { cancelJob } from "@/lib/jobs/queue";
import { httpStatusFor } from "@/lib/errors";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getOrgContextOrThrow();
    const { id } = await params;
    const job = await ctx.db.job.findUnique({
      where: { id },
      select: { id: true, type: true, status: true, progress: true, progressMessage: true, error: true, queuedAt: true, startedAt: true, finishedAt: true, websiteId: true, attempts: true },
    });
    if (!job || (ctx.websiteScope && job.websiteId && !ctx.websiteScope.includes(job.websiteId))) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(job, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: httpStatusFor(err) });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const origin = req.headers.get("origin");
    if (origin && new URL(origin).host !== new URL(req.url).host) return Response.json({ error: "Bad origin" }, { status: 403 });
    const ctx = await getOrgContextOrThrow();
    ctx.assert("audits:run");
    const { id } = await params;
    const ok = await cancelJob(ctx.org.id, id);
    return Response.json({ cancelled: ok });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: httpStatusFor(err) });
  }
}

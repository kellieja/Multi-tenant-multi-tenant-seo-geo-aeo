import { getOrgContextOrThrow } from "@/lib/auth/context";
import { httpStatusFor, UserError } from "@/lib/errors";
import { packItems, packMarkdown, packPromptFor } from "@/server/change-packs";

/** Downloads a change pack as a Markdown checklist, JSON, or the plain-text Replit Agent prompt. Staff only. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getOrgContextOrThrow();
    if (ctx.role === "CLIENT") throw new UserError("Not found", 404);
    const pack = await ctx.db.changePack.findUnique({ where: { id: (await params).id } });
    if (!pack || (ctx.websiteScope && !ctx.websiteScope.includes(pack.websiteId))) throw new UserError("Not found", 404);
    const site = await ctx.db.website.findUniqueOrThrow({ where: { id: pack.websiteId }, select: { name: true, domain: true } });
    const format = new URL(req.url).searchParams.get("format") ?? "md";
    const base = pack.title.replace(/[^\w.-]+/g, "_").slice(0, 80);
    const headers = (type: string, ext: string) => ({ "content-type": type, "content-disposition": `attachment; filename="${base}.${ext}"`, "cache-control": "private, no-store" });
    if (format === "json") {
      return new Response(JSON.stringify({ title: pack.title, website: site, status: pack.status, createdAt: pack.createdAt, items: packItems(pack) }, null, 2), { headers: headers("application/json", "json") });
    }
    if (format === "prompt") return new Response(await packPromptFor(pack), { headers: headers("text/plain; charset=utf-8", "txt") });
    return new Response(packMarkdown(pack, site), { headers: headers("text/markdown; charset=utf-8", "md") });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: httpStatusFor(err) });
  }
}

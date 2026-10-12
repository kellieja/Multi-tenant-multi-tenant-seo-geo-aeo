import { getOrgContextOrThrow } from "@/lib/auth/context";
import { disavowFile } from "@/server/backlinks";
import { httpStatusFor } from "@/lib/errors";

export async function GET(req: Request) {
  try {
    const ctx = await getOrgContextOrThrow();
    const websiteId = new URL(req.url).searchParams.get("websiteId") ?? "";
    const text = await disavowFile(ctx, websiteId);
    return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": 'attachment; filename="disavow.txt"' } });
  } catch (err) { return Response.json({ error: (err as Error).message }, { status: httpStatusFor(err) }); }
}

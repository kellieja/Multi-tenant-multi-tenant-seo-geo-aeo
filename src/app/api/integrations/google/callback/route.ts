import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { completeGoogleConnect } from "@/server/integrations";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const base = process.env.APP_URL ?? url.origin;
  const session = await getSession();
  if (!session) return NextResponse.redirect(`${base}/login`);
  const error = url.searchParams.get("error");
  if (error) return NextResponse.redirect(`${base}/integrations?error=${encodeURIComponent(error === "access_denied" ? "Google access was not granted." : error)}`);
  try {
    const conn = await completeGoogleConnect(session.userId, url.searchParams.get("state") ?? "", url.searchParams.get("code") ?? "");
    return NextResponse.redirect(`${base}/integrations?select=${conn.id}`);
  } catch (err) {
    return NextResponse.redirect(`${base}/integrations?error=${encodeURIComponent((err as Error).message)}`);
  }
}

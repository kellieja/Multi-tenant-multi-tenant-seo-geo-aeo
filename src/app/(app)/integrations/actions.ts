"use server";

import { revalidatePath } from "next/cache";
import type { IntegrationProvider } from "@prisma/client";
import { getOrgContextOrThrow } from "@/lib/auth/context";
import { toActionError, type ActionResult } from "@/lib/errors";
import { connectWithCredentials, disconnect, listGoogleProperties, retestConnection, selectGoogleProperty, startGoogleConnect, syncNow } from "@/server/integrations";

export async function connectAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    const fields: Record<string, string> = {};
    for (const [k, v] of fd.entries()) if (typeof v === "string" && !["provider", "websiteId"].includes(k) && !k.startsWith("$")) fields[k] = v;
    const r = await connectWithCredentials(ctx, String(fd.get("provider")) as IntegrationProvider, fields, String(fd.get("websiteId") ?? "") || null);
    revalidatePath("/integrations");
    return { ok: true, data: undefined, message: r.message };
  } catch (e) { return toActionError(e); }
}

export async function googleConnectAction(_: unknown, fd: FormData): Promise<ActionResult<{ url: string }>> {
  try {
    const ctx = await getOrgContextOrThrow();
    const url = await startGoogleConnect(ctx, String(fd.get("provider")) as IntegrationProvider, String(fd.get("websiteId") ?? ""));
    return { ok: true, data: { url } };
  } catch (e) { return toActionError(e); }
}

export async function googlePropertiesAction(connectionId: string): Promise<ActionResult<{ id: string; name: string }[]>> {
  try { return { ok: true, data: await listGoogleProperties(await getOrgContextOrThrow(), connectionId) }; } catch (e) { return toActionError(e); }
}

export async function selectPropertyAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    await selectGoogleProperty(await getOrgContextOrThrow(), String(fd.get("connectionId")), String(fd.get("property")));
    revalidatePath("/integrations");
    return { ok: true, data: undefined, message: "Property saved. The first sync has been queued." };
  } catch (e) { return toActionError(e); }
}

export async function disconnectAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try { await disconnect(await getOrgContextOrThrow(), String(fd.get("id"))); revalidatePath("/integrations"); return { ok: true, data: undefined, message: "Disconnected. Stored credentials were deleted." }; } catch (e) { return toActionError(e); }
}

export async function testAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try { const m = await retestConnection(await getOrgContextOrThrow(), String(fd.get("id"))); revalidatePath("/integrations"); return { ok: true, data: undefined, message: m }; } catch (e) { revalidatePath("/integrations"); return toActionError(e); }
}

export async function syncAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try { await syncNow(await getOrgContextOrThrow(), String(fd.get("id")), String(fd.get("websiteId") ?? "") || undefined); revalidatePath("/integrations"); return { ok: true, data: undefined, message: "Sync queued" }; } catch (e) { return toActionError(e); }
}

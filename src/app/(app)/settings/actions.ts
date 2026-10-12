"use server";

import { revalidatePath } from "next/cache";
import type { Role } from "@prisma/client";
import { getOrgContextOrThrow } from "@/lib/auth/context";
import { toActionError, type ActionResult } from "@/lib/errors";
import { archiveClient, changeMemberRole, inviteMember, removeMember, updateOrgSettings, upsertClient } from "@/server/orgs";
import { changePassword } from "@/server/auth";
import { revokeAllUserSessions } from "@/lib/auth/session-core";

const done = (message: string): ActionResult => { revalidatePath("/settings"); return { ok: true, data: undefined, message }; };

export async function updateOrgAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try { await updateOrgSettings(await getOrgContextOrThrow(), Object.fromEntries(fd)); return done("Workspace settings saved"); } catch (e) { return toActionError(e); }
}

export async function inviteAction(_: unknown, fd: FormData): Promise<ActionResult<{ acceptUrl: string }>> {
  try {
    const res = await inviteMember(await getOrgContextOrThrow(), Object.fromEntries(fd));
    revalidatePath("/settings");
    return { ok: true, data: res, message: "Invitation created. Copy the link below and send it to the invitee." };
  } catch (e) { return toActionError(e); }
}

export async function changeRoleAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    await changeMemberRole(await getOrgContextOrThrow(), String(fd.get("membershipId")), String(fd.get("role")) as Role, String(fd.get("clientId") ?? "") || null);
    return done("Role updated");
  } catch (e) { return toActionError(e); }
}

export async function removeMemberAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try { await removeMember(await getOrgContextOrThrow(), String(fd.get("membershipId"))); return done("Member removed"); } catch (e) { return toActionError(e); }
}

export async function saveClientAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const id = String(fd.get("id") ?? "") || undefined;
    await upsertClient(await getOrgContextOrThrow(), Object.fromEntries(fd), id);
    return done(id ? "Client updated" : "Client created");
  } catch (e) { return toActionError(e); }
}

export async function archiveClientAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try { await archiveClient(await getOrgContextOrThrow(), String(fd.get("id")), fd.get("archived") === "1"); return done("Client updated"); } catch (e) { return toActionError(e); }
}

export async function changePasswordAction(_: unknown, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    await changePassword(ctx.userId, String(fd.get("current")), String(fd.get("next")));
    await revokeAllUserSessions(ctx.userId, ctx.sessionId);
    return { ok: true, data: undefined, message: "Password changed. Other sessions were signed out." };
  } catch (e) { return toActionError(e); }
}

export async function signOutOthersAction(): Promise<ActionResult> {
  try {
    const ctx = await getOrgContextOrThrow();
    await revokeAllUserSessions(ctx.userId, ctx.sessionId);
    return done("Signed out of all other sessions");
  } catch (e) { return toActionError(e); }
}

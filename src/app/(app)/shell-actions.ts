"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { getOrgContextOrThrow } from "@/lib/auth/context";

export async function switchOrgAction(fd: FormData) {
  const session = await getSession();
  if (!session) redirect("/login");
  const orgId = String(fd.get("organizationId") ?? "");
  const m = await prisma.membership.findUnique({ where: { userId_organizationId: { userId: session.userId, organizationId: orgId } } });
  if (m) await prisma.session.update({ where: { id: session.id }, data: { organizationId: orgId } });
  redirect("/dashboard");
}

export async function markNotificationsReadAction() {
  const ctx = await getOrgContextOrThrow();
  await ctx.db.notification.updateMany({ where: { OR: [{ userId: ctx.userId }, { userId: null }], readAt: null }, data: { readAt: new Date() } });
  revalidatePath("/", "layout");
}

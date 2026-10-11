"use server";

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { acceptInvitation } from "@/server/orgs";
import { toActionError, type ActionResult } from "@/lib/errors";

export async function acceptInviteAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  try {
    const session = await getSession();
    if (!session) redirect("/login");
    const orgId = await acceptInvitation(session.userId, session.user.email, String(fd.get("token")));
    await prisma.session.update({ where: { id: session.id }, data: { organizationId: orgId } });
  } catch (err) {
    return toActionError(err);
  }
  redirect("/dashboard");
}

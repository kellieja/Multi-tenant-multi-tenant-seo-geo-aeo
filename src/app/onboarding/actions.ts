"use server";

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { createOrganization } from "@/server/orgs";
import { toActionError, type ActionResult } from "@/lib/errors";

export async function createOrgAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  try {
    const session = await getSession();
    if (!session) redirect("/login");
    const org = await createOrganization(session.userId, String(fd.get("name") ?? ""));
    await prisma.session.update({ where: { id: session.id }, data: { organizationId: org.id } });
  } catch (err) {
    return toActionError(err);
  }
  redirect("/websites?welcome=1");
}

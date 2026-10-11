import type { Role } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { buildOrgContext } from "@/lib/auth/context";
import { randomToken } from "@/lib/crypto";

export async function makeUser(name = "Test User") {
  return prisma.user.create({
    data: { name, email: `${randomToken(6).toLowerCase()}@example.test`, passwordHash: "x" },
  });
}

export async function makeOrg(name = "Org") {
  return prisma.organization.create({ data: { name, slug: `${name.toLowerCase()}-${randomToken(5).toLowerCase()}` } });
}

/** Creates (or reuses) an org, adds a member with the given role, returns their context. */
export async function makeContext(role: Role = "OWNER", opts: { orgId?: string; clientId?: string } = {}) {
  const user = await makeUser(`${role} user`);
  const orgId = opts.orgId ?? (await makeOrg()).id;
  await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role, clientId: opts.clientId ?? null } });
  const ctx = await buildOrgContext({ userId: user.id, organizationId: orgId });
  if (!ctx) throw new Error("context build failed");
  return ctx;
}

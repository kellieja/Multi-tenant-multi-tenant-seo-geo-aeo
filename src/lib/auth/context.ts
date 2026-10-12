import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import type { Membership, Organization, Role } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { tenantDb, type TenantDb } from "@/lib/db/tenant";
import { getSession } from "./session";
import { assertCan, can, ForbiddenError, type Permission } from "./rbac";

export interface OrgContext {
  userId: string;
  userName: string;
  userEmail: string;
  sessionId: string;
  role: Role;
  membership: Membership;
  org: Organization;
  db: TenantDb;
  /** null = every website in the org; otherwise the only website ids this member may see. */
  websiteScope: string[] | null;
  can: (p: Permission) => boolean;
  assert: (p: Permission) => void;
}

export class UnauthenticatedError extends Error {
  status = 401;
  constructor() {
    super("Not signed in");
    this.name = "UnauthenticatedError";
  }
}

export async function resolveWebsiteScope(membership: Membership): Promise<string[] | null> {
  if (membership.role !== "CLIENT") return null;
  if (!membership.clientId) return [];
  const sites = await prisma.website.findMany({
    where: { organizationId: membership.organizationId, clientId: membership.clientId, status: { not: "ARCHIVED" } },
    select: { id: true },
  });
  return sites.map((s) => s.id);
}

/** Builds an org context for a user/org pair. Used by the web app and by tests. */
export async function buildOrgContext(params: {
  userId: string;
  organizationId: string;
  sessionId?: string;
}): Promise<OrgContext | null> {
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: params.userId, organizationId: params.organizationId } },
    include: { organization: true, user: { select: { name: true, email: true } } },
  });
  if (!membership) return null;
  const websiteScope = await resolveWebsiteScope(membership);
  const { organization, user, ...m } = membership;
  return {
    userId: params.userId,
    userName: user.name,
    userEmail: user.email,
    sessionId: params.sessionId ?? "",
    role: membership.role,
    membership: m as Membership,
    org: organization,
    db: tenantDb(organization.id),
    websiteScope,
    can: (p) => can(membership.role, p),
    assert: (p) => assertCan(membership.role, p),
  };
}

/** For pages: redirects to /login or onboarding when there is no usable context. */
export const requireOrgContext = cache(async (): Promise<OrgContext> => {
  const session = await getSession();
  if (!session) redirect("/login");
  let orgId = session.organizationId;
  if (!orgId) {
    const first = await prisma.membership.findFirst({ where: { userId: session.userId }, orderBy: { createdAt: "asc" } });
    if (!first) redirect("/onboarding");
    orgId = first.organizationId;
    await prisma.session.update({ where: { id: session.id }, data: { organizationId: orgId } });
  }
  const ctx = await buildOrgContext({ userId: session.userId, organizationId: orgId, sessionId: session.id });
  if (!ctx) {
    await prisma.session.update({ where: { id: session.id }, data: { organizationId: null } });
    redirect("/onboarding");
  }
  return ctx;
});

/**
 * For staff-only modules (audits, automation, integrations, ...). Client-portal users get a 404,
 * so pages that list org-wide data can never leak other clients' information to them.
 */
export async function requireStaffContext(): Promise<OrgContext> {
  const ctx = await requireOrgContext();
  if (ctx.role === "CLIENT") notFound();
  return ctx;
}

/** For route handlers / server actions: throws instead of redirecting. */
export async function getOrgContextOrThrow(): Promise<OrgContext> {
  const session = await getSession();
  if (!session?.organizationId) throw new UnauthenticatedError();
  const ctx = await buildOrgContext({
    userId: session.userId,
    organizationId: session.organizationId,
    sessionId: session.id,
  });
  if (!ctx) throw new UnauthenticatedError();
  return ctx;
}

/** Throws if the member cannot see this website (tenant + client-portal scope). */
export async function assertWebsiteAccess(ctx: OrgContext, websiteId: string) {
  if (ctx.websiteScope && !ctx.websiteScope.includes(websiteId)) throw new ForbiddenError("Website not available");
  const site = await ctx.db.website.findUnique({ where: { id: websiteId } });
  if (!site) throw new ForbiddenError("Website not found");
  return site;
}

/** Prisma `where` fragment restricting a websiteId column to the member's scope. */
export function websiteWhere(ctx: OrgContext, websiteId?: string | null) {
  if (websiteId) {
    if (ctx.websiteScope && !ctx.websiteScope.includes(websiteId)) return { websiteId: "__none__" };
    return { websiteId };
  }
  return ctx.websiteScope ? { websiteId: { in: ctx.websiteScope } } : {};
}

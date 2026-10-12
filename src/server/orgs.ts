import { z } from "zod";
import type { Role } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { OrgContext } from "@/lib/auth/context";
import { randomToken, sha256 } from "@/lib/crypto";
import { UserError } from "@/lib/errors";
import { writeAuditLog } from "@/lib/audit-log";

export function slugify(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "workspace";
}

export async function createOrganization(userId: string, name: string) {
  const clean = z.string().trim().min(2, "Workspace name is too short").max(80).parse(name);
  const base = slugify(clean);
  let slug = base;
  for (let i = 2; await prisma.organization.findUnique({ where: { slug } }); i++) slug = `${base}-${i}`;
  const org = await prisma.organization.create({
    data: { name: clean, slug, brandName: clean, memberships: { create: { userId, role: "OWNER" } } },
  });
  await writeAuditLog({ organizationId: org.id, userId, action: "org.create", entityType: "Organization", entityId: org.id });
  return org;
}

export const clientSchema = z.object({
  name: z.string().trim().min(1, "Client name is required").max(120),
  contactEmail: z.string().trim().email().max(200).optional().or(z.literal("")).transform((v) => v || null),
  notes: z.string().trim().max(2000).optional().transform((v) => v || null),
});

export async function upsertClient(ctx: OrgContext, input: unknown, id?: string) {
  ctx.assert("websites:write");
  const data = clientSchema.parse(input);
  const clash = await ctx.db.client.findFirst({ where: { name: data.name, ...(id ? { id: { not: id } } : {}) } });
  if (clash) throw new UserError("A client with that name already exists");
  return id
    ? ctx.db.client.update({ where: { id }, data })
    : ctx.db.client.create({ data: { ...data, organizationId: ctx.org.id } });
}

export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(["ADMIN", "MANAGER", "ANALYST", "CLIENT"]),
  clientId: z.string().optional().nullable().transform((v) => v || null),
});

/** Creates an invitation and returns the one-time accept link (shown once to the inviter). */
export async function inviteMember(ctx: OrgContext, input: unknown) {
  ctx.assert("members:manage");
  const data = inviteSchema.parse(input);
  if (data.role === "CLIENT" && !data.clientId) throw new UserError("Client accounts must be linked to a client");
  if (data.clientId && !(await ctx.db.client.findUnique({ where: { id: data.clientId } }))) throw new UserError("Unknown client");
  const existingUser = await prisma.user.findUnique({ where: { email: data.email } });
  if (existingUser && (await ctx.db.membership.findFirst({ where: { userId: existingUser.id } }))) {
    throw new UserError("That person is already a member");
  }
  const token = randomToken(24);
  await ctx.db.invitation.create({
    data: {
      organizationId: ctx.org.id,
      email: data.email,
      role: data.role as Role,
      clientId: data.clientId,
      tokenHash: sha256(token),
      invitedById: ctx.userId,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    },
  });
  await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: "member.invite", metadata: { email: data.email, role: data.role } });
  return { acceptUrl: `${process.env.APP_URL ?? ""}/invite/${token}` };
}

export async function acceptInvitation(userId: string, email: string, token: string) {
  const invite = await prisma.invitation.findUnique({ where: { tokenHash: sha256(token) } });
  if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) throw new UserError("This invitation is invalid or has expired");
  if (invite.email !== email.toLowerCase()) throw new UserError(`This invitation was sent to ${invite.email}`);
  await prisma.$transaction([
    prisma.membership.upsert({
      where: { userId_organizationId: { userId, organizationId: invite.organizationId } },
      create: { userId, organizationId: invite.organizationId, role: invite.role, clientId: invite.clientId },
      update: {},
    }),
    prisma.invitation.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } }),
  ]);
  return invite.organizationId;
}

export async function changeMemberRole(ctx: OrgContext, membershipId: string, role: Role, clientId: string | null) {
  ctx.assert("members:manage");
  const m = await ctx.db.membership.findUnique({ where: { id: membershipId } });
  if (!m) throw new UserError("Member not found");
  if (m.role === "OWNER" && ctx.role !== "OWNER") throw new UserError("Only owners can change an owner's access");
  if (m.role === "OWNER" && role !== "OWNER") {
    const owners = await ctx.db.membership.count({ where: { role: "OWNER" } });
    if (owners <= 1) throw new UserError("A workspace needs at least one owner");
  }
  if (role === "OWNER" && ctx.role !== "OWNER") throw new UserError("Only owners can grant owner access");
  if (role === "CLIENT" && !clientId) throw new UserError("Client accounts must be linked to a client");
  await ctx.db.membership.update({ where: { id: membershipId }, data: { role, clientId: role === "CLIENT" ? clientId : null } });
  await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: "member.role", entityId: membershipId, metadata: { role } });
}

export async function removeMember(ctx: OrgContext, membershipId: string) {
  ctx.assert("members:manage");
  const m = await ctx.db.membership.findUnique({ where: { id: membershipId } });
  if (!m) throw new UserError("Member not found");
  if (m.role === "OWNER" && ctx.role !== "OWNER") throw new UserError("Only owners can remove an owner");
  if (m.role === "OWNER" && (await ctx.db.membership.count({ where: { role: "OWNER" } })) <= 1) {
    throw new UserError("A workspace needs at least one owner");
  }
  await ctx.db.membership.delete({ where: { id: membershipId } });
  await prisma.session.updateMany({ where: { userId: m.userId, organizationId: ctx.org.id }, data: { organizationId: null } });
  await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: "member.remove", entityId: membershipId });
}

export const orgSettingsSchema = z.object({
  name: z.string().trim().min(2).max(80),
  brandName: z.string().trim().max(80).optional().transform((v) => v || null),
  brandColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #2F5BEA"),
  logoUrl: z.string().trim().url().max(500).refine((u) => u.startsWith("https://"), "Logo must be an https URL").optional().or(z.literal("")).transform((v) => v || null),
  notifyEmail: z.string().trim().email().optional().or(z.literal("")).transform((v) => v || null),
  slackWebhookConfigured: z.any().optional(),
});

export async function updateOrgSettings(ctx: OrgContext, input: unknown) {
  ctx.assert("org:manage");
  const data = orgSettingsSchema.parse(input);
  const current = (ctx.org.settings ?? {}) as Record<string, unknown>;
  await prisma.organization.update({
    where: { id: ctx.org.id },
    data: {
      name: data.name,
      brandName: data.brandName,
      brandColor: data.brandColor,
      logoUrl: data.logoUrl,
      settings: { ...current, notifyEmail: data.notifyEmail },
    },
  });
  await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: "org.settings.update" });
}

export async function archiveClient(ctx: OrgContext, id: string, archived: boolean) {
  ctx.assert("websites:write");
  return ctx.db.client.update({ where: { id }, data: { archivedAt: archived ? new Date() : null } });
}

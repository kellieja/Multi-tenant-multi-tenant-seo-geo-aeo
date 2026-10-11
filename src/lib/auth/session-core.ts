import { prisma } from "@/lib/db/client";
import { randomToken, sha256 } from "@/lib/crypto";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export async function createSessionRecord(input: {
  userId: string;
  organizationId: string | null;
  ip?: string | null;
  userAgent?: string | null;
}) {
  const token = randomToken(32);
  const session = await prisma.session.create({
    data: {
      tokenHash: sha256(token),
      userId: input.userId,
      organizationId: input.organizationId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
    },
  });
  return { token, session };
}

/** Resolves a raw cookie token into a live session + user, sliding the expiry. */
export async function validateSessionToken(token: string) {
  if (!token || token.length > 200) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { select: { id: true, email: true, name: true, lockedUntil: true } } },
  });
  if (!session) return null;
  const now = Date.now();
  if (session.expiresAt.getTime() < now) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  if (now - session.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
    await prisma.session.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date(), expiresAt: new Date(now + SESSION_TTL_MS) },
    });
  }
  return session;
}

export async function revokeSessionToken(token: string) {
  await prisma.session.deleteMany({ where: { tokenHash: sha256(token) } });
}

export async function revokeAllUserSessions(userId: string, exceptSessionId?: string) {
  await prisma.session.deleteMany({ where: { userId, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) } });
}

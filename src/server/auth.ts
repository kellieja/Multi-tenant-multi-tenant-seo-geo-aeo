import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { hashPassword, passwordSchema, verifyPassword } from "@/lib/auth/password";
import { UserError } from "@/lib/errors";
import { writeAuditLog } from "@/lib/audit-log";

export const registerSchema = z.object({
  name: z.string().trim().min(1, "Your name is required").max(100),
  email: z.string().trim().toLowerCase().email("Enter a valid email").max(200),
  password: passwordSchema,
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(1, "Password is required").max(200),
});

const LOCK_AFTER = 8;
const LOCK_MINUTES = 15;
// Pre-computed argon2 hash so unknown-email logins cost the same as real ones.
let dummyHash: Promise<string> | null = null;

export async function registerUser(input: unknown) {
  const data = registerSchema.parse(input);
  const exists = await prisma.user.findUnique({ where: { email: data.email } });
  if (exists) throw new UserError("An account with this email already exists. Sign in instead.");
  const user = await prisma.user.create({
    data: { name: data.name, email: data.email, passwordHash: await hashPassword(data.password) },
  });
  await writeAuditLog({ userId: user.id, action: "user.register" });
  return user;
}

/** Verifies credentials with lockout after repeated failures. Error message never reveals which part was wrong. */
export async function authenticate(input: unknown, ip?: string | null) {
  const data = loginSchema.parse(input);
  const user = await prisma.user.findUnique({ where: { email: data.email } });
  if (!user) {
    dummyHash ??= hashPassword("timing-equaliser-password-1");
    await verifyPassword(await dummyHash, data.password);
    throw new UserError("Incorrect email or password");
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new UserError("Too many failed attempts. This account is temporarily locked; try again in a few minutes.");
  }
  const ok = await verifyPassword(user.passwordHash, data.password);
  if (!ok) {
    const failed = user.failedLoginCount + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: failed >= LOCK_AFTER ? 0 : failed,
        lockedUntil: failed >= LOCK_AFTER ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
      },
    });
    await writeAuditLog({ userId: user.id, action: "user.login.failed", ip });
    throw new UserError("Incorrect email or password");
  }
  await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
  await writeAuditLog({ userId: user.id, action: "user.login", ip });
  return user;
}

export async function changePassword(userId: string, current: string, next: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await verifyPassword(user.passwordHash, current))) throw new UserError("Current password is incorrect");
  const parsed = passwordSchema.parse(next);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(parsed) } });
  await writeAuditLog({ userId, action: "user.password.change" });
}

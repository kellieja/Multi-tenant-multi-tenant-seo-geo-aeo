import { describe, expect, it } from "vitest";
import { authenticate, registerUser } from "@/server/auth";
import { createSessionRecord, revokeSessionToken, validateSessionToken } from "@/lib/auth/session-core";
import { prisma } from "@/lib/db/client";

describe("auth", () => {
  it("registers, authenticates, and rejects bad passwords without leaking which part failed", async () => {
    const email = `u${Date.now()}@example.test`;
    await registerUser({ name: "Kim", email, password: "correct-horse-9" });
    await expect(registerUser({ name: "Kim", email, password: "correct-horse-9" })).rejects.toThrow(/already exists/);
    const user = await authenticate({ email, password: "correct-horse-9" });
    expect(user.email).toBe(email);
    await expect(authenticate({ email, password: "wrong-password-1" })).rejects.toThrow("Incorrect email or password");
    await expect(authenticate({ email: "nobody@example.test", password: "whatever-123" })).rejects.toThrow("Incorrect email or password");
    const stored = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("enforces password strength", async () => {
    await expect(registerUser({ name: "a", email: "weak@example.test", password: "short" })).rejects.toThrow();
  });

  it("locks the account after repeated failures", async () => {
    const email = `lock${Date.now()}@example.test`;
    await registerUser({ name: "L", email, password: "correct-horse-9" });
    for (let i = 0; i < 8; i++) await authenticate({ email, password: "nope-nope-1" }).catch(() => undefined);
    await expect(authenticate({ email, password: "correct-horse-9" })).rejects.toThrow(/locked/);
  });

  it("stores only a hash of the session token and supports revocation", async () => {
    const user = await registerUser({ name: "S", email: `s${Date.now()}@example.test`, password: "correct-horse-9" });
    const { token, session } = await createSessionRecord({ userId: user.id, organizationId: null });
    expect(session.tokenHash).not.toBe(token);
    expect((await validateSessionToken(token))?.userId).toBe(user.id);
    await revokeSessionToken(token);
    expect(await validateSessionToken(token)).toBeNull();
  });
});

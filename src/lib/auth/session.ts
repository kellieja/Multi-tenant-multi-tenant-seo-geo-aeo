import { cookies, headers } from "next/headers";
import { cache } from "react";
import { createSessionRecord, revokeSessionToken, SESSION_TTL_MS, validateSessionToken } from "./session-core";

export const SESSION_COOKIE = "so_session";

async function requestMeta() {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null;
  return { ip, userAgent: h.get("user-agent") };
}

export async function startSession(userId: string, organizationId: string | null) {
  const meta = await requestMeta();
  const { token } = await createSessionRecord({ userId, organizationId, ...meta });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

/** Current session for this request (memoised per request). */
export const getSession = cache(async () => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return validateSessionToken(token);
});

export async function endSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await revokeSessionToken(token);
  jar.delete(SESSION_COOKIE);
}

export { requestMeta };

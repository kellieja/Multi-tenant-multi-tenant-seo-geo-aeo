import { cookies, headers } from "next/headers";
import { cache } from "react";
import { createSessionRecord, revokeSessionToken, SESSION_TTL_MS, validateSessionToken } from "./session-core";

export const SESSION_COOKIE = "so_session";

async function requestMeta() {
  const h = await headers();
  return { ip: clientIp(h), userAgent: h.get("user-agent") };
}

/**
 * Client IP for rate limiting and session records. The leftmost X-Forwarded-For entry is
 * client-controlled, so we take the entry added by our own proxy: TRUSTED_PROXY_HOPS from the
 * right (default 1). Vercel's own header is preferred when present.
 */
export function clientIp(h: Pick<Headers, "get">): string | null {
  const vercel = h.get("x-vercel-forwarded-for");
  if (vercel) return vercel.split(",")[0].trim();
  const hops = Math.max(1, Number(process.env.TRUSTED_PROXY_HOPS ?? 1) || 1);
  const xff = h.get("x-forwarded-for")?.split(",").map((x) => x.trim()).filter(Boolean) ?? [];
  if (xff.length) return xff[Math.max(0, xff.length - hops)];
  return h.get("x-real-ip");
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

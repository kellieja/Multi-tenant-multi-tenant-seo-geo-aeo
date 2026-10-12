import type { IntegrationConnection, IntegrationProvider } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { signPayload } from "@/lib/crypto";
import { IntegrationError, readSecret, saveSecret } from "./connections";
import { providerDef } from "./registry";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch ms
  scope?: string;
}

export const googleRedirectUri = () => `${process.env.APP_URL ?? "http://localhost:3000"}/api/integrations/google/callback`;

export function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function buildGoogleAuthUrl(state: { orgId: string; userId: string; connectionId: string; provider: IntegrationProvider }) {
  if (!googleConfigured()) throw new Error("Google OAuth is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).");
  const def = providerDef(state.provider);
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: ["openid", "email", ...(def.scopes ?? [])].join(" "),
    state: signPayload(state, 900),
  });
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(body: Record<string, string>, provider: IntegrationProvider) {
  const res = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = String(json.error_description ?? json.error ?? `HTTP ${res.status}`);
    throw new IntegrationError(`Google token exchange failed: ${msg}`, provider, res.status === 400 && json.error === "invalid_grant" ? 401 : res.status);
  }
  return json as { access_token: string; refresh_token?: string; expires_in: number; scope?: string; id_token?: string };
}

export async function exchangeCode(code: string, provider: IntegrationProvider): Promise<GoogleTokens & { email?: string }> {
  const t = await tokenRequest({ code, client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, redirect_uri: googleRedirectUri(), grant_type: "authorization_code" }, provider);
  let email: string | undefined;
  if (t.id_token) {
    try { email = JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url").toString()).email; } catch { /* optional */ }
  }
  return { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000, scope: t.scope, email };
}

/** Returns a valid access token, refreshing (and persisting) it when within 2 minutes of expiry. */
export async function googleAccessToken(conn: IntegrationConnection): Promise<string> {
  const tokens = readSecret<GoogleTokens>(conn);
  if (tokens.expires_at - Date.now() > 120_000) return tokens.access_token;
  if (!tokens.refresh_token) throw new IntegrationError("Google access expired and no refresh token is stored. Reconnect the integration.", conn.provider, 401);
  const t = await tokenRequest({ refresh_token: tokens.refresh_token, client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, grant_type: "refresh_token" }, conn.provider);
  const next: GoogleTokens = { ...tokens, access_token: t.access_token, expires_at: Date.now() + t.expires_in * 1000 };
  await saveSecret(conn.id, next);
  await prisma.integrationConnection.update({ where: { id: conn.id }, data: { tokenExpiresAt: new Date(next.expires_at) } });
  return next.access_token;
}

/** Authenticated Google API call with retry on 429/5xx (exponential backoff, max 4 tries). */
export async function googleApi<T>(conn: IntegrationConnection, url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const token = await googleAccessToken(conn);
    const res = await fetch(url, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (res.ok) return (await res.json()) as T;
    const text = await res.text();
    let message = text.slice(0, 300);
    try { message = JSON.parse(text).error?.message ?? message; } catch { /* raw */ }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 500));
      continue;
    }
    throw new IntegrationError(`Google API ${res.status}: ${message}`, conn.provider, res.status, res.status === 429);
  }
}

// ───────────── Search Console

export interface GscSite { siteUrl: string; permissionLevel: string }

export async function listGscSites(conn: IntegrationConnection) {
  const res = await googleApi<{ siteEntry?: GscSite[] }>(conn, "https://www.googleapis.com/webmasters/v3/sites");
  return (res.siteEntry ?? []).filter((s) => s.permissionLevel !== "siteUnverifiedUser");
}

interface GscRow { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }

export async function gscQuery(conn: IntegrationConnection, property: string, body: Record<string, unknown>) {
  const rows: GscRow[] = [];
  let calls = 0;
  for (let startRow = 0; ; startRow += 25000) {
    const res = await googleApi<{ rows?: GscRow[] }>(conn, `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`, { body: { ...body, rowLimit: 25000, startRow } });
    calls++;
    rows.push(...(res.rows ?? []));
    if (!res.rows || res.rows.length < 25000 || startRow >= 100_000) break;
  }
  return { rows, calls };
}

// ───────────── GA4

export async function listGa4Properties(conn: IntegrationConnection) {
  const res = await googleApi<{ accountSummaries?: { displayName: string; propertySummaries?: { property: string; displayName: string }[] }[] }>(conn, "https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200");
  return (res.accountSummaries ?? []).flatMap((a) => (a.propertySummaries ?? []).map((p) => ({ id: p.property.replace("properties/", ""), name: `${a.displayName} › ${p.displayName}` })));
}

export async function ga4Report(conn: IntegrationConnection, propertyId: string, body: Record<string, unknown>) {
  return googleApi<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[]; rowCount?: number }>(
    conn, `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`, { body },
  );
}

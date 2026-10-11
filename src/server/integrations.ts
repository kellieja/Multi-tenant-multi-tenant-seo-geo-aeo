import type { IntegrationProvider, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { OrgContext } from "@/lib/auth/context";
import { assertWebsiteAccess } from "@/lib/auth/context";
import { encryptSecret, verifyPayload } from "@/lib/crypto";
import { UserError } from "@/lib/errors";
import { writeAuditLog } from "@/lib/audit-log";
import { enqueueJob } from "@/lib/jobs/queue";
import { PROVIDERS, providerDef, missingEnv } from "@/integrations/registry";
import { TESTERS } from "@/integrations/testers";
import { readSecret } from "@/integrations/connections";
import { buildGoogleAuthUrl, exchangeCode, listGscSites, listGa4Properties } from "@/integrations/google";
import { updateWebsiteSettings } from "./websites";

/** Connection list safe to send to the browser (no secrets). */
export async function listConnections(ctx: OrgContext, websiteId?: string) {
  const rows = await ctx.db.integrationConnection.findMany({
    where: websiteId ? { OR: [{ websiteId }, { websiteId: null }] } : {},
    orderBy: { createdAt: "asc" },
    include: { website: { select: { id: true, name: true, domain: true } } },
  });
  return rows.map(({ encryptedSecret, ...r }) => ({ ...r, hasSecret: Boolean(encryptedSecret) }));
}

export async function connectWithCredentials(ctx: OrgContext, provider: IntegrationProvider, fields: Record<string, string>, websiteId: string | null) {
  ctx.assert("integrations:manage");
  const def = providerDef(provider);
  if (!def || def.auth === "oauth-google") throw new UserError("This provider connects via OAuth");
  if (def.level === "website") {
    if (!websiteId) throw new UserError("Choose a website for this connection");
    await assertWebsiteAccess(ctx, websiteId);
  } else websiteId = null;
  const secret: Record<string, string> = {};
  for (const f of def.fields ?? []) {
    const v = (fields[f.name] ?? "").trim();
    if (!v && !f.optional) throw new UserError(`${f.label} is required`);
    if (v.length > 4000) throw new UserError(`${f.label} is too long`);
    secret[f.name] = v;
  }
  const tester = TESTERS[provider];
  const result = tester ? await tester(secret) : { ok: true, message: "Saved" };
  if (!result.ok) throw new UserError(result.message);
  const existing = await ctx.db.integrationConnection.findFirst({ where: { provider, websiteId } });
  const data = {
    status: "CONNECTED" as const,
    encryptedSecret: encryptSecret(secret),
    externalAccountId: result.externalAccountId ?? null,
    config: (result.config ?? {}) as Prisma.InputJsonValue,
    label: def.name,
    lastError: null,
    scopes: def.scopes ?? [],
  };
  const conn = existing
    ? await ctx.db.integrationConnection.update({ where: { id: existing.id }, data })
    : await ctx.db.integrationConnection.create({ data: { ...data, organizationId: ctx.org.id, provider, websiteId } });
  await prisma.syncLog.create({ data: { organizationId: ctx.org.id, connectionId: conn.id, websiteId, operation: "connect.verify", status: "SUCCEEDED", message: result.message, finishedAt: new Date() } });
  await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: "integration.connect", entityType: "IntegrationConnection", entityId: conn.id, metadata: { provider } });
  return { connectionId: conn.id, message: result.message };
}

export async function startGoogleConnect(ctx: OrgContext, provider: IntegrationProvider, websiteId: string) {
  ctx.assert("integrations:manage");
  const def = providerDef(provider);
  if (def.auth !== "oauth-google") throw new UserError("Not a Google OAuth provider");
  const missing = missingEnv(def);
  if (missing.length) throw new UserError(`Google OAuth isn't configured on this server. Set ${missing.join(" and ")} (see setup steps).`);
  await assertWebsiteAccess(ctx, websiteId);
  const existing = await ctx.db.integrationConnection.findFirst({ where: { provider, websiteId } });
  const conn = existing
    ? await ctx.db.integrationConnection.update({ where: { id: existing.id }, data: { status: existing.encryptedSecret ? existing.status : "PENDING" } })
    : await ctx.db.integrationConnection.create({ data: { organizationId: ctx.org.id, provider, websiteId, status: "PENDING", label: def.name, scopes: def.scopes ?? [] } });
  return buildGoogleAuthUrl({ orgId: ctx.org.id, userId: ctx.userId, connectionId: conn.id, provider });
}

/** OAuth callback: validates signed state, binds tokens to the connection it was issued for. */
export async function completeGoogleConnect(sessionUserId: string, stateToken: string, code: string) {
  const state = verifyPayload<{ orgId: string; userId: string; connectionId: string; provider: IntegrationProvider }>(stateToken);
  if (!state) throw new UserError("The connection request expired or was tampered with. Please try again.");
  if (state.userId !== sessionUserId) throw new UserError("This connection was started by a different user.");
  const conn = await prisma.integrationConnection.findFirst({ where: { id: state.connectionId, organizationId: state.orgId } });
  if (!conn) throw new UserError("Connection not found");
  const tokens = await exchangeCode(code, state.provider);
  if (!tokens.refresh_token) {
    const prior = conn.encryptedSecret ? readSecret<{ refresh_token?: string }>(conn) : {};
    tokens.refresh_token = prior.refresh_token;
  }
  const granted = tokens.scope?.split(" ") ?? [];
  const needed = providerDef(state.provider).scopes ?? [];
  const missingScopes = needed.filter((s) => !granted.includes(s));
  await prisma.integrationConnection.update({
    where: { id: conn.id },
    data: {
      encryptedSecret: encryptSecret({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: tokens.expires_at, scope: tokens.scope }),
      tokenExpiresAt: new Date(tokens.expires_at),
      externalAccountId: tokens.email ?? null,
      scopes: granted,
      status: missingScopes.length ? "ERROR" : "PENDING",
      lastError: missingScopes.length ? `Permission not granted: ${missingScopes.join(", ")}. Reconnect and allow access.` : "Select a property to finish setup.",
    },
  });
  await writeAuditLog({ organizationId: state.orgId, userId: sessionUserId, action: "integration.oauth", entityType: "IntegrationConnection", entityId: conn.id, metadata: { provider: state.provider, account: tokens.email } });
  return conn;
}

export async function listGoogleProperties(ctx: OrgContext, connectionId: string) {
  const conn = await ctx.db.integrationConnection.findUnique({ where: { id: connectionId } });
  if (!conn?.encryptedSecret) throw new UserError("Connect the Google account first");
  if (conn.provider === "GOOGLE_SEARCH_CONSOLE") return (await listGscSites(conn)).map((s) => ({ id: s.siteUrl, name: `${s.siteUrl} (${s.permissionLevel.replace("site", "").toLowerCase()})` }));
  if (conn.provider === "GOOGLE_ANALYTICS_4") return listGa4Properties(conn);
  throw new UserError("Unsupported provider");
}

export async function selectGoogleProperty(ctx: OrgContext, connectionId: string, propertyId: string) {
  ctx.assert("integrations:manage");
  const conn = await ctx.db.integrationConnection.findUnique({ where: { id: connectionId } });
  if (!conn || !conn.websiteId) throw new UserError("Connection not found");
  const options = await listGoogleProperties(ctx, connectionId);
  if (!options.some((o) => o.id === propertyId)) throw new UserError("That property isn't available to the connected Google account");
  const isGsc = conn.provider === "GOOGLE_SEARCH_CONSOLE";
  await ctx.db.integrationConnection.update({ where: { id: connectionId }, data: { status: "CONNECTED", lastError: null, config: isGsc ? { property: propertyId } : { propertyId } } });
  await updateWebsiteSettings(ctx, conn.websiteId, isGsc ? { gscPropertyUrl: propertyId } : { ga4PropertyId: propertyId });
  const { job } = await enqueueJob({ organizationId: ctx.org.id, websiteId: conn.websiteId, type: isGsc ? "gsc-sync" : "ga4-sync", payload: { full: true }, createdById: ctx.userId, dedupe: true });
  return job;
}

export async function disconnect(ctx: OrgContext, connectionId: string) {
  ctx.assert("integrations:manage");
  const conn = await ctx.db.integrationConnection.findUnique({ where: { id: connectionId } });
  if (!conn) throw new UserError("Connection not found");
  // Best-effort token revocation for Google.
  if (conn.provider.startsWith("GOOGLE_") && conn.encryptedSecret) {
    try {
      const t = readSecret<{ refresh_token?: string; access_token: string }>(conn);
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refresh_token ?? t.access_token)}`, { method: "POST", signal: AbortSignal.timeout(10_000) });
    } catch { /* still disconnect locally */ }
  }
  await ctx.db.integrationConnection.update({ where: { id: connectionId }, data: { status: "DISCONNECTED", encryptedSecret: null, tokenExpiresAt: null, lastError: null } });
  await writeAuditLog({ organizationId: ctx.org.id, userId: ctx.userId, action: "integration.disconnect", entityType: "IntegrationConnection", entityId: connectionId, metadata: { provider: conn.provider } });
}

export async function retestConnection(ctx: OrgContext, connectionId: string) {
  ctx.assert("integrations:manage");
  const conn = await ctx.db.integrationConnection.findUnique({ where: { id: connectionId } });
  if (!conn?.encryptedSecret) throw new UserError("Nothing to test; connect first");
  if (conn.provider.startsWith("GOOGLE_")) {
    await listGoogleProperties(ctx, connectionId);
    await ctx.db.integrationConnection.update({ where: { id: conn.id }, data: { lastError: null, status: (conn.config as { property?: string; propertyId?: string }).property || (conn.config as { propertyId?: string }).propertyId ? "CONNECTED" : "PENDING" } });
    return "Google access verified.";
  }
  const tester = TESTERS[conn.provider];
  const res = tester ? await tester(readSecret(conn)) : { ok: true, message: "OK" };
  await ctx.db.integrationConnection.update({ where: { id: conn.id }, data: res.ok ? { status: "CONNECTED", lastError: null } : { status: "ERROR", lastError: res.message } });
  await prisma.syncLog.create({ data: { organizationId: ctx.org.id, connectionId: conn.id, websiteId: conn.websiteId, operation: "connect.verify", status: res.ok ? "SUCCEEDED" : "FAILED", message: res.message, finishedAt: new Date() } });
  if (!res.ok) throw new UserError(res.message);
  return res.message;
}

const SYNC_JOB: Partial<Record<IntegrationProvider, "gsc-sync" | "ga4-sync" | "psi-check" | "backlink-sync">> = {
  GOOGLE_SEARCH_CONSOLE: "gsc-sync",
  GOOGLE_ANALYTICS_4: "ga4-sync",
};

export async function syncNow(ctx: OrgContext, connectionId: string, websiteId?: string) {
  ctx.assert("integrations:manage");
  const conn = await ctx.db.integrationConnection.findUnique({ where: { id: connectionId } });
  if (!conn) throw new UserError("Connection not found");
  const type = SYNC_JOB[conn.provider] ?? (conn.provider === "PAGESPEED_INSIGHTS" ? "psi-check" : undefined);
  if (!type) throw new UserError("This integration has no sync job; it's used on demand.");
  const site = conn.websiteId ?? websiteId;
  if (!site) throw new UserError("Choose a website to run this for");
  await assertWebsiteAccess(ctx, site);
  return (await enqueueJob({ organizationId: ctx.org.id, websiteId: site, type, createdById: ctx.userId, dedupe: true })).job;
}

export { PROVIDERS };

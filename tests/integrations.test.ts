import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/client";
import { connectWithCredentials, listConnections, completeGoogleConnect, selectGoogleProperty, disconnect } from "@/server/integrations";
import { processGscSync, processGa4Sync } from "@/server/sync";
import { getDashboard } from "@/server/dashboard";
import { createWebsite } from "@/server/websites";
import { signPayload, encryptSecret } from "@/lib/crypto";
import { extract } from "@/integrations/pagespeed";
import { googleAccessToken } from "@/integrations/google";
import type { JobContext } from "@/lib/jobs/context";
import { makeContext } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

type Route = (url: string, init?: RequestInit) => { status?: number; json: unknown } | undefined;
function mockFetch(route: Route) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const r = route(url, init);
    if (!r) throw new Error(`unmocked fetch ${url}`);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }));
  return calls;
}

const jc = (job: { id: string; organizationId: string; websiteId: string | null; payload?: object }) =>
  ({ job: { ...job, type: "x", status: "RUNNING", progress: 0, payload: job.payload ?? {} } as never, progress: async () => undefined, isCancelled: async () => false, log: () => undefined }) as JobContext;

describe("credential integrations", () => {
  it("verifies DataForSEO credentials with a live call, encrypts them and never exposes them", async () => {
    const ctx = await makeContext("ADMIN");
    const calls = mockFetch((url) => url.includes("user_data") ? { json: { tasks: [{ result: [{ money: { balance: 42.5 } }] }] } } : undefined);
    const r = await connectWithCredentials(ctx, "DATAFORSEO", { login: "me@x.com", password: "s3cret-pass" }, null);
    expect(r.message).toMatch(/42.5/);
    expect(calls[0].init?.headers).toMatchObject({ authorization: `Basic ${Buffer.from("me@x.com:s3cret-pass").toString("base64")}` });
    const stored = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: r.connectionId } });
    expect(stored.status).toBe("CONNECTED");
    expect(stored.encryptedSecret).not.toContain("s3cret");
    const listed = await listConnections(ctx);
    expect(JSON.stringify(listed)).not.toContain("encryptedSecret");
    expect(JSON.stringify(listed)).not.toContain("s3cret");
    expect(await prisma.syncLog.count({ where: { connectionId: r.connectionId, operation: "connect.verify" } })).toBe(1);
    await disconnect(ctx, r.connectionId);
    expect((await prisma.integrationConnection.findUniqueOrThrow({ where: { id: r.connectionId } })).encryptedSecret).toBeNull();
  });

  it("rejects bad credentials with an actionable error and stores nothing", async () => {
    const ctx = await makeContext("ADMIN");
    mockFetch(() => ({ status: 401, json: {} }));
    await expect(connectWithCredentials(ctx, "ANTHROPIC", { apiKey: "bad" }, null)).rejects.toThrow(/rejected the API key/);
    expect(await ctx.db.integrationConnection.count()).toBe(0);
  });

  it("requires integrations permission", async () => {
    const ctx = await makeContext("ANALYST");
    await expect(connectWithCredentials(ctx, "ANTHROPIC", { apiKey: "x" }, null)).rejects.toThrow(/permission/);
  });

  it("parses PageSpeed field and lab data", () => {
    const m = extract({
      lighthouseResult: { categories: { performance: { score: 0.42 } }, audits: { "largest-contentful-paint": { numericValue: 4100 } } },
      loadingExperience: { overall_category: "SLOW", metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 3900 }, INTERACTION_TO_NEXT_PAINT: { percentile: 180 }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 12 } } },
    });
    expect(m).toMatchObject({ performanceScore: 0.42, lcpMs: 4100, fieldLcpMs: 3900, fieldInpMs: 180, fieldCls: 0.12, fieldCategory: "SLOW" });
  });
});

describe("Google OAuth + Search Console / GA4 sync", () => {
  it("rejects forged or foreign OAuth state", async () => {
    const ctx = await makeContext("OWNER");
    await expect(completeGoogleConnect(ctx.userId, "garbage.sig", "code")).rejects.toThrow(/expired or was tampered/);
    const state = signPayload({ orgId: ctx.org.id, userId: "someone-else", connectionId: "x", provider: "GOOGLE_SEARCH_CONSOLE" });
    await expect(completeGoogleConnect(ctx.userId, state, "code")).rejects.toThrow(/different user/);
  });

  it("exchanges the code, selects a property, syncs GSC data and feeds the dashboard", async () => {
    process.env.GOOGLE_CLIENT_ID = "cid";
    process.env.GOOGLE_CLIENT_SECRET = "csecret";
    const ctx = await makeContext("OWNER");
    const site = await createWebsite(ctx, { name: "G", url: "gsc-test.example.com" });
    const conn = await ctx.db.integrationConnection.create({ data: { organizationId: ctx.org.id, websiteId: site.id, provider: "GOOGLE_SEARCH_CONSOLE", status: "PENDING" } });
    const days = Array.from({ length: 5 }, (_, i) => new Date(Date.now() - (i + 2) * 86400_000).toISOString().slice(0, 10));
    mockFetch((url, init) => {
      if (url.includes("oauth2.googleapis.com/token")) return { json: { access_token: "at", refresh_token: "refresh-token-plaintext-1d9f", expires_in: 3600, scope: "openid https://www.googleapis.com/auth/webmasters.readonly", id_token: `x.${Buffer.from(JSON.stringify({ email: "seo@example.com" })).toString("base64url")}.y` } };
      if (url.endsWith("/webmasters/v3/sites")) return { json: { siteEntry: [{ siteUrl: "sc-domain:gsc-test.example.com", permissionLevel: "siteOwner" }] } };
      if (url.includes("searchAnalytics/query")) {
        const body = JSON.parse(String(init?.body));
        if (body.dimensions.length === 1) return { json: { rows: days.map((d, i) => ({ keys: [d], clicks: 10 + i, impressions: 100, ctr: 0.1, position: 5 })) } };
        return { json: { rows: [{ keys: [days[0], "widgets", "https://gsc-test.example.com/"], clicks: 3, impressions: 40, ctr: 0.075, position: 4.2 }] } };
      }
      return undefined;
    });
    const state = signPayload({ orgId: ctx.org.id, userId: ctx.userId, connectionId: conn.id, provider: "GOOGLE_SEARCH_CONSOLE" });
    await completeGoogleConnect(ctx.userId, state, "auth-code");
    const pending = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(pending.status).toBe("PENDING");
    expect(pending.externalAccountId).toBe("seo@example.com");
    expect(pending.encryptedSecret).not.toContain("refresh-token-plaintext-1d9f");

    await expect(selectGoogleProperty(ctx, conn.id, "sc-domain:not-mine.com")).rejects.toThrow(/isn't available/);
    const job = await selectGoogleProperty(ctx, conn.id, "sc-domain:gsc-test.example.com");
    expect(job.type).toBe("gsc-sync");

    const res = await processGscSync(jc({ id: job.id, organizationId: ctx.org.id, websiteId: site.id }));
    expect(res.items).toBe(6);
    expect(await prisma.searchConsoleDaily.count({ where: { websiteId: site.id } })).toBe(5);
    const log = await prisma.syncLog.findFirstOrThrow({ where: { connectionId: conn.id, operation: "gsc.searchAnalytics" } });
    expect(log.status).toBe("SUCCEEDED");

    const d = await getDashboard(ctx, { range: "28d" });
    expect(d.searchConsole.available).toBe(true);
    expect(d.searchConsole.totals?.clicks).toBe(10 + 11 + 12 + 13 + 14);
    expect(d.searchConsole.totals?.position).toBeCloseTo(5);
  });

  it("marks the connection as errored with an actionable message when Google rejects access", async () => {
    process.env.GOOGLE_CLIENT_ID = "cid";
    process.env.GOOGLE_CLIENT_SECRET = "csecret";
    const ctx = await makeContext("OWNER");
    const site = await createWebsite(ctx, { name: "E", url: "ga-err.example.com" });
    const conn = await ctx.db.integrationConnection.create({ data: { organizationId: ctx.org.id, websiteId: site.id, provider: "GOOGLE_ANALYTICS_4", status: "CONNECTED", config: { propertyId: "123" }, encryptedSecret: encryptSecret({ access_token: "a", refresh_token: "r", expires_at: Date.now() + 3600_000 }) } });
    mockFetch((url) => url.includes("runReport") ? { status: 403, json: { error: { message: "User does not have sufficient permissions for this property." } } } : undefined);
    await expect(processGa4Sync(jc({ id: "j", organizationId: ctx.org.id, websiteId: site.id }))).rejects.toThrow(/403/);
    const after = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after.status).toBe("ERROR");
    expect(after.lastError).toMatch(/reconnect or check permissions/);
  });

  it("refreshes expired access tokens and persists them", async () => {
    process.env.GOOGLE_CLIENT_ID = "cid";
    process.env.GOOGLE_CLIENT_SECRET = "csecret";
    const ctx = await makeContext("OWNER");
    const conn = await ctx.db.integrationConnection.create({ data: { organizationId: ctx.org.id, provider: "GOOGLE_SEARCH_CONSOLE", status: "CONNECTED", encryptedSecret: encryptSecret({ access_token: "old", refresh_token: "r", expires_at: Date.now() - 1000 }) } });
    mockFetch((url) => url.includes("token") ? { json: { access_token: "fresh", expires_in: 3600 } } : undefined);
    expect(await googleAccessToken(conn)).toBe("fresh");
    const again = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(again.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });
});

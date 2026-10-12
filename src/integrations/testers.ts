import { safeSmtpOptions } from "@/lib/net/smtp";
import { UserError } from "@/lib/errors";
import type { IntegrationProvider } from "@prisma/client";
import { safeFetch } from "@/lib/net/safe-fetch";
import { IntegrationError } from "./connections";

export interface TestResult {
  ok: boolean;
  message: string;
  externalAccountId?: string;
  config?: Record<string, unknown>;
}

const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

async function jsonFetch(url: string, init: RequestInit, provider: IntegrationProvider) {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new IntegrationError(`Could not reach ${new URL(url).host}: ${(err as Error).message}`, provider);
  }
  const body = await res.json().catch(() => ({}));
  return { res, body: body as Record<string, unknown> };
}

/**
 * Verifies credentials with a real, cheap API call before a connection is marked CONNECTED.
 * Each tester returns a human-readable, actionable message on failure.
 */
export const TESTERS: Partial<Record<IntegrationProvider, (s: Record<string, string>, existingConfig?: Record<string, unknown>) => Promise<TestResult>>> = {
  /** Checks the token can see and push to the repository and that the base branch exists. */
  async GITHUB(s) {
    const { GitHubClient, parseRepository } = await import("./github");
    let repo: string;
    try { repo = parseRepository(s.repository); } catch (err) { return { ok: false, message: (err as Error).message }; }
    try {
      const gh = new GitHubClient(s.token, repo);
      const info = await gh.repoInfo();
      if (info.permissions && !info.permissions.push) return { ok: false, message: `The token can read ${repo} but can't write to it. Grant Contents: Read and write, and Pull requests: Read and write.` };
      const base = s.baseBranch?.trim() || info.default_branch;
      await gh.branchSha(base);
      return { ok: true, message: `Connected to ${repo}; pull requests will target ${base}.`, externalAccountId: repo, config: { repository: repo, baseBranch: base, defaultBranch: info.default_branch, sitePath: (s.sitePath ?? "").trim() } };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  },
  /** Connects, checks the document root has an index.html, and pins the SFTP host key on first connect. */
  async FILE_HOST(s, existingConfig) {
    const { FileHostClient, normalizeDocRoot } = await import("./filehost");
    let client;
    try {
      client = await FileHostClient.open(s as never, (existingConfig ?? {}) as never);
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
    try {
      const root = normalizeDocRoot(s.docRoot || "/");
      const index = await client.read(`${root === "/" ? "" : root}/index.html`).catch(() => null);
      if (index == null) return { ok: false, message: `Connected, but there's no index.html in ${root}. Check the document root.` };
      return {
        ok: true,
        message: `Connected over ${s.protocol.toUpperCase()}; found ${root}/index.html${client.hostKeySha256 ? `. Host key pinned (SHA256:${client.hostKeySha256.slice(0, 16)}…)` : ""}.`,
        externalAccountId: `${s.username}@${s.host}`,
        config: { protocol: s.protocol, docRoot: root, ...(client.hostKeySha256 ? { hostKeySha256: client.hostKeySha256 } : {}) },
      };
    } finally {
      await client.close();
    }
  },
  async DATAFORSEO(s) {
    const { res, body } = await jsonFetch("https://api.dataforseo.com/v3/appendix/user_data", { headers: { authorization: basic(s.login, s.password) } }, "DATAFORSEO");
    if (res.status === 401) return { ok: false, message: "DataForSEO rejected the login/password." };
    const task = (body.tasks as { result?: { money?: { balance?: number } }[]; status_message?: string }[] | undefined)?.[0];
    if (!res.ok || !task) return { ok: false, message: `DataForSEO error: ${String(body.status_message ?? res.status)}` };
    const balance = task.result?.[0]?.money?.balance;
    return { ok: true, message: `Connected. Account balance: $${balance ?? "?"}`, externalAccountId: s.login, config: { balance } };
  },
  async ANTHROPIC(s) {
    const { res, body } = await jsonFetch("https://api.anthropic.com/v1/models?limit=5", { headers: { "x-api-key": s.apiKey, "anthropic-version": "2023-06-01" } }, "ANTHROPIC");
    if (res.status === 401) return { ok: false, message: "Anthropic rejected the API key." };
    if (!res.ok) return { ok: false, message: `Anthropic error ${res.status}: ${JSON.stringify(body.error ?? body).slice(0, 200)}` };
    return { ok: true, message: "API key verified.", config: { model: s.model || undefined } };
  },
  async OPENAI(s) {
    const { res, body } = await jsonFetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${s.apiKey}` } }, "OPENAI");
    if (res.status === 401) return { ok: false, message: "OpenAI rejected the API key." };
    if (!res.ok) return { ok: false, message: `OpenAI error ${res.status}: ${JSON.stringify(body.error ?? body).slice(0, 200)}` };
    return { ok: true, message: "API key verified.", config: { model: s.model || undefined } };
  },
  async GEMINI(s) {
    const { res, body } = await jsonFetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(s.apiKey)}&pageSize=1`, {}, "GEMINI");
    if (res.status === 400 || res.status === 403) return { ok: false, message: "Gemini rejected the API key." };
    if (!res.ok) return { ok: false, message: `Gemini error ${res.status}: ${JSON.stringify(body.error ?? body).slice(0, 200)}` };
    return { ok: true, message: "API key verified.", config: { model: s.model || undefined } };
  },
  async PERPLEXITY(s) {
    // Smallest possible request (1 output token) to validate the key.
    const { res, body } = await jsonFetch("https://api.perplexity.ai/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${s.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: s.model || "sonar", messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
    }, "PERPLEXITY");
    if (res.status === 401) return { ok: false, message: "Perplexity rejected the API key." };
    if (!res.ok) return { ok: false, message: `Perplexity error ${res.status}: ${JSON.stringify(body.error ?? body).slice(0, 200)}` };
    return { ok: true, message: "API key verified.", config: { model: s.model || undefined } };
  },
  async PAGESPEED_INSIGHTS(s) {
    if (!s.apiKey) return { ok: true, message: "Connected without an API key (shared anonymous quota; expect 429 errors under load)." };
    const { res, body } = await jsonFetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent("https://www.google.com/")}&strategy=desktop&category=seo&key=${encodeURIComponent(s.apiKey)}`, {}, "PAGESPEED_INSIGHTS");
    if (res.status === 400 || res.status === 403) return { ok: false, message: `Google rejected the key: ${String((body.error as { message?: string })?.message ?? res.status)}` };
    if (!res.ok) return { ok: false, message: `PageSpeed error ${res.status}` };
    return { ok: true, message: "API key verified." };
  },
  async WORDPRESS(s) {
    let base: URL;
    try { base = new URL(s.baseUrl); } catch { return { ok: false, message: "Enter a valid site URL" }; }
    const r = await safeFetch(`${base.origin}${base.pathname.replace(/\/$/, "")}/wp-json/wp/v2/users/me?context=edit`, {
      headers: { authorization: basic(s.username, s.appPassword), accept: "application/json" }, maxBytes: 512 * 1024,
    });
    if (r.status === 401 || r.status === 403) return { ok: false, message: "WordPress rejected the username/application password (or the REST API is blocked for authenticated requests)." };
    if (r.status === 404) return { ok: false, message: "No WordPress REST API found at /wp-json. Check the URL and that the REST API is enabled." };
    if (r.status !== 200) return { ok: false, message: `WordPress returned HTTP ${r.status}` };
    const me = JSON.parse(r.body) as { id: number; name: string; capabilities?: Record<string, boolean>; roles?: string[] };
    if (me.capabilities && !me.capabilities.edit_posts) return { ok: false, message: `User "${me.name}" cannot edit posts. Use an Editor account.` };
    const admin = me.roles?.includes("administrator");
    return { ok: true, message: `Connected as ${me.name}${admin ? ". Consider a less privileged Editor account." : ""}`, externalAccountId: String(me.id), config: { baseUrl: base.toString().replace(/\/$/, ""), metaDescriptionKey: s.metaDescriptionKey || null, roles: me.roles } };
  },
  async SMTP(s) {
    const nodemailer = await import("nodemailer");
    try {
      const t = nodemailer.createTransport(await safeSmtpOptions(s.url));
      await t.verify();
      return { ok: true, message: "SMTP server accepted the credentials.", config: { from: s.from } };
    } catch (err) {
      if (err instanceof UserError) return { ok: false, message: err.message };
      return { ok: false, message: `SMTP verification failed: ${(err as Error).message}` };
    }
  },
  async SLACK_WEBHOOK(s) {
    let u: URL;
    try { u = new URL(s.webhookUrl); } catch { return { ok: false, message: "Enter a valid webhook URL" }; }
    if (u.protocol !== "https:" || u.hostname !== "hooks.slack.com") return { ok: false, message: "Webhook must be an https://hooks.slack.com/ URL" };
    const { res } = await jsonFetch(u.toString(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "✅ SearchOps is connected to this channel." }) }, "SLACK_WEBHOOK");
    if (!res.ok) return { ok: false, message: `Slack rejected the webhook (HTTP ${res.status}).` };
    return { ok: true, message: "Test message posted to Slack." };
  },
};

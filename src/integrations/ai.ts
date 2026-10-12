import Anthropic from "@anthropic-ai/sdk";
import type { IntegrationProvider } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { readSecret } from "./connections";

export type AiProviderId = "ANTHROPIC" | "OPENAI" | "GEMINI" | "PERPLEXITY";
export const AI_PROVIDERS: AiProviderId[] = ["ANTHROPIC", "OPENAI", "GEMINI", "PERPLEXITY"];

export const DEFAULT_MODELS: Record<AiProviderId, string> = {
  ANTHROPIC: "claude-opus-5-5",
  OPENAI: "gpt-4.1",
  GEMINI: "gemini-2.5-flash",
  PERPLEXITY: "sonar",
};

export interface AiRequest {
  system?: string;
  prompt: string;
  maxTokens?: number;
  /** Ask the provider to search the web and return the sources it cited (GEO checks). */
  webSearch?: boolean;
  /** Market/location hint for web-grounded answers, e.g. "US". */
  country?: string;
}

export interface AiCitation { url: string; title?: string }

export interface AiResponse {
  provider: AiProviderId;
  model: string;
  text: string;
  citations: AiCitation[];
  webSearchUsed: boolean;
  /** Set when the model declined; text is then empty. */
  refusal?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export class AiError extends Error {
  constructor(message: string, public provider: AiProviderId, public status?: number, public retryable = false) {
    super(message);
    this.name = "AiError";
  }
}

const dedupeCitations = (c: AiCitation[]) => {
  const seen = new Set<string>();
  return c.filter((x) => x.url && !seen.has(x.url) && (seen.add(x.url), true));
};

// ───────────── Anthropic (official SDK)

async function callAnthropic(apiKey: string, model: string, req: AiRequest): Promise<AiResponse> {
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 10 * 60 * 1000 });
  try {
    const response = await client.beta.messages.create({
      model,
      max_tokens: req.maxTokens ?? 16000,
      // Server-side refusal fallback: a declined request is re-run on Anthropic's recommended model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      ...(req.system ? { system: req.system } : {}),
      ...(req.webSearch
        ? { tools: [{ type: "web_search_20260209" as const, name: "web_search" as const, max_uses: 5, ...(req.country ? { user_location: { type: "approximate" as const, country: req.country } } : {}) }] }
        : {}),
      messages: [{ role: "user", content: req.prompt }],
    });
    if (response.stop_reason === "refusal") {
      return { provider: "ANTHROPIC", model: response.model, text: "", citations: [], webSearchUsed: Boolean(req.webSearch), refusal: response.stop_details?.explanation ?? "The model declined this request." };
    }
    const citations: AiCitation[] = [];
    const parts: string[] = [];
    for (const block of response.content) {
      if (block.type === "text") {
        parts.push(block.text);
        for (const c of block.citations ?? []) if (c.type === "web_search_result_location") citations.push({ url: c.url, title: c.title ?? undefined });
      }
    }
    return {
      provider: "ANTHROPIC", model: response.model, text: parts.join("").trim(), citations: dedupeCitations(citations), webSearchUsed: Boolean(req.webSearch),
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new AiError("Anthropic rejected the API key", "ANTHROPIC", 401);
    if (err instanceof Anthropic.RateLimitError) throw new AiError("Anthropic rate limit reached; retry later", "ANTHROPIC", 429, true);
    if (err instanceof Anthropic.BadRequestError) throw new AiError(`Anthropic rejected the request: ${err.message}`, "ANTHROPIC", 400);
    if (err instanceof Anthropic.APIError) throw new AiError(`Anthropic API error ${err.status}: ${err.message}`, "ANTHROPIC", err.status, (err.status ?? 500) >= 500);
    throw err;
  }
}

// ───────────── REST providers

async function postJson(provider: AiProviderId, url: string, headers: Record<string, string>, body: unknown) {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
  } catch (err) {
    throw new AiError(`Could not reach ${provider}: ${(err as Error).message}`, provider, undefined, true);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = (json.error as { message?: string } | undefined)?.message ?? JSON.stringify(json).slice(0, 300);
    throw new AiError(`${provider} error ${res.status}: ${msg}`, provider, res.status, res.status === 429 || res.status >= 500);
  }
  return json;
}

async function callOpenAI(apiKey: string, model: string, req: AiRequest): Promise<AiResponse> {
  const json = await postJson("OPENAI", "https://api.openai.com/v1/responses", { authorization: `Bearer ${apiKey}` }, {
    model,
    ...(req.system ? { instructions: req.system } : {}),
    input: req.prompt,
    max_output_tokens: req.maxTokens ?? 8000,
    ...(req.webSearch ? { tools: [{ type: "web_search", ...(req.country ? { user_location: { type: "approximate", country: req.country } } : {}) }] } : {}),
  });
  type Out = { type: string; content?: { type: string; text?: string; refusal?: string; annotations?: { type: string; url?: string; title?: string }[] }[] };
  const outputs = (json.output as Out[] | undefined) ?? [];
  const texts: string[] = [];
  const citations: AiCitation[] = [];
  let refusal: string | undefined;
  for (const o of outputs) for (const c of o.content ?? []) {
    if (c.type === "output_text" && c.text) texts.push(c.text);
    if (c.type === "refusal") refusal = c.refusal;
    for (const a of c.annotations ?? []) if (a.type === "url_citation" && a.url) citations.push({ url: a.url, title: a.title });
  }
  const usage = json.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  return { provider: "OPENAI", model: String(json.model ?? model), text: texts.join("\n").trim(), citations: dedupeCitations(citations), webSearchUsed: Boolean(req.webSearch), refusal, usage: { inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens } };
}

async function callGemini(apiKey: string, model: string, req: AiRequest): Promise<AiResponse> {
  const json = await postJson("GEMINI", `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { "x-goog-api-key": apiKey }, {
    contents: [{ role: "user", parts: [{ text: req.prompt }] }],
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    ...(req.webSearch ? { tools: [{ google_search: {} }] } : {}),
    generationConfig: { maxOutputTokens: req.maxTokens ?? 8000 },
  });
  type Cand = { content?: { parts?: { text?: string }[] }; finishReason?: string; groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] } };
  const cand = ((json.candidates as Cand[] | undefined) ?? [])[0];
  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
  const citations = (cand?.groundingMetadata?.groundingChunks ?? []).map((g) => ({ url: g.web?.uri ?? "", title: g.web?.title })).filter((c) => c.url);
  const usage = json.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
  return {
    provider: "GEMINI", model, text, citations: dedupeCitations(citations), webSearchUsed: Boolean(req.webSearch),
    refusal: cand?.finishReason === "SAFETY" ? "Blocked by Gemini safety filters" : undefined,
    usage: { inputTokens: usage?.promptTokenCount, outputTokens: usage?.candidatesTokenCount },
  };
}

async function callPerplexity(apiKey: string, model: string, req: AiRequest): Promise<AiResponse> {
  const json = await postJson("PERPLEXITY", "https://api.perplexity.ai/chat/completions", { authorization: `Bearer ${apiKey}` }, {
    model,
    messages: [...(req.system ? [{ role: "system", content: req.system }] : []), { role: "user", content: req.prompt }],
    max_tokens: req.maxTokens ?? 4000,
    ...(req.country ? { web_search_options: { user_location: { country: req.country } } } : {}),
  });
  const text = String(((json.choices as { message?: { content?: string } }[] | undefined) ?? [])[0]?.message?.content ?? "").trim();
  const results = (json.search_results as { url?: string; title?: string }[] | undefined) ?? [];
  const legacy = (json.citations as string[] | undefined) ?? [];
  const citations = results.length ? results.map((r) => ({ url: r.url ?? "", title: r.title })) : legacy.map((url) => ({ url }));
  const usage = json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  // Sonar models always search the web; citations are the sources the answer used.
  return { provider: "PERPLEXITY", model: String(json.model ?? model), text, citations: dedupeCitations(citations), webSearchUsed: true, usage: { inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens } };
}

const CALLERS: Record<AiProviderId, (key: string, model: string, req: AiRequest) => Promise<AiResponse>> = {
  ANTHROPIC: callAnthropic,
  OPENAI: callOpenAI,
  GEMINI: callGemini,
  PERPLEXITY: callPerplexity,
};

export interface AiClient {
  provider: AiProviderId;
  model: string;
  complete: (req: AiRequest) => Promise<AiResponse>;
}

/** Builds a client from the org's connected AI integration (preferred provider first). */
export async function getAiClient(organizationId: string, preferred?: AiProviderId | null): Promise<AiClient | null> {
  const conns = await prisma.integrationConnection.findMany({ where: { organizationId, websiteId: null, provider: { in: AI_PROVIDERS as IntegrationProvider[] }, status: "CONNECTED" }, orderBy: { createdAt: "asc" } });
  const conn = (preferred && conns.find((c) => c.provider === preferred)) || conns[0];
  if (!conn) return null;
  const provider = conn.provider as AiProviderId;
  const secret = readSecret<{ apiKey: string; model?: string }>(conn);
  const model = secret.model || (conn.config as { model?: string }).model || DEFAULT_MODELS[provider];
  return { provider, model, complete: (req) => CALLERS[provider](secret.apiKey, model, req) };
}

export async function getAiClientFor(organizationId: string, provider: AiProviderId): Promise<AiClient | null> {
  const c = await getAiClient(organizationId, provider);
  return c?.provider === provider ? c : null;
}

export class NoAiProviderError extends Error {
  constructor() {
    super("No AI provider is connected. Add an Anthropic, OpenAI, Gemini or Perplexity key in Integrations.");
    this.name = "NoAiProviderError";
  }
}

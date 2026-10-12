import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import { assertSafeUrlShape, isPublicIp, UnsafeUrlError } from "./ssrf";

export interface SafeFetchOptions {
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Return the redirect hops instead of following them silently. Always on. */
  allowPrivate?: boolean;
}

export interface RedirectHop {
  url: string;
  status: number;
  location: string;
}

export interface SafeFetchResult {
  url: string;
  finalUrl: string;
  status: number;
  headers: Headers;
  body: string;
  raw: Buffer;
  bytes: number;
  truncated: boolean;
  redirects: RedirectHop[];
  timeMs: number;
}

const privateAllowedByEnv = () =>
  process.env.ALLOW_PRIVATE_NETWORK_FETCH === "true" && process.env.NODE_ENV !== "production";

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** DNS lookup that refuses to hand a non-public address to the socket (prevents DNS rebinding). */
function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: { all?: boolean } & Record<string, unknown>, cb: LookupCb) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return cb(err, "");
      const list = addresses as LookupAddress[];
      const bad = list.find((a) => !isPublicIp(a.address));
      if (bad && !allowPrivate) {
        return cb(Object.assign(new UnsafeUrlError(`${hostname} resolves to non-public address ${bad.address}`), { code: "ESSRF" }), "");
      }
      if (options.all) return cb(null, list);
      cb(null, list[0].address, list[0].family);
    });
  };
}

const agents = new Map<boolean, Dispatcher>();
function agentFor(allowPrivate: boolean): Dispatcher {
  let a = agents.get(allowPrivate);
  if (!a) {
    a = new Agent({
      connect: { lookup: guardedLookup(allowPrivate) as never, timeout: 10_000 },
      headersTimeout: 20_000,
      bodyTimeout: 30_000,
      connections: 64,
    });
    agents.set(allowPrivate, a);
  }
  return a;
}

/**
 * Outbound HTTP for anything a user can point us at (crawler, link checks,
 * CMS connectors). Validates every redirect hop, pins DNS results, enforces
 * timeouts and a response size cap.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const allowPrivate = Boolean(opts.allowPrivate) || privateAllowedByEnv();
  const maxRedirects = opts.maxRedirects ?? 5;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const started = Date.now();
  const redirects: RedirectHop[] = [];
  let current = assertSafeUrlShape(rawUrl, { allowPrivate });
  let method = opts.method ?? "GET";
  let body = opts.body;

  for (let hop = 0; ; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await undiciFetch(current.toString(), {
        method,
        headers: opts.headers,
        body: method === "GET" || method === "HEAD" ? undefined : body,
        redirect: "manual",
        signal: controller.signal,
        dispatcher: agentFor(allowPrivate),
      });

      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        const location = res.headers.get("location")!;
        await res.body?.cancel().catch(() => undefined);
        redirects.push({ url: current.toString(), status: res.status, location });
        if (hop >= maxRedirects) {
          return finish(rawUrl, current, res.status, res.headers as unknown as Headers, EMPTY, 0, false, redirects, started);
        }
        const next = new URL(location, current);
        if (redirects.some((r) => r.url === next.toString())) {
          // Redirect loop: report the chain instead of following it forever.
          return finish(rawUrl, next, res.status, res.headers as unknown as Headers, EMPTY, 0, false, redirects, started);
        }
        current = assertSafeUrlShape(next, { allowPrivate });
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
        }
        continue;
      }

      const { raw, bytes, truncated } = await readCapped(res.body as ReadableStream<Uint8Array> | null, maxBytes, method === "HEAD");
      return finish(rawUrl, current, res.status, res.headers as unknown as Headers, raw, bytes, truncated, redirects, started);
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`Request timed out after ${timeoutMs}ms: ${current}`);
      const cause = (err as { cause?: Error }).cause;
      if (cause instanceof UnsafeUrlError) throw cause;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

const EMPTY = Buffer.alloc(0);

function finish(
  url: string, final: URL, status: number, headers: Headers, raw: Buffer, bytes: number,
  truncated: boolean, redirects: RedirectHop[], started: number,
): SafeFetchResult {
  return { url, finalUrl: final.toString(), status, headers, body: raw.toString("utf8"), raw, bytes, truncated, redirects, timeMs: Date.now() - started };
}

async function readCapped(stream: ReadableStream<Uint8Array> | null, maxBytes: number, skip: boolean) {
  if (!stream || skip) return { raw: EMPTY, bytes: 0, truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      truncated = true;
      chunks.push(value.subarray(0, value.byteLength - (bytes - maxBytes)));
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return { raw: Buffer.concat(chunks), bytes, truncated };
}

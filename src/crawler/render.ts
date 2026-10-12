import type { Browser, BrowserContext } from "playwright-core";
import { safeFetch } from "@/lib/net/safe-fetch";

/**
 * Headless-Chromium rendering for sites whose content is built by JavaScript (React/Vite
 * single-page apps, typical of Replit projects).
 *
 * Every request the page makes is answered by our own SSRF-guarded fetcher (route.fetch is
 * never used), so a rendered page can't reach private networks, cloud metadata or anything
 * the raw crawler couldn't. WebSockets and service workers are blocked, and heavy resources
 * (images, media, fonts) are skipped because they don't change the DOM text we audit.
 */

export interface RenderResult {
  html: string;
  finalUrl: string;
  /** Requests the guard refused (private address, bad scheme, over the cap). */
  blocked: number;
  /** Uncaught page errors, e.g. a crashing bundle that leaves the page blank. */
  pageErrors: string[];
  timeMs: number;
}

export interface PageRenderer {
  render(url: string): Promise<RenderResult>;
  close(): Promise<void>;
}

export interface RendererOptions {
  userAgent: string;
  allowPrivate?: boolean;
  /** Overall budget per page. */
  timeoutMs?: number;
  /** Cap on sub-requests per page (scripts, XHR, CSS). */
  maxRequests?: number;
}

const SKIP_TYPES = new Set(["image", "media", "font"]);

export class RendererUnavailableError extends Error {
  constructor(cause: string) {
    super(`JavaScript rendering is unavailable: ${cause}. Install Chromium for the worker (see README) or set CHROMIUM_PATH.`);
    this.name = "RendererUnavailableError";
  }
}

export async function createRenderer(opts: RendererOptions): Promise<PageRenderer> {
  let browser: Browser;
  try {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({
      headless: true,
      // Empty or the string "undefined" (an unset variable copied into process.env) means: use Playwright's Chromium.
      executablePath: process.env.CHROMIUM_PATH && process.env.CHROMIUM_PATH !== "undefined" ? process.env.CHROMIUM_PATH : undefined,
      // No WebRTC (it can open UDP to arbitrary hosts outside our request routing).
      args: ["--disable-dev-shm-usage", "--disable-features=WebRtcHideLocalIpsWithMdns", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
    });
  } catch (err) {
    throw new RendererUnavailableError((err as Error).message.split("\n")[0]);
  }
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const maxRequests = opts.maxRequests ?? 150;

  return {
    async render(url: string): Promise<RenderResult> {
      const started = Date.now();
      const context: BrowserContext = await browser.newContext({
        userAgent: opts.userAgent,
        serviceWorkers: "block",
        javaScriptEnabled: true,
        viewport: { width: 1280, height: 900 },
      });
      let blocked = 0;
      let requests = 0;
      const pageErrors: string[] = [];
      try {
        await context.routeWebSocket(/.*/, (ws) => { blocked++; ws.close(); });
        await context.route("**/*", async (route) => {
          const req = route.request();
          if (SKIP_TYPES.has(req.resourceType())) return route.abort("blockedbyclient");
          if (++requests > maxRequests) { blocked++; return route.abort("blockedbyclient"); }
          if (!/^https?:/i.test(req.url())) { blocked++; return route.abort("blockedbyclient"); }
          try {
            const headers: Record<string, string> = { ...req.headers(), "user-agent": opts.userAgent };
            delete headers["accept-encoding"];
            const res = await safeFetch(req.url(), {
              method: req.method() as "GET",
              headers,
              body: req.postData() ?? undefined,
              maxBytes: 10 * 1024 * 1024,
              timeoutMs: 15_000,
              allowPrivate: opts.allowPrivate,
            });
            const out: Record<string, string> = {};
            res.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding|set-cookie)$/i.test(k)) out[k] = v; });
            await route.fulfill({ status: res.status, headers: out, body: res.raw });
          } catch {
            blocked++;
            await route.abort("blockedbyclient").catch(() => undefined);
          }
        });
        const page = await context.newPage();
        page.on("pageerror", (e) => { if (pageErrors.length < 5) pageErrors.push(e.message.slice(0, 300)); });
        page.setDefaultTimeout(timeoutMs);
        const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch((err: Error) => {
          if (/ERR_BLOCKED_BY_CLIENT/.test(err.message)) throw new Error(`Blocked for safety: ${url} resolves to a disallowed or unreachable address`);
          throw err;
        });
        // Give client-side rendering and data fetching a chance to settle.
        await page.waitForLoadState("networkidle", { timeout: Math.min(10_000, timeoutMs) }).catch(() => undefined);
        const html = await page.content();
        return { html, finalUrl: resp?.url() ?? page.url(), blocked, pageErrors, timeMs: Date.now() - started };
      } finally {
        await context.close().catch(() => undefined);
      }
    },
    async close() {
      await browser.close().catch(() => undefined);
    },
  };
}

/**
 * Decides whether a site needs rendering by comparing the raw HTML with the rendered DOM of
 * the same page. Thresholds are deliberately conservative so ordinary server-rendered sites
 * aren't rendered (rendering is ~10x slower).
 */
export function needsRendering(raw: { wordCount: number; links: number; title: string | null; h1: number }, rendered: { wordCount: number; links: number; title: string | null; h1: number }) {
  const reasons: string[] = [];
  if (rendered.wordCount >= 50 && rendered.wordCount >= raw.wordCount * 2 + 20) reasons.push(`${raw.wordCount} words in raw HTML vs ${rendered.wordCount} after JavaScript`);
  if (rendered.links >= raw.links + 5 && rendered.links >= raw.links * 2) reasons.push(`${raw.links} links in raw HTML vs ${rendered.links} after JavaScript`);
  if (!raw.h1 && rendered.h1) reasons.push("H1 only appears after JavaScript");
  if (!raw.title && rendered.title) reasons.push("title only appears after JavaScript");
  return { required: reasons.length > 0, reasons };
}

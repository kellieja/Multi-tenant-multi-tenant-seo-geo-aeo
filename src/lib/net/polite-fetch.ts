import { safeFetch, type SafeFetchResult } from "./safe-fetch";
import { parseRobots, isAllowed, type ParsedRobots } from "@/crawler/robots";
import { UserError } from "@/lib/errors";

const cache = new Map<string, { robots: ParsedRobots | null; at: number }>();
const TTL = 30 * 60_000;

export const userAgent = () => process.env.CRAWLER_USER_AGENT ?? "SearchOpsBot/1.0";

async function robotsFor(origin: string, ua: string) {
  const hit = cache.get(origin);
  if (hit && Date.now() - hit.at < TTL) return hit.robots;
  let robots: ParsedRobots | null = null;
  try {
    const r = await safeFetch(`${origin}/robots.txt`, { headers: { "user-agent": ua }, maxBytes: 256 * 1024, timeoutMs: 10_000 });
    if (r.status === 200) robots = parseRobots(r.body);
  } catch { /* unreachable robots.txt: treat as no rules */ }
  cache.set(origin, { robots, at: Date.now() });
  return robots;
}

/** Fetches one HTML page through the SSRF guard after checking the site's robots.txt. */
export async function fetchHtmlPolitely(url: string): Promise<SafeFetchResult> {
  const ua = userAgent();
  const origin = new URL(url).origin;
  if (!isAllowed(await robotsFor(origin, ua), ua, url).allowed) throw new UserError(`robots.txt on ${new URL(url).host} disallows fetching this page`);
  const res = await safeFetch(url, { headers: { "user-agent": ua, accept: "text/html" }, maxBytes: 5 * 1024 * 1024, timeoutMs: 20_000 });
  if (res.status !== 200) throw new UserError(`${url} returned HTTP ${res.status}`);
  const ct = res.headers.get("content-type") ?? "";
  if (ct && !ct.includes("html")) throw new UserError(`${url} is not an HTML page (${ct.split(";")[0]})`);
  return res;
}

export const _clearRobotsCache = () => cache.clear();

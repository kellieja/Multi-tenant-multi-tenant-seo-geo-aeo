/**
 * robots.txt parser following RFC 9309 / Google semantics:
 * - the most specific user-agent group wins (exact token match, else "*")
 * - the longest matching path rule wins; on a tie, Allow wins
 * - supports "*" wildcards and "$" end anchors
 */
export interface RobotsRule {
  allow: boolean;
  path: string;
  regex: RegExp;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelay?: number;
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
  raw: string;
}

function toRegex(path: string): RegExp {
  const anchored = path.endsWith("$");
  const body = (anchored ? path.slice(0, -1) : path)
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

export function parseRobots(raw: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      // An empty Disallow means "allow everything" and adds no rule.
      if (!value) continue;
      let path = value;
      try { path = decodeURIComponent(value); } catch { /* keep raw */ }
      current.rules.push({ allow: key === "allow", path, regex: toRegex(path) });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }
  return { groups, sitemaps, raw };
}

/** Product token used for matching, e.g. "SearchOpsBot/1.0 (+url)" → "searchopsbot". */
export const productToken = (ua: string) => ua.split(/[\s/]/)[0].toLowerCase();

export function groupFor(robots: ParsedRobots, userAgent: string): RobotsGroup | null {
  const token = productToken(userAgent);
  const specific = robots.groups.filter((g) => g.agents.some((a) => a !== "*" && token.startsWith(a)));
  if (specific.length) return mergeGroups(specific);
  const star = robots.groups.filter((g) => g.agents.includes("*"));
  return star.length ? mergeGroups(star) : null;
}

function mergeGroups(gs: RobotsGroup[]): RobotsGroup {
  return {
    agents: gs.flatMap((g) => g.agents),
    rules: gs.flatMap((g) => g.rules),
    crawlDelay: gs.map((g) => g.crawlDelay).find((d) => d != null),
  };
}

export function isAllowed(robots: ParsedRobots | null, userAgent: string, url: string): { allowed: boolean; rule?: string } {
  if (!robots) return { allowed: true };
  const group = groupFor(robots, userAgent);
  if (!group) return { allowed: true };
  let pathAndQuery: string;
  try {
    const u = new URL(url);
    pathAndQuery = u.pathname + u.search;
    try { pathAndQuery = decodeURIComponent(pathAndQuery); } catch { /* raw */ }
  } catch {
    return { allowed: false, rule: "invalid url" };
  }
  if (pathAndQuery === "/robots.txt") return { allowed: true };
  let best: RobotsRule | null = null;
  for (const r of group.rules) {
    if (!r.regex.test(pathAndQuery)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow && !best.allow)) best = r;
  }
  if (!best || best.allow) return { allowed: true, rule: best ? `Allow: ${best.path}` : undefined };
  return { allowed: false, rule: `Disallow: ${best.path}` };
}

/** True when robots.txt blocks the whole site for this agent (a critical misconfiguration). */
export function blocksEverything(robots: ParsedRobots | null, userAgent: string) {
  return !isAllowed(robots, userAgent, "https://x.invalid/").allowed;
}

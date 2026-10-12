import { UserError } from "./errors";

/** Normalises user input like "Example.com/" into a canonical https base URL + bare domain. */
export function normalizeSiteUrl(input: string): { baseUrl: string; domain: string } {
  let raw = input.trim();
  if (!raw) throw new UserError("Website URL is required");
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UserError(`"${input}" is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UserError("Only http(s) websites are supported");
  const host = url.hostname.toLowerCase();
  if (!host.includes(".")) throw new UserError(`"${input}" is not a public domain`);
  const domain = host.replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "");
  return { baseUrl: `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}${path}`, domain };
}

/** Canonical form used to deduplicate crawled URLs. Drops fragments, sorts query params, strips default ports. */
export function normalizeUrl(input: string, base?: string): string | null {
  try {
    const url = new URL(input, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) url.port = "";
    const params = [...url.searchParams.entries()].filter(([k]) => !/^utm_|^gclid$|^fbclid$/i.test(k));
    params.sort(([a], [b]) => a.localeCompare(b));
    url.search = params.length ? `?${new URLSearchParams(params).toString()}` : "";
    return url.toString();
  } catch {
    return null;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function isSameSite(url: string, domain: string): boolean {
  const h = hostOf(url);
  return h === domain || h.endsWith(`.${domain}`);
}

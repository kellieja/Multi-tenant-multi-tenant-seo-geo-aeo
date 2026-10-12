import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
// IPv4 special-purpose / non-public ranges (RFC 6890 and friends).
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
// IPv6 special-purpose ranges.
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(net, prefix, "ipv6");

/** Extracts an embedded IPv4 from IPv4-mapped/compatible IPv6 (::ffff:a.b.c.d or ::ffff:7f00:1). */
function embeddedV4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const dotted = lower.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

export function isPublicIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  if (family === 4) return !blocked.check(ip, "ipv4");
  const v4 = embeddedV4(ip);
  if (v4) return isIP(v4) === 4 && !blocked.check(v4, "ipv4");
  return !blocked.check(ip, "ipv6");
}

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);
const BLOCKED_HOST_SUFFIXES = [".internal", ".local", ".localhost", ".localdomain", ".home.arpa", ".corp", ".lan"];

/** Syntactic checks done before any DNS lookup. */
export function assertSafeUrlShape(raw: string | URL, opts: { allowPrivate?: boolean } = {}): URL {
  let url: URL;
  try {
    url = typeof raw === "string" ? new URL(raw) : raw;
  } catch {
    throw new UnsafeUrlError("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrlError(`Blocked protocol ${url.protocol}`);
  if (url.username || url.password) throw new UnsafeUrlError("URLs with embedded credentials are not allowed");
  if (opts.allowPrivate) return url;
  if (!ALLOWED_PORTS.has(url.port)) throw new UnsafeUrlError(`Blocked port ${url.port}`);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UnsafeUrlError(`Blocked internal hostname ${host}`);
  }
  if (isIP(host) && !isPublicIp(host)) throw new UnsafeUrlError(`Blocked non-public address ${host}`);
  // Single-label hosts (e.g. "intranet") are never public websites.
  if (!isIP(host) && !host.includes(".")) throw new UnsafeUrlError(`Blocked single-label hostname ${host}`);
  return url;
}

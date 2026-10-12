import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicIp } from "./ssrf";
import { UserError } from "@/lib/errors";

export const privateAllowedByEnv = () => process.env.ALLOW_PRIVATE_NETWORK_FETCH === "true" && process.env.NODE_ENV !== "production";

/**
 * Resolves a user-supplied hostname for a non-HTTP connection (SMTP, SFTP, FTPS) and refuses
 * private, loopback, link-local and metadata addresses. Returns the address to connect to, so
 * the connection is pinned to what was checked (no DNS-rebinding window).
 */
export async function resolvePublicHost(host: string, opts: { allowPrivate?: boolean; what?: string } = {}) {
  const h = host.replace(/^\[|\]$/g, "").trim();
  if (!h) throw new UserError(`${opts.what ?? "Server"} host is required`);
  const allowPrivate = opts.allowPrivate ?? privateAllowedByEnv();
  const addrs = isIP(h) ? [{ address: h }] : await lookup(h, { all: true }).catch(() => { throw new UserError(`Couldn't resolve ${h}`); });
  if (!allowPrivate && addrs.some((a) => !isPublicIp(a.address))) throw new UserError(`${opts.what ?? "Server"} must be a public host`);
  return { address: addrs[0].address, hostname: h, isIpLiteral: Boolean(isIP(h)) };
}

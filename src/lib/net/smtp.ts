import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicIp } from "./ssrf";
import { UserError } from "@/lib/errors";

const PORTS = new Set([25, 465, 587, 2525]);

/**
 * Turns a user-supplied smtp(s):// URL into Nodemailer options that can only reach a public
 * mail server: standard mail ports, every resolved address public, and the connection pinned
 * to the checked IP (TLS still verifies the original hostname). Query-string options such as
 * proxies are ignored. Operator-set SMTP_URL from the environment is trusted and not passed here.
 */
export async function safeSmtpOptions(raw: string, opts: { allowPrivate?: boolean } = {}) {
  let u: URL;
  try { u = new URL(raw); } catch { throw new UserError("Enter a valid smtp:// or smtps:// URL"); }
  if (u.protocol !== "smtp:" && u.protocol !== "smtps:") throw new UserError("SMTP URL must start with smtp:// or smtps://");
  const secure = u.protocol === "smtps:";
  const port = u.port ? Number(u.port) : secure ? 465 : 587;
  if (!PORTS.has(port)) throw new UserError("SMTP port must be 25, 465, 587 or 2525");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new UserError("SMTP URL needs a host");
  const allowPrivate = opts.allowPrivate ?? (process.env.ALLOW_PRIVATE_NETWORK_FETCH === "true" && process.env.NODE_ENV !== "production");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => { throw new UserError(`Couldn't resolve ${host}`); });
  if (!allowPrivate && addrs.some((a) => !isPublicIp(a.address))) throw new UserError("SMTP host must be a public mail server");
  return {
    host: addrs[0].address,
    port,
    secure: secure || port === 465,
    auth: u.username ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } : undefined,
    tls: { servername: isIP(host) ? undefined : host },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
  };
}

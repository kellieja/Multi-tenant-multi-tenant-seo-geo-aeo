import { isIP } from "node:net";
import { resolvePublicHost } from "./resolve";
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
  if (!u.hostname) throw new UserError("SMTP URL needs a host");
  const r = await resolvePublicHost(u.hostname, { allowPrivate: opts.allowPrivate, what: "SMTP host" }).catch((e: Error) => {
    throw new UserError(/public host/.test(e.message) ? "SMTP host must be a public mail server" : e.message);
  });
  const host = r.hostname;
  return {
    host: r.address,
    port,
    secure: secure || port === 465,
    auth: u.username ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } : undefined,
    tls: { servername: isIP(host) ? undefined : host },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
  };
}

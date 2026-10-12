import { createHash } from "node:crypto";
import { posix } from "node:path";
import { Readable, Writable } from "node:stream";
import { UserError } from "@/lib/errors";
import { resolvePublicHost } from "@/lib/net/resolve";
import { IntegrationError } from "./connections";

/** Credentials as stored (encrypted) for a FILE_HOST connection. */
export interface FileHostSecret {
  protocol: string; // "sftp" | "ftps"
  host: string;
  port?: string;
  username: string;
  password?: string;
  privateKey?: string;
  docRoot: string;
}

/** Non-secret connection config recorded on first successful connect. */
export interface FileHostConfig {
  protocol?: string;
  docRoot?: string;
  /** SFTP host key fingerprint (sha256, base64), pinned on first connect. */
  hostKeySha256?: string;
}

const MAX_FILE = 5 * 1024 * 1024;

export function normalizeDocRoot(docRoot: string) {
  const d = posix.normalize(`/${docRoot.trim()}`).replace(/\/+$/, "");
  if (d.split("/").includes("..")) throw new UserError("Document root must not contain '..'");
  return d || "/";
}

/** Joins a URL path under the document root, refusing anything that escapes it. */
export function underRoot(docRoot: string, rel: string) {
  const root = normalizeDocRoot(docRoot);
  const p = posix.normalize(posix.join(root, rel));
  if (p !== root && !p.startsWith(root === "/" ? "/" : `${root}/`)) throw new UserError("Path escapes the document root");
  return p;
}

/** Candidate files that could serve a URL path on a static host, most likely first. */
export function candidateFiles(urlPath: string) {
  let p = decodeURIComponent(urlPath.split("?")[0].split("#")[0] || "/");
  if (p.includes("\0")) return [];
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.endsWith("/")) return [`${p}index.html`, `${p}index.htm`];
  if (/\.(html?|php)$/i.test(p)) return [p];
  return [`${p}.html`, `${p}/index.html`, `${p}.htm`, `${p}/index.htm`];
}

interface Driver {
  read(path: string): Promise<Buffer | null>;
  write(path: string, data: Buffer): Promise<void>;
  close(): Promise<void>;
}

async function sftpDriver(s: FileHostSecret, cfg: FileHostConfig, addr: string, onHostKey: (fp: string) => void): Promise<Driver> {
  const { default: SftpClient } = await import("ssh2-sftp-client");
  const sftp = new SftpClient();
  let mismatch = false;
  await sftp.connect({
    host: addr,
    port: Number(s.port) || 22,
    username: s.username,
    password: s.password || undefined,
    privateKey: s.privateKey || undefined,
    readyTimeout: 15_000,
    hostVerifier: (key: Buffer) => {
      const fp = createHash("sha256").update(key).digest("base64");
      onHostKey(fp);
      if (cfg.hostKeySha256 && cfg.hostKeySha256 !== fp) { mismatch = true; return false; }
      return true;
    },
  } as never).catch((err: Error) => {
    if (mismatch) throw new IntegrationError("The server's SSH host key changed since this connection was set up. If you changed servers, reconnect the integration; otherwise this may be an interception attempt.", "FILE_HOST");
    throw new IntegrationError(`SFTP connection failed: ${err.message}`, "FILE_HOST");
  });
  return {
    async read(path) {
      const st = await sftp.stat(path).catch(() => null);
      if (!st || !st.isFile) return null;
      if (st.size > MAX_FILE) throw new UserError(`${path} is larger than 5 MB`);
      return (await sftp.get(path)) as Buffer;
    },
    async write(path, data) {
      const tmp = posix.join(posix.dirname(path), `.${posix.basename(path)}.searchops-tmp`);
      await sftp.put(data, tmp);
      try {
        await sftp.posixRename(tmp, path);
      } catch {
        await sftp.delete(path).catch(() => undefined);
        await sftp.rename(tmp, path);
      }
    },
    async close() { await sftp.end().catch(() => undefined); },
  };
}

async function ftpsDriver(s: FileHostSecret, addr: string, servername: string | undefined): Promise<Driver> {
  const { Client } = await import("basic-ftp");
  const ftp = new Client(20_000);
  const port = Number(s.port) || 21;
  try {
    await ftp.access({
      host: addr, port, user: s.username, password: s.password ?? "",
      // TLS is required (explicit AUTH TLS, or implicit on port 990) and certificates are verified.
      secure: port === 990 ? "implicit" : true,
      secureOptions: { servername, rejectUnauthorized: true },
    });
  } catch (err) {
    ftp.close();
    throw new IntegrationError(`FTPS connection failed: ${(err as Error).message}`, "FILE_HOST");
  }
  return {
    async read(path) {
      const size = await ftp.size(path).catch(() => null);
      if (size == null) return null;
      if (size > MAX_FILE) throw new UserError(`${path} is larger than 5 MB`);
      const chunks: Buffer[] = [];
      await ftp.downloadTo(new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } }), path);
      return Buffer.concat(chunks);
    },
    async write(path, data) {
      const tmp = posix.join(posix.dirname(path), `.${posix.basename(path)}.searchops-tmp`);
      await ftp.uploadFrom(Readable.from(data), tmp);
      await ftp.remove(path).catch(() => undefined);
      await ftp.rename(tmp, path);
    },
    async close() { ftp.close(); },
  };
}

/**
 * Edits files on a static host over SFTP or FTPS. Plain FTP is refused (it sends the password
 * in clear text). The host must resolve to a public address and the connection is pinned to it.
 */
export class FileHostClient {
  private constructor(private driver: Driver, readonly docRoot: string, readonly hostKeySha256: string | null) {}

  static async open(secret: FileHostSecret, config: FileHostConfig = {}, opts: { allowPrivate?: boolean } = {}) {
    const protocol = (secret.protocol || "sftp").toLowerCase();
    if (protocol === "ftp") throw new UserError("Plain FTP isn't supported because it sends your password unencrypted. Use SFTP or FTPS (FTP over TLS); most hosts offer one of them.");
    if (protocol !== "sftp" && protocol !== "ftps") throw new UserError("Protocol must be sftp or ftps");
    const resolved = await resolvePublicHost(secret.host, { allowPrivate: opts.allowPrivate, what: "File host" });
    let hostKey: string | null = null;
    const driver = protocol === "sftp"
      ? await sftpDriver(secret, config, resolved.address, (fp) => { hostKey = fp; })
      : await ftpsDriver(secret, resolved.address, resolved.isIpLiteral ? undefined : resolved.hostname);
    return new FileHostClient(driver, normalizeDocRoot(secret.docRoot || "/"), hostKey);
  }

  /** Finds the file that serves a URL path, or explains why there isn't one. */
  async locate(urlPath: string): Promise<{ path: string; html: string }> {
    for (const rel of candidateFiles(urlPath)) {
      const p = underRoot(this.docRoot, rel);
      const buf = await this.driver.read(p);
      if (buf) return { path: p, html: buf.toString("utf8") };
    }
    const index = await this.driver.read(underRoot(this.docRoot, "/index.html"));
    if (index && urlPath !== "/" && looksLikeSpaShell(index.toString("utf8"))) {
      throw new UserError(`${urlPath} isn't a separate file: this site is a single-page app whose pages are built by JavaScript from index.html. Use a change pack (or the GitHub connector) to change per-page titles and content in the source code.`);
    }
    throw new UserError(`Couldn't find a file for ${urlPath} under ${this.docRoot}. Check the document root in the File host integration.`);
  }

  async read(path: string) { return (await this.driver.read(path))?.toString("utf8") ?? null; }

  /** Writes atomically (temp file + rename) and verifies by reading back. */
  async write(path: string, content: string) {
    await this.driver.write(path, Buffer.from(content, "utf8"));
    const back = await this.driver.read(path);
    if (back?.toString("utf8") !== content) throw new IntegrationError("Upload verification failed: the file on the server doesn't match what was written", "FILE_HOST");
  }

  async close() { await this.driver.close(); }
}

/** An HTML document whose body is essentially an empty mount point plus scripts. */
export function looksLikeSpaShell(html: string) {
  const body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html).replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  const text = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.split(" ").filter(Boolean).length < 30 && /<script[^>]+(type=["']module["']|src=)/i.test(html) && /id=["'](root|app|__next|svelte)["']/i.test(html);
}

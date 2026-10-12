import { posix } from "node:path";
import type { AddressInfo } from "node:net";
import ssh2, { type Connection } from "ssh2";

const { Server, utils } = ssh2;
const { OPEN_MODE, STATUS_CODE } = utils.sftp;

/**
 * A minimal in-memory SFTP server for tests: password auth, regular files only, enough of the
 * protocol for stat/get/put/rename/posix-rename/remove. `files` is the server's filesystem.
 */
export function fakeSftp(opts: { username?: string; password?: string } = {}) {
  const files = new Map<string, Buffer>();
  const username = opts.username ?? "deploy";
  const password = opts.password ?? "s3cret-pass";
  let hostKey = utils.generateKeyPairSync("ed25519").private;
  let server = makeServer();
  let port = 0;

  function makeServer() {
    return new Server({ hostKeys: [hostKey] }, (client: Connection) => {
      client.on("authentication", (ctx) => {
        if (ctx.method === "password" && ctx.username === username && ctx.password === password) ctx.accept();
        else ctx.reject(["password"]);
      });
      client.on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.on("sftp", (acceptSftp) => {
            const sftp = acceptSftp();
            const handles = new Map<number, { path: string; data: Buffer; write: boolean }>();
            let next = 1;
            const handleBuf = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
            const attrs = (size: number) => ({ mode: 0o100644, uid: 0, gid: 0, size, atime: 0, mtime: 0 });
            sftp.on("REALPATH", (id, p) => sftp.name(id, [{ filename: posix.normalize(p === "." ? "/" : p), longname: "", attrs: attrs(0) }]));
            const stat = (id: number, p: string) => {
              const f = files.get(posix.normalize(p));
              if (f) return sftp.attrs(id, attrs(f.length));
              const isDir = [...files.keys()].some((k) => k.startsWith(`${posix.normalize(p).replace(/\/$/, "")}/`));
              return isDir ? sftp.attrs(id, { ...attrs(0), mode: 0o40755 }) : sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
            };
            sftp.on("STAT", stat);
            sftp.on("LSTAT", stat);
            sftp.on("OPEN", (id, filename, flags) => {
              const p = posix.normalize(filename);
              const write = Boolean(flags & OPEN_MODE.WRITE);
              if (!write && !files.has(p)) return sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
              const n = next++;
              handles.set(n, { path: p, data: write ? Buffer.alloc(0) : files.get(p)!, write });
              sftp.handle(id, handleBuf(n));
            });
            sftp.on("FSTAT", (id, h) => { const x = handles.get(h.readUInt32BE(0)); return x ? sftp.attrs(id, attrs(x.data.length)) : sftp.status(id, STATUS_CODE.FAILURE); });
            sftp.on("READ", (id, h, offset, length) => {
              const x = handles.get(h.readUInt32BE(0));
              if (!x) return sftp.status(id, STATUS_CODE.FAILURE);
              if (offset >= x.data.length) return sftp.status(id, STATUS_CODE.EOF);
              sftp.data(id, x.data.subarray(offset, offset + length));
            });
            sftp.on("WRITE", (id, h, offset, data) => {
              const x = handles.get(h.readUInt32BE(0));
              if (!x) return sftp.status(id, STATUS_CODE.FAILURE);
              const end = offset + data.length;
              const buf = Buffer.alloc(Math.max(x.data.length, end));
              x.data.copy(buf); data.copy(buf, offset); x.data = buf;
              sftp.status(id, STATUS_CODE.OK);
            });
            sftp.on("CLOSE", (id, h) => {
              const n = h.readUInt32BE(0);
              const x = handles.get(n);
              if (x?.write) files.set(x.path, x.data);
              handles.delete(n);
              sftp.status(id, STATUS_CODE.OK);
            });
            sftp.on("REMOVE", (id, p) => sftp.status(id, files.delete(posix.normalize(p)) ? STATUS_CODE.OK : STATUS_CODE.NO_SUCH_FILE));
            const rename = (id: number, from: string, to: string, overwrite: boolean) => {
              const a = posix.normalize(from), b = posix.normalize(to);
              if (!files.has(a)) return sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
              if (files.has(b) && !overwrite) return sftp.status(id, STATUS_CODE.FAILURE);
              files.set(b, files.get(a)!); files.delete(a);
              sftp.status(id, STATUS_CODE.OK);
            };
            sftp.on("RENAME", (id, from, to) => rename(id, from, to, false));
            sftp.on("EXTENDED", (id, name, data) => {
              if (name !== "posix-rename@openssh.com") return sftp.status(id, STATUS_CODE.OP_UNSUPPORTED);
              const l1 = data.readUInt32BE(0); const from = data.subarray(4, 4 + l1).toString();
              const l2 = data.readUInt32BE(4 + l1); const to = data.subarray(8 + l1, 8 + l1 + l2).toString();
              rename(id, from, to, true);
            });
          });
        });
      });
      client.on("error", () => undefined);
    });
  }

  return {
    files,
    username, password,
    get port() { return port; },
    start: () => new Promise<number>((ok) => server.listen(0, "127.0.0.1", () => { port = (server.address() as AddressInfo).port; ok(port); })),
    stop: () => new Promise<void>((ok) => server.close(() => ok())),
    /** Simulates the server being replaced (or intercepted): new host key, same port. */
    async rotateHostKey() {
      await new Promise<void>((ok) => server.close(() => ok()));
      hostKey = utils.generateKeyPairSync("ed25519").private;
      server = makeServer();
      await new Promise<void>((ok) => server.listen(port, "127.0.0.1", () => ok()));
    },
  };
}

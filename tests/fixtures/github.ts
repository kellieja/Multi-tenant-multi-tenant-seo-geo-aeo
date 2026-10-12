import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Fake GitHub REST API with one in-memory repository: branches, contents, trees, code search,
 * refs and pull requests. Enough for the pull-request connector's real HTTP calls.
 */
export function fakeGitHub(opts: { repo?: string; token?: string; push?: boolean; searchWorks?: boolean } = {}) {
  const repo = opts.repo ?? "acme/shop";
  const token = opts.token ?? "ghp_test_token";
  const state = {
    push: opts.push ?? true,
    searchWorks: opts.searchWorks ?? true,
    branches: new Map<string, Map<string, string>>([["main", new Map()]]),
    pulls: [] as { number: number; head: string; base: string; title: string; body: string; state: "open" | "closed"; merged: boolean; merged_at: string | null }[],
    requests: [] as string[],
  };
  let commitN = 0;
  const commitToBranch = new Map<string, string>();
  const blobSha = (c: string) => createHash("sha1").update(c).digest("hex");
  const commitSha = (branch: string) => { const sha = createHash("sha1").update(`${branch}:${++commitN}`).digest("hex"); commitToBranch.set(sha, branch); return sha; };
  let origin = "";

  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url!, "http://x");
    state.requests.push(`${req.method} ${url.pathname}`);
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { message: "Bad credentials" });
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const p = url.pathname;
      const base = `/repos/${repo}`;
      if (p === "/search/code") {
        if (!state.searchWorks) return send(422, { message: "Validation Failed" });
        const q = url.searchParams.get("q") ?? "";
        const text = JSON.parse(q.slice(0, q.lastIndexOf(" repo:")));
        const items = [...state.branches.get("main")!].filter(([, c]) => c.includes(text)).map(([path]) => ({ path }));
        return send(200, { total_count: items.length, items });
      }
      if (p === base && req.method === "GET") return send(200, { default_branch: "main", private: true, permissions: { push: state.push } });
      let m = p.match(new RegExp(`^${base}/git/ref/heads/(.+)$`));
      if (m) { const b = decodeURIComponent(m[1]); return state.branches.has(b) ? send(200, { object: { sha: commitSha(b) } }) : send(404, { message: "Not Found" }); }
      m = p.match(new RegExp(`^${base}/git/trees/([0-9a-f]+)$`));
      if (m) {
        const b = commitToBranch.get(m[1]);
        if (!b) return send(404, { message: "Not Found" });
        return send(200, { truncated: false, tree: [...state.branches.get(b)!].map(([path, c]) => ({ path, type: "blob", size: Buffer.byteLength(c), sha: blobSha(c) })) });
      }
      if (p === `${base}/git/refs` && req.method === "POST") {
        const name = String(body.ref).replace(/^refs\/heads\//, "");
        const from = commitToBranch.get(body.sha);
        if (!from) return send(422, { message: "Object does not exist" });
        if (state.branches.has(name)) return send(422, { message: "Reference already exists" });
        state.branches.set(name, new Map(state.branches.get(from)!));
        return send(201, { ref: body.ref });
      }
      m = p.match(new RegExp(`^${base}/contents/(.+)$`));
      if (m) {
        const path = decodeURIComponent(m[1]);
        if (req.method === "GET") {
          const files = state.branches.get(url.searchParams.get("ref") ?? "main");
          const c = files?.get(path);
          return c == null ? send(404, { message: "Not Found" }) : send(200, { type: "file", encoding: "base64", content: Buffer.from(c).toString("base64"), sha: blobSha(c) });
        }
        if (req.method === "PUT") {
          if (!state.push) return send(403, { message: "Resource not accessible by personal access token" });
          const files = state.branches.get(body.branch);
          if (!files) return send(404, { message: "Branch not found" });
          const cur = files.get(path);
          if (cur != null && blobSha(cur) !== body.sha) return send(409, { message: "does not match" });
          files.set(path, Buffer.from(body.content, "base64").toString("utf8"));
          return send(200, { content: { path } });
        }
      }
      if (p === `${base}/pulls` && req.method === "POST") {
        const pr = { number: state.pulls.length + 1, head: body.head, base: body.base, title: body.title, body: body.body, state: "open" as const, merged: false, merged_at: null };
        state.pulls.push(pr);
        return send(201, { number: pr.number, html_url: `https://github.com/${repo}/pull/${pr.number}` });
      }
      m = p.match(new RegExp(`^${base}/pulls/(\\d+)$`));
      if (m) { const pr = state.pulls[Number(m[1]) - 1]; return pr ? send(200, pr) : send(404, { message: "Not Found" }); }
      send(404, { message: `No fake route for ${req.method} ${p}` });
    });
  });

  return {
    state, repo, token,
    get origin() { return origin; },
    main: () => state.branches.get("main")!,
    /** Merges a pull request: the head branch's files replace the base branch's. */
    merge(num: number) {
      const pr = state.pulls[num - 1];
      state.branches.set(pr.base, new Map(state.branches.get(pr.head)!));
      Object.assign(pr, { state: "closed", merged: true, merged_at: new Date().toISOString() });
    },
    close(num: number) { Object.assign(state.pulls[num - 1], { state: "closed" }); },
    start: () => new Promise<string>((ok) => server.listen(0, "127.0.0.1", () => { origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; ok(origin); })),
    stop: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

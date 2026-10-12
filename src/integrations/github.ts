import { safeFetch } from "@/lib/net/safe-fetch";
import { UserError } from "@/lib/errors";
import { IntegrationError } from "./connections";

/** Credentials as stored (encrypted) for a GITHUB connection. */
export interface GitHubSecret {
  /** "owner/name" */
  repository: string;
  /** Fine-grained token limited to this repository: Contents read/write, Pull requests read/write. */
  token: string;
  /** Branch pull requests target; defaults to the repository's default branch. */
  baseBranch?: string;
  /** Folder in the repository that holds the site (e.g. "client" or "public"); empty = whole repo. */
  sitePath?: string;
}

export interface GitHubConfig { repository?: string; baseBranch?: string; sitePath?: string; defaultBranch?: string }

const apiBase = () => (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");

export const parseRepository = (repo: string) => {
  const m = repo.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) throw new UserError("Repository must look like owner/name");
  return `${m[1]}/${m[2]}`;
};

/** Minimal GitHub REST client for the pull-request connector. Only api.github.com (or GITHUB_API_URL) is called. */
export class GitHubClient {
  readonly repo: string;
  constructor(private token: string, repository: string) {
    this.repo = parseRepository(repository);
  }

  async api<T>(method: "GET" | "POST" | "PUT" | "PATCH", path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<{ status: number; data: T; text: string }> {
    const url = `${apiBase()}${path.startsWith("/") ? path : `/${path}`}`;
    let res;
    try {
      res = await safeFetch(url, {
        method,
        headers: { authorization: `Bearer ${this.token}`, accept, "x-github-api-version": "2022-11-28", "user-agent": "SearchOps", ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        timeoutMs: 20_000,
        maxBytes: 20 * 1024 * 1024,
      });
    } catch (err) {
      throw new IntegrationError(`Could not reach GitHub: ${(err as Error).message}`, "GITHUB");
    }
    const text = res.body;
    let data: unknown = null;
    if (accept.includes("json")) { try { data = text ? JSON.parse(text) : null; } catch { data = null; } }
    if (res.status === 401) throw new IntegrationError("GitHub rejected the token (expired or revoked). Reconnect the GitHub integration.", "GITHUB");
    if (res.status === 403 && /rate limit/i.test(text)) throw new IntegrationError("GitHub API rate limit reached; try again later.", "GITHUB", 403, true);
    return { status: res.status, data: data as T, text };
  }

  private ok<T>(r: { status: number; data: T; text: string }, what: string) {
    if (r.status < 200 || r.status >= 300) {
      const msg = (r.data as { message?: string } | null)?.message ?? r.text.slice(0, 200);
      throw new IntegrationError(`GitHub ${what} failed (${r.status}): ${msg}`, "GITHUB");
    }
    return r.data;
  }

  async repoInfo() {
    const r = await this.api<{ default_branch: string; private: boolean; permissions?: { push?: boolean } }>("GET", `/repos/${this.repo}`);
    if (r.status === 404) throw new UserError(`Repository ${this.repo} not found, or the token can't see it.`);
    return this.ok(r, "repository lookup");
  }

  async branchSha(branch: string) {
    const r = await this.api<{ object: { sha: string } }>("GET", `/repos/${this.repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    if (r.status === 404) throw new UserError(`Branch ${branch} not found in ${this.repo}`);
    return this.ok(r, "branch lookup").object.sha;
  }

  async tree(commitSha: string) {
    const r = await this.api<{ tree: { path: string; type: string; size?: number; sha: string }[]; truncated: boolean }>("GET", `/repos/${this.repo}/git/trees/${commitSha}?recursive=1`);
    return this.ok(r, "file list");
  }

  /** File content and blob sha on a branch; null when the file doesn't exist. */
  async file(path: string, ref: string): Promise<{ content: string; sha: string } | null> {
    const r = await this.api<{ content?: string; encoding?: string; sha: string; type: string }>("GET", `/repos/${this.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
    if (r.status === 404) return null;
    const d = this.ok(r, "file read");
    if (d.type !== "file") return null;
    return { content: Buffer.from(d.content ?? "", (d.encoding as BufferEncoding) ?? "base64").toString("utf8"), sha: d.sha };
  }

  /** Paths whose content contains the exact text (GitHub code search; default branch only). */
  async searchCode(text: string): Promise<string[] | null> {
    const q = `${JSON.stringify(text)} repo:${this.repo}`;
    const r = await this.api<{ items?: { path: string }[] }>("GET", `/search/code?q=${encodeURIComponent(q)}&per_page=20`);
    if (r.status !== 200) return null; // not indexed, rate limited, or unsupported: caller falls back to scanning
    return (r.data.items ?? []).map((i) => i.path);
  }

  async createBranch(name: string, fromSha: string) {
    this.ok(await this.api("POST", `/repos/${this.repo}/git/refs`, { ref: `refs/heads/${name}`, sha: fromSha }), "branch creation");
  }

  async putFile(path: string, branch: string, content: string, blobSha: string, message: string) {
    this.ok(await this.api("PUT", `/repos/${this.repo}/contents/${encodePath(path)}`, { message, content: Buffer.from(content, "utf8").toString("base64"), sha: blobSha, branch }), "file update");
  }

  async openPullRequest(head: string, base: string, title: string, body: string) {
    const d = this.ok(await this.api<{ number: number; html_url: string }>("POST", `/repos/${this.repo}/pulls`, { head, base, title, body, maintainer_can_modify: true }), "pull request creation");
    return { number: d.number, url: d.html_url };
  }

  async pullRequest(num: number) {
    const d = this.ok(await this.api<{ state: string; merged: boolean; merged_at: string | null }>("GET", `/repos/${this.repo}/pulls/${num}`), "pull request lookup");
    return d;
  }
}

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** Text source files worth searching for page copy and metadata. */
export const SOURCE_FILE = /\.(html?|jsx|tsx|js|ts|mjs|vue|svelte|astro|mdx?|json|ejs|hbs|njk|liquid|php)$/i;
export const SKIP_DIR = /(^|\/)(node_modules|dist|build|\.next|\.nuxt|\.output|out|coverage|\.git|vendor|\.cache|\.replit-cache)(\/|$)/;

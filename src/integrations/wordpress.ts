import type { IntegrationConnection } from "@prisma/client";
import { safeFetch } from "@/lib/net/safe-fetch";
import { IntegrationError, readSecret } from "./connections";

interface WpSecret { baseUrl: string; username: string; appPassword: string; metaDescriptionKey?: string }
export interface WpPost {
  id: number;
  type: "post" | "page";
  link: string;
  slug: string;
  title: { raw?: string; rendered: string };
  content: { raw?: string; rendered: string };
  excerpt?: { raw?: string };
  meta?: Record<string, unknown>;
  modified: string;
}

/** Minimal WordPress REST client. All requests go through the SSRF-safe fetcher. */
export class WordPressClient {
  private s: WpSecret;
  constructor(private conn: IntegrationConnection) {
    this.s = readSecret<WpSecret>(conn);
  }
  private get api() {
    return `${this.s.baseUrl.replace(/\/$/, "")}/wp-json/wp/v2`;
  }
  private headers() {
    return {
      authorization: `Basic ${Buffer.from(`${this.s.username}:${this.s.appPassword}`).toString("base64")}`,
      accept: "application/json",
      "content-type": "application/json",
    };
  }
  private async call<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
    const r = await safeFetch(`${this.api}${path}`, { method: init.method ?? "GET", headers: this.headers(), body: init.body ? JSON.stringify(init.body) : undefined, maxBytes: 8 * 1024 * 1024, timeoutMs: 30_000 });
    if (r.status >= 400) {
      let msg = r.body.slice(0, 300);
      try { msg = JSON.parse(r.body).message ?? msg; } catch { /* raw */ }
      throw new IntegrationError(`WordPress ${r.status}: ${msg}`, "WORDPRESS", r.status);
    }
    return JSON.parse(r.body) as T;
  }

  get metaDescriptionKey() {
    return this.s.metaDescriptionKey || (this.conn.config as { metaDescriptionKey?: string }).metaDescriptionKey || null;
  }

  /** Resolves a public URL to its post/page by slug (WordPress has no URL lookup endpoint). */
  async findByUrl(url: string): Promise<WpPost | null> {
    const path = new URL(url).pathname.replace(/\/$/, "");
    const slug = decodeURIComponent(path.split("/").pop() ?? "");
    const norm = (u: string) => u.replace(/^https?:\/\//, "").replace(/\/$/, "");
    for (const type of ["pages", "posts"] as const) {
      const list = slug
        ? await this.call<WpPost[]>(`/${type}?slug=${encodeURIComponent(slug)}&context=edit&status=publish,draft,private`)
        : type === "pages" ? await this.call<WpPost[]>(`/pages?context=edit&per_page=100`) : [];
      const match = list.find((p) => norm(p.link) === norm(url)) ?? (slug ? list[0] : undefined);
      if (match) return { ...match, type: type === "pages" ? "page" : "post" };
    }
    return null;
  }

  async get(type: "post" | "page", id: number): Promise<WpPost> {
    return { ...(await this.call<WpPost>(`/${type}s/${id}?context=edit`)), type };
  }

  /** Reads the current value of a field (used for backups before applying). */
  async readField(type: "post" | "page", id: number, field: string): Promise<string | null> {
    const p = await this.get(type, id);
    if (field === "title") return p.title.raw ?? p.title.rendered;
    if (field === "content") return p.content.raw ?? p.content.rendered;
    if (field === "excerpt") return p.excerpt?.raw ?? null;
    if (field === "meta_description") {
      const key = this.metaDescriptionKey;
      if (!key) throw new IntegrationError("No meta description field configured for this WordPress connection", "WORDPRESS");
      return (p.meta?.[key] as string | undefined) ?? null;
    }
    throw new IntegrationError(`Unsupported field ${field}`, "WORDPRESS");
  }

  async writeField(type: "post" | "page", id: number, field: string, value: string): Promise<void> {
    let body: Record<string, unknown>;
    if (field === "title" || field === "content" || field === "excerpt") body = { [field]: value };
    else if (field === "meta_description") {
      const key = this.metaDescriptionKey;
      if (!key) throw new IntegrationError("No meta description field configured", "WORDPRESS");
      body = { meta: { [key]: value } };
    } else throw new IntegrationError(`Unsupported field ${field}`, "WORDPRESS");
    await this.call(`/${type}s/${id}`, { method: "POST", body });
    // Verify the write actually took effect (meta keys not exposed via show_in_rest are silently ignored).
    const after = await this.readField(type, id, field);
    if (field === "meta_description" && (after ?? "") !== value) {
      throw new IntegrationError(`WordPress accepted the request but "${this.metaDescriptionKey}" did not change. Register it with show_in_rest => true.`, "WORDPRESS");
    }
  }
}

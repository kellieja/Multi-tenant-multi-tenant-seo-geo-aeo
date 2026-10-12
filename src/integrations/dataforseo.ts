import type { IntegrationConnection } from "@prisma/client";
import { IntegrationError, readSecret } from "./connections";

const BASE = "https://api.dataforseo.com/v3";

interface DfsTask<T> { id: string; status_code: number; status_message: string; cost: number; result: T[] | null }
interface DfsEnvelope<T> { status_code: number; status_message: string; cost: number; tasks?: DfsTask<T>[] }

/**
 * DataForSEO v3 client (licensed SERP, keyword, backlink and content data).
 * Every call returns its cost so syncs can record spend in the sync log.
 */
export class DataForSeoClient {
  cost = 0;
  calls = 0;
  private auth: string;

  constructor(conn: IntegrationConnection) {
    const s = readSecret<{ login: string; password: string }>(conn);
    this.auth = `Basic ${Buffer.from(`${s.login}:${s.password}`).toString("base64")}`;
  }

  private async post<T>(path: string, body: unknown[]): Promise<T[]> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${BASE}${path}`, { method: "POST", headers: { authorization: this.auth, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
      } catch (err) {
        if (attempt < 2) { await sleep(2000 * 2 ** attempt); continue; }
        throw new IntegrationError(`Could not reach DataForSEO: ${(err as Error).message}`, "DATAFORSEO", undefined, true);
      }
      this.calls++;
      if (res.status === 401) throw new IntegrationError("DataForSEO rejected the credentials", "DATAFORSEO", 401);
      if (res.status === 429 || res.status >= 500) {
        if (attempt < 3) { await sleep(3000 * 2 ** attempt); continue; }
        throw new IntegrationError(`DataForSEO HTTP ${res.status}`, "DATAFORSEO", res.status, true);
      }
      const json = (await res.json()) as DfsEnvelope<T>;
      this.cost += json.cost ?? 0;
      if (json.status_code !== 20000) throw dfsError(json.status_code, json.status_message);
      const task = json.tasks?.[0];
      if (!task) return [];
      if (task.status_code !== 20000 && task.status_code !== 40102 /* no results */) throw dfsError(task.status_code, task.status_message);
      return task.result ?? [];
    }
  }

  /** Live Google organic SERP. Returns organic + feature items. */
  async serp(keyword: string, opts: { locationCode: number; languageCode: string; device: string; depth?: number }) {
    const [r] = await this.post<{ items?: SerpItem[]; check_url?: string }>("/serp/google/organic/live/regular", [{ keyword, location_code: opts.locationCode, language_code: opts.languageCode, device: opts.device, depth: opts.depth ?? 100 }]);
    return r?.items ?? [];
  }

  async searchVolume(keywords: string[], locationCode: number, languageCode: string) {
    return this.post<{ keyword: string; search_volume: number | null; competition: string | null; cpc: number | null }>("/keywords_data/google_ads/search_volume/live", [{ keywords: keywords.slice(0, 1000), location_code: locationCode, language_code: languageCode }]);
  }

  async searchIntent(keywords: string[], languageCode: string) {
    const [r] = await this.post<{ items?: { keyword: string; keyword_intent?: { label: string; probability: number } }[] }>("/dataforseo_labs/google/search_intent/live", [{ keywords: keywords.slice(0, 1000), language_code: languageCode }]);
    return r?.items ?? [];
  }

  async keywordIdeas(seeds: string[], locationCode: number, languageCode: string, limit = 100) {
    const [r] = await this.post<{ items?: { keyword: string; keyword_info?: { search_volume?: number | null; cpc?: number | null }; keyword_properties?: { keyword_difficulty?: number | null }; search_intent_info?: { main_intent?: string } }[] }>(
      "/dataforseo_labs/google/keyword_ideas/live", [{ keywords: seeds.slice(0, 20), location_code: locationCode, language_code: languageCode, limit, include_serp_info: false }]);
    return r?.items ?? [];
  }

  async rankedKeywords(target: string, locationCode: number, languageCode: string, limit = 500) {
    const [r] = await this.post<{ items?: { keyword_data?: { keyword: string; keyword_info?: { search_volume?: number | null } }; ranked_serp_element?: { serp_item?: { rank_group?: number; url?: string } } }[] }>(
      "/dataforseo_labs/google/ranked_keywords/live", [{ target, location_code: locationCode, language_code: languageCode, limit, item_types: ["organic"] }]);
    return (r?.items ?? []).map((i) => ({ keyword: i.keyword_data?.keyword ?? "", volume: i.keyword_data?.keyword_info?.search_volume ?? null, position: i.ranked_serp_element?.serp_item?.rank_group ?? null, url: i.ranked_serp_element?.serp_item?.url ?? null })).filter((x) => x.keyword);
  }

  async competitorDomains(target: string, locationCode: number, languageCode: string, limit = 20) {
    const [r] = await this.post<{ items?: { domain: string; avg_position?: number; intersections?: number; full_domain_metrics?: { organic?: { count?: number; etv?: number } } }[] }>(
      "/dataforseo_labs/google/competitors_domain/live", [{ target, location_code: locationCode, language_code: languageCode, limit, exclude_top_domains: true }]);
    return r?.items ?? [];
  }

  async backlinks(target: string, opts: { limit?: number; offset?: number } = {}) {
    const [r] = await this.post<{ total_count?: number; items?: DfsBacklink[] }>("/backlinks/backlinks/live", [{ target, mode: "as_is", limit: opts.limit ?? 1000, offset: opts.offset ?? 0, backlinks_status_type: "all", include_subdomains: true, order_by: ["first_seen,desc"] }]);
    return { total: r?.total_count ?? 0, items: r?.items ?? [] };
  }

  async referringDomains(target: string, limit = 1000) {
    const [r] = await this.post<{ items?: { domain: string; rank?: number; backlinks?: number; first_seen?: string; lost_date?: string | null }[] }>("/backlinks/referring_domains/live", [{ target, limit, backlinks_status_type: "all", include_subdomains: true }]);
    return r?.items ?? [];
  }

  /** Domains linking to every given competitor but not to us (link gap). */
  async domainIntersection(competitors: string[], exclude: string, limit = 200) {
    const targets = Object.fromEntries(competitors.slice(0, 20).map((c, i) => [String(i + 1), c]));
    const [r] = await this.post<{ items?: Record<string, { domain?: string; target?: string; rank?: number; backlinks?: number }>[] }>("/backlinks/domain_intersection/live", [{ targets, exclude_targets: [exclude], limit, include_subdomains: true }]);
    return (r?.items ?? []).map((row) => {
      const any = Object.values(row)[0] ?? {};
      return { domain: any.domain ?? "", rank: any.rank ?? null, linksTo: Object.values(row).map((v) => v.target).filter(Boolean) as string[] };
    }).filter((x) => x.domain);
  }

  /** Pages mentioning a phrase (brand) across the web. Used for unlinked-mention discovery. */
  async contentSearch(keyword: string, limit = 100) {
    const [r] = await this.post<{ items?: { url: string; domain: string; main_domain?: string; content_info?: { title?: string; snippet?: string; date_published?: string } }[] }>("/content_analysis/search/live", [{ keyword: `"${keyword}"`, limit, search_mode: "as_is" }]);
    return r?.items ?? [];
  }
}

export interface SerpItem {
  type: string;
  rank_group?: number;
  rank_absolute?: number;
  domain?: string;
  url?: string;
  title?: string;
}

export interface DfsBacklink {
  url_from: string;
  domain_from: string;
  url_to: string;
  anchor?: string | null;
  dofollow?: boolean;
  attributes?: string[] | null;
  is_lost?: boolean;
  is_new?: boolean;
  first_seen?: string;
  last_seen?: string;
  lost_date?: string | null;
  rank?: number;
  domain_from_rank?: number;
  page_from_title?: string;
  item_type?: string;
}

function dfsError(code: number, message: string) {
  const hint = code === 40200 || code === 40210 ? " Add funds to your DataForSEO account." : code === 40100 ? " Check the API login/password." : code === 40202 ? " Rate limit reached; the job will retry." : "";
  return new IntegrationError(`DataForSEO ${code}: ${message}.${hint}`, "DATAFORSEO", code === 40100 ? 401 : code === 40202 ? 429 : 400, code === 40202);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

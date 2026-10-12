const ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

export interface PsiMetrics {
  performanceScore: number | null;
  lcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
  fcpMs: number | null;
  fieldLcpMs: number | null;
  fieldInpMs: number | null;
  fieldCls: number | null;
  fieldCategory: string | null;
}

type Audit = { numericValue?: number };
interface PsiResponse {
  lighthouseResult?: { categories?: { performance?: { score?: number } }; audits?: Record<string, Audit> };
  loadingExperience?: { overall_category?: string; metrics?: Record<string, { percentile?: number; category?: string }> };
  originLoadingExperience?: PsiResponse["loadingExperience"];
  error?: { message?: string; code?: number };
}

/** Calls the public PageSpeed Insights API (fixed Google host; the analysed URL is fetched by Google, not us). */
export async function runPageSpeed(url: string, strategy: "mobile" | "desktop", apiKey?: string): Promise<{ metrics: PsiMetrics; raw: unknown }> {
  const params = new URLSearchParams({ url, strategy, category: "performance" });
  if (apiKey) params.set("key", apiKey);
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${ENDPOINT}?${params}`, { signal: AbortSignal.timeout(120_000) });
    const json = (await res.json().catch(() => ({}))) as PsiResponse;
    if (res.ok) return { metrics: extract(json), raw: { loadingExperience: json.loadingExperience, originLoadingExperience: json.originLoadingExperience, score: json.lighthouseResult?.categories?.performance?.score } };
    lastErr = json.error?.message ?? `HTTP ${res.status}`;
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 3000 * 2 ** attempt));
  }
  throw new Error(`PageSpeed Insights failed for ${url}: ${lastErr}`);
}

export function extract(json: PsiResponse): PsiMetrics {
  const a = json.lighthouseResult?.audits ?? {};
  const field = json.loadingExperience?.metrics ? json.loadingExperience : undefined;
  const m = field?.metrics ?? {};
  return {
    performanceScore: json.lighthouseResult?.categories?.performance?.score ?? null,
    lcpMs: a["largest-contentful-paint"]?.numericValue ?? null,
    cls: a["cumulative-layout-shift"]?.numericValue ?? null,
    tbtMs: a["total-blocking-time"]?.numericValue ?? null,
    fcpMs: a["first-contentful-paint"]?.numericValue ?? null,
    fieldLcpMs: m.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? null,
    fieldInpMs: m.INTERACTION_TO_NEXT_PAINT?.percentile ?? null,
    // CrUX reports CLS ×100 as an integer percentile.
    fieldCls: m.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile != null ? m.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100 : null,
    fieldCategory: field?.overall_category ?? null,
  };
}

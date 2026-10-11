import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import { normalizeUrl } from "@/lib/url";

export interface ParsedLink { href: string; anchor: string; rel: string; nofollow: boolean }
export interface ParsedImage { src: string; alt: string | null; width: string | null; height: string | null; loading: string | null }
export interface Heading { level: number; text: string }
export interface StructuredDataItem { format: "json-ld" | "microdata"; types: string[]; valid: boolean; error?: string; data?: unknown }

export interface ParsedPage {
  title: string | null;
  titleCount: number;
  metaDescription: string | null;
  metaDescriptionCount: number;
  robotsMeta: string | null;
  canonical: string | null;
  canonicalCount: number;
  lang: string | null;
  hasViewport: boolean;
  headings: Heading[];
  h1: string[];
  links: ParsedLink[];
  images: ParsedImage[];
  hreflang: { lang: string; href: string }[];
  relNext: string | null;
  relPrev: string | null;
  structuredData: StructuredDataItem[];
  mixedContent: string[];
  wordCount: number;
  text: string;
  paragraphs: string[];
  contentHash: string;
  simhash: string;
  scriptCount: number;
  baseHref: string | null;
}

const BLOCK_STRIP = "script, style, noscript, template, svg, iframe, nav, footer, header, form, [aria-hidden=true]";

export function parseHtml(html: string, pageUrl: string): ParsedPage {
  const $ = cheerio.load(html);
  const baseHref = $("base[href]").attr("href") ?? null;
  const base = baseHref ? new URL(baseHref, pageUrl).toString() : pageUrl;
  const abs = (href: string | undefined | null) => (href ? normalizeUrl(href.trim(), base) : null);

  const titles = $("head title, title").first();
  const metaDesc = $('meta[name="description" i]');
  const canonical = $('link[rel~="canonical" i]');
  const robotsMeta = $('meta[name="robots" i], meta[name="googlebot" i]')
    .map((_, el) => $(el).attr("content") ?? "")
    .get()
    .join(", ")
    .toLowerCase() || null;

  const headings: Heading[] = $("h1, h2, h3, h4, h5, h6")
    .map((_, el) => ({ level: Number(el.tagName.slice(1)), text: $(el).text().replace(/\s+/g, " ").trim().slice(0, 300) }))
    .get();

  const links: ParsedLink[] = [];
  $("a[href]").each((_, el) => {
    const raw = $(el).attr("href")!;
    if (/^(mailto:|tel:|javascript:|#)/i.test(raw.trim())) return;
    const href = abs(raw);
    if (!href) return;
    const rel = ($(el).attr("rel") ?? "").toLowerCase();
    const anchor = ($(el).text() || $(el).find("img").attr("alt") || $(el).attr("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 200);
    links.push({ href, anchor, rel, nofollow: /\bnofollow\b/.test(rel) });
  });

  const images: ParsedImage[] = $("img")
    .map((_, el) => {
      const src = abs($(el).attr("src") ?? $(el).attr("data-src"));
      return src
        ? { src, alt: $(el).attr("alt") ?? null, width: $(el).attr("width") ?? null, height: $(el).attr("height") ?? null, loading: $(el).attr("loading") ?? null }
        : null;
    })
    .get()
    .filter(Boolean) as ParsedImage[];

  const hreflang = $('link[rel~="alternate" i][hreflang]')
    .map((_, el) => ({ lang: ($(el).attr("hreflang") ?? "").trim(), href: abs($(el).attr("href")) ?? "" }))
    .get()
    .filter((h) => h.href);

  const structuredData: StructuredDataItem[] = [];
  $('script[type="application/ld+json" i]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    try {
      const data = JSON.parse(raw);
      structuredData.push({ format: "json-ld", types: collectTypes(data), valid: true, data });
    } catch (e) {
      structuredData.push({ format: "json-ld", types: [], valid: false, error: `Invalid JSON: ${(e as Error).message.slice(0, 120)}` });
    }
  });
  $("[itemscope][itemtype]").each((_, el) => {
    if ($(el).parents("[itemscope]").length) return;
    const t = ($(el).attr("itemtype") ?? "").split(/\s+/).map((x) => x.replace(/^https?:\/\/schema\.org\//, ""));
    structuredData.push({ format: "microdata", types: t, valid: true });
  });

  const mixedContent: string[] = [];
  if (pageUrl.startsWith("https:")) {
    $("img[src], script[src], link[rel~=stylesheet][href], iframe[src], video[src], audio[src], source[src]").each((_, el) => {
      const v = $(el).attr("src") ?? $(el).attr("href") ?? "";
      if (/^http:\/\//i.test(v)) mixedContent.push(v.slice(0, 300));
    });
  }

  const scriptCount = $("script[src]").length;
  const $body = $("body").clone();
  $body.find(BLOCK_STRIP).remove();
  const main = $body.find("main, article, [role=main]").first();
  const scope = main.length ? main : $body;
  const paragraphs = scope
    .find("p, li")
    .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
    .get()
    .filter((p) => p.length >= 40)
    .slice(0, 200);
  const text = scope.text().replace(/\s+/g, " ").trim();
  const words = text ? text.split(" ").filter((w) => /\p{L}|\p{N}/u.test(w)) : [];

  return {
    title: titles.length ? titles.text().replace(/\s+/g, " ").trim() : null,
    titleCount: $("head title").length || $("title").length,
    metaDescription: metaDesc.first().attr("content")?.trim() ?? null,
    metaDescriptionCount: metaDesc.length,
    robotsMeta,
    canonical: canonical.length ? abs(canonical.first().attr("href")) : null,
    canonicalCount: canonical.length,
    lang: $("html").attr("lang")?.trim() || null,
    hasViewport: $('meta[name="viewport" i]').length > 0,
    headings,
    h1: headings.filter((h) => h.level === 1).map((h) => h.text),
    links,
    images,
    hreflang,
    relNext: abs($('link[rel~="next" i]').attr("href")),
    relPrev: abs($('link[rel~="prev" i]').attr("href")),
    structuredData,
    mixedContent: [...new Set(mixedContent)].slice(0, 50),
    wordCount: words.length,
    text: text.slice(0, 20000),
    paragraphs,
    contentHash: createHash("sha1").update(text.toLowerCase()).digest("hex"),
    simhash: simhash(words),
    scriptCount,
    baseHref,
  };
}

function collectTypes(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => collectTypes(n, out));
  else if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    const t = o["@type"];
    if (typeof t === "string") out.push(t);
    else if (Array.isArray(t)) out.push(...t.filter((x): x is string => typeof x === "string"));
    if (Array.isArray(o["@graph"])) collectTypes(o["@graph"], out);
  }
  return [...new Set(out)];
}

/** 64-bit SimHash over word 3-shingles, as hex. Used for near-duplicate detection. */
export function simhash(words: string[]): string {
  const v = new Array(64).fill(0);
  const lower = words.map((w) => w.toLowerCase());
  const n = Math.max(1, lower.length - 2);
  for (let i = 0; i < n; i++) {
    const shingle = lower.slice(i, i + 3).join(" ");
    const h = createHash("md5").update(shingle).digest();
    for (let b = 0; b < 64; b++) {
      const bit = (h[b >> 3] >> (b & 7)) & 1;
      v[b] += bit ? 1 : -1;
    }
  }
  let hex = "";
  for (let nib = 0; nib < 16; nib++) {
    let x = 0;
    for (let k = 0; k < 4; k++) if (v[nib * 4 + k] > 0) x |= 1 << k;
    hex += x.toString(16);
  }
  return hex;
}

export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

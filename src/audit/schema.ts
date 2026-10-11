/**
 * Validates JSON-LD against the properties Google documents as REQUIRED for
 * its rich-result features (plus a few strongly recommended ones, reported
 * separately). Passing does not guarantee rich results are shown.
 */
type Check = { required: (string | string[])[]; recommended?: string[]; nested?: (node: Record<string, unknown>) => string[] };

const has = (o: Record<string, unknown>, k: string) => {
  const v = o[k];
  return v != null && v !== "" && !(Array.isArray(v) && v.length === 0);
};
const asArray = (v: unknown) => (Array.isArray(v) ? v : v == null ? [] : [v]);

const RULES: Record<string, Check> = {
  Article: { required: [], recommended: ["headline", "image", "datePublished", "author"] },
  NewsArticle: { required: [], recommended: ["headline", "image", "datePublished", "author"] },
  BlogPosting: { required: [], recommended: ["headline", "image", "datePublished", "author"] },
  Product: { required: ["name", ["offers", "review", "aggregateRating"]], recommended: ["image", "description", "brand"] },
  Offer: { required: [["price", "priceSpecification"]], recommended: ["priceCurrency", "availability"] },
  FAQPage: {
    required: ["mainEntity"],
    nested: (n) =>
      asArray(n.mainEntity).flatMap((q, i) => {
        const qq = (q ?? {}) as Record<string, unknown>;
        const errs: string[] = [];
        if (!has(qq, "name")) errs.push(`mainEntity[${i}] Question is missing "name"`);
        const ans = (qq.acceptedAnswer ?? {}) as Record<string, unknown>;
        if (!has(ans, "text")) errs.push(`mainEntity[${i}] is missing acceptedAnswer.text`);
        return errs;
      }),
  },
  QAPage: { required: ["mainEntity"] },
  BreadcrumbList: {
    required: ["itemListElement"],
    nested: (n) => {
      const items = asArray(n.itemListElement) as Record<string, unknown>[];
      return items.flatMap((it, i) => {
        const errs: string[] = [];
        if (!has(it ?? {}, "position")) errs.push(`itemListElement[${i}] is missing "position"`);
        if (!has(it ?? {}, "name") && !has(((it ?? {}).item ?? {}) as Record<string, unknown>, "name")) errs.push(`itemListElement[${i}] is missing "name"`);
        if (i < items.length - 1 && !has(it ?? {}, "item")) errs.push(`itemListElement[${i}] is missing "item" (only the last crumb may omit it)`);
        return errs;
      });
    },
  },
  Organization: { required: [], recommended: ["name", "url", "logo", "sameAs"] },
  LocalBusiness: { required: ["name", "address"], recommended: ["telephone", "openingHoursSpecification", "geo"] },
  Event: { required: ["name", "startDate", "location"], recommended: ["endDate", "eventStatus", "image"] },
  Recipe: { required: ["name", "image"], recommended: ["recipeIngredient", "recipeInstructions", "author"] },
  HowTo: { required: ["name", "step"] },
  Review: { required: ["itemReviewed", "reviewRating", "author"] },
  AggregateRating: { required: ["ratingValue", ["ratingCount", "reviewCount"]] },
  VideoObject: { required: ["name", "thumbnailUrl", "uploadDate"], recommended: ["description", "duration"] },
  JobPosting: { required: ["title", "description", "datePosted", "hiringOrganization", "jobLocation"] },
  SoftwareApplication: { required: ["name", ["offers", "aggregateRating", "review"]] },
  Person: { required: [], recommended: ["name"] },
  WebSite: { required: [], recommended: ["name", "url"] },
};

export interface SchemaIssue {
  type: string;
  severity: "error" | "warning";
  message: string;
}

function nodes(data: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(data)) data.forEach((d) => nodes(d, out));
  else if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (o["@type"]) out.push(o);
    if (Array.isArray(o["@graph"])) nodes(o["@graph"], out);
    // Validate nested typed entities such as offers/aggregateRating.
    for (const k of ["offers", "aggregateRating", "review"]) for (const v of asArray(o[k])) if (v && typeof v === "object" && (v as Record<string, unknown>)["@type"]) nodes(v, out);
  }
  return out;
}

export function validateStructuredData(data: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const all = nodes(data);
  if (all.length === 0) issues.push({ type: "unknown", severity: "warning", message: "JSON-LD block has no @type" });
  const root = Array.isArray(data) ? data[0] : data;
  if (root && typeof root === "object" && !("@context" in (root as object)) && !Array.isArray(data)) {
    issues.push({ type: "unknown", severity: "warning", message: 'Missing "@context" (expected https://schema.org)' });
  }
  for (const node of all) {
    for (const type of asArray(node["@type"]).filter((t): t is string => typeof t === "string")) {
      const rule = RULES[type];
      if (!rule) continue;
      for (const req of rule.required) {
        const keys = Array.isArray(req) ? req : [req];
        if (!keys.some((k) => has(node, k))) issues.push({ type, severity: "error", message: `${type} is missing required ${keys.length > 1 ? `one of: ${keys.join(", ")}` : `"${keys[0]}"`}` });
      }
      for (const rec of rule.recommended ?? []) if (!has(node, rec)) issues.push({ type, severity: "warning", message: `${type} is missing recommended "${rec}"` });
      for (const msg of rule.nested?.(node) ?? []) issues.push({ type, severity: "error", message: msg });
    }
  }
  return issues;
}

export const SUPPORTED_SCHEMA_TYPES = Object.keys(RULES);

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { sha256 } from "@/lib/crypto";
import { getAiClient, NoAiProviderError } from "@/integrations/ai";
import { parseJsonLoose, FACT_GUARDRAIL } from "./ai-json";

const META_ISSUES = ["missing_title", "duplicate_title", "title_length", "missing_meta_description", "duplicate_meta_description", "meta_description_length"];

/**
 * Drafts titles and meta descriptions for pages with open metadata findings.
 * Results are stored as SUGGESTED ContentSuggestions (provider, model and prompt hash
 * recorded) and never published without the approval flow.
 */
export async function generateMetadataSuggestions(organizationId: string, websiteId: string, opts: { limit?: number; userId?: string | null; urls?: string[] } = {}) {
  const ai = await getAiClient(organizationId);
  if (!ai) throw new NoAiProviderError();
  const site = await prisma.website.findFirstOrThrow({ where: { id: websiteId, organizationId } });
  const crawl = await prisma.crawl.findFirst({ where: { websiteId, status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" } });
  if (!crawl) throw new Error("Run a crawl first so suggestions are based on real page content");
  let urls = opts.urls;
  if (!urls?.length) {
    const findings = await prisma.auditFinding.findMany({ where: { websiteId, issueType: { in: META_ISSUES }, status: { in: ["OPEN", "REGRESSED", "IN_PROGRESS"] } }, orderBy: { priorityScore: "desc" }, select: { url: true } });
    urls = [...new Set(findings.map((f) => f.url))];
  }
  // Skip pages that already have a pending suggestion.
  const pending = await prisma.contentSuggestion.findMany({ where: { websiteId, kind: "METADATA", status: { in: ["SUGGESTED", "EDITED", "APPROVED"] } }, select: { url: true } });
  const skip = new Set(pending.map((p) => p.url));
  urls = urls.filter((u) => !skip.has(u)).slice(0, opts.limit ?? 10);
  const pages = await prisma.crawledPage.findMany({ where: { crawlId: crawl.id, url: { in: urls } } });
  const titles = await prisma.crawledPage.findMany({ where: { crawlId: crawl.id, indexable: true, title: { not: null } }, select: { title: true }, take: 300 });

  const created = [];
  for (const p of pages) {
    const headings = ((p.headings as { level: number; text: string }[]) ?? []).slice(0, 15).map((h) => `${"#".repeat(h.level)} ${h.text}`).join("\n");
    const prompt = `Write SEO metadata for this page of ${site.name} (${site.domain}).

URL: ${p.url}
Current title: ${p.title ?? "(none)"}
Current meta description: ${p.metaDescription ?? "(none)"}
H1: ${p.h1.join(" | ") || "(none)"}
Headings:
${headings || "(none)"}

Main content excerpt:
"""
${(p.textSample ?? "").slice(0, 4000)}
"""

Other titles already used on the site (avoid duplicating them):
${titles.map((t) => `- ${t.title}`).slice(0, 60).join("\n")}

Requirements:
- title: 30–60 characters, unique, describes this specific page, brand name at the end only if it fits.
- metaDescription: 70–155 characters, accurate summary that would make a searcher click.
- ${FACT_GUARDRAIL}
Respond with JSON only: {"title": "...", "metaDescription": "...", "rationale": "one sentence"}`;
    const res = await ai.complete({ system: "You are a meticulous technical SEO editor.", prompt, maxTokens: 2000 });
    if (res.refusal) continue;
    const out = parseJsonLoose<{ title?: string; metaDescription?: string; rationale?: string }>(res.text);
    if (!out?.title && !out?.metaDescription) continue;
    created.push(await prisma.contentSuggestion.create({
      data: {
        organizationId, websiteId, url: p.url, kind: "METADATA",
        input: { currentTitle: p.title, currentMetaDescription: p.metaDescription, crawlId: crawl.id } as Prisma.InputJsonValue,
        output: JSON.stringify({ title: out.title?.trim(), metaDescription: out.metaDescription?.trim(), rationale: out.rationale }),
        provider: res.provider, model: res.model, promptHash: sha256(prompt).slice(0, 16), createdById: opts.userId ?? null,
      },
    }));
  }
  return { created: created.length, considered: pages.length };
}

/** Worker: drafts title/meta suggestions for a website (optionally for specific URLs). */
export async function processMetadataSuggest(jc: import("@/lib/jobs/context").JobContext) {
  const p = jc.job.payload as { urls?: string[]; limit?: number };
  await jc.progress(5, "Drafting titles and meta descriptions");
  return generateMetadataSuggestions(jc.job.organizationId, jc.job.websiteId!, { urls: p.urls, limit: p.limit ?? 10, userId: jc.job.createdById });
}

import type { OrgContext } from "@/lib/auth/context";
import { Select } from "@/components/ui/form";
import { Button } from "@/components/ui/button";

/** Resolves the active website for single-site modules from ?websiteId (falls back to the first site). */
export async function resolveSite(ctx: OrgContext, requested?: string) {
  const sites = await ctx.db.website.findMany({ where: { status: { not: "ARCHIVED" }, ...(ctx.websiteScope ? { id: { in: ctx.websiteScope } } : {}) }, select: { id: true, name: true, domain: true, baseUrl: true, cmsType: true, brandTerms: true }, orderBy: { name: "asc" } });
  const site = sites.find((s) => s.id === requested) ?? sites[0] ?? null;
  return { sites, site };
}

export function SitePicker({ sites, current, preserve = {} }: { sites: { id: string; name: string }[]; current?: string; preserve?: Record<string, string | undefined> }) {
  if (sites.length <= 1) return null;
  return (
    <form method="get" className="flex gap-2">
      {Object.entries(preserve).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      <Select name="websiteId" defaultValue={current} aria-label="Website" className="w-auto max-w-60">{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
      <Button type="submit">View</Button>
    </form>
  );
}

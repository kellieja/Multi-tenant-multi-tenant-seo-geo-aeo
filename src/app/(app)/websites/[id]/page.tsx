import { notFound } from "next/navigation";
import Link from "next/link";
import { requireOrgContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/rbac";
import { getWebsite, readSettings } from "@/server/websites";
import { PageHeader } from "@/components/ui/page";
import { TabNav } from "@/components/ui/tabs";
import { StatusDot, Badge } from "@/components/ui/badge";
import { EditWebsiteDialog } from "../dialogs";
import { WEBSITE_TABS, renderWebsiteTab } from "./tabs";

export async function generateMetadata() {
  return { title: "Website" };
}

export default async function WebsiteDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await requireOrgContext();
  let site;
  try {
    site = await getWebsite(ctx, id);
  } catch (e) {
    if (e instanceof ForbiddenError) notFound();
    throw e;
  }
  const clients = ctx.can("websites:write") ? await ctx.db.client.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }) : [];
  const visibleTabs = WEBSITE_TABS.filter((t) => !t.staffOnly || ctx.role !== "CLIENT");
  const tab = visibleTabs.find((t) => t.key === sp.tab)?.key ?? "overview";

  return (
    <>
      <PageHeader
        eyebrow={<Link href="/websites" className="hover:text-fg">Websites</Link>}
        title={
          <span className="flex items-center gap-2.5">
            <img src={`https://www.google.com/s2/favicons?domain=${site.domain}&sz=64`} alt="" className="size-5 rounded" />
            {site.name}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <a href={site.baseUrl} target="_blank" rel="noreferrer noopener" className="hover:text-fg hover:underline">{site.domain}</a>
            <StatusDot tone={site.status === "ACTIVE" ? "good" : site.status === "PAUSED" ? "warn" : "neutral"} label={site.status.toLowerCase()} />
            {site.client && <Badge>{site.client.name}</Badge>}
            {site.cmsType !== "NONE" && <Badge tone="info">{site.cmsType.toLowerCase()}</Badge>}
          </span>
        }
        actions={ctx.can("websites:write") && (
          <EditWebsiteDialog clients={clients} initial={{ ...site, tags: site.tags, brandTerms: site.brandTerms }} />
        )}
      />
      <TabNav active={tab} tabs={visibleTabs.map((t) => ({ key: t.key, label: t.label, href: `/websites/${id}?tab=${t.key}` }))} />
      {await renderWebsiteTab(tab, { ctx, site, settings: readSettings(site.settings), sp })}
    </>
  );
}

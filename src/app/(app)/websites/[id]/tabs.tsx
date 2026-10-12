import type { OrgContext } from "@/lib/auth/context";
import type { WebsiteSettings } from "@/server/websites";
import type { Website, Client, WebsiteAssignment } from "@prisma/client";
import { OverviewTab } from "./overview-tab";
import { SettingsTab } from "./settings-tab";

export interface TabProps {
  ctx: OrgContext;
  site: Website & { client: Client | null; assignments: (WebsiteAssignment & { user: { id: string; name: string; email: string } })[] };
  settings: WebsiteSettings;
  sp: Record<string, string | undefined>;
}

export const WEBSITE_TABS: { key: string; label: string; staffOnly?: boolean }[] = [
  { key: "overview", label: "Overview" },
  { key: "settings", label: "Settings & team", staffOnly: true },
];

export async function renderWebsiteTab(tab: string, props: TabProps) {
  switch (tab) {
    case "settings":
      return <SettingsTab {...props} />;
    default:
      return <OverviewTab {...props} />;
  }
}

import type { Role } from "@prisma/client";

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  clientVisible?: boolean;
}

export const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Overview",
    items: [
      { href: "/dashboard", label: "Executive Dashboard", icon: "LayoutDashboard", clientVisible: true },
      { href: "/websites", label: "Websites", icon: "Globe", clientVisible: true },
    ],
  },
  {
    label: "Search",
    items: [
      { href: "/audits", label: "SEO Audits", icon: "ScanSearch" },
      { href: "/keywords", label: "Keywords & Rankings", icon: "TrendingUp" },
      { href: "/technical", label: "Technical SEO", icon: "Gauge" },
      { href: "/internal-links", label: "Internal Linking", icon: "Network" },
      { href: "/competitors", label: "Competitor Intelligence", icon: "Swords" },
    ],
  },
  {
    label: "AI search",
    items: [
      { href: "/aeo", label: "AEO Optimization", icon: "MessageSquareQuote" },
      { href: "/geo", label: "GEO & AI Visibility", icon: "Sparkles" },
    ],
  },
  {
    label: "Growth",
    items: [
      { href: "/backlinks", label: "Backlink Intelligence", icon: "Link2" },
      { href: "/content", label: "Content Studio", icon: "PenLine" },
    ],
  },
  {
    label: "Operations",
    items: [
      { href: "/automation", label: "Automation Center", icon: "Workflow" },
      { href: "/reports", label: "Reports", icon: "FileBarChart", clientVisible: true },
      { href: "/integrations", label: "Integrations", icon: "Plug" },
      { href: "/settings", label: "Settings", icon: "Settings" },
    ],
  },
];

export function navFor(role: Role) {
  if (role !== "CLIENT") return NAV_GROUPS;
  return NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => i.clientVisible) })).filter((g) => g.items.length);
}

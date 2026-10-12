import type { IntegrationProvider } from "@prisma/client";

export type AuthKind = "oauth-google" | "api-key" | "basic" | "wordpress" | "smtp" | "webhook" | "none";

export interface ProviderField {
  name: string;
  label: string;
  type: "text" | "password" | "url" | "email" | "textarea" | "select";
  /** Choices for type "select". */
  options?: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
  secret?: boolean;
  optional?: boolean;
}

export interface ProviderDef {
  id: IntegrationProvider;
  name: string;
  category: "Google" | "CMS" | "SEO data" | "AI models" | "Messaging";
  level: "website" | "organization";
  auth: AuthKind;
  description: string;
  powers: string[];
  scopes?: string[];
  fields?: ProviderField[];
  /** Server env vars that must be set before this provider can be connected. */
  requiresEnv?: string[];
  setup: string[];
  docsUrl?: string;
  costNote?: string;
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: "GOOGLE_SEARCH_CONSOLE", name: "Google Search Console", category: "Google", level: "website", auth: "oauth-google",
    description: "First-party clicks, impressions, CTR and average position by date, query and page.",
    powers: ["Executive dashboard search metrics", "Keyword & page performance", "Finding prioritisation by impressions", "Declining page detection"],
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"], requiresEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    setup: [
      "In Google Cloud Console create an OAuth client (type: Web application).",
      "Add the redirect URI <APP_URL>/api/integrations/google/callback.",
      "Enable the “Google Search Console API” for the project.",
      "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server and restart.",
      "Click Connect, sign in with a Google account that has access to the property, then choose the property.",
    ],
    docsUrl: "https://developers.google.com/webmaster-tools/v1/how-tos/search_analytics",
  },
  {
    id: "GOOGLE_ANALYTICS_4", name: "Google Analytics 4", category: "Google", level: "website", auth: "oauth-google",
    description: "Sessions, organic sessions, users and key events from the GA4 Data API.",
    powers: ["Organic sessions on dashboards and reports"],
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"], requiresEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    setup: ["Use the same OAuth client as Search Console.", "Enable the “Google Analytics Data API” and “Google Analytics Admin API”.", "Connect, then select the GA4 property for this website."],
    docsUrl: "https://developers.google.com/analytics/devguides/reporting/data/v1",
  },
  {
    id: "PAGESPEED_INSIGHTS", name: "PageSpeed Insights", category: "Google", level: "organization", auth: "api-key",
    description: "Lighthouse lab metrics plus Chrome UX Report field data (Core Web Vitals) when Google has enough samples.",
    powers: ["Core Web Vitals in Technical SEO", "CWV findings in audits"],
    fields: [{ name: "apiKey", label: "API key", type: "password", secret: true, optional: true, hint: "Optional. Without a key, requests share a low anonymous quota." }],
    setup: ["Optionally create an API key in Google Cloud Console with the PageSpeed Insights API enabled.", "Paste it here, or connect without a key for light usage."],
    docsUrl: "https://developers.google.com/speed/docs/insights/v5/get-started",
  },
  {
    id: "WORDPRESS", name: "WordPress", category: "CMS", level: "website", auth: "wordpress",
    description: "Reads posts/pages and applies approved changes (titles, content links, meta) through the WordPress REST API with backups and rollback.",
    powers: ["Apply approved metadata and internal-link changes", "Content inventory"],
    fields: [
      { name: "baseUrl", label: "WordPress site URL", type: "url", placeholder: "https://example.com" },
      { name: "username", label: "Username", type: "text" },
      { name: "appPassword", label: "Application password", type: "password", secret: true, hint: "Users → Profile → Application Passwords. Never your login password." },
      { name: "metaDescriptionKey", label: "Meta description field (optional)", type: "text", optional: true, placeholder: "_yoast_wpseo_metadesc", hint: "Post meta key registered with show_in_rest. Leave empty to disable meta-description writes." },
    ],
    setup: [
      "Create an Application Password for a user with the Editor role (least privilege that can edit posts/pages).",
      "Enter the site URL, username and application password. The connection is verified with /wp-json/wp/v2/users/me.",
      "To let approved changes update SEO meta descriptions, the meta key must be exposed via register_post_meta(..., ['show_in_rest' => true]).",
    ],
    docsUrl: "https://developer.wordpress.org/rest-api/",
  },
  {
    id: "FILE_HOST", name: "File host (SFTP / FTPS)", category: "CMS", level: "website", auth: "basic",
    description: "Applies approved changes to static HTML sites on hosts like Hostinger, GoDaddy or cPanel (including sites exported from Replit): titles, meta descriptions and internal links, with a backup, an upload check and rollback.",
    powers: ["Apply approved title, meta description and internal-link changes to HTML files"],
    fields: [
      { name: "protocol", label: "Protocol", type: "select", options: [{ value: "sftp", label: "SFTP (SSH)" }, { value: "ftps", label: "FTPS (FTP over TLS)" }], hint: "Plain FTP isn't supported: it sends your password unencrypted." },
      { name: "host", label: "Host", type: "text", placeholder: "ftp.example.com" },
      { name: "port", label: "Port", type: "text", optional: true, placeholder: "22 for SFTP, 21 or 990 for FTPS" },
      { name: "username", label: "Username", type: "text" },
      { name: "password", label: "Password", type: "password", secret: true, optional: true, hint: "Use a dedicated account limited to the site's folder if your host allows it." },
      { name: "privateKey", label: "SSH private key (SFTP)", type: "textarea", secret: true, optional: true, hint: "PEM/OpenSSH key instead of a password." },
      { name: "docRoot", label: "Document root", type: "text", placeholder: "/public_html", hint: "Folder on the server that holds the site's index.html." },
    ],
    setup: [
      "In your host's control panel, find the SFTP or FTPS details (often under Files → FTP Accounts or SSH Access). Prefer SFTP.",
      "Create an FTP/SFTP account limited to the website's folder if you can.",
      "Enter the details and the document root (e.g. /public_html or /htdocs). The connection is verified, and for SFTP the server's host key is pinned.",
      "Works for sites made of HTML files. A single-page app (e.g. a built React app) has one index.html for every page, so per-page changes need a change pack or the GitHub connector instead.",
    ],
  },
  {
    id: "GITHUB", name: "GitHub (pull requests)", category: "CMS", level: "website", auth: "api-key",
    description: "For sites built from a code repository, including Replit projects synced to GitHub: each approved title, meta description or internal-link change is opened as a pull request against the source. Merging it is the final approval.",
    powers: ["Open pull requests for approved title, meta description and internal-link changes", "Track merges and open revert pull requests"],
    fields: [
      { name: "repository", label: "Repository", type: "text", placeholder: "owner/name" },
      { name: "token", label: "Fine-grained access token", type: "password", secret: true, hint: "Limited to this one repository, with Contents: read and write and Pull requests: read and write." },
      { name: "baseBranch", label: "Base branch", type: "text", optional: true, placeholder: "the repository's default branch" },
      { name: "sitePath", label: "Site folder in the repository", type: "text", optional: true, placeholder: "e.g. client or src (leave empty for the whole repo)" },
    ],
    setup: [
      "In Replit, connect the project to GitHub (Git pane → Connect to GitHub) and push it, if it isn't there already.",
      "On GitHub: Settings → Developer settings → Fine-grained tokens → Generate. Choose only this repository, and grant Contents and Pull requests: Read and write.",
      "Enter the repository and token. The connection is verified and must have write access.",
      "Approved changes become pull requests. After you merge one, redeploy the site in Replit (or wherever it's hosted) unless it deploys automatically from that branch. The next crawl verifies the change.",
    ],
    docsUrl: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
  },
  {
    id: "DATAFORSEO", name: "DataForSEO", category: "SEO data", level: "organization", auth: "basic",
    description: "Licensed SERP rank tracking, keyword volumes/intent, backlink index, competitor domains and brand-mention search.",
    powers: ["Rank tracking", "Keyword research & volumes", "Backlink inventory & new/lost links", "Competitor & link-gap analysis", "Unlinked brand mentions"],
    fields: [
      { name: "login", label: "API login", type: "email" },
      { name: "password", label: "API password", type: "password", secret: true },
    ],
    setup: ["Create an account at dataforseo.com and add funds (pay-as-you-go).", "Copy the API login and password from the dashboard."],
    docsUrl: "https://docs.dataforseo.com/v3/", costNote: "Paid per request. Costs are recorded per sync in the sync log.",
  },
  {
    id: "ANTHROPIC", name: "Anthropic Claude", category: "AI models", level: "organization", auth: "api-key",
    description: "Drafts titles, meta descriptions, briefs and AEO improvements. Also usable for GEO prompt sampling.",
    powers: ["Content Studio", "AEO drafts", "GEO checks (model answers)"],
    fields: [{ name: "apiKey", label: "API key", type: "password", secret: true }, { name: "model", label: "Model", type: "text", optional: true, placeholder: "claude-opus-5-5" }],
    setup: ["Create an API key in the Anthropic Console.", "Paste it here. It is encrypted at rest and only used server-side."], docsUrl: "https://docs.anthropic.com/",
  },
  {
    id: "OPENAI", name: "OpenAI", category: "AI models", level: "organization", auth: "api-key",
    description: "Content drafting and GEO prompt checks via the OpenAI API (optionally with web search).",
    powers: ["Content Studio", "AEO drafts", "GEO checks"],
    fields: [{ name: "apiKey", label: "API key", type: "password", secret: true }, { name: "model", label: "Model", type: "text", optional: true, placeholder: "gpt-4.1" }],
    setup: ["Create an API key at platform.openai.com.", "Paste it here."], docsUrl: "https://platform.openai.com/docs",
  },
  {
    id: "GEMINI", name: "Google Gemini", category: "AI models", level: "organization", auth: "api-key",
    description: "Content drafting and GEO checks via the Gemini API (with Google Search grounding when enabled for your key).",
    powers: ["Content Studio", "GEO checks"],
    fields: [{ name: "apiKey", label: "API key", type: "password", secret: true }, { name: "model", label: "Model", type: "text", optional: true, placeholder: "gemini-2.5-flash" }],
    setup: ["Create an API key in Google AI Studio.", "Paste it here."], docsUrl: "https://ai.google.dev/gemini-api/docs",
  },
  {
    id: "PERPLEXITY", name: "Perplexity", category: "AI models", level: "organization", auth: "api-key",
    description: "Sonar API answers include the source URLs they cite, the most direct official route for AI citation tracking.",
    powers: ["GEO citation tracking", "Content Studio"],
    fields: [{ name: "apiKey", label: "API key", type: "password", secret: true }, { name: "model", label: "Model", type: "text", optional: true, placeholder: "sonar" }],
    setup: ["Create an API key at perplexity.ai/settings/api.", "Paste it here."], docsUrl: "https://docs.perplexity.ai/",
  },
  {
    id: "SMTP", name: "Email (SMTP)", category: "Messaging", level: "organization", auth: "smtp",
    description: "Sends notifications, scheduled reports and approved outreach emails from your own mailbox/provider.",
    powers: ["Email alerts", "Scheduled report delivery", "Outreach sending (after approval)"],
    fields: [
      { name: "url", label: "SMTP URL", type: "password", secret: true, placeholder: "smtps://user:pass@smtp.example.com:465" },
      { name: "from", label: "From address", type: "text", placeholder: "SEO Team <seo@example.com>" },
    ],
    setup: ["Use your provider's SMTP credentials (e.g. Postmark, SES, Google Workspace, Microsoft 365).", "A test connection is made when you save."],
  },
  {
    id: "SLACK_WEBHOOK", name: "Slack", category: "Messaging", level: "organization", auth: "webhook",
    description: "Posts alerts (failed jobs, health drops, approvals waiting) to a Slack channel via an incoming webhook.",
    powers: ["Slack alerts"],
    fields: [{ name: "webhookUrl", label: "Incoming webhook URL", type: "password", secret: true, placeholder: "https://hooks.slack.com/services/…" }],
    setup: ["In Slack, create an app with Incoming Webhooks enabled and add it to a channel.", "Paste the webhook URL (must be on hooks.slack.com)."],
  },
];

export const providerDef = (id: IntegrationProvider) => PROVIDERS.find((p) => p.id === id)!;

export function missingEnv(def: ProviderDef): string[] {
  return (def.requiresEnv ?? []).filter((k) => !process.env[k]);
}

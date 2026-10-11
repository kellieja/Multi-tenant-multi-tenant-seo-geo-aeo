import { z } from "zod";

export const EVENTS = {
  "crawl.completed": "A crawl finishes",
  "health.dropped": "Health score drops past the site threshold",
  "finding.critical": "New critical issues are detected",
  "ranking.dropped": "Tracked keywords drop past the alert threshold",
  "backlink.lost": "Backlinks are lost",
  "backlink.new": "New backlinks are found",
  "gsc.synced": "Search Console data is refreshed",
} as const;
export type EventName = keyof typeof EVENTS;

export const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("schedule"), cron: z.string().trim().min(9).max(100) }),
  z.object({ type: z.literal("event"), event: z.enum(Object.keys(EVENTS) as [EventName, ...EventName[]]) }),
  z.object({ type: z.literal("manual") }),
]);

export const CONDITION_FIELDS = {
  healthScore: { label: "Health score (internal)", type: "number" },
  openCritical: { label: "Open critical issues", type: "number" },
  openFindings: { label: "Open issues (all)", type: "number" },
  missingMetadata: { label: "Pages missing title/description", type: "number" },
  clicks28d: { label: "GSC clicks, last 28 days", type: "number" },
  clicksChangePct: { label: "GSC clicks change vs prior 28 days (%)", type: "number" },
  rankDrops: { label: "Keywords dropped ≥ threshold", type: "number" },
  lostBacklinks7d: { label: "Backlinks lost, last 7 days", type: "number" },
  daysSinceCrawl: { label: "Days since last crawl", type: "number" },
  tag: { label: "Website tag", type: "string" },
  cmsType: { label: "CMS", type: "string" },
} as const;
export type ConditionField = keyof typeof CONDITION_FIELDS;

export const conditionSchema = z.object({
  field: z.enum(Object.keys(CONDITION_FIELDS) as [ConditionField, ...ConditionField[]]),
  op: z.enum(["gt", "gte", "lt", "lte", "eq", "neq", "contains"]),
  value: z.union([z.number(), z.string()]),
});

/**
 * Actions and their risk class:
 *  internal → only changes data inside this platform (always allowed outside dry-run)
 *  external → affects a live website or contacts people (always needs approval, except
 *             low-risk metadata fixes in AUTOMATIC mode when the site policy is "safe-auto")
 */
export const ACTIONS = {
  run_crawl: { label: "Run a crawl", risk: "internal", params: { mode: ["FULL", "INCREMENTAL"] } },
  create_tasks: { label: "Create tasks from open findings", risk: "internal", params: { minSeverity: ["CRITICAL", "HIGH", "MEDIUM", "LOW"], limit: "number" } },
  run_pagespeed: { label: "Run PageSpeed / Core Web Vitals check", risk: "internal", params: {} },
  sync_search_console: { label: "Refresh Search Console data", risk: "internal", params: {} },
  check_rankings: { label: "Check keyword rankings", risk: "internal", params: {} },
  sync_backlinks: { label: "Sync backlinks from provider", risk: "internal", params: {} },
  verify_backlinks: { label: "Verify backlinks are live", risk: "internal", params: {} },
  run_geo: { label: "Run GEO / AI visibility prompts", risk: "internal", params: {} },
  suggest_metadata: { label: "Draft titles/descriptions for pages missing them (AI)", risk: "internal", params: { limit: "number" } },
  propose_metadata_fixes: { label: "Propose approved drafts as live CMS changes", risk: "external", params: { limit: "number" } },
  generate_report: { label: "Generate a report", risk: "internal", params: { days: "number" } },
  notify: { label: "Send a notification", risk: "internal", params: { message: "string", channel: ["in-app", "email", "slack"] } },
} as const;
export type ActionType = keyof typeof ACTIONS;

export const actionSchema = z.object({
  type: z.enum(Object.keys(ACTIONS) as [ActionType, ...ActionType[]]),
  params: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
});

export const scopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("all") }),
  z.object({ type: z.literal("websites"), ids: z.array(z.string()).min(1, "Pick at least one website") }),
  z.object({ type: z.literal("clients"), ids: z.array(z.string()).min(1, "Pick at least one client") }),
]);

export const workflowSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  description: z.string().trim().max(1000).optional().nullable(),
  mode: z.enum(["DRY_RUN", "APPROVAL", "AUTOMATIC"]),
  trigger: triggerSchema,
  conditions: z.array(conditionSchema).max(10),
  actions: z.array(actionSchema).min(1, "Add at least one action").max(10),
  scope: scopeSchema,
  maxRetries: z.coerce.number().int().min(0).max(5).default(2),
  notifyOn: z.array(z.enum(["FAILED", "SUCCEEDED", "APPROVAL"])).default(["FAILED"]),
});
export type WorkflowInput = z.infer<typeof workflowSchema>;

export function evaluateCondition(c: z.infer<typeof conditionSchema>, ctx: Record<string, unknown>): { pass: boolean; actual: unknown } {
  const actual = ctx[c.field];
  if (actual === null || actual === undefined) return { pass: false, actual: null };
  if (c.op === "contains") return { pass: Array.isArray(actual) ? actual.map(String).includes(String(c.value)) : String(actual).includes(String(c.value)), actual };
  const a = typeof actual === "number" ? actual : Number(actual);
  const v = typeof c.value === "number" ? c.value : Number(c.value);
  if (CONDITION_FIELDS[c.field].type === "string") {
    const pass = c.op === "eq" ? String(actual) === String(c.value) : c.op === "neq" ? String(actual) !== String(c.value) : false;
    return { pass, actual };
  }
  if (!Number.isFinite(a) || !Number.isFinite(v)) return { pass: false, actual };
  const pass = { gt: a > v, gte: a >= v, lt: a < v, lte: a <= v, eq: a === v, neq: a !== v }[c.op as "gt"];
  return { pass, actual };
}

export const TEMPLATES: { name: string; description: string; input: WorkflowInput }[] = [
  {
    name: "Weekly audit → tasks",
    description: "Crawl every Monday at 03:00 UTC and turn new high-severity issues into tasks.",
    input: { name: "Weekly audit → tasks", mode: "APPROVAL", trigger: { type: "schedule", cron: "0 3 * * 1" }, conditions: [], actions: [{ type: "run_crawl", params: { mode: "INCREMENTAL" } }, { type: "create_tasks", params: { minSeverity: "HIGH", limit: 25 } }], scope: { type: "all" }, maxRetries: 2, notifyOn: ["FAILED"] },
  },
  {
    name: "Critical issue alert",
    description: "When a crawl finds new critical issues, create tasks and alert the team.",
    input: { name: "Critical issue alert", mode: "AUTOMATIC", trigger: { type: "event", event: "finding.critical" }, conditions: [{ field: "openCritical", op: "gt", value: 0 }], actions: [{ type: "create_tasks", params: { minSeverity: "CRITICAL", limit: 50 } }, { type: "notify", params: { channel: "slack", message: "New critical SEO issues need attention." } }], scope: { type: "all" }, maxRetries: 1, notifyOn: ["FAILED"] },
  },
  {
    name: "Missing metadata drafts",
    description: "Weekly: draft titles and meta descriptions for pages missing them, for review in Content Studio.",
    input: { name: "Missing metadata drafts", mode: "APPROVAL", trigger: { type: "schedule", cron: "0 6 * * 2" }, conditions: [{ field: "missingMetadata", op: "gt", value: 0 }], actions: [{ type: "suggest_metadata", params: { limit: 20 } }], scope: { type: "all" }, maxRetries: 1, notifyOn: ["FAILED", "SUCCEEDED"] },
  },
  {
    name: "Lost backlink watch",
    description: "Daily backlink verification; alert when links are lost.",
    input: { name: "Lost backlink watch", mode: "AUTOMATIC", trigger: { type: "schedule", cron: "30 5 * * *" }, conditions: [], actions: [{ type: "verify_backlinks", params: {} }], scope: { type: "all" }, maxRetries: 2, notifyOn: ["FAILED"] },
  },
  {
    name: "Monthly client report",
    description: "Generate a 30-day report on the 1st of every month.",
    input: { name: "Monthly client report", mode: "AUTOMATIC", trigger: { type: "schedule", cron: "0 7 1 * *" }, conditions: [], actions: [{ type: "generate_report", params: { days: 30 } }], scope: { type: "all" }, maxRetries: 2, notifyOn: ["FAILED", "SUCCEEDED"] },
  },
];

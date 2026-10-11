export const JOB_TYPES = {
  crawl: { queue: "crawl", label: "Site crawl & audit", attempts: 1 },
  "gsc-sync": { queue: "default", label: "Search Console sync", attempts: 3 },
  "ga4-sync": { queue: "default", label: "Google Analytics sync", attempts: 3 },
  "psi-check": { queue: "default", label: "PageSpeed / Core Web Vitals", attempts: 2 },
  "rank-check": { queue: "default", label: "Rank tracking", attempts: 2 },
  "keyword-metrics": { queue: "default", label: "Keyword metrics refresh", attempts: 2 },
  "backlink-sync": { queue: "default", label: "Backlink provider sync", attempts: 2 },
  "backlink-verify": { queue: "default", label: "Backlink verification", attempts: 2 },
  "geo-run": { queue: "default", label: "GEO / AI visibility check", attempts: 2 },
  "aeo-assess": { queue: "default", label: "AEO assessment", attempts: 1 },
  "internal-links": { queue: "default", label: "Internal link analysis", attempts: 1 },
  "workflow-run": { queue: "default", label: "Automation workflow", attempts: 1 },
  "report-generate": { queue: "default", label: "Report generation", attempts: 2 },
  "outreach-send": { queue: "default", label: "Outreach email send", attempts: 3 },
  "site-change-apply": { queue: "default", label: "Apply approved site change", attempts: 1 },
  maintenance: { queue: "default", label: "Retention & maintenance", attempts: 1 },
} as const;

export type JobType = keyof typeof JOB_TYPES;
export const QUEUE_NAMES = ["crawl", "default"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export interface QueuePayload {
  jobId: string;
}

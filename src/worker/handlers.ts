import type { JobContext } from "@/lib/jobs/context";
import type { JobType } from "@/lib/jobs/types";
import { processCrawlJob } from "@/server/crawls";
import { processGscSync, processGa4Sync, processPsiCheck } from "@/server/sync";
import { processMaintenance } from "@/server/maintenance";
import { processWorkflowRun } from "@/server/workflows";
import { processSiteChangeApply } from "@/server/site-changes";
import { processRankCheck, processKeywordMetrics } from "@/server/keywords";
import { processBacklinkSync, processBacklinkVerify } from "@/server/backlinks";
import { processCompetitorGap } from "@/server/competitors";
import { processAeoAssess, processAeoOpportunities } from "@/server/aeo";
import { processGeoRun } from "@/server/geo";
import { processMetadataSuggest } from "@/server/content";
import { processInternalLinks } from "@/server/internal-links";
import { processOutreachSend, discoverLinkGap, discoverUnlinkedMentions } from "@/server/outreach";

type Handler = (jc: JobContext) => Promise<unknown>;

/** Job type → implementation. Types without a handler fail with a clear message. */
export const HANDLERS: Partial<Record<JobType, Handler>> = {
  crawl: processCrawlJob,
  "gsc-sync": processGscSync,
  "ga4-sync": processGa4Sync,
  "psi-check": processPsiCheck,
  maintenance: processMaintenance,
  "workflow-run": processWorkflowRun,
  "site-change-apply": processSiteChangeApply,
  "rank-check": processRankCheck,
  "keyword-metrics": processKeywordMetrics,
  "backlink-sync": processBacklinkSync,
  "backlink-verify": processBacklinkVerify,
  "outreach-send": processOutreachSend,
  "link-gap": discoverLinkGap,
  "competitor-gap": processCompetitorGap,
  "aeo-assess": processAeoAssess,
  "aeo-opportunities": processAeoOpportunities,
  "geo-run": processGeoRun,
  "unlinked-mentions": discoverUnlinkedMentions,
  "metadata-suggest": processMetadataSuggest,
  "internal-links": processInternalLinks,
};

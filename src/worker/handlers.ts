import type { JobContext } from "@/lib/jobs/context";
import type { JobType } from "@/lib/jobs/types";
import { processCrawlJob } from "@/server/crawls";
import { processGscSync, processGa4Sync, processPsiCheck } from "@/server/sync";
import { processMaintenance } from "@/server/maintenance";

type Handler = (jc: JobContext) => Promise<unknown>;

/** Job type → implementation. Types without a handler fail with a clear message. */
export const HANDLERS: Partial<Record<JobType, Handler>> = {
  crawl: processCrawlJob,
  "gsc-sync": processGscSync,
  "ga4-sync": processGa4Sync,
  "psi-check": processPsiCheck,
  maintenance: processMaintenance,
};

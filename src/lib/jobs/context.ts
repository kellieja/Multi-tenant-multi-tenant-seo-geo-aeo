import type { Job } from "@prisma/client";

export interface JobContext {
  job: Job;
  progress: (pct: number, message?: string) => Promise<void>;
  isCancelled: () => Promise<boolean>;
  log: (message: string, data?: unknown) => void;
}

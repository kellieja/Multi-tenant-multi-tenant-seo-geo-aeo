import { Prisma } from "@prisma/client";
import { prisma } from "./client";

/** Every model that carries `organizationId` and therefore must be tenant scoped. */
export const TENANT_MODELS = new Set<string>([
  "Membership", "Invitation", "Client", "Website", "WebsiteAssignment",
  "IntegrationConnection", "SyncLog", "Job", "Crawl", "CrawledPage", "CrawledLink",
  "AuditFinding", "FindingEvent", "Task", "SearchConsoleDaily", "SearchConsoleQuery",
  "AnalyticsDaily", "PageSpeedResult", "Keyword", "RankObservation", "Competitor",
  "Backlink", "ReferringDomain", "OutreachProspect", "OutreachCampaign", "OutreachTemplate",
  "OutreachMessage", "DisavowEntry", "ContentSuggestion", "AeoAssessment", "AeoOpportunity",
  "GeoPromptSet", "GeoPrompt", "GeoObservation", "InternalLinkSuggestion", "SiteChange",
  "Workflow", "WorkflowExecution", "Approval", "Notification", "Report", "ReportSchedule",
  "AuditLog",
]);

const WHERE_OPS = new Set([
  "findMany", "findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow",
  "count", "aggregate", "groupBy", "updateMany", "updateManyAndReturn", "deleteMany",
  "update", "delete", "upsert",
]);

export class TenantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantViolationError";
  }
}

function stampData(data: unknown, orgId: string, model: string): unknown {
  if (Array.isArray(data)) return data.map((d) => stampData(d, orgId, model));
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (record.organizationId !== undefined && record.organizationId !== orgId) {
      throw new TenantViolationError(`Attempted to write ${model} into another organization`);
    }
    // Relation-style writes (organization: { connect }) are not allowed through the scoped client.
    if ("organization" in record) {
      throw new TenantViolationError(`Use organizationId, not a nested organization relation, on ${model}`);
    }
    return { ...record, organizationId: orgId };
  }
  return data;
}

/**
 * Returns a Prisma client that injects `organizationId = orgId` into every
 * read/update/delete filter and stamps it on every create for tenant models.
 * Cross-tenant reads return nothing; cross-tenant writes throw.
 */
export function tenantDb(orgId: string) {
  if (!orgId) throw new TenantViolationError("tenantDb requires an organization id");
  return prisma.$extends({
    name: "tenant-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !TENANT_MODELS.has(model)) return query(args);
          const a = (args ?? {}) as Record<string, unknown>;

          if (WHERE_OPS.has(operation)) {
            const where = (a.where ?? {}) as Record<string, unknown>;
            if (where.organizationId !== undefined && where.organizationId !== orgId) {
              throw new TenantViolationError(`Cross-tenant filter on ${model}`);
            }
            a.where = { ...where, organizationId: orgId };
          }
          if (operation === "create" || operation === "createMany" || operation === "createManyAndReturn") {
            a.data = stampData(a.data, orgId, model);
          }
          if (operation === "upsert") {
            a.create = stampData(a.create, orgId, model);
          }
          if ((operation === "update" || operation === "updateMany" || operation === "upsert") && a.data) {
            const d = (operation === "upsert" ? a.update : a.data) as Record<string, unknown>;
            if (d && d.organizationId !== undefined && d.organizationId !== orgId) {
              throw new TenantViolationError(`Cannot move ${model} to another organization`);
            }
          }
          return query(a as typeof args);
        },
      },
    },
  });
}

export type TenantDb = ReturnType<typeof tenantDb>;
export type { Prisma };

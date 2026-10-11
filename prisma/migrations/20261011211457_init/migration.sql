-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'ANALYST', 'CLIENT');

-- CreateEnum
CREATE TYPE "WebsiteStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CmsType" AS ENUM ('NONE', 'WORDPRESS', 'WEBFLOW', 'SHOPIFY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('GOOGLE_SEARCH_CONSOLE', 'GOOGLE_ANALYTICS_4', 'PAGESPEED_INSIGHTS', 'WORDPRESS', 'DATAFORSEO', 'ANTHROPIC', 'OPENAI', 'GEMINI', 'PERPLEXITY', 'SMTP', 'SLACK_WEBHOOK');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'PENDING', 'ERROR', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CrawlMode" AS ENUM ('FULL', 'INCREMENTAL');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');

-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'IGNORED', 'REGRESSED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SearchIntent" AS ENUM ('INFORMATIONAL', 'NAVIGATIONAL', 'COMMERCIAL', 'TRANSACTIONAL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "BacklinkStatus" AS ENUM ('ACTIVE', 'LOST', 'BROKEN', 'REDIRECTED', 'UNVERIFIED');

-- CreateEnum
CREATE TYPE "OpportunityType" AS ENUM ('INDUSTRY_PUBLICATION', 'RESOURCE_PAGE', 'ASSOCIATION', 'DIRECTORY', 'PARTNER_SUPPLIER', 'EDITORIAL_MENTION', 'UNLINKED_MENTION', 'BROKEN_LINK', 'GUEST_CONTRIBUTION', 'COMPETITOR_GAP', 'PODCAST_INTERVIEW', 'OTHER');

-- CreateEnum
CREATE TYPE "OutreachStage" AS ENUM ('DISCOVERED', 'QUALIFIED', 'CONTACTED', 'RESPONDED', 'NEGOTIATING', 'ACQUIRED', 'VERIFIED', 'LOST', 'REJECTED');

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('SUGGESTED', 'EDITED', 'APPROVED', 'REJECTED', 'APPLIED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "WorkflowMode" AS ENUM ('DRY_RUN', 'APPROVAL', 'AUTOMATIC');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "emailVerifiedAt" TIMESTAMP(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'trial',
    "brandName" TEXT,
    "brandColor" TEXT DEFAULT '#2F5BEA',
    "logoUrl" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'ANALYST',
    "clientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "clientId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactEmail" TEXT,
    "notes" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Website" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "status" "WebsiteStatus" NOT NULL DEFAULT 'ACTIVE',
    "cmsType" "CmsType" NOT NULL DEFAULT 'NONE',
    "project" TEXT,
    "industry" TEXT,
    "folder" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "brandTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "settings" JSONB NOT NULL DEFAULT '{}',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Website_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebsiteAssignment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebsiteAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT,
    "provider" "IntegrationProvider" NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "label" TEXT,
    "encryptedSecret" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "externalAccountId" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "tokenExpiresAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "websiteId" TEXT,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "itemsProcessed" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "quotaUsed" DOUBLE PRECISION,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "SyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT,
    "type" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "progressMessage" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Crawl" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "jobId" TEXT,
    "mode" "CrawlMode" NOT NULL DEFAULT 'FULL',
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "pagesDiscovered" INTEGER NOT NULL DEFAULT 0,
    "pagesCrawled" INTEGER NOT NULL DEFAULT 0,
    "errorsCount" INTEGER NOT NULL DEFAULT 0,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "healthScore" DOUBLE PRECISION,
    "summary" JSONB,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Crawl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrawledPage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "crawlId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "finalUrl" TEXT,
    "statusCode" INTEGER,
    "contentType" TEXT,
    "redirectChain" JSONB NOT NULL DEFAULT '[]',
    "title" TEXT,
    "metaDescription" TEXT,
    "h1" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "headings" JSONB NOT NULL DEFAULT '[]',
    "canonical" TEXT,
    "robotsMeta" TEXT,
    "xRobotsTag" TEXT,
    "indexable" BOOLEAN NOT NULL DEFAULT true,
    "indexabilityReason" TEXT,
    "inSitemap" BOOLEAN NOT NULL DEFAULT false,
    "blockedByRobots" BOOLEAN NOT NULL DEFAULT false,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "contentHash" TEXT,
    "simhash" TEXT,
    "textSample" TEXT,
    "inlinks" INTEGER NOT NULL DEFAULT 0,
    "outlinks" INTEGER NOT NULL DEFAULT 0,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "responseTimeMs" INTEGER,
    "bytes" INTEGER,
    "lang" TEXT,
    "hreflang" JSONB NOT NULL DEFAULT '[]',
    "structuredData" JSONB NOT NULL DEFAULT '[]',
    "images" JSONB NOT NULL DEFAULT '[]',
    "mixedContent" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hasViewport" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrawledPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrawledLink" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "crawlId" TEXT NOT NULL,
    "fromUrl" TEXT NOT NULL,
    "toUrl" TEXT NOT NULL,
    "anchor" TEXT,
    "rel" TEXT,
    "isInternal" BOOLEAN NOT NULL,
    "statusCode" INTEGER,

    CONSTRAINT "CrawledLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditFinding" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "crawlId" TEXT,
    "fingerprint" TEXT NOT NULL,
    "issueType" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "recommendation" TEXT NOT NULL,
    "implementation" TEXT NOT NULL,
    "automatable" BOOLEAN NOT NULL DEFAULT false,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT true,
    "status" "FindingStatus" NOT NULL DEFAULT 'OPEN',
    "priorityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "priorityFactors" JSONB NOT NULL DEFAULT '{}',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "AuditFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FindingEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "fromStatus" "FindingStatus",
    "toStatus" "FindingStatus" NOT NULL,
    "note" TEXT,
    "userId" TEXT,
    "crawlId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FindingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT,
    "findingId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'TODO',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "assigneeId" TEXT,
    "visibleToClient" BOOLEAN NOT NULL DEFAULT false,
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchConsoleDaily" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "ctr" DOUBLE PRECISION NOT NULL,
    "position" DOUBLE PRECISION NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchConsoleDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchConsoleQuery" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "query" TEXT NOT NULL,
    "page" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "ctr" DOUBLE PRECISION NOT NULL,
    "position" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "SearchConsoleQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsDaily" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "sessions" INTEGER NOT NULL,
    "organicSessions" INTEGER NOT NULL,
    "users" INTEGER NOT NULL,
    "conversions" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageSpeedResult" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "performanceScore" DOUBLE PRECISION,
    "lcpMs" DOUBLE PRECISION,
    "cls" DOUBLE PRECISION,
    "tbtMs" DOUBLE PRECISION,
    "fcpMs" DOUBLE PRECISION,
    "fieldLcpMs" DOUBLE PRECISION,
    "fieldInpMs" DOUBLE PRECISION,
    "fieldCls" DOUBLE PRECISION,
    "fieldCategory" TEXT,
    "raw" JSONB,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageSpeedResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Keyword" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "phrase" TEXT NOT NULL,
    "locationCode" INTEGER NOT NULL DEFAULT 2840,
    "languageCode" TEXT NOT NULL DEFAULT 'en',
    "device" TEXT NOT NULL DEFAULT 'desktop',
    "intent" "SearchIntent" NOT NULL DEFAULT 'UNKNOWN',
    "intentSource" TEXT,
    "group" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetUrl" TEXT,
    "searchVolume" INTEGER,
    "volumeSource" TEXT,
    "volumeUpdatedAt" TIMESTAMP(3),
    "difficulty" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Keyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RankObservation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "keywordId" TEXT NOT NULL,
    "position" INTEGER,
    "url" TEXT,
    "serpFeatures" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL,
    "checkedDepth" INTEGER NOT NULL DEFAULT 100,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RankObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Competitor" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "name" TEXT,
    "brandTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Competitor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Backlink" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceDomain" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "anchor" TEXT,
    "rel" TEXT NOT NULL DEFAULT 'follow',
    "status" "BacklinkStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "source" TEXT NOT NULL,
    "providerRank" DOUBLE PRECISION,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lostAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "verifyHttpStatus" INTEGER,
    "verifyNote" TEXT,

    CONSTRAINT "Backlink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferringDomain" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "backlinks" INTEGER NOT NULL DEFAULT 0,
    "providerRank" DOUBLE PRECISION,
    "rankSource" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lostAt" TIMESTAMP(3),

    CONSTRAINT "ReferringDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachProspect" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "campaignId" TEXT,
    "domain" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "type" "OpportunityType" NOT NULL DEFAULT 'OTHER',
    "stage" "OutreachStage" NOT NULL DEFAULT 'DISCOVERED',
    "relevanceScore" DOUBLE PRECISION,
    "relevanceReason" TEXT,
    "discoverySource" TEXT NOT NULL,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactSource" TEXT,
    "targetUrl" TEXT,
    "notes" TEXT,
    "nextFollowUpAt" TIMESTAMP(3),
    "acquiredLinkUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachProspect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachCampaign" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "templateId" TEXT,
    "followUpDays" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachTemplate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachMessage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "approvalId" TEXT,
    "providerMessageId" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisavowEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "included" BOOLEAN NOT NULL DEFAULT false,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisavowEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentSuggestion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "url" TEXT,
    "kind" TEXT NOT NULL,
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "promptHash" TEXT,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'SUGGESTED',
    "createdById" TEXT,
    "approvalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AeoAssessment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "crawlId" TEXT,
    "url" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "checks" JSONB NOT NULL,
    "assessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AeoAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AeoOpportunity" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "intent" "SearchIntent" NOT NULL DEFAULT 'INFORMATIONAL',
    "rankingUrl" TEXT,
    "recommendedFormat" TEXT NOT NULL,
    "contentGaps" JSONB NOT NULL DEFAULT '[]',
    "suggestedChanges" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "source" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AeoOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeoPromptSet" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "market" TEXT NOT NULL DEFAULT 'US',
    "language" TEXT NOT NULL DEFAULT 'en',
    "platforms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "competitorTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "schedule" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeoPromptSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeoPrompt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "promptSetId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeoPrompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeoObservation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "responseText" TEXT NOT NULL,
    "citations" JSONB NOT NULL DEFAULT '[]',
    "brandMentioned" BOOLEAN NOT NULL,
    "brandCited" BOOLEAN NOT NULL,
    "citedOwnUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "competitorMentions" JSONB NOT NULL DEFAULT '{}',
    "sentiment" TEXT,
    "sentimentMethod" TEXT,
    "methodology" TEXT NOT NULL,
    "market" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeoObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InternalLinkSuggestion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "crawlId" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "anchor" TEXT NOT NULL,
    "sourceParagraph" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'SUGGESTED',
    "changeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InternalLinkSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteChange" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "targetRef" TEXT NOT NULL,
    "targetUrl" TEXT,
    "field" TEXT NOT NULL,
    "before" TEXT,
    "after" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "approvalId" TEXT,
    "source" TEXT NOT NULL,
    "error" TEXT,
    "appliedAt" TIMESTAMP(3),
    "rolledBackAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workflow" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "mode" "WorkflowMode" NOT NULL DEFAULT 'DRY_RUN',
    "trigger" JSONB NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "scope" JSONB NOT NULL DEFAULT '{"type":"all"}',
    "maxRetries" INTEGER NOT NULL DEFAULT 2,
    "notifyOn" TEXT[] DEFAULT ARRAY['FAILED']::TEXT[],
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowExecution" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "websiteId" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "mode" "WorkflowMode" NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "logs" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT,
    "kind" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "note" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT,
    "clientId" TEXT,
    "scheduleId" TEXT,
    "title" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'GENERATED',
    "data" JSONB NOT NULL,
    "notes" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportSchedule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "websiteIds" TEXT[],
    "clientId" TEXT,
    "frequency" TEXT NOT NULL,
    "recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "autoApprove" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "Membership_organizationId_idx" ON "Membership"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_organizationId_key" ON "Membership"("userId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_organizationId_idx" ON "Invitation"("organizationId");

-- CreateIndex
CREATE INDEX "Client_organizationId_idx" ON "Client"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Client_organizationId_name_key" ON "Client"("organizationId", "name");

-- CreateIndex
CREATE INDEX "Website_organizationId_status_idx" ON "Website"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Website_organizationId_clientId_idx" ON "Website"("organizationId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Website_organizationId_domain_key" ON "Website"("organizationId", "domain");

-- CreateIndex
CREATE INDEX "WebsiteAssignment_organizationId_idx" ON "WebsiteAssignment"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "WebsiteAssignment_websiteId_userId_key" ON "WebsiteAssignment"("websiteId", "userId");

-- CreateIndex
CREATE INDEX "IntegrationConnection_organizationId_provider_idx" ON "IntegrationConnection"("organizationId", "provider");

-- CreateIndex
CREATE INDEX "IntegrationConnection_websiteId_idx" ON "IntegrationConnection"("websiteId");

-- CreateIndex
CREATE INDEX "SyncLog_organizationId_startedAt_idx" ON "SyncLog"("organizationId", "startedAt");

-- CreateIndex
CREATE INDEX "SyncLog_connectionId_startedAt_idx" ON "SyncLog"("connectionId", "startedAt");

-- CreateIndex
CREATE INDEX "Job_organizationId_queuedAt_idx" ON "Job"("organizationId", "queuedAt");

-- CreateIndex
CREATE INDEX "Job_organizationId_status_idx" ON "Job"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Job_websiteId_type_idx" ON "Job"("websiteId", "type");

-- CreateIndex
CREATE INDEX "Crawl_organizationId_websiteId_createdAt_idx" ON "Crawl"("organizationId", "websiteId", "createdAt");

-- CreateIndex
CREATE INDEX "CrawledPage_organizationId_websiteId_idx" ON "CrawledPage"("organizationId", "websiteId");

-- CreateIndex
CREATE UNIQUE INDEX "CrawledPage_crawlId_url_key" ON "CrawledPage"("crawlId", "url");

-- CreateIndex
CREATE INDEX "CrawledLink_crawlId_toUrl_idx" ON "CrawledLink"("crawlId", "toUrl");

-- CreateIndex
CREATE INDEX "CrawledLink_crawlId_fromUrl_idx" ON "CrawledLink"("crawlId", "fromUrl");

-- CreateIndex
CREATE INDEX "AuditFinding_organizationId_websiteId_status_idx" ON "AuditFinding"("organizationId", "websiteId", "status");

-- CreateIndex
CREATE INDEX "AuditFinding_organizationId_severity_idx" ON "AuditFinding"("organizationId", "severity");

-- CreateIndex
CREATE INDEX "AuditFinding_organizationId_priorityScore_idx" ON "AuditFinding"("organizationId", "priorityScore");

-- CreateIndex
CREATE UNIQUE INDEX "AuditFinding_websiteId_fingerprint_key" ON "AuditFinding"("websiteId", "fingerprint");

-- CreateIndex
CREATE INDEX "FindingEvent_findingId_createdAt_idx" ON "FindingEvent"("findingId", "createdAt");

-- CreateIndex
CREATE INDEX "Task_organizationId_status_idx" ON "Task"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Task_websiteId_idx" ON "Task"("websiteId");

-- CreateIndex
CREATE INDEX "SearchConsoleDaily_organizationId_date_idx" ON "SearchConsoleDaily"("organizationId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "SearchConsoleDaily_websiteId_date_key" ON "SearchConsoleDaily"("websiteId", "date");

-- CreateIndex
CREATE INDEX "SearchConsoleQuery_organizationId_websiteId_date_idx" ON "SearchConsoleQuery"("organizationId", "websiteId", "date");

-- CreateIndex
CREATE INDEX "SearchConsoleQuery_websiteId_query_idx" ON "SearchConsoleQuery"("websiteId", "query");

-- CreateIndex
CREATE UNIQUE INDEX "SearchConsoleQuery_websiteId_date_query_page_key" ON "SearchConsoleQuery"("websiteId", "date", "query", "page");

-- CreateIndex
CREATE INDEX "AnalyticsDaily_organizationId_date_idx" ON "AnalyticsDaily"("organizationId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsDaily_websiteId_date_key" ON "AnalyticsDaily"("websiteId", "date");

-- CreateIndex
CREATE INDEX "PageSpeedResult_organizationId_websiteId_fetchedAt_idx" ON "PageSpeedResult"("organizationId", "websiteId", "fetchedAt");

-- CreateIndex
CREATE INDEX "Keyword_organizationId_websiteId_idx" ON "Keyword"("organizationId", "websiteId");

-- CreateIndex
CREATE UNIQUE INDEX "Keyword_websiteId_phrase_locationCode_device_key" ON "Keyword"("websiteId", "phrase", "locationCode", "device");

-- CreateIndex
CREATE INDEX "RankObservation_keywordId_observedAt_idx" ON "RankObservation"("keywordId", "observedAt");

-- CreateIndex
CREATE INDEX "RankObservation_organizationId_websiteId_observedAt_idx" ON "RankObservation"("organizationId", "websiteId", "observedAt");

-- CreateIndex
CREATE INDEX "Competitor_organizationId_idx" ON "Competitor"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Competitor_websiteId_domain_key" ON "Competitor"("websiteId", "domain");

-- CreateIndex
CREATE INDEX "Backlink_organizationId_websiteId_status_idx" ON "Backlink"("organizationId", "websiteId", "status");

-- CreateIndex
CREATE INDEX "Backlink_websiteId_sourceDomain_idx" ON "Backlink"("websiteId", "sourceDomain");

-- CreateIndex
CREATE INDEX "Backlink_websiteId_firstSeenAt_idx" ON "Backlink"("websiteId", "firstSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "Backlink_websiteId_sourceUrl_targetUrl_key" ON "Backlink"("websiteId", "sourceUrl", "targetUrl");

-- CreateIndex
CREATE INDEX "ReferringDomain_organizationId_websiteId_idx" ON "ReferringDomain"("organizationId", "websiteId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferringDomain_websiteId_domain_key" ON "ReferringDomain"("websiteId", "domain");

-- CreateIndex
CREATE INDEX "OutreachProspect_organizationId_websiteId_stage_idx" ON "OutreachProspect"("organizationId", "websiteId", "stage");

-- CreateIndex
CREATE INDEX "OutreachProspect_organizationId_nextFollowUpAt_idx" ON "OutreachProspect"("organizationId", "nextFollowUpAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachProspect_websiteId_domain_url_key" ON "OutreachProspect"("websiteId", "domain", "url");

-- CreateIndex
CREATE INDEX "OutreachCampaign_organizationId_websiteId_idx" ON "OutreachCampaign"("organizationId", "websiteId");

-- CreateIndex
CREATE INDEX "OutreachTemplate_organizationId_idx" ON "OutreachTemplate"("organizationId");

-- CreateIndex
CREATE INDEX "OutreachMessage_organizationId_status_idx" ON "OutreachMessage"("organizationId", "status");

-- CreateIndex
CREATE INDEX "DisavowEntry_organizationId_idx" ON "DisavowEntry"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "DisavowEntry_websiteId_value_key" ON "DisavowEntry"("websiteId", "value");

-- CreateIndex
CREATE INDEX "ContentSuggestion_organizationId_websiteId_createdAt_idx" ON "ContentSuggestion"("organizationId", "websiteId", "createdAt");

-- CreateIndex
CREATE INDEX "AeoAssessment_organizationId_websiteId_assessedAt_idx" ON "AeoAssessment"("organizationId", "websiteId", "assessedAt");

-- CreateIndex
CREATE INDEX "AeoOpportunity_organizationId_websiteId_status_idx" ON "AeoOpportunity"("organizationId", "websiteId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AeoOpportunity_websiteId_question_key" ON "AeoOpportunity"("websiteId", "question");

-- CreateIndex
CREATE INDEX "GeoPromptSet_organizationId_websiteId_idx" ON "GeoPromptSet"("organizationId", "websiteId");

-- CreateIndex
CREATE INDEX "GeoObservation_organizationId_websiteId_observedAt_idx" ON "GeoObservation"("organizationId", "websiteId", "observedAt");

-- CreateIndex
CREATE INDEX "GeoObservation_promptId_observedAt_idx" ON "GeoObservation"("promptId", "observedAt");

-- CreateIndex
CREATE INDEX "InternalLinkSuggestion_organizationId_websiteId_status_idx" ON "InternalLinkSuggestion"("organizationId", "websiteId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InternalLinkSuggestion_crawlId_sourceUrl_targetUrl_key" ON "InternalLinkSuggestion"("crawlId", "sourceUrl", "targetUrl");

-- CreateIndex
CREATE INDEX "SiteChange_organizationId_websiteId_status_idx" ON "SiteChange"("organizationId", "websiteId", "status");

-- CreateIndex
CREATE INDEX "Workflow_organizationId_enabled_idx" ON "Workflow"("organizationId", "enabled");

-- CreateIndex
CREATE INDEX "Workflow_enabled_nextRunAt_idx" ON "Workflow"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "WorkflowExecution_organizationId_createdAt_idx" ON "WorkflowExecution"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowExecution_workflowId_createdAt_idx" ON "WorkflowExecution"("workflowId", "createdAt");

-- CreateIndex
CREATE INDEX "Approval_organizationId_status_idx" ON "Approval"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Approval_subjectType_subjectId_idx" ON "Approval"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "Notification_organizationId_userId_readAt_idx" ON "Notification"("organizationId", "userId", "readAt");

-- CreateIndex
CREATE INDEX "Report_organizationId_createdAt_idx" ON "Report"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Report_clientId_idx" ON "Report"("clientId");

-- CreateIndex
CREATE INDEX "ReportSchedule_organizationId_idx" ON "ReportSchedule"("organizationId");

-- CreateIndex
CREATE INDEX "ReportSchedule_enabled_nextRunAt_idx" ON "ReportSchedule"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Website" ADD CONSTRAINT "Website_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Website" ADD CONSTRAINT "Website_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteAssignment" ADD CONSTRAINT "WebsiteAssignment_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteAssignment" ADD CONSTRAINT "WebsiteAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncLog" ADD CONSTRAINT "SyncLog_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Crawl" ADD CONSTRAINT "Crawl_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrawledPage" ADD CONSTRAINT "CrawledPage_crawlId_fkey" FOREIGN KEY ("crawlId") REFERENCES "Crawl"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrawledLink" ADD CONSTRAINT "CrawledLink_crawlId_fkey" FOREIGN KEY ("crawlId") REFERENCES "Crawl"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditFinding" ADD CONSTRAINT "AuditFinding_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditFinding" ADD CONSTRAINT "AuditFinding_crawlId_fkey" FOREIGN KEY ("crawlId") REFERENCES "Crawl"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingEvent" ADD CONSTRAINT "FindingEvent_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "AuditFinding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "AuditFinding"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Keyword" ADD CONSTRAINT "Keyword_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RankObservation" ADD CONSTRAINT "RankObservation_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "Keyword"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Backlink" ADD CONSTRAINT "Backlink_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachProspect" ADD CONSTRAINT "OutreachProspect_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "OutreachCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachMessage" ADD CONSTRAINT "OutreachMessage_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "OutreachProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeoPrompt" ADD CONSTRAINT "GeoPrompt_promptSetId_fkey" FOREIGN KEY ("promptSetId") REFERENCES "GeoPromptSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeoObservation" ADD CONSTRAINT "GeoObservation_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "GeoPrompt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowExecution" ADD CONSTRAINT "WorkflowExecution_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

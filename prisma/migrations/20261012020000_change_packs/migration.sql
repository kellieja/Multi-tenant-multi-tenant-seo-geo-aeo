-- CreateTable
CREATE TABLE "ChangePack" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "items" JSONB NOT NULL,
    "createdById" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChangePack_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChangePack_organizationId_websiteId_status_idx" ON "ChangePack"("organizationId", "websiteId", "status");


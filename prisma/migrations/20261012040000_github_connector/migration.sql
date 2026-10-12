-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'GITHUB';

-- AlterTable
ALTER TABLE "SiteChange" ADD COLUMN     "externalUrl" TEXT;


-- AlterTable
ALTER TABLE "CrawledPage" ADD COLUMN     "carriedForward" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "extra" JSONB NOT NULL DEFAULT '{}';

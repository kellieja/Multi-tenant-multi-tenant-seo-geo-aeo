-- AlterTable
ALTER TABLE "Competitor" ADD COLUMN     "analysis" JSONB,
ADD COLUMN     "analyzedAt" TIMESTAMP(3);

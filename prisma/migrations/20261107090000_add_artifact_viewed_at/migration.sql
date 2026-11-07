-- AlterTable
ALTER TABLE "learning_artifact" ADD COLUMN "viewedAt" TIMESTAMP(3);

-- Artifacts that already finished before this column existed count as seen.
UPDATE "learning_artifact" SET "viewedAt" = "updatedAt" WHERE "status" = 'READY';

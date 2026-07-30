-- CreateEnum
CREATE TYPE "AIReviewRunStatus" AS ENUM ('pending', 'running', 'completed', 'failed');

-- AlterTable
ALTER TABLE "ai_reviews" ADD COLUMN     "duration_ms" INTEGER,
ADD COLUMN     "error" TEXT,
ADD COLUMN     "issue_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "run_id" TEXT;

-- CreateTable
CREATE TABLE "ai_review_runs" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "code_file_id" TEXT,
    "triggered_by_id" TEXT NOT NULL,
    "status" "AIReviewRunStatus" NOT NULL DEFAULT 'pending',
    "engine" TEXT,
    "summary" TEXT,
    "total_issues" INTEGER NOT NULL DEFAULT 0,
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "ai_review_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_review_runs_session_id_created_at_idx" ON "ai_review_runs"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_review_runs_status_idx" ON "ai_review_runs"("status");

-- CreateIndex
CREATE INDEX "sessions_created_by_id_idx" ON "sessions"("created_by_id");

-- CreateIndex
CREATE INDEX "sessions_updated_at_idx" ON "sessions"("updated_at");

-- CreateIndex
CREATE INDEX "comments_session_id_created_at_idx" ON "comments"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "comments_code_file_id_idx" ON "comments"("code_file_id");

-- CreateIndex
CREATE INDEX "comments_parent_id_idx" ON "comments"("parent_id");

-- CreateIndex
CREATE INDEX "ai_reviews_session_id_idx" ON "ai_reviews"("session_id");

-- CreateIndex
CREATE INDEX "ai_reviews_run_id_idx" ON "ai_reviews"("run_id");

-- AddForeignKey
ALTER TABLE "ai_reviews" ADD CONSTRAINT "ai_reviews_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "ai_review_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_review_runs" ADD CONSTRAINT "ai_review_runs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_review_runs" ADD CONSTRAINT "ai_review_runs_code_file_id_fkey" FOREIGN KEY ("code_file_id") REFERENCES "code_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_review_runs" ADD CONSTRAINT "ai_review_runs_triggered_by_id_fkey" FOREIGN KEY ("triggered_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


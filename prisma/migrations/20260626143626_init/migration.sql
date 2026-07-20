-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('author', 'reviewer', 'ai_reviewer');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('active', 'completed', 'archived');

-- CreateEnum
CREATE TYPE "CommentAuthorType" AS ENUM ('human', 'ai');

-- CreateEnum
CREATE TYPE "CommentCategory" AS ENUM ('bug', 'security', 'anti-pattern', 'test', 'general');

-- CreateEnum
CREATE TYPE "AgentType" AS ENUM ('bug_detection', 'security_scan', 'anti_pattern', 'test_generation');

-- CreateEnum
CREATE TYPE "AIReviewStatus" AS ENUM ('pending', 'running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('critical', 'high', 'medium', 'low', 'info');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'reviewer',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "repository_url" TEXT,
    "status" "SessionStatus" NOT NULL DEFAULT 'active',
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_participants" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),

    CONSTRAINT "session_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_files" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "language" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "code_file_id" TEXT,
    "author_id" TEXT NOT NULL,
    "author_type" "CommentAuthorType" NOT NULL,
    "category" "CommentCategory" NOT NULL DEFAULT 'general',
    "content" TEXT NOT NULL,
    "line_start" INTEGER,
    "line_end" INTEGER,
    "parent_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cursor_presence" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "file_path" TEXT,
    "line" INTEGER,
    "column" INTEGER,
    "color" TEXT NOT NULL DEFAULT '#10b981',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cursor_presence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_reviews" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "agent_type" "AgentType" NOT NULL,
    "status" "AIReviewStatus" NOT NULL DEFAULT 'pending',
    "result" TEXT,
    "file_path" TEXT,
    "line_start" INTEGER,
    "line_end" INTEGER,
    "severity" "Severity" DEFAULT 'info',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "ai_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_participants_session_id_user_id_key" ON "session_participants"("session_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "code_files_session_id_file_path_key" ON "code_files"("session_id", "file_path");

-- CreateIndex
CREATE UNIQUE INDEX "cursor_presence_session_id_user_id_key" ON "cursor_presence"("session_id", "user_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_files" ADD CONSTRAINT "code_files_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_code_file_id_fkey" FOREIGN KEY ("code_file_id") REFERENCES "code_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cursor_presence" ADD CONSTRAINT "cursor_presence_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cursor_presence" ADD CONSTRAINT "cursor_presence_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_reviews" ADD CONSTRAINT "ai_reviews_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

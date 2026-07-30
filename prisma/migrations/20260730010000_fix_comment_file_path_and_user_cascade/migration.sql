-- DropForeignKey
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_created_by_id_fkey";

-- AlterTable
ALTER TABLE "comments" ADD COLUMN     "file_path" TEXT;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


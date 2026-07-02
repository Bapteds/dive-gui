-- AlterTable: templates carry a JSON-encoded string[] of tags (search + sort).
ALTER TABLE "Template" ADD COLUMN "tags" TEXT NOT NULL DEFAULT '[]';

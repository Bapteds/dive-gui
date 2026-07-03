-- AlterTable: a run records how many cores (parallel subdomains) it used; 1 = serial single-core.
ALTER TABLE "Run" ADD COLUMN "cores" INTEGER NOT NULL DEFAULT 1;

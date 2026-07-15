-- CreateTable
CREATE TABLE "Study" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "totalSamples" INTEGER NOT NULL DEFAULT 0,
    "doneSamples" INTEGER NOT NULL DEFAULT 0,
    "bestDiameterM" REAL,
    "currentRunId" TEXT,
    "reason" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Study_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Study_projectId_idx" ON "Study"("projectId");

-- CreateIndex
CREATE INDEX "Study_projectId_status_idx" ON "Study"("projectId", "status");

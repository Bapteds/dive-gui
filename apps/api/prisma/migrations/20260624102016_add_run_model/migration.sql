-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "solver" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "pid" INTEGER,
    "exitCode" INTEGER,
    "command" TEXT NOT NULL,
    "logPath" TEXT NOT NULL,
    "reason" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Run_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Run_projectId_idx" ON "Run"("projectId");

-- CreateIndex
CREATE INDEX "Run_projectId_status_idx" ON "Run"("projectId", "status");

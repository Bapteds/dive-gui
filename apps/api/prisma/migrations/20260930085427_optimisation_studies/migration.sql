-- CreateTable
CREATE TABLE "Study" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "baseSource" TEXT NOT NULL,
    "baseLabel" TEXT NOT NULL,
    "baseInput" TEXT NOT NULL,
    "paramSpace" TEXT NOT NULL,
    "bandPct" REAL NOT NULL DEFAULT 10,
    "objectives" TEXT NOT NULL DEFAULT '[{"id":"headLoss","sense":"min"},{"id":"vortex","sense":"min"}]',
    "weights" TEXT NOT NULL DEFAULT '{"headLoss":0.5,"vortex":0.5}',
    "mode" TEXT NOT NULL DEFAULT 'weighted',
    "sampler" TEXT NOT NULL DEFAULT 'tpe',
    "seed" INTEGER,
    "vortexMetric" TEXT NOT NULL DEFAULT 'maskedQVolume',
    "maxEvaluations" INTEGER NOT NULL DEFAULT 30,
    "maxDurationHours" REAL,
    "keepBest" INTEGER NOT NULL DEFAULT 3,
    "keepLast" INTEGER NOT NULL DEFAULT 2,
    "meshingSourceId" TEXT NOT NULL,
    "solverSetup" TEXT NOT NULL DEFAULT '{"cores":1}',
    "criteria" TEXT,
    "normalisation" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "reason" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Study_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Study_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Evaluation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "studyId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "designParams" TEXT NOT NULL,
    "chamberHash" TEXT,
    "meshingSessionId" TEXT,
    "meshingSessionName" TEXT,
    "sessionDeleted" BOOLEAN NOT NULL DEFAULT false,
    "projectId" TEXT,
    "runId" TEXT,
    "dp0" REAL,
    "headLoss" REAL,
    "maskedQVolume" REAL,
    "omegaRms" REAL,
    "objective" REAL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stage" TEXT,
    "refusalReason" TEXT,
    "runStatus" TEXT,
    "budgetHit" BOOLEAN NOT NULL DEFAULT false,
    "warnings" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Evaluation_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Study_ownerId_idx" ON "Study"("ownerId");

-- CreateIndex
CREATE INDEX "Study_projectId_idx" ON "Study"("projectId");

-- CreateIndex
CREATE INDEX "Study_status_idx" ON "Study"("status");

-- CreateIndex
CREATE INDEX "Evaluation_studyId_status_idx" ON "Evaluation"("studyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Evaluation_studyId_index_key" ON "Evaluation"("studyId", "index");

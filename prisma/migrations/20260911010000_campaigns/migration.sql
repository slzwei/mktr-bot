-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('draft', 'running', 'paused', 'stopped', 'completed');

-- CreateEnum
CREATE TYPE "CampaignContactStatus" AS ENUM ('pending', 'dialing', 'completed', 'skipped');

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "campaignId" TEXT,
ADD COLUMN     "contactId" TEXT;

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "flowVersion" INTEGER NOT NULL,
    "callerId" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'draft',
    "callingHours" JSONB NOT NULL,
    "maxAttempts" INTEGER NOT NULL,
    "retryDelaySeconds" INTEGER NOT NULL,
    "dialIntervalMs" INTEGER NOT NULL,
    "lastDialAt" TIMESTAMP(3),
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignContact" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "status" "CampaignContactStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "lastCallId" TEXT,
    "outcome" TEXT,
    "skipReason" TEXT,
    "snapshot" JSONB NOT NULL,

    CONSTRAINT "CampaignContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Contact_phone_key" ON "Contact"("phone");

-- CreateIndex
CREATE INDEX "Campaign_status_createdAt_idx" ON "Campaign"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CampaignContact_campaignId_status_nextAttemptAt_idx" ON "CampaignContact"("campaignId", "status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignContact_campaignId_contactId_key" ON "CampaignContact"("campaignId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignContact_campaignId_ordinal_key" ON "CampaignContact"("campaignId", "ordinal");

-- CreateIndex
CREATE INDEX "Call_campaignId_contactId_idx" ON "Call"("campaignId", "contactId");

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_flowId_flowVersion_fkey" FOREIGN KEY ("flowId", "flowVersion") REFERENCES "FlowVersion"("flowId", "version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignContact" ADD CONSTRAINT "CampaignContact_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignContact" ADD CONSTRAINT "CampaignContact_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


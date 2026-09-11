-- CreateEnum
CREATE TYPE "OutcomeDeliveryStatus" AS ENUM ('pending', 'delivered', 'failed');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "outcomeWebhookEnabledAt" TIMESTAMP(3),
ADD COLUMN     "outcomeWebhookUrl" TEXT;

-- CreateTable
CREATE TABLE "OutcomeDelivery" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" "OutcomeDeliveryStatus" NOT NULL DEFAULT 'pending',
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "OutcomeDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OutcomeDelivery_callId_key" ON "OutcomeDelivery"("callId");

-- CreateIndex
CREATE INDEX "OutcomeDelivery_status_nextAttemptAt_idx" ON "OutcomeDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OutcomeDelivery_campaignId_createdAt_idx" ON "OutcomeDelivery"("campaignId", "createdAt");

-- AddForeignKey
ALTER TABLE "OutcomeDelivery" ADD CONSTRAINT "OutcomeDelivery_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutcomeDelivery" ADD CONSTRAINT "OutcomeDelivery_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

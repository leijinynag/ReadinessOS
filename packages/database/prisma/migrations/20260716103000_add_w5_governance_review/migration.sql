-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'denied', 'expired', 'stale');

-- CreateEnum
CREATE TYPE "RemediationStatus" AS ENUM ('open', 'in_progress', 'resolved');

-- CreateTable
CREATE TABLE "approvals" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "action_type" TEXT NOT NULL,
    "participant_id" UUID NOT NULL,
    "requested_by_command_id" UUID NOT NULL,
    "requested_sequence" INTEGER NOT NULL,
    "parameters" JSONB NOT NULL DEFAULT '{}',
    "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "requested_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "resolved_by_id" UUID,
    "resolution_sequence" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decisions" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "approval_id" UUID,
    "sequence" INTEGER NOT NULL,
    "decision" TEXT NOT NULL,
    "actor_id" UUID,
    "actor_name" TEXT,
    "rationale" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluations" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "evaluator_key" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "summary" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidences" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "evaluation_id" UUID,
    "approval_id" UUID,
    "sequence" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remediation_items" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "evaluation_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "RemediationStatus" NOT NULL DEFAULT 'open',
    "owner_id" UUID,
    "due_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "remediation_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "approvals_run_id_status_expires_at_idx" ON "approvals"("run_id", "status", "expires_at");
CREATE INDEX "approvals_run_id_requested_sequence_idx" ON "approvals"("run_id", "requested_sequence");
CREATE UNIQUE INDEX "decisions_approval_id_key" ON "decisions"("approval_id");
CREATE UNIQUE INDEX "decisions_run_id_sequence_key" ON "decisions"("run_id", "sequence");
CREATE INDEX "decisions_run_id_created_at_idx" ON "decisions"("run_id", "created_at");
CREATE UNIQUE INDEX "evaluations_run_id_evaluator_key_sequence_key"
  ON "evaluations"("run_id", "evaluator_key", "sequence");
CREATE INDEX "evaluations_run_id_sequence_idx" ON "evaluations"("run_id", "sequence");
CREATE UNIQUE INDEX "evidences_evaluation_id_sequence_event_type_key"
  ON "evidences"("evaluation_id", "sequence", "event_type");
CREATE UNIQUE INDEX "evidences_approval_id_sequence_event_type_key"
  ON "evidences"("approval_id", "sequence", "event_type");
CREATE INDEX "evidences_run_id_sequence_idx" ON "evidences"("run_id", "sequence");
CREATE INDEX "evidences_approval_id_idx" ON "evidences"("approval_id");
CREATE INDEX "remediation_items_run_id_status_updated_at_idx"
  ON "remediation_items"("run_id", "status", "updated_at" DESC);

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "simulation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "simulation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_approval_id_fkey"
  FOREIGN KEY ("approval_id") REFERENCES "approvals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "simulation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "evidences" ADD CONSTRAINT "evidences_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "simulation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "evidences" ADD CONSTRAINT "evidences_evaluation_id_fkey"
  FOREIGN KEY ("evaluation_id") REFERENCES "evaluations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "evidences" ADD CONSTRAINT "evidences_approval_id_fkey"
  FOREIGN KEY ("approval_id") REFERENCES "approvals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "remediation_items" ADD CONSTRAINT "remediation_items_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "simulation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "remediation_items" ADD CONSTRAINT "remediation_items_evaluation_id_fkey"
  FOREIGN KEY ("evaluation_id") REFERENCES "evaluations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 独立的 Agent 审计层不参与 run_events 的 sequence 与重放。
CREATE TYPE "AgentRecommendationStatus" AS ENUM ('pending', 'adopted', 'modified', 'rejected', 'deferred', 'superseded', 'expired');
CREATE TYPE "AgentDispatchStatus" AS ENUM ('pending', 'running', 'waiting_for_input', 'completed', 'failed');
CREATE TYPE "AgentDecisionType" AS ENUM ('adopt', 'modify', 'reject', 'defer');

ALTER TABLE "simulation_runs" ADD COLUMN "agent_activity_sequence" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "decisions" ALTER COLUMN "sequence" DROP NOT NULL;
ALTER TABLE "decisions" DROP CONSTRAINT IF EXISTS "decisions_run_id_sequence_key";
ALTER TABLE "decisions" ADD COLUMN "recommendation_id" UUID;
ALTER TABLE "decisions" ADD COLUMN "agent_decision_type" "AgentDecisionType";
ALTER TABLE "decisions" ADD COLUMN "modified_action_type" TEXT;
ALTER TABLE "decisions" ADD COLUMN "modified_parameters" JSONB;
ALTER TABLE "decisions" ADD COLUMN "kernel_command_id" UUID;
ALTER TABLE "decisions" ADD COLUMN "execution_sequence" INTEGER;
CREATE INDEX "decisions_recommendation_id_idx" ON "decisions"("recommendation_id");
CREATE INDEX "decisions_run_id_sequence_idx" ON "decisions"("run_id", "sequence");

CREATE TABLE "agent_recommendations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "advisor_participant_id" UUID NOT NULL,
  "target_participant_id" UUID NOT NULL,
  "action_type" TEXT NOT NULL,
  "parameters" JSONB NOT NULL DEFAULT '{}',
  "rationale" TEXT NOT NULL,
  "evidence_refs" JSONB NOT NULL DEFAULT '[]',
  "confidence" DOUBLE PRECISION NOT NULL,
  "trigger_event_types" JSONB NOT NULL DEFAULT '[]',
  "trigger_sequences" JSONB NOT NULL DEFAULT '[]',
  "observation_hash" TEXT NOT NULL,
  "base_run_version" INTEGER NOT NULL,
  "base_virtual_time" INTEGER NOT NULL,
  "expires_at_virtual_time" INTEGER NOT NULL,
  "eve_session_id" TEXT,
  "eve_trace_identity" TEXT,
  "status" "AgentRecommendationStatus" NOT NULL DEFAULT 'pending',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_recommendations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "agent_recommendations_run_id_status_created_at_idx" ON "agent_recommendations"("run_id", "status", "created_at" DESC);
CREATE INDEX "agent_recommendations_advisor_participant_id_status_idx" ON "agent_recommendations"("advisor_participant_id", "status");

CREATE TABLE "agent_dispatches" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "advisor_participant_id" UUID NOT NULL,
  "status" "AgentDispatchStatus" NOT NULL DEFAULT 'pending',
  "active_key" TEXT,
  "request_kind" TEXT NOT NULL DEFAULT 'automatic',
  "trigger_event_types" JSONB NOT NULL DEFAULT '[]',
  "trigger_sequences" JSONB NOT NULL DEFAULT '[]',
  "base_run_version" INTEGER NOT NULL,
  "observation_hash" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_dispatches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "agent_dispatches_active_key_key" ON "agent_dispatches"("active_key");
CREATE INDEX "agent_dispatches_run_id_status_next_attempt_at_idx" ON "agent_dispatches"("run_id", "status", "next_attempt_at");
CREATE INDEX "agent_dispatches_advisor_participant_id_status_idx" ON "agent_dispatches"("advisor_participant_id", "status");

CREATE TABLE "agent_questions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "run_id" UUID NOT NULL,
  "dispatch_id" UUID NOT NULL,
  "recommendation_id" UUID,
  "request_id" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "options" JSONB NOT NULL DEFAULT '[]',
  "allow_freeform" BOOLEAN NOT NULL DEFAULT false,
  "answer" JSONB,
  "answered_by_id" UUID,
  "answered_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_questions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "agent_questions_request_id_key" ON "agent_questions"("request_id");
CREATE INDEX "agent_questions_run_id_answered_at_idx" ON "agent_questions"("run_id", "answered_at");

CREATE TABLE "agent_activities" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "run_id" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "dispatch_id" UUID,
  "recommendation_id" UUID,
  "data" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_activities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "agent_activities_run_id_sequence_key" ON "agent_activities"("run_id", "sequence");
CREATE INDEX "agent_activities_run_id_created_at_idx" ON "agent_activities"("run_id", "created_at");

ALTER TABLE "decisions" ADD CONSTRAINT "decisions_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "agent_recommendations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "agent_recommendations" ADD CONSTRAINT "agent_recommendations_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "simulation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_recommendations" ADD CONSTRAINT "agent_recommendations_advisor_participant_id_fkey" FOREIGN KEY ("advisor_participant_id") REFERENCES "run_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_recommendations" ADD CONSTRAINT "agent_recommendations_target_participant_id_fkey" FOREIGN KEY ("target_participant_id") REFERENCES "run_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_dispatches" ADD CONSTRAINT "agent_dispatches_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "simulation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_dispatches" ADD CONSTRAINT "agent_dispatches_advisor_participant_id_fkey" FOREIGN KEY ("advisor_participant_id") REFERENCES "run_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "simulation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_dispatch_id_fkey" FOREIGN KEY ("dispatch_id") REFERENCES "agent_dispatches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "agent_recommendations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "agent_activities" ADD CONSTRAINT "agent_activities_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "simulation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_activities" ADD CONSTRAINT "agent_activities_dispatch_id_fkey" FOREIGN KEY ("dispatch_id") REFERENCES "agent_dispatches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "agent_activities" ADD CONSTRAINT "agent_activities_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "agent_recommendations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

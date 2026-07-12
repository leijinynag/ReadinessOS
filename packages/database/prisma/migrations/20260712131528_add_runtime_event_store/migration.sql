-- CreateEnum
CREATE TYPE "EventSource" AS ENUM ('human', 'agent', 'system', 'integration');

-- CreateEnum
CREATE TYPE "AgentSessionStatus" AS ENUM ('active', 'waiting_for_input', 'completed', 'failed', 'terminated');

-- AlterTable
ALTER TABLE "simulation_runs" ADD COLUMN     "next_tick_index" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "scheduler_generation" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tick_interval_seconds" INTEGER NOT NULL DEFAULT 15;

-- CreateTable
CREATE TABLE "run_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "source" "EventSource" NOT NULL,
    "participant_id" UUID,
    "simulated_at" TIMESTAMP(3) NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL,
    "causation_id" UUID,
    "correlation_id" UUID,
    "idempotency_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "run_events_pkey" PRIMARY KEY ("id")
);

-- Prisma Schema 暂不能声明此类跨数据库不通用的 Check Constraint。
-- 事件序列从 1 起严格递增，0 或负数会破坏快照和 Cursor 语义。
ALTER TABLE "run_events"
ADD CONSTRAINT "run_events_sequence_positive" CHECK ("sequence" > 0);

-- CreateTable
CREATE TABLE "state_snapshots" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "state" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "state_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkpoints" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_session_links" (
    "id" UUID NOT NULL,
    "run_participant_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "agent_key" TEXT NOT NULL,
    "session_id" TEXT,
    "continuation_token" TEXT,
    "stream_index" INTEGER NOT NULL DEFAULT 0,
    "status" "AgentSessionStatus" NOT NULL DEFAULT 'active',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_session_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_traces" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "run_participant_id" UUID,
    "session_id" TEXT,
    "stream_index" INTEGER,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_traces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_overview_projection" (
    "run_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "status" "RunStatus" NOT NULL,
    "latest_sequence" INTEGER NOT NULL,
    "virtual_time" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "run_overview_projection_pkey" PRIMARY KEY ("run_id")
);

-- CreateTable
CREATE TABLE "participant_projection" (
    "run_participant_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "participant_projection_pkey" PRIMARY KEY ("run_participant_id")
);

-- CreateTable
CREATE TABLE "timeline_projection" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "event_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "source" "EventSource" NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timeline_projection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_messages" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "run_id" UUID,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_ledger" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "run_id" UUID,
    "run_participant_id" UUID,
    "category" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "run_events_organization_id_recorded_at_idx" ON "run_events"("organization_id", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX "run_events_run_id_type_sequence_idx" ON "run_events"("run_id", "type", "sequence");

-- CreateIndex
CREATE INDEX "run_events_run_id_participant_id_sequence_idx" ON "run_events"("run_id", "participant_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "run_events_run_id_sequence_key" ON "run_events"("run_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "run_events_run_id_idempotency_key_key" ON "run_events"("run_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "state_snapshots_run_id_sequence_idx" ON "state_snapshots"("run_id", "sequence" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "state_snapshots_run_id_sequence_key" ON "state_snapshots"("run_id", "sequence");

-- CreateIndex
CREATE INDEX "checkpoints_run_id_created_at_idx" ON "checkpoints"("run_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "checkpoints_run_id_sequence_key" ON "checkpoints"("run_id", "sequence");

-- CreateIndex
CREATE INDEX "agent_session_links_session_id_idx" ON "agent_session_links"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_session_links_run_participant_id_provider_agent_key_key" ON "agent_session_links"("run_participant_id", "provider", "agent_key");

-- CreateIndex
CREATE INDEX "agent_traces_run_id_recorded_at_idx" ON "agent_traces"("run_id", "recorded_at");

-- CreateIndex
CREATE INDEX "agent_traces_session_id_stream_index_idx" ON "agent_traces"("session_id", "stream_index");

-- CreateIndex
CREATE INDEX "run_overview_projection_organization_id_status_updated_at_idx" ON "run_overview_projection"("organization_id", "status", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "participant_projection_run_id_status_idx" ON "participant_projection"("run_id", "status");

-- CreateIndex
CREATE INDEX "timeline_projection_run_id_created_at_idx" ON "timeline_projection"("run_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "timeline_projection_run_id_sequence_key" ON "timeline_projection"("run_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "timeline_projection_event_id_key" ON "timeline_projection"("event_id");

-- CreateIndex
CREATE INDEX "outbox_messages_published_at_next_attempt_at_idx" ON "outbox_messages"("published_at", "next_attempt_at");

-- CreateIndex
CREATE INDEX "outbox_messages_run_id_created_at_idx" ON "outbox_messages"("run_id", "created_at");

-- CreateIndex
CREATE INDEX "usage_ledger_organization_id_category_created_at_idx" ON "usage_ledger"("organization_id", "category", "created_at");

-- CreateIndex
CREATE INDEX "usage_ledger_run_id_created_at_idx" ON "usage_ledger"("run_id", "created_at");

-- AddForeignKey
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "simulation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "state_snapshots" ADD CONSTRAINT "state_snapshots_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "simulation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "simulation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_session_links" ADD CONSTRAINT "agent_session_links_run_participant_id_fkey" FOREIGN KEY ("run_participant_id") REFERENCES "run_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_traces" ADD CONSTRAINT "agent_traces_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "simulation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_traces" ADD CONSTRAINT "agent_traces_run_participant_id_fkey" FOREIGN KEY ("run_participant_id") REFERENCES "run_participants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_overview_projection" ADD CONSTRAINT "run_overview_projection_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "simulation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "participant_projection" ADD CONSTRAINT "participant_projection_run_participant_id_fkey" FOREIGN KEY ("run_participant_id") REFERENCES "run_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timeline_projection" ADD CONSTRAINT "timeline_projection_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "simulation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "simulation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "simulation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_run_participant_id_fkey" FOREIGN KEY ("run_participant_id") REFERENCES "run_participants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

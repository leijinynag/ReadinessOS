ALTER TABLE "agent_traces" ADD COLUMN "trace_identity" TEXT;

UPDATE "agent_traces"
SET "trace_identity" = "run_id"::text || ':' || COALESCE("run_participant_id"::text, 'none') || ':' ||
  COALESCE("session_id", 'legacy:' || "id"::text) || ':' ||
  COALESCE("stream_index"::text, "id"::text);

ALTER TABLE "agent_traces" ALTER COLUMN "trace_identity" SET NOT NULL;
CREATE UNIQUE INDEX "agent_traces_trace_identity_key" ON "agent_traces"("trace_identity");
DROP INDEX "agent_traces_run_id_recorded_at_idx";
CREATE INDEX "agent_traces_run_id_recorded_at_id_idx"
  ON "agent_traces"("run_id", "recorded_at", "id");

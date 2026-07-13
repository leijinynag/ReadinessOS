ALTER TABLE "agent_traces" ADD COLUMN "trace_identity" TEXT;

WITH "legacy_identities" AS (
  SELECT
    "id",
    "recorded_at",
    "run_id"::text || ':' || COALESCE("run_participant_id"::text, 'none') || ':' ||
      COALESCE("session_id", 'legacy:' || "id"::text) || ':' ||
      COALESCE("stream_index"::text, "id"::text) AS "legacy_identity"
  FROM "agent_traces"
),
"ranked_legacy_identities" AS (
  SELECT
    "id",
    "legacy_identity",
    ROW_NUMBER() OVER (
      PARTITION BY "legacy_identity"
      ORDER BY "recorded_at", "id"
    ) AS "duplicate_rank"
  FROM "legacy_identities"
)
UPDATE "agent_traces" AS "trace"
SET "trace_identity" = CASE
  WHEN "ranked"."duplicate_rank" = 1 THEN "ranked"."legacy_identity"
  ELSE "ranked"."legacy_identity" || ':legacy:' || "trace"."id"::text
END
FROM "ranked_legacy_identities" AS "ranked"
WHERE "trace"."id" = "ranked"."id";

ALTER TABLE "agent_traces" ALTER COLUMN "trace_identity" SET NOT NULL;
CREATE UNIQUE INDEX "agent_traces_trace_identity_key" ON "agent_traces"("trace_identity");
DROP INDEX "agent_traces_run_id_recorded_at_idx";
CREATE INDEX "agent_traces_run_id_recorded_at_id_idx"
  ON "agent_traces"("run_id", "recorded_at", "id");

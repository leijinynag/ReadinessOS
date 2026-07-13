CREATE TABLE "run_schedule_leases" (
    "run_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "holder_id" UUID NOT NULL,
    "heartbeat_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "run_schedule_leases_pkey" PRIMARY KEY ("run_id"),
    CONSTRAINT "run_schedule_leases_generation_check" CHECK ("generation" >= 0),
    CONSTRAINT "run_schedule_leases_expiry_check" CHECK ("expires_at" > "heartbeat_at")
);

CREATE INDEX "run_schedule_leases_organization_id_expires_at_idx"
    ON "run_schedule_leases"("organization_id", "expires_at");
CREATE INDEX "run_schedule_leases_expires_at_idx"
    ON "run_schedule_leases"("expires_at");

ALTER TABLE "run_schedule_leases"
    ADD CONSTRAINT "run_schedule_leases_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "simulation_runs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

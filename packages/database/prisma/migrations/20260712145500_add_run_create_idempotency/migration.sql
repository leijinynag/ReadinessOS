-- AlterTable
ALTER TABLE "simulation_runs" ADD COLUMN "create_idempotency_key" TEXT;

-- 同一用户在同一组织下复用创建请求时返回原 Run；PostgreSQL 的 UNIQUE 允许
-- 多个 NULL，因此未提供历史 key 的记录不会互相冲突。
CREATE UNIQUE INDEX "simulation_runs_organization_id_created_by_create_idempotency_key_key"
ON "simulation_runs"("organization_id", "created_by", "create_idempotency_key");

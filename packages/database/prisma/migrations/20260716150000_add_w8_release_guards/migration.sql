-- 访客会话只保存不可逆的 token HMAC，访客身份和运行数据与共享演示租户隔离。
ALTER TABLE "users"
  ADD COLUMN "is_guest" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "guest_expires_at" TIMESTAMP(3),
  ADD COLUMN "guest_token_hash" TEXT;

CREATE INDEX "users_is_guest_guest_expires_at_idx"
  ON "users"("is_guest", "guest_expires_at");

-- 临时访客 Run 到期后由 API、lease 和 tick 三层共同阻止继续推进。
ALTER TABLE "simulation_runs"
  ADD COLUMN "expires_at" TIMESTAMP(3);

CREATE INDEX "simulation_runs_expires_at_idx"
  ON "simulation_runs"("expires_at");

-- 固定窗口限流只持久化 HMAC 后的来源键，避免保存明文 IP 或浏览器标识。
CREATE TABLE "request_rate_limits" (
  "id" UUID NOT NULL,
  "scope" TEXT NOT NULL,
  "key_hash" TEXT NOT NULL,
  "window_starts_at" TIMESTAMP(3) NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "request_rate_limits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "request_rate_limits_scope_key_hash_window_starts_at_key"
  ON "request_rate_limits"("scope", "key_hash", "window_starts_at");
CREATE INDEX "request_rate_limits_scope_window_starts_at_idx"
  ON "request_rate_limits"("scope", "window_starts_at");

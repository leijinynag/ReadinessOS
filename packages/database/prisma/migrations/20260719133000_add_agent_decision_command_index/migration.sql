-- 高风险 Agent 建议在审批完成时按原 Kernel command 回写最终 sequence。
CREATE INDEX "decisions_run_id_kernel_command_id_idx"
ON "decisions"("run_id", "kernel_command_id");

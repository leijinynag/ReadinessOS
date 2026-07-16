# ReadinessOS 运行与事故 Runbook

## 日常检查

- 检查运行失败率、Tick 延迟、Outbox 待投递数量、Agent Turn/Token/工具成本和数据库错误。
- 访客创建限流与 Agent 预算均写入数据库；不要依赖浏览器状态或单实例内存计数。
- 应用错误日志必须经 `sanitizeForLog` 脱敏。不得记录 Authorization、Cookie、密码、Token、
  API Key、凭据、邮箱或访客 token。

## Run 无法推进

1. 查询 Run 是否已经 `completed`、`paused` 或到期。
2. 查询 `run_schedule_leases`，确认 generation、holder 和租约过期时间。
3. 调用受保护的 reconcile Cron；它只会为缺失或过期租约的运行启动 Workflow。
4. 检查 Outbox 是否积压；应用请求和 reconcile 任务都会尝试投递。
5. 如果需要人工干预，先保留 RunEvent、Snapshot、AgentTrace 与 UsageLedger，再修复或停止 Run。

## Agent 成本或失败

1. 查询 `usage_ledger` 汇总指定 Run 的 Turn、Token、工具步骤、子 Agent 步骤和 micro USD。
2. 达到预算后，新的 Agent Turn 应返回 `BUDGET_EXCEEDED`；不要通过删除账本记录绕过限制。
3. 检查 Eve Trace 与 `agent_traces` 的失败事件，再确认 Sandbox 仍是 deny-all。
4. 不要将 Eve continuation token 返回给客户端或写入日志。

## Guest Demo

1. 每次创建都会生成独立组织、访客 User 和复制的已发布演示场景版本。
2. IP 与 User-Agent 仅以 HMAC 用于固定窗口限流，不保存明文来源。
3. Guest Run 到期后 API、调度租约和 Tick 都应停止推进；访客身份到期后也无法重新认证。
4. 访客若报告无法操作，请先区分产品限制和过期：分支、Director Inject 与 Agent Turn 是设计上禁用。

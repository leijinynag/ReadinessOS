# MVP 发布就绪度

更新日期：2026-07-16。

## 本地已实现

- Guest Demo 以独立组织隔离，访客 token 仅保存 HMAC；创建入口有数据库固定窗口限流。
- Guest Run 有时效；写入 API、调度租约和 Tick 都会阻止过期 Run 继续推进。
- Agent 用量持久化到 `UsageLedger`，覆盖 Turn、Token、缓存 Token、工具步骤、子 Agent 步骤、费用和延迟。
- Agent Turn 在执行前检查 Turn、Token、工具和费用预算。
- Eve Sandbox 对 Vercel、Docker 和 Microsandbox 使用 deny-all 网络策略。
- OTel 覆盖 Studio Command、Agent Observation/Turn、Workflow Tick/对账以及 Outbox drain。
- Review Timeline 使用虚拟列表；全局样式支持 `prefers-reduced-motion`。
- 发布、回滚、运行排障和 Guest Demo 操作流程已在 Runbook 中记录。

## 仍需真实部署验证

- Production Secret Store、Sentry、监控 Dashboard 和告警规则。
- Preview/Production 环境、独立数据库、迁移、PITR 与恢复演练。
- Playwright 桌面/移动端视觉检查，10 events/s 交互性能和真实生产冒烟测试。
- 5 分钟面对面演示排练。

这些项目在 `tasks.md` 中保持未勾选，不能以本地代码存在替代云环境验证。

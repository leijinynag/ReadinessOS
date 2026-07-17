# ReadinessOS 发布与回滚 Runbook

## 发布前检查

1. 在干净的 `main` 分支执行 `pnpm db:generate`、`pnpm typecheck`、`pnpm test`、`pnpm lint`、
   `pnpm build`、`pnpm markdown:lint` 和 `pnpm db:test:migrations`。
2. 在部署平台的 Preview 环境设置独立的 `DATABASE_URL`、`DIRECT_URL`、`AUTH_SECRET`、
   `CRON_SECRET`、`DEEPSEEK_API_KEY`、`EVE_BASE_URL` 和 `EVE_API_KEY`。不要把真实密钥提交到仓库。
   `DEEPSEEK_API_KEY` 用于直连 DeepSeek 的 `deepseek-v4-pro`；`EVE_BASE_URL` 只用于连接 Eve Runtime。
3. 设置 Agent 预算变量；生产默认上限是 20 个 Turn、40,000 Token、100 个工具步骤和 2 美元。
   如果不允许子 Agent，保持 `AGENT_MAX_SUBAGENT_STEPS_PER_RUN=0`。
4. 确认 Eve 的 Sandbox 使用 `apps/web/agent/sandbox.ts`，Vercel、Docker 和 Microsandbox
   都是 `deny-all` 网络策略。`just-bash` 仅允许本地开发回退。
5. 使用 `DIRECT_URL` 在目标数据库执行 `pnpm db:deploy`，然后执行 `pnpm db:seed`。

## Preview 验证

1. 以常规演示账号登录，创建并开始 SaaS Incident Run。
2. 执行一条人工 Action，确认 Timeline、评分和 Review 可读取。
3. 创建 Guest Demo，确认其只可从 Studio 创建带时效的 Run，不能创建分支、触发 Director
   Inject 或执行 Agent Turn。
4. 确认 `/api/cron/reconcile-runs` 只接受配置正确的 `CRON_SECRET`。
5. 检查 OTel Trace 是否出现 `readinessos.command.*`、`readinessos.agent.*`、
   `readinessos.workflow.*` 与 `readinessos.outbox.drain`。

## Production 发布

1. 为 Production 复用已验证的环境变量键名，但使用独立数据库和独立密钥。
2. 先执行数据库迁移，再部署应用版本，避免新代码读取不存在的列。
3. 发布后在生产环境重复 Preview 验证中的常规 Run 和 Guest Demo 检查。
4. 记录部署版本、迁移目录和验证时间到发布工单。

## 回滚

1. 先将应用回滚到上一个已验证的部署版本，并暂停继续发布。
2. 不对已经执行的 Prisma Migration 做 `migrate reset` 或自动降级。数据迁移需要单独的、
   经审查的 forward-fix 或恢复步骤。
3. 如果新版本持续写入错误数据，禁用相关入口或暂停 Run，保留数据库与 Outbox 证据。
4. 依据数据库提供商的 PITR 恢复到确认的时间点后，在隔离环境验证数据和核心查询。
5. 重新部署已验证版本并完成常规 Run 冒烟测试，再恢复对外访问。

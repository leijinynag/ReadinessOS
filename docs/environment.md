# ReadinessOS 环境登记

> 更新日期：2026-07-16

| 环境       | 数据库                                                     | 应用                   | Agent / 模型                               | 账号与负责人 | 当前状态         |
| ---------- | ---------------------------------------------------------- | ---------------------- | ------------------------------------------ | ------------ | ---------------- |
| Local      | Docker Compose PostgreSQL 18，`localhost:5433/readinessos` | Next.js 本地开发服务器 | Deterministic Adapter；Eve + DeepSeek 可选 | 本机开发环境 | 可由项目脚本创建 |
| Preview    | Vercel Preview 独立数据库或 Schema                         | Vercel Preview         | Eve Runtime、DeepSeek 模型凭据             | 尚未配置     | 待真实环境验证   |
| Production | 托管 PostgreSQL，启用 PITR 和连接池                        | Vercel Production      | Eve Runtime、DeepSeek 凭据和 Sandbox 策略  | 尚未配置     | 待真实环境验证   |

本地开发不使用生产密钥。`DATABASE_URL`、`AUTH_SECRET`、`CRON_SECRET` 和任何模型凭据仅保存在被 Git 忽略的 `.env.local` 或部署平台 Secret Store 中。

Eve Agent 直接调用 DeepSeek 的 OpenAI 兼容 API，主 Agent 与 stakeholder 子 Agent 都使用
`deepseek-v4-pro`。在 `.env.local` 填写 `DEEPSEEK_API_KEY`；`EVE_BASE_URL` 是 Web 服务访问 Eve
Runtime 的地址，不是模型 API 地址，不能填写为 DeepSeek API URL。

生产部署中，`DATABASE_URL` 指向运行时连接池，`DIRECT_URL` 仅供 Prisma Migration 使用并直连数据库；两者均不得暴露给客户端。

`CRON_SECRET` 至少 16 字符，用于 Vercel Cron 调用 `/api/cron/reconcile-runs`。未配置时维护接口始终返回 `401`，不会回退为公开访问。

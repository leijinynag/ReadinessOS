# ReadinessOS 环境登记

> 更新日期：2026-07-11

| 环境       | 数据库                                                     | 应用                   | Agent / 模型                          | 账号与负责人 | 当前状态         |
| ---------- | ---------------------------------------------------------- | ---------------------- | ------------------------------------- | ------------ | ---------------- |
| Local      | Docker Compose PostgreSQL 18，`localhost:5433/readinessos` | Next.js 本地开发服务器 | Deterministic Agent Adapter；Eve 可选 | 本机开发环境 | 可由项目脚本创建 |
| Preview    | Vercel Preview 独立数据库或 Schema                         | Vercel Preview         | Eve Runtime 和模型凭据                | 尚未配置     | W8 前配置        |
| Production | 托管 PostgreSQL，启用 PITR 和连接池                        | Vercel Production      | Eve Runtime、模型凭据和 Sandbox 策略  | 尚未配置     | W8 前配置        |

本地开发不使用生产密钥。`DATABASE_URL`、`AUTH_SECRET`、`CRON_SECRET` 和任何模型凭据仅保存在被 Git 忽略的 `.env.local` 或部署平台 Secret Store 中。

生产部署中，`DATABASE_URL` 指向运行时连接池，`DIRECT_URL` 仅供 Prisma Migration 使用并直连数据库；两者均不得暴露给客户端。

`CRON_SECRET` 至少 16 字符，用于 Vercel Cron 调用 `/api/cron/reconcile-runs`。未配置时维护接口始终返回 `401`，不会回退为公开访问。

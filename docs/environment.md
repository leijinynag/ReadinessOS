# ReadinessOS 环境登记

> 更新日期：2026-07-17

| 环境       | 数据库                                                     | 应用                   | Agent / 模型                               | 账号与负责人 | 当前状态         |
| ---------- | ---------------------------------------------------------- | ---------------------- | ------------------------------------------ | ------------ | ---------------- |
| Local      | Docker Compose PostgreSQL 18，`localhost:5433/readinessos` | Next.js 本地开发服务器 | Deterministic Adapter；Eve + DeepSeek 可选 | 本机开发环境 | 可由项目脚本创建 |
| Preview    | Vercel Preview 独立数据库或 Schema                         | Vercel Preview         | Eve Runtime、DeepSeek 模型凭据             | 尚未配置     | 待真实环境验证   |
| Production | 托管 PostgreSQL，启用 PITR 和连接池                        | Vercel Production      | Eve Runtime、DeepSeek 凭据和 Sandbox 策略  | 尚未配置     | 待真实环境验证   |

本地开发不使用生产密钥。`DATABASE_URL`、`AUTH_SECRET`、`CRON_SECRET` 和任何模型凭据仅保存在被 Git 忽略的 `.env.local` 或部署平台 Secret Store 中。

本机必须使用 Node.js `24.15.0`（执行 `nvm use`）。Node.js 25 不在项目支持范围内，Eve 的本地
Runner 可能无法在该版本下就绪。

Eve Agent 直接调用 DeepSeek 的 OpenAI 兼容 API，主 Agent 与 stakeholder 子 Agent 都使用
`deepseek-v4-pro`。在 `.env.local` 填写 `DEEPSEEK_API_KEY`。DeepSeek API 地址已经固定为
`https://api.deepseek.com/v1`，不需要另行配置。

本地开发和 Web App 与 Eve 一体化部署时，不配置 `EVE_RUNTIME_URL`。Next.js 会将同源
`/eve/v1/*` 请求代理到 Eve 自动启动的动态 Runtime 端口。只有 Web App 与 Eve Runtime 分离部署时，
才设置 `EVE_RUNTIME_URL` 为 Eve 服务的绝对地址，例如 `https://agent.example.com`。不要在业务
配置中设置 `EVE_BASE_URL`，该变量由 Eve 框架自身保留使用。

`EVE_RUNTIME_URL`、`OTEL_EXPORTER_OTLP_ENDPOINT` 和 `SENTRY_DSN` 可以写成 `""`，应用会将其视为
未配置。不要把 `DEEPSEEK_API_KEY`、`AUTH_SECRET` 或数据库 URL 提交到仓库。

生产部署中，`DATABASE_URL` 指向运行时连接池，`DIRECT_URL` 仅供 Prisma Migration 使用并直连数据库；两者均不得暴露给客户端。

`CRON_SECRET` 至少 16 字符，用于 Vercel Cron 调用 `/api/cron/reconcile-runs`。未配置时维护接口始终返回 `401`，不会回退为公开访问。

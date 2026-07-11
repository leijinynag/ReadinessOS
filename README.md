# ReadinessOS

ReadinessOS 是一个面向组织业务韧性和决策训练的模拟平台。用户可以运行可重复的业务事故演练，在动态信息边界下与 Agent 协作决策，并通过事件回放、证据评分和分支重跑验证处置能力。

## 本地启动

前置条件：

- Node.js `24.15.0`，项目根目录提供 `.nvmrc`；
- pnpm `11.7.0`；
- Docker Desktop。

```bash
nvm use
pnpm install
cp .env.example .env.local
pnpm dev:local
```

打开 `http://localhost:3000/login`。本地演示账号和密码由 `.env.local` 的
`AUTH_DEMO_EMAIL`、`AUTH_DEMO_PASSWORD` 定义。

## 常用命令

```bash
pnpm db:up
pnpm db:migrate --name <migration-name>
pnpm db:seed
pnpm dev:local
pnpm test
pnpm verify
```

默认 Compose 数据库监听 `localhost:5433`，避免占用本机已有的 PostgreSQL 服务。

## 文档

- [MVP 工程计划](./plan.md)
- [实施任务清单](./tasks.md)
- [环境登记](./docs/environment.md)
- [事件目录](./docs/event-catalog.md)

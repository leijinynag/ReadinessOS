<!-- markdownlint-disable MD013 -->

# ReadinessOS MVP 工程实施计划

> 状态：Draft v1  
> 编写日期：2026-07-11  
> 依据：[ReadinessOS MVP 技术方案](https://bytedance.sg.larkoffice.com/docx/J7jkdlXGIo79AvxUmzxl3PhLgkf)  
> 长期架构参考：[ReadinessOS 完整产品技术方案](https://bytedance.sg.larkoffice.com/docx/BQTedLYhroUYfKxhtw5lAJWBgwh)

## 1. 文档目的

本文把 MVP 技术方案转化为可以直接执行的产品与工程计划，统一以下内容：

- MVP 要解决的用户问题、范围与非目标；
- 核心领域模型、系统边界和必须稳定的协议；
- 技术选型、仓库结构、数据库和 API 设计；
- Studio Lite、Live、Review 的实现细节；
- Eve、Simulation Kernel、事件流和前端状态的协作方式；
- 8 周研发阶段、每阶段交付物和退出标准；
- 测试、安全、可观测性、部署和最终验收要求。

本文不是逐日排期。具体任务进入开发时，应从本文里程碑继续拆为 Issue，并保持每个 Issue 可独立验收。

---

## 2. 产品定义

### 2.1 一句话定位

ReadinessOS 是一个面向组织业务韧性和决策训练的模拟平台。用户可以运行可重复的业务事故演练，在动态信息边界下与 Agent 协作决策，并通过事件回放、证据评分和分支重跑验证处置能力。

### 2.2 MVP 首发场景

主场景是 **SaaS 支付服务故障演练**。一次运行控制在 10-15 分钟，包含：

1. 支付失败率上升；
2. 客户影响和收入风险扩大；
3. 工程、客服、管理层等动态参与方产生信号和压力；
4. 用户执行调查、升级、回滚、公告和恢复验证；
5. 高风险动作需要人工审批；
6. 系统在结束后输出带事件证据的复盘评分；
7. 用户可从检查点创建分支，比较另一种决策的后果。

同时实现一个 **关键客户升级薄场景**，只覆盖最短闭环，用于证明平台扩展依赖 Scenario Pack，而不是复制内核或页面。

### 2.3 目标用户

- 工程负责人、SRE、安全负责人；
- 需要训练或验证应急处置能力的 SaaS 团队；
- 通过公开演示体验产品的访客；
- 用于项目展示和技术面试的评审者。

### 2.4 北极星用户闭环

```text
选择场景
  -> 配置参与方与难度
  -> 运行动态演练
  -> 提交决策与审批动作
  -> 完成或失败
  -> 查看评分与证据
  -> 创建整改项
  -> 从检查点分支重跑
  -> 对比改进结果
```

### 2.5 MVP 成功标准

| 维度   | 验收目标                                                   |
| ------ | ---------------------------------------------------------- |
| 可用性 | 用户可在线完成一场真实运行，不依赖静态 Mock 或预录结果     |
| 闭环   | 场景配置、运行、审批、复盘、整改、分支均有可用路径         |
| 恢复   | 刷新或断网 30 秒后可从最新 Cursor 恢复，无重复事件         |
| 证据   | 每个评分项至少关联一个有效 EvidenceRef                     |
| 扩展   | 第二个场景不修改 Simulation Kernel 和核心 Live/Review 页面 |
| 稳定性 | 主场景可连续自动运行 20 次，无非法状态或事件顺序错误       |
| 展示性 | 5 分钟内能够演示动态运行、Agent 行动、审批、回放和分支     |

---

## 3. 范围拆解

### 3.1 P0：MVP 必须交付

#### 身份与工作区

- 登录、退出、访客演示身份；
- Organization 和 Member 最小模型；
- 用户只能访问所属组织或本人临时运行；
- 只读分享链接带过期时间。

#### 场景与 Studio Lite

- 场景模板列表和详情；
- 调整难度、目标和随机种子；
- 启停参与方；
- 在 `human / agent / system` 控制器之间切换；
- 查看参与方能力、知识范围和只读事件图；
- 创建不可变的 ScenarioVersion 后启动运行。

#### Simulation Kernel

- 纯函数状态转换；
- 虚拟时间 start、pause、resume、advance；
- Trigger 条件和 Effect；
- Signal 可见性路由；
- Action Schema、权限、前置条件和审批策略；
- 检查点、终止条件、基础评估和分支；
- 相同初始状态、种子和事件序列得到相同结果。

#### Eve Agent 编排

- Director、Stakeholder、Observer、Evaluator 四类 Agent；
- Eve filesystem-first 目录；
- 结构化 `ProposedAction` 输出；
- 按 Participant 注入最小 Observation；
- Tool allowlist、预算、超时和审批；
- Eve Session 与 RunParticipant 的持久化映射；
- Eve 生命周期事件映射为内部运行事件或 Agent Trace。

#### Live 工作区

- 当前风险、业务指标、目标和虚拟时间；
- 动态参与方状态；
- 动态 Capability 模块；
- 时间线实时流；
- 用户动作提交；
- 暂停、继续和导演事件注入；
- 审批抽屉；
- 断线恢复和 Cursor 缺口补拉；
- 运行完成或失败状态。

#### Review 工作区

- 时间线回放和检查点定位；
- 决策、状态变化和结果的因果链；
- 六维评分和 Evidence 跳转；
- 整改项创建与状态修改；
- 从检查点创建 BranchRun；
- 父子运行结果和关键状态差异。

#### 平台能力

- PostgreSQL 权威存储；
- 事件、快照、投影和 Outbox；
- SSE/NDJSON 实时通道；
- Blob 存储报告和附件；
- 限流、Agent 预算和运行时长限制；
- 日志、错误监控、Trace 和产品指标；
- CI、数据库迁移、自动测试和 Vercel 部署。

### 3.2 P1：MVP 稳定后补充

- 场景创建向导；
- Review 报告导出；
- 运行标签、搜索和筛选；
- 预录观察模式；
- 更丰富的 Branch Diff；
- Storybook 全量组件文档；
- 场景级成本和性能报告。

### 3.3 明确不做

- 多人实时参与和 Yjs 协作编辑；
- 开放第三方 Scenario Pack 发布；
- Slack、PagerDuty、Linear 等真实系统写入；
- SSO、SCIM、区域化部署和高级合规；
- 通用知识库摄取；
- 通用 Agent IDE 或聊天产品；
- 任意模型生成 JSX；
- 微服务、Kafka 或独立 CQRS 框架；
- 移动端完整 Studio 编辑能力。

---

## 4. 不可破坏的设计原则

### 4.1 权威事实归属

1. PostgreSQL 中已提交的 DomainEvent、ScenarioVersion、Snapshot、审批和 Evidence 是产品事实。
2. Eve Session、Turn、Tool Call、Subagent 和 Sandbox 是 Agent 运行事实。
3. LLM 只能提出动作，不能直接修改 WorldState。
4. 前端投影和缓存不是权威事实。
5. 已发生事件不原地修改，纠错通过补偿事件完成。

### 4.2 确定性边界

由 Simulation Kernel 决定：

- 时间推进；
- 规则触发；
- 状态转换；
- 权限和前置条件；
- 确定性评分；
- 终止条件；
- 检查点和分支基线。

由 Agent 决定：

- 自然语言表达；
- 开放式策略建议；
- Stakeholder 对话；
- 有限的语义评估；
- 结构化 ProposedAction 提议。

### 4.3 MVP 演进原则

- 缩减容量和功能面，不替换核心协议；
- 新场景通过 Scenario Pack 增加；
- 新查询通过 Projection 增加；
- Eve 变化只影响 `agent-adapter`；
- 多人协作未来增加通道，不改变 DomainEvent Cursor；
- 企业能力未来增加策略层，不重写 Run 和 Participant。

---

## 5. 技术选型

### 5.1 运行时和工程基线

| 项目        | 选择                   | 决策                                             |
| ----------- | ---------------------- | ------------------------------------------------ |
| Node.js     | Node.js 24 LTS 兼容线  | Eve 当前要求 Node.js 24+                         |
| 包管理      | pnpm 11                | Workspace、严格依赖和磁盘复用                    |
| Monorepo    | Turborepo 2            | 包边界、任务缓存和 CI 过滤                       |
| 语言        | TypeScript 5.9，strict | 所有应用、包、迁移脚本共享类型基线               |
| 格式化/Lint | ESLint 9.39 + Prettier | 与 Next.js 16 当前兼容，首版不额外引入多套检查器 |
| Git         | Conventional Commits   | 按逻辑单元提交，在阶段检查点推送                 |

依赖采用精确版本并由 Renovate 或 Dependabot 创建升级 PR。Eve 仍处于 Beta，禁止自动合并 Eve 主版本或次版本升级。

### 5.2 Web 前端

| 领域           | 选择                   | 用途                                       |
| -------------- | ---------------------- | ------------------------------------------ |
| 框架           | Next.js 16 App Router  | 路由、RSC、Server Actions、Route Handlers  |
| UI             | React 19               | 并发渲染、Transition 和现代 Hook           |
| 样式           | Tailwind CSS 4         | Token 化样式和响应式布局                   |
| 无障碍组件     | Radix UI               | Dialog、Popover、Tabs、Tooltip 等基础行为  |
| 图标           | Lucide React           | 统一工具型图标                             |
| 状态机         | XState 5               | Run、Connection、Approval、Replay 生命周期 |
| 外部事件 Store | `useSyncExternalStore` | 高频事件的精确订阅                         |
| 虚拟列表       | TanStack Virtual       | Timeline、日志和长列表                     |
| 图可视化       | `@xyflow/react` 12     | Scenario Graph 和因果图                    |
| 自动布局       | ELK.js，放入 Worker    | 大图布局不阻塞主线程                       |
| Schema/校验    | Zod 4                  | API、事件、Pack 和 Agent 输出校验          |

不引入 Redux。服务端数据优先由 RSC 获取；客户端命令使用 Route Handler/Server Action；高频运行事件进入自研 RunEventStore。

### 5.3 后端和数据

| 领域     | 选择                                    | 用途                                       |
| -------- | --------------------------------------- | ------------------------------------------ |
| API      | Next.js Route Handlers + Server Actions | Command、Query 和页面表单                  |
| 数据库   | 托管 PostgreSQL                         | 权威领域数据                               |
| ORM      | Prisma ORM + Prisma Client              | Schema、类型安全 CRUD 和事务               |
| 迁移     | Prisma Migrate                          | 生成、审查和应用 SQL Migration             |
| 原生查询 | Prisma TypedSQL / `$queryRaw`           | Outbox 锁、复杂投影和 PostgreSQL 特有能力  |
| 连接     | Prisma Client + 托管连接池              | 控制 Vercel Serverless 数据库连接数量      |
| 事件通知 | PostgreSQL Outbox + 轻量轮询 Worker     | 提交后发布 SSE，不依赖事务外通知           |
| 调度     | Workflow DevKit `workflow` 4.x          | durable sleep、Run tick 和 Serverless 恢复 |
| Blob     | Vercel Blob 或 S3 兼容实现              | 报告、附件和后续截图                       |
| Auth     | Auth.js 5 Beta，封装 Auth Port          | Cookie Session，与 Eve same-origin 集成    |
| 限流     | MVP 先数据库令牌桶/滑动窗口             | 避免首版依赖 Redis；规模增长后替换         |

Auth.js 5 仍为 Beta，因此业务层只依赖 `AuthSession` 和 `AuthorizationService`，不在领域包中引用 Auth.js 类型。

Prisma 使用边界：

- 常规实体、关系、分页和简单 Projection 使用 Prisma Client；
- 事件追加、Run version 更新、同步投影和 Outbox 写入放在同一个 `$transaction`；
- `FOR UPDATE SKIP LOCKED`、复杂 Review 查询和 Prisma Schema 无法表达的 PostgreSQL 能力使用 TypedSQL 或参数化 `$queryRaw`；
- Check Constraint、Partial Index 等数据库约束写入并审查 Prisma Migration SQL；
- `packages/database` 对外暴露 Repository 和 Transaction Port，不把 Prisma Model 类型泄漏到 Domain、Kernel 或 Scenario Pack；
- 生产环境复用 Prisma Client，并通过托管连接池限制 Serverless 连接数量。
- `DATABASE_URL` 在生产环境指向运行时连接池，`DIRECT_URL` 指向仅供 Prisma Migration 使用的数据库直连地址；本地开发两者可指向同一 Compose 数据库。

### 5.4 Agent

| 项目          | 选择                                                               |
| ------------- | ------------------------------------------------------------------ |
| Agent Runtime | Eve 最新锁定版本，当前基线 0.22.x                                  |
| 部署          | Next.js `withEve()` 同项目、同域部署                               |
| Agent 目录    | `apps/web/agent/`                                                  |
| 前端接入      | 服务端 `AgentRuntime` Adapter；不让业务组件直接依赖 `useEveAgent`  |
| 输出          | Zod/JSON Schema 结构化 `ProposedAction`                            |
| HITL          | Eve Tool Approval + 平台领域审批                                   |
| Subagents     | Director 为根编排，Stakeholder/Observer/Evaluator 为声明式子 Agent |
| Sandbox       | 默认后端；生产明确设置网络 allowlist 或 deny-all                   |
| Evals         | Eve Evals + 固定场景数据集                                         |

`useEveAgent` 适合聊天式 UI，但 ReadinessOS 的权威 UI 由 DomainEvent 驱动。因此 Eve Client 仅用于 Adapter、诊断页或开发工具，不作为 Live 页状态源。

### 5.5 测试与运维

| 领域             | 选择             |
| ---------------- | ---------------- |
| Unit/Integration | Vitest 4         |
| Property Test    | fast-check 4     |
| Component        | Testing Library  |
| E2E              | Playwright 1.61+ |
| 组件预览         | Storybook 10     |
| Error/APM        | Sentry           |
| Trace            | OpenTelemetry    |
| CI               | GitHub Actions   |
| Hosting          | Vercel           |

---

## 6. 系统架构

### 6.1 MVP 部署拓扑

```text
Browser
  |
  v
Next.js Web / Route Handlers
  |-- Auth and Authorization
  |-- Command Handlers
  |-- Query Handlers
  |-- SSE Gateway
  |-- Outbox Publisher
  |-- Reconciliation Cron
  |
  +--> Simulation Kernel packages
  |
  +--> PostgreSQL
  |      |-- Domain tables
  |      |-- Append-only events
  |      |-- Snapshots
  |      |-- Projections
  |      `-- Outbox
  |
  +--> Eve Adapter
  |       |
  |       `--> Eve Runtime / Sessions / Subagents / Sandbox
  |
  `--> RunScheduler Adapter
          |
          `--> Workflow DevKit / durable sleep
```

Vercel 上通过 `withEve()` 将 Web 与 Eve 服务部署在同一项目。逻辑上仍保持独立端口：Web 只能通过 `AgentRuntime` 调 Eve，Eve Tool 只能通过受限平台 API 提交 ProposedAction。

虚拟时间调度通过 `RunScheduler` Port 接入 Workflow DevKit。Cron 不负责高频推进，只定期查找处于运行态但没有活跃调度记录的 Run，并触发幂等恢复。

### 6.2 模块依赖方向

```text
domain-events        <- 无框架依赖
simulation-kernel    -> domain-events
scenario-sdk         -> domain-events + simulation-kernel ports
scenario-packs       -> scenario-sdk
database             -> domain-events + application ports
agent-adapter        -> domain-events + application ports + eve
ui-runtime           -> domain-events read models
apps/web             -> application services + all adapters
```

禁止：

- `simulation-kernel` 引用 Next.js、Prisma、Eve 或 React；
- Scenario Pack 直接执行 SQL；
- React 组件直接修改数据库；
- Eve Tool 直接写 `run_events`；
- Query Handler 在读取时临时调用 LLM 推导业务状态。

### 6.3 一次动作的完整事务

```text
UI 提交 Command
  -> 鉴权、Zod 校验、租户校验
  -> 检查 idempotencyKey 和 expectedRunVersion
  -> 加载最新 Snapshot + 后续事件
  -> Kernel 执行纯函数 transition
  -> 同一数据库事务：
       append run_events
       update simulation_runs.version
       update 同步核心投影
       insert outbox_messages
  -> 返回 accepted commandId
  -> Outbox Publisher 发布已提交 Cursor
  -> SSE 客户端收到 DomainEvent
  -> RunEventStore 应用事件并确认乐观状态
```

MVP 的核心 Live 投影在同事务更新，保证提交成功后查询立即一致。成本较高的 Review、统计和报告投影可以异步更新。

---

## 7. Monorepo 结构

```text
ReadinessOs/
├── apps/
│   └── web/
│       ├── app/
│       │   ├── (auth)/
│       │   ├── (app)/
│       │   │   ├── scenarios/
│       │   │   ├── runs/[runId]/live/
│       │   │   └── runs/[runId]/review/
│       │   ├── api/
│       │   │   ├── runs/
│       │   │   ├── scenarios/
│       │   │   ├── approvals/
│       │   │   └── internal/agent/
│       │   └── share/[token]/
│       ├── agent/
│       │   ├── agent.ts
│       │   ├── instructions.md
│       │   ├── channels/eve.ts
│       │   ├── tools/
│       │   ├── subagents/
│       │   │   ├── stakeholder/
│       │   │   ├── observer/
│       │   │   └── evaluator/
│       │   └── sandbox/
│       ├── components/
│       ├── features/
│       ├── lib/
│       └── next.config.ts
├── packages/
│   ├── domain-events/
│   ├── simulation-kernel/
│   ├── scenario-sdk/
│   ├── agent-adapter/
│   ├── database/
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   ├── migrations/
│   │   │   └── seed.ts
│   │   └── src/
│   │       ├── client.ts
│   │       ├── repositories/
│   │       ├── transactions/
│   │       └── typed-sql/
│   ├── application/
│   ├── ui-runtime/
│   ├── auth/
│   ├── observability/
│   ├── config-eslint/
│   └── config-typescript/
├── scenario-packs/
│   ├── saas-incident/
│   └── customer-escalation/
├── tests/
│   ├── e2e/
│   ├── evals/
│   ├── fixtures/
│   └── performance/
├── docs/
│   ├── adr/
│   ├── event-catalog.md
│   └── runbooks/
├── prototypes/
│   └── readinessos-prototype.html
├── .github/workflows/
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── plan.md
```

---

## 8. 领域模型

### 8.1 核心实体

| 实体             | 说明                               |
| ---------------- | ---------------------------------- |
| Organization     | 租户边界                           |
| Member           | 用户与组织角色                     |
| Scenario         | 场景逻辑身份                       |
| ScenarioVersion  | 不可变的已发布配置                 |
| SimulationRun    | 一次运行及其生命周期               |
| RunParticipant   | 运行中的 human/agent/system 参与方 |
| RunEvent         | 按 sequence 排序的领域事实         |
| StateSnapshot    | 某 sequence 的完整世界状态         |
| Decision         | 参与方做出的关键决策               |
| Approval         | 高风险动作审批记录                 |
| Evidence         | 评分或结论引用的事实               |
| Evaluation       | 评估器输出                         |
| RemediationItem  | 整改项                             |
| AgentSessionLink | RunParticipant 与 Eve Session 映射 |
| ShareLink        | 只读分享令牌                       |

### 8.2 WorldState

WorldState 由 Scenario Pack 定义 Zod Schema。支付故障场景至少包含：

```ts
type SaasIncidentState = {
  clock: {
    elapsedMinutes: number;
    status: 'idle' | 'running' | 'paused' | 'completed';
  };
  service: {
    paymentSuccessRate: number;
    errorRate: number;
    latencyP95Ms: number;
    writesDisabled: boolean;
    rollbackStarted: boolean;
    recovered: boolean;
  };
  impact: {
    affectedCustomers: number;
    estimatedRevenueLoss: number;
    duplicateChargesDetected: boolean;
  };
  response: {
    incidentDeclared: boolean;
    severity: 'unknown' | 'sev3' | 'sev2' | 'sev1';
    ownerParticipantId?: string;
    statusPagePublished: boolean;
    customerCommsSent: boolean;
  };
  objectives: Record<string, 'healthy' | 'at-risk' | 'failed'>;
};
```

### 8.3 Participant

```ts
type Participant = {
  id: string;
  controller: 'human' | 'agent' | 'system';
  templateKey: string;
  displayName: string;
  capabilities: string[];
  permissions: string[];
  objectives: string[];
  knowledgeScopes: string[];
  channels: string[];
};
```

参与方名称不是权限。所有可见数据和动作都由 `capabilities`、`permissions`、`knowledgeScopes` 决定。

### 8.4 DomainEvent 信封

```ts
type DomainEvent<TType extends string = string, TPayload = unknown> = {
  id: string;
  organizationId: string;
  runId: string;
  sequence: number;
  type: TType;
  version: number;
  source: 'human' | 'agent' | 'system' | 'integration';
  participantId?: string;
  simulatedAt: string;
  recordedAt: string;
  causationId?: string;
  correlationId?: string;
  idempotencyKey: string;
  payload: TPayload;
};
```

首版事件目录至少包括：

- `run.created`
- `run.started`
- `run.paused`
- `run.resumed`
- `run.completed`
- `run.failed`
- `clock.advanced`
- `signal.emitted`
- `signal.observed`
- `action.proposed`
- `action.rejected`
- `action.approval_requested`
- `action.approved`
- `action.denied`
- `action.executed`
- `state.changed`
- `inject.triggered`
- `participant.joined`
- `participant.status_changed`
- `decision.recorded`
- `checkpoint.created`
- `evaluation.completed`
- `remediation.created`
- `branch.created`

事件类型和 payload 版本写入 `docs/event-catalog.md`，任何破坏性变更必须通过 upcaster 或新事件版本处理。

### 8.5 ProposedAction

```ts
type ProposedAction = {
  actionType: string;
  participantId: string;
  parameters: Record<string, unknown>;
  rationale: string;
  evidenceRefs: string[];
  confidence: number;
  clientRequestId: string;
};
```

处理顺序：

1. Zod Schema；
2. Participant 是否存在；
3. Capability 与 Permission；
4. Knowledge Scope 是否允许引用证据；
5. Action 前置条件；
6. 预算和速率限制；
7. 是否需要审批；
8. Kernel 执行。

---

## 9. 数据库设计

### 9.1 表清单

#### 租户与身份

- `organizations`
- `users`
- `members`

#### 场景

- `scenarios`
- `scenario_versions`

#### 运行

- `simulation_runs`
- `run_participants`
- `run_events`
- `state_snapshots`
- `checkpoints`
- `agent_session_links`

#### 决策和复盘

- `decisions`
- `approvals`
- `evidence`
- `evaluations`
- `remediation_items`

#### 查询与平台

- `run_overview_projection`
- `participant_projection`
- `timeline_projection`
- `review_projection`
- `outbox_messages`
- `share_links`
- `usage_ledger`

### 9.2 关键字段和约束

`simulation_runs`

```text
id
organization_id
scenario_version_id
parent_run_id nullable
branch_from_sequence nullable
status
version
seed
virtual_time
latest_sequence
started_at
completed_at
created_by
created_at
```

`run_events`

```text
id
organization_id
run_id
sequence
type
version
source
participant_id nullable
simulated_at
recorded_at
causation_id nullable
correlation_id nullable
idempotency_key
payload jsonb
```

约束和索引：

```sql
unique (run_id, sequence);
unique (run_id, idempotency_key);
check (sequence > 0);
index (organization_id, recorded_at desc);
index (run_id, type, sequence);
index (run_id, participant_id, sequence);
```

### 9.3 快照策略

- 每 100 条事件或虚拟时间 5 分钟创建一次 Snapshot；
- 运行暂停、完成、分支前强制创建 Snapshot；
- Snapshot 包含 `runId`、`sequence`、`schemaVersion`、`stateJson`、`checksum`；
- 恢复时加载不大于目标 sequence 的最近 Snapshot，再重放后续事件；
- CI 中验证 Snapshot 恢复与从头重放结果一致。

### 9.4 分支存储

MVP 使用逻辑继承，不复制父运行全部事件：

- 子 Run 保存 `parent_run_id` 和 `branch_from_sequence`；
- 创建分支时写入父运行在该 sequence 的 Snapshot；
- 子运行从 Snapshot 作为新初始状态开始，sequence 从 1 重新计数；
- Review 对比时通过父子映射对齐虚拟时间和 causation；
- 父运行历史只读，子运行不会修改父事件。

### 9.5 Outbox

每次领域事务同时写入 `outbox_messages`。Publisher 按批次锁定未发布记录：

1. 通过 Prisma TypedSQL 或参数化 `$queryRaw` 执行 `FOR UPDATE SKIP LOCKED`；
2. 推送到进程内 Run Event Hub；
3. 标记 `published_at`；
4. 失败记录 attempt 和 next_attempt_at；
5. SSE 重连始终可从数据库按 Cursor 补拉，因此进程内推送丢失不影响正确性。

### 9.6 Prisma 实现约定

- `schema.prisma` 是应用数据模型入口，Migration SQL 是最终数据库变更事实；
- 所有关系、枚举、唯一键和普通索引优先在 Prisma Schema 中声明；
- Prisma 无法表达的 Check Constraint、Partial Index 和锁语义写入 Migration SQL 或 TypedSQL；
- 领域事务使用交互式 `$transaction`，事务回调内不调用 Eve、Workflow、Blob 或其他网络服务；
- Event payload、Snapshot 和 Projection JSON 字段在进入 Prisma 前后都通过 Zod 校验；
- 乐观并发更新必须带 `id + version` 条件，并验证实际更新行数；
- 所有 `$queryRaw` 使用参数绑定，禁止拼接用户输入；
- CI 执行 Prisma Schema 格式、校验、Migration Diff 和全新数据库迁移测试；
- 生产发布使用显式迁移步骤，不在应用启动时自动运行 `migrate deploy`。

---

## 10. Simulation Kernel 实现

### 10.1 Kernel API

```ts
interface SimulationKernel<TState> {
  createRun(input: CreateRunInput<TState>): KernelResult<TState>;
  execute(context: KernelContext<TState>, command: RunCommand): KernelResult<TState>;
  replay(initialState: TState, events: DomainEvent[]): TState;
  evaluate(context: KernelContext<TState>): EvaluationDraft[];
}
```

`KernelResult` 只返回事件草稿、下一状态和副作用意图，不访问数据库或网络。

### 10.2 Command

首版 Command：

- `StartRun`
- `PauseRun`
- `ResumeRun`
- `AdvanceClock`
- `SubmitAction`
- `ResolveApproval`
- `TriggerInject`
- `FinishRun`
- `CreateCheckpoint`
- `CreateBranch`

每个 Command 必须携带：

```ts
type CommandEnvelope<T> = {
  commandId: string;
  organizationId: string;
  runId: string;
  actor: ActorRef;
  expectedRunVersion: number;
  idempotencyKey: string;
  issuedAt: string;
  payload: T;
};
```

### 10.3 Trigger 与 Effect DSL

Scenario SDK 提供有限组合器：

```ts
all(...)
any(...)
not(...)
elapsedMinutesGte(...)
stateEquals(...)
stateNumberGte(...)
eventOccurred(...)
participantActionCountGte(...)
```

Effect 首版支持：

```ts
setState(path, value);
incrementState(path, amount);
emitSignal(signalKey, recipients);
scheduleInject(injectKey, delay);
changeParticipantStatus(participantId, status);
recordMetric(metricKey, value);
completeRun(reason);
```

所有 path 在 Pack 加载时校验，不接受运行时任意 JSONPath 写入。

### 10.4 虚拟时间调度

Vercel Serverless 环境不维持常驻循环。MVP 使用离散 tick：

- Run 启动或恢复时启动或恢复该 Run 对应的调度 Workflow；
- Workflow 使用 durable `sleep()` 等待下一个墙上时间间隔；
- 醒来后以 Command 形式推进 15-30 秒虚拟时间；
- 每次 tick 执行到期 Inject、Signal 和 Agent Observation；
- Pause、Completed、Failed 等状态使本轮 tick 成为 no-op，并让 Workflow 结束；
- Resume 创建新的调度代次，避免旧 Workflow 与新 Workflow 并行推进；
- 重试依赖稳定的 idempotencyKey 和 expectedRunVersion；
- 开发环境提供手动 `AdvanceClock`，便于测试快速运行。

具体实现封装为 `RunScheduler` Port：

```ts
interface RunScheduler {
  start(input: { runId: string; generation: number; intervalSeconds: number }): Promise<void>;
  cancel(input: { runId: string; generation: number }): Promise<void>;
  reconcile(runId: string): Promise<void>;
}
```

生产 Adapter 使用 Workflow DevKit：

1. `StartRun` 或 `ResumeRun` 提交成功后，通过 Outbox 副作用启动 Workflow；
2. Workflow 读取 `runId`、`generation` 和 tick 序号，执行 `sleep("15s")` 或场景配置的间隔；
3. 醒来后发送幂等 `AdvanceClock` Command，idempotencyKey 使用 `tick:{runId}:{generation}:{tickIndex}`；
4. Command Handler 在事务中检查 Run 状态、generation 和 expectedRunVersion；
5. 若仍为 running，Workflow 安排下一次 sleep；若 paused 或 terminal，Workflow 正常结束；
6. Workflow 重放、函数重试或重复启动不会产生重复 `clock.advanced`；
7. 低频 Reconciliation Cron 只修复“Run 为 running 但无活跃 Workflow”的孤儿状态，不承担常规 tick。

测试 Adapter 不等待真实时间，暴露手动推进和虚拟时钟，支持在单元测试中精确触发第 N 个 tick。Kernel 仍只处理 `AdvanceClock` Command，不依赖 Workflow DevKit、Cron 或墙上时间。

### 10.5 不变量

- Run 完成后不可再改变 WorldState；
- 未批准动作不能产生 `action.executed`；
- 参与方不能接收 Knowledge Scope 外 Signal；
- 同一 Command 只能生效一次；
- sequence 严格递增；
- 相同输入重放结果一致；
- Trigger 不得产生无限零延迟循环；
- Evaluation 必须引用有效事件或决策。

---

## 11. Scenario SDK 与场景包

### 11.1 Scenario Pack 接口

```ts
interface ScenarioPack<TState> {
  manifest: PackManifest;
  stateSchema: z.ZodType<TState>;
  initialState(input: ScenarioConfig): TState;
  participantTemplates: ParticipantTemplate[];
  capabilities: CapabilityDefinition[];
  actions: ActionDefinition<TState>[];
  signals: SignalDefinition<TState>[];
  injects: InjectDefinition<TState>[];
  evaluators: EvaluatorDefinition<TState>[];
  uiContributions: UIContribution[];
}
```

### 11.2 SaaS 支付故障 Pack

参与方：

- Incident Commander：默认 human；
- On-call Engineer：agent 或 human；
- Customer Support Lead：agent；
- Executive Stakeholder：agent；
- Monitoring System：system；
- Payment Provider：agent/system。

动作：

- declare_incident
- inspect_metrics
- assign_owner
- disable_payment_writes
- start_rollback
- publish_status
- notify_customers
- contact_provider
- verify_recovery
- close_incident

评估维度：

1. 发现速度；
2. 升级质量；
3. 决策与领导；
4. 缓解速度；
5. 客户沟通；
6. 恢复验证。

### 11.3 薄场景验收

关键客户升级 Pack 必须：

- 使用相同 Participant 和 Action 协议；
- 使用相同 Live Timeline、Decision、Approval 和 Review；
- 只新增 Pack 内 State、Action、Signal、Inject、Evaluator 和 UI Contribution；
- 不修改 `simulation-kernel`；
- 不新增场景专属路由；
- Contract Test 全部通过。

---

## 12. Eve 集成

### 12.1 文件结构

```text
apps/web/agent/
├── agent.ts
├── instructions.md
├── channels/eve.ts
├── lib/
│   ├── platform-client.ts
│   └── schemas.ts
├── tools/
│   ├── observe_run.ts
│   ├── propose_action.ts
│   └── request_context.ts
├── subagents/
│   ├── stakeholder/
│   ├── observer/
│   └── evaluator/
└── sandbox/
    └── sandbox.ts
```

### 12.2 AgentRuntime Port

```ts
interface AgentRuntime {
  start(input: StartAgentInput): Promise<AgentHandle>;
  sendObservation(handle: AgentHandle, observation: Observation): Promise<AgentTurnResult>;
  answerInput(handle: AgentHandle, response: AgentInputResponse): Promise<AgentTurnResult>;
  terminate(handle: AgentHandle): Promise<void>;
  getStatus(handle: AgentHandle): Promise<AgentRuntimeStatus>;
}
```

Eve Adapter 负责：

- 创建或恢复 Eve Session；
- 保存 continuation token、sessionId 和 streamIndex；
- 消费 NDJSON 事件；
- 处理 `input.requested`、`action.result`、`session.failed`；
- 将最终结构化结果转换为 ProposedAction；
- 将 Trace 写入独立 Agent Trace 表或观测系统；
- 对 Eve API 变化提供契约测试。

### 12.3 Agent Observation

```ts
type Observation = {
  runId: string;
  participant: ParticipantView;
  simulatedAt: string;
  visibleSignals: SignalView[];
  visibleState: Record<string, unknown>;
  recentEvents: EventSummary[];
  pendingObjectives: ObjectiveView[];
  availableActions: ActionDescriptor[];
  budget: {
    remainingTurns: number;
    remainingTokens: number;
  };
};
```

禁止把完整 WorldState 或其他参与方私有 Signal 发送给 Agent。

### 12.4 双层审批

Eve Tool Approval 负责暂停 Agent Tool 执行；平台 Approval 负责业务语义和审计。流程：

1. Agent 调 `propose_action`；
2. Adapter 将输入映射为 `action.proposed`；
3. Policy 判断需要审批；
4. 平台创建 Approval，Live 显示影响和参数；
5. 用户批准后写 `action.approved`；
6. Adapter 通过 Eve `inputResponses` 恢复原 Session；
7. Kernel 再次校验当前状态并执行；
8. 若状态已变化导致前置条件失效，动作拒绝而不是强制执行。

### 12.5 安全与预算

- Eve channel 生产环境使用应用 Auth，不使用 `none()`；
- Sandbox 生产默认 deny-all，只开放必要模型/平台域名；
- Agent Tool 只能调用内部受鉴权 API；
- 每个 Session 记录 model、promptVersion、PackVersion；
- 单运行 Agent 不超过 8 个；
- 限制 Turn、Token、Tool Call、Subagent Depth 和总时长；
- 外部文本均标记来源，不允许提升 Tool 权限；
- Agent 失败不改变 WorldState。

---

## 13. API 设计

### 13.1 Command API

| Method | Endpoint                                 | 用途                        |
| ------ | ---------------------------------------- | --------------------------- |
| POST   | `/api/runs`                              | 从 ScenarioVersion 创建 Run |
| POST   | `/api/runs/:runId/start`                 | 启动                        |
| POST   | `/api/runs/:runId/actions`               | 提交动作                    |
| POST   | `/api/runs/:runId/pause`                 | 暂停                        |
| POST   | `/api/runs/:runId/resume`                | 继续                        |
| POST   | `/api/runs/:runId/approvals/:approvalId` | 批准或拒绝                  |
| POST   | `/api/runs/:runId/checkpoints`           | 创建检查点                  |
| POST   | `/api/runs/:runId/branches`              | 创建分支                    |
| POST   | `/api/runs/:runId/remediations`          | 创建整改项                  |

Command Header：

```text
Idempotency-Key: uuid
If-Match: run-version
```

错误码：

- `RUN_VERSION_CONFLICT`
- `COMMAND_ALREADY_APPLIED`
- `ACTION_NOT_ALLOWED`
- `APPROVAL_REQUIRED`
- `APPROVAL_STALE`
- `RUN_TERMINAL`
- `BUDGET_EXCEEDED`
- `SEQUENCE_GAP`

### 13.2 Query API

| Method | Endpoint                          | 用途                    |
| ------ | --------------------------------- | ----------------------- |
| GET    | `/api/scenarios`                  | 场景列表                |
| GET    | `/api/scenarios/:id`              | 场景和版本              |
| GET    | `/api/runs/:runId`                | Run Overview Projection |
| GET    | `/api/runs/:runId/events?after=`  | Cursor 补拉             |
| GET    | `/api/runs/:runId/stream?cursor=` | SSE/NDJSON              |
| GET    | `/api/runs/:runId/review`         | Review Projection       |
| GET    | `/api/runs/:runId/branches`       | 分支列表                |
| GET    | `/share/:token`                   | 只读分享                |

### 13.3 SSE 协议

每个消息包含：

```ts
type StreamEnvelope = {
  cursor: number;
  event: DomainEvent;
};
```

客户端规则：

1. `cursor <= localCursor`：去重丢弃；
2. `cursor === localCursor + 1`：正常应用；
3. `cursor > localCursor + 1`：暂停应用，HTTP 补拉缺口；
4. 补拉完成后恢复 Stream；
5. Stream 失败指数退避，最大 30 秒；
6. 页面隐藏时降低非关键渲染频率，不停止权威事件消费。

---

## 14. 前端架构

### 14.1 路由

```text
/scenarios
/scenarios/[scenarioId]
/runs/[runId]/live
/runs/[runId]/review
/runs/[runId]/review/branches/[branchId]
/share/[token]
/settings
```

### 14.2 状态分层

| 状态                                    | 所有者                                               |
| --------------------------------------- | ---------------------------------------------------- |
| 场景、Run 元数据、初始 Projection       | RSC/Server Query                                     |
| 高频 DomainEvent                        | RunEventStore                                        |
| Run/Connection/Approval/Replay 生命周期 | XState Actors                                        |
| 面板大小、筛选、选中项                  | Local component/store                                |
| 乐观命令                                | Command Queue，仅显示 pending，不修改权威 WorldState |

### 14.3 RunEventStore

```ts
interface RunEventStore {
  connect(cursor?: number): void;
  disconnect(): void;
  getSnapshot(): RunClientProjection;
  subscribe(listener: () => void): () => void;
  enqueueCommand(command: ClientCommand): string;
  applyEvent(event: DomainEvent): void;
  recoverGap(fromCursor: number, toCursor: number): Promise<void>;
}
```

Store 内部：

- `eventsById` 去重；
- `cursor`；
- `pendingCommands`；
- `projection`；
- `connectionStatus`；
- Worker 通道；
- 每次批量事件只发布受影响 selector。

### 14.4 XState Actors

`runActor`

```text
idle -> starting -> running <-> paused -> finishing -> completed
                           \-> failed
```

`connectionActor`

```text
connecting -> live -> recovering -> live
                 \-> offline -> connecting
```

`approvalActor`

```text
none -> pending -> submitting -> resolved -> none
                      \-> stale
```

`replayActor`

```text
live -> scrubbing -> replaying -> comparing
                 \-> branching
```

### 14.5 Worker

Web Worker 负责：

- Snapshot + Event 重放；
- Branch Diff；
- Scenario Graph ELK 布局；
- Timeline 密度聚合；
- 大批量事件转换为 Projection Patch。

Worker 输入输出使用可序列化 DTO；大型数组尽量使用 Transferable。Worker 崩溃时降级到最近服务端 Projection，并提示用户重新加载 Review。

---

## 15. 页面实现

### 15.1 Studio Lite

页面目标：让用户在 3 分钟内理解场景并开始运行。

模块：

- 场景摘要和预计时长；
- 难度 Segmented Control；
- 随机种子高级选项；
- 目标列表；
- Participant Table；
- Controller 切换；
- Capability 和 Knowledge Scope Inspector；
- 只读 Scenario Graph；
- 成本预估；
- 启动运行按钮。

校验：

- 至少一个 human 参与方；
- 必需 Participant 不可禁用；
- Agent 数量不超过配额；
- Controller 和 Capability 组合合法；
- 创建 Run 前固定 ScenarioVersion。

### 15.2 Live

桌面布局沿用原型 A 的运营控制台方向：

```text
Sidebar | Main Situation Workspace | Decision Inspector
        |--------------------------|
        | Collapsible Timeline     |
```

核心区域：

- 顶栏：运行状态、虚拟时间、连接状态、暂停/继续；
- 风险摘要：服务健康、客户影响、收入风险；
- 目标状态；
- 动态 Capability 模块；
- 参与方列表和当前活动；
- 待决策动作；
- Approval Drawer；
- Timeline；
- Director Inject 控制，仅开发/演示权限可见。

响应式：

- > = 1280px：三列；
- 768-1279px：Inspector 变 Drawer；
- < 768px：只保留风险、待决策、参与方和关键 Timeline，Studio 不提供图编辑。

### 15.3 Review

模块：

- Run Summary；
- 六维评分；
- Evidence Coverage；
- 虚拟化同步 Timeline；
- Decision Detail；
- Cause Graph；
- WorldState Inspector；
- Remediation List；
- Checkpoint Picker；
- Branch Diff。

Replay：

- 拖动时间轴只更新预览，不写服务端；
- 停止拖动后 Worker 重放到目标 sequence；
- 点击 Evidence 自动定位到相应 sequence；
- Live 运行未完成时 Review 为只读增量模式。

Branch Diff：

- 对齐父子运行虚拟时间；
- 展示关键动作差异；
- 展示最终 State path 差异；
- 展示评分差异；
- 不尝试对所有文本做通用语义 Diff。

### 15.4 设计系统约束

- 操作型、高密度、安静的界面；
- 不以聊天窗口为主；
- Page Section 不做浮动大卡片；
- 卡片圆角不超过 8px；
- 颜色只表达语义状态；
- 图标按钮使用 Lucide 并提供 Tooltip；
- 所有交互可键盘访问；
- 支持 Reduced Motion；
- 文本不能溢出或覆盖；
- 一次 Run 的核心状态在首屏可判断。

---

## 16. 鉴权与权限

### 16.1 角色

MVP：

- Owner
- Facilitator
- Participant
- Reviewer
- Guest

权限检查分两层：

1. Organization RBAC：能否访问场景、Run、成员和分享；
2. Runtime ABAC：Participant 的 Capability、Permission、Knowledge Scope 和 Action Risk。

### 16.2 访客演示

- 临时匿名主体；
- 只能使用预置 ScenarioVersion；
- 每 IP/浏览器每日有限运行次数；
- 单次不超过 15 分钟；
- 不连接真实外部系统；
- 运行数据设置较短保留期；
- 分享默认关闭。

### 16.3 内部 Agent API

`/api/internal/agent/*` 必须验证：

- Eve Session 对应的内部服务身份；
- runId/participantId 与 AgentSessionLink 一致；
- 请求参数摘要；
- 单次使用或短时 token；
- 租户上下文；
- 速率和预算。

---

## 17. 可观测性

### 17.1 Trace

每条链路统一字段：

```text
organization_id
run_id
command_id
correlation_id
participant_id
eve_session_id
scenario_version
```

关键 Span：

- command.validate
- kernel.load
- kernel.execute
- events.commit
- outbox.publish
- sse.deliver
- agent.observe
- agent.turn
- projection.rebuild
- review.replay

### 17.2 指标

产品：

- Run 创建、启动、完成和放弃率；
- 首次有效决策时间；
- Review 打开率；
- Branch 创建率；
- 整改项创建率。

系统：

- Command p50/p95；
- Event commit 到客户端可见延迟；
- SSE 重连次数；
- Cursor gap 次数；
- Snapshot 和 replay 耗时；
- Agent Turn 成功率、Token 和费用；
- 无效/越权 ProposedAction；
- Worker 长任务和页面内存。

### 17.3 日志

- JSON 结构化日志；
- 禁止记录 Prompt 全文、Token、Cookie 和敏感 Signal；
- Agent 输入输出按可配置策略脱敏；
- 错误包含 correlationId，不包含完整 WorldState；
- Production 日志保留期与运行数据保留期分离。

---

## 18. 测试计划

### 18.1 Unit

- Event Schema；
- Reducer；
- Trigger 和 Effect；
- Action Policy；
- Evaluator 公式；
- Projection Reducer；
- Cursor 去重和 gap 检测；
- XState actor transitions。

### 18.2 Property

fast-check 生成随机 Command/Event：

- 永不产生非法状态；
- 重放等价；
- Command 幂等；
- Snapshot + 后续事件等于完整重放；
- 分支不修改父运行；
- sequence 始终递增；
- 未批准动作不改变状态。

### 18.3 Contract

- `ScenarioPack`；
- `AgentRuntime`；
- `DomainEvent`；
- `UIContribution`；
- Eve Adapter 流事件映射；
- API Error Envelope。

每个 Pack 必须使用同一套 Contract Test Harness。

### 18.4 Integration

使用真实 PostgreSQL：

- 事件和投影同事务；
- expectedVersion 并发冲突；
- idempotency；
- Outbox 重试；
- Snapshot 恢复；
- 租户隔离；
- Approval stale；
- Eve 无效 JSON、超时和恢复。

### 18.5 Component

- Participant 控制器切换；
- Approval Drawer；
- Timeline 虚拟化；
- WorldState Inspector；
- Evidence 跳转；
- Branch Diff；
- Keyboard 和 ARIA。

### 18.6 E2E

主路径：

1. 访客选择场景；
2. 配置参与方；
3. 启动；
4. 收到事件；
5. 提交动作；
6. 完成审批；
7. 刷新恢复；
8. 完成运行；
9. Review 跳转证据；
10. 创建整改项；
11. 创建分支并比较。

失败路径：

- 数据库版本冲突；
- SSE 中断；
- Agent 输出非法；
- 审批过期；
- Run 超预算；
- Worker 失败；
- Eve 暂不可用。

### 18.7 Agent Eval

固定数据集至少包含：

- 正常支付故障；
- 重复扣款；
- Provider 延迟；
- 错误的客户沟通建议；
- 越权读取私有 Signal；
- 高风险动作未审批；
- 无足够证据的评分。

指标：

- ProposedAction Schema 合法率；
- 越权率；
- 动作前置条件命中率；
- EvidenceRef 有效率；
- 场景一致性；
- 平均 Turn、Token、费用和延迟。

---

## 19. 性能预算

| 场景                   | 目标                       |
| ---------------------- | -------------------------- |
| Live 命令本地反馈      | < 100ms 显示 pending       |
| Command 服务端确认 p95 | < 500ms，不含 Agent        |
| 事件提交到客户端 p95   | < 1s                       |
| 断线恢复 p95           | < 3s                       |
| 5,000 事件 Timeline    | 60fps 主观流畅，无全量 DOM |
| Projection Worker 单批 | 主线程阻塞 < 50ms          |
| 10 events/s 实时输入   | 输入、面板拖动保持响应     |
| Live 首次可交互        | < 2.5s，正常网络和热数据库 |
| 移动端                 | 无横向页面溢出和内容重叠   |

性能测试放入 CI 的 nightly 或手动 workflow，普通 PR 跑缩小数据集。

---

## 20. CI/CD 与环境

### 20.1 环境

| 环境       | 数据和用途                                       |
| ---------- | ------------------------------------------------ |
| Local      | 本地/托管开发 PostgreSQL，Eve dev，模拟模型可选  |
| Preview    | PR 独立 Vercel Preview，独立 Schema 或数据库分支 |
| Production | 公开演示和登录工作区                             |

### 20.2 CI 顺序

1. dependency install；
2. format check；
3. lint；
4. typecheck；
5. Prisma format/validate；
6. unit/property/contract；
7. build；
8. Prisma Migration Diff 和全新数据库迁移；
9. component test；
10. 核心 Playwright；
11. Eve Eval 小数据集。

### 20.3 数据库迁移

- 所有 Prisma Migration SQL 与 `schema.prisma` 一起提交；
- 每次生成迁移后人工审查 SQL，补充 Prisma 无法表达的数据库约束；
- Preview 先应用；
- destructive migration 分 expand/contract；
- 主分支部署前备份/PITR 已启用；
- 禁止应用启动时自动执行生产迁移，部署流水线显式运行迁移；
- 提供 seed 命令创建两个 Scenario Pack 和演示用户。

### 20.4 Feature Flag

首版 Flag：

- `branching`
- `guest_demo`
- `agent_evaluator`
- `director_inject_controls`
- `customer_escalation_pack`

Flag 只控制功能暴露，不创建两套数据模型。

### 20.5 Git 提交与推送策略

- 初始化仓库后使用功能分支开发；远端未配置前允许本地提交，但不得把“已推送”标为完成；
- Commit 必须对应一个可解释的逻辑单元，使用 `feat:`、`fix:`、`test:`、`docs:`、`refactor:`、`chore:` 等 Conventional Commits 前缀；
- 数据库 Schema 与对应 Migration SQL 必须放在同一 Commit；
- DomainEvent、Command、API 等协议变更必须连同测试和 Event Catalog 放在同一 Commit；
- 不提交 `.env`、密钥、模型凭据、运行日志、大型生成物或本地数据库；
- 每次 Commit 前至少运行受影响 package 的 format、lint、typecheck 和测试；
- 每个阶段退出标准通过后必须创建阶段检查点 Commit 并 Push；
- 高风险变更开始前先 Push 当前已验证状态，避免本地唯一副本；
- 不为追求“一任务一提交”制造碎片提交；同一逻辑单元的实现、测试和文档应一起提交；
- `main` 始终保持可构建，阶段开发通过分支和 PR 合并。

---

## 21. 8 周实施计划

每周必须交付纵向可运行结果。后续阶段不得依赖尚未验证的“大一统框架”。

### W1：工程与领域基线

交付：

- pnpm/Turborepo/Next.js monorepo；
- Node 24、TypeScript strict、ESLint、Prettier；
- Prisma ORM、Prisma Migrate 和 PostgreSQL；
- Auth、Organization、Member；
- DomainEvent、CommandEnvelope、错误协议；
- CI、环境变量校验和基础 OTel；
- 迁移与 seed。

退出标准：

- 本地一条命令启动；
- 用户可登录并看到场景列表占位；
- CI 全绿；
- 事件 Schema 和数据库约束测试通过。

### W2：Kernel 与 Scenario SDK

交付：

- 纯函数 Kernel；
- 虚拟时间、Trigger、Effect；
- Participant、Signal、Action Policy；
- Snapshot/replay；
- Scenario Pack 接口；
- SaaS Incident 最小确定性场景；
- Property/Contract Test。

退出标准：

- 无 LLM 可通过 CLI/测试跑完整小场景；
- 重放结果一致；
- 未批准动作不执行；
- Pack 不直接依赖数据库和框架。

### W3：Run API、事件存储与 Eve Adapter

交付：

- Run Command/Query API；
- 事件、核心投影、Outbox；
- SSE + Cursor 恢复；
- RunScheduler Port、Workflow DevKit Adapter 和测试时钟；
- 调度 generation、幂等 tick 和孤儿 Run 对账；
- Eve `withEve()`；
- Director/Stakeholder 最小 Agent；
- AgentRuntime Adapter；
- ProposedAction 校验和 Session 映射。

退出标准：

- Agent 可收到最小 Observation 并提出合法动作；
- DomainEvent 不直接暴露 Eve 原生事件；
- SSE 刷新恢复无重复；
- Pause 后不再推进，Resume 后只有一个有效调度代次；
- Workflow 重试、重复启动和对账恢复不会产生重复 tick；
- Eve 失败不改变 WorldState。

### W4：Studio Lite 与 Live 纵向闭环

交付：

- Studio Lite；
- Live 主布局；
- RunEventStore；
- XState actors；
- Timeline 虚拟化；
- 动态参与方和 Capability 模块；
- 用户动作和暂停/继续。

退出标准：

- 用户可从配置进入 Live；
- 一个 human 与至少两个 Agent 在同一运行中产生事件；
- 断网恢复；
- 桌面和手机关键路径无重叠。

### W5：审批、Review、回放与分支

交付：

- 双层审批；
- Review Projection；
- Worker replay；
- 六维评分和 Evidence；
- 整改项；
- Checkpoint 和 BranchRun；
- 基础 Branch Diff。

退出标准：

- 高风险动作可批准、拒绝和过期；
- Evidence 可跳到准确事件；
- 分支不修改父运行；
- Snapshot replay 与完整 replay 一致。

### W6：完整 SaaS Incident Pack

交付：

- 完整状态、10 个左右 Inject；
- 4-6 个动态 Agent/System 参与方；
- 10 个左右核心动作；
- 6 个 Evaluator；
- 演示脚本和固定种子；
- Agent Eval 数据集。

退出标准：

- 主场景连续自动运行 20 次；
- 无无限循环和非法状态；
- 每个评分项有 Evidence；
- 单场费用和时间在预算内。

### W7：第二场景与扩展证明

交付：

- Customer Escalation Pack；
- 新 State、Action、Signal、Inject、Evaluator；
- UI Contribution 接入；
- Scenario Pack Contract 报告；
- 场景切换 E2E。

退出标准：

- 不修改 Kernel；
- 不增加场景专属页面；
- Live/Review 复用；
- 两个场景全部通过同一 Harness。

### W8：上线质量与演示

交付：

- Guest Demo、限流和 Usage Ledger；
- Sentry/OTel Dashboard；
- 性能、无障碍和视觉修复；
- Vercel Production；
- 备份和恢复演练；
- README、架构图、ADR、演示数据；
- 5 分钟面试演示流程。

退出标准：

- Production 可访问；
- 核心 E2E、Eval、A11y、Visual 全绿；
- 数据库恢复演练完成；
- 运行成本告警有效；
- 已知风险有明确记录。

---

## 22. Issue 拆分规则

每个实现 Issue 必须包含：

- 用户或系统目标；
- In Scope / Out of Scope；
- 接口或数据变更；
- 依赖项；
- 验收条件；
- 测试要求；
- 可观测性要求；
- 数据迁移或回滚影响。

建议单个 Issue 控制在 0.5-2 天。跨 3 个以上 package 或同时修改协议、数据库和 UI 的任务必须先拆分或写 ADR。

Definition of Done：

- 代码、测试、类型检查和 Lint 通过；
- 行为有可观察日志/指标；
- 新事件已写入 Event Catalog；
- 新环境变量已加入校验和文档；
- UI 经过桌面和移动端检查；
- 无未说明的临时 Mock；
- 不引入跨包反向依赖。

---

## 23. 架构决策记录

首批 ADR：

1. `ADR-001`：DomainEvent 为业务事实，Eve Event 不直接进入 UI；
2. `ADR-002`：模块化单体和 Monorepo 边界；
3. `ADR-003`：事件、同步核心投影和 Outbox 同事务；
4. `ADR-004`：逻辑分支继承与 Snapshot；
5. `ADR-005`：XState + External Store 的客户端状态分层；
6. `ADR-006`：Eve `withEve()` 同项目部署和 AgentRuntime Port；
7. `ADR-007`：虚拟时间离散 tick、RunScheduler Port 与 Workflow DevKit；
8. `ADR-008`：Auth Provider 封装和租户权限边界；
9. `ADR-009`：Prisma ORM、Migration SQL 与原生查询逃生口。

---

## 24. 主要风险与缓解

| 风险                | 影响                  | 缓解                                              |
| ------------------- | --------------------- | ------------------------------------------------- |
| Eve Beta API 变化   | Agent 集成返工        | 锁版本、Adapter、Contract Test、升级 ADR          |
| 事件溯源复杂度      | 开发和调试成本        | 限定事件目录、显式 Projection、Event Debug 页     |
| Serverless 定时推进 | Tick 重复、丢失或延迟 | durable workflow、generation、幂等 tick、低频对账 |
| Agent 不稳定        | 场景不可复现          | 确定性 Kernel、固定种子、结构化输出、Eval         |
| 场景过度通用        | MVP 延期              | 只抽象两个场景实际重复的能力                      |
| 前端信息过载        | 用户无法决策          | 原型 A、渐进披露、Inspector、首屏风险摘要         |
| Auth.js Beta        | 鉴权升级风险          | Auth Port、Cookie Session 集中封装                |
| 公共 Demo 成本      | 费用和滥用            | 限额、验证码/风控、固定模型预算、预录降级         |
| Branch Diff 膨胀    | 性能问题              | 只对齐关键事件、状态路径和评分                    |
| 数据泄漏            | 严重安全问题          | organizationId 全链路、Knowledge Scope、脱敏测试  |

---

## 25. 最终发布验收清单

### 产品

- [ ] 两个 Scenario Pack 可运行；
- [ ] Studio Lite、Live、Review 完整；
- [ ] 审批、回放、整改、分支可用；
- [ ] 访客和登录用户权限正确；
- [ ] 只读分享不会泄漏私有数据。

### 数据和一致性

- [ ] Run Event 严格顺序；
- [ ] Command 幂等；
- [ ] Tick 重试不重复推进，Pause/Resume 不产生并行调度；
- [ ] Snapshot 恢复正确；
- [ ] Projection 可重建；
- [ ] 分支不修改父历史；
- [ ] 跨租户访问测试通过。

### Agent

- [ ] ProposedAction Schema 合法；
- [ ] Agent 无法直接写 WorldState；
- [ ] 高风险 Tool 有审批；
- [ ] Knowledge Scope 隔离；
- [ ] Eve Session 可恢复；
- [ ] Eval 达到阈值。

### 前端

- [ ] 5,000 事件 Timeline 达到预算；
- [ ] SSE 断线恢复；
- [ ] Worker 失败有降级；
- [ ] 键盘和屏幕阅读器关键路径通过；
- [ ] 桌面和移动端无重叠、溢出；
- [ ] Reduced Motion 可用。

### 运维

- [ ] Production 密钥在 Secret Store；
- [ ] Sentry/OTel 和告警启用；
- [ ] 数据库 PITR 与恢复演练完成；
- [ ] 访客限流和预算生效；
- [ ] 发布和回滚 Runbook 完成；
- [ ] 已知风险与后续项有记录。

---

## 26. 开发启动顺序

正式编码时按以下顺序启动，不先做视觉页面：

1. 初始化 Monorepo 和 CI；
2. 建立 DomainEvent、Command 和错误协议；
3. 建立 Prisma Schema、Migration SQL 和 Seed；
4. 实现无 Agent 的确定性 Kernel；
5. 实现第一个最小 Scenario Pack；
6. 实现 Run API、事件事务和 SSE；
7. 接入 Eve Adapter；
8. 做 Studio Lite -> Live 的第一条纵向路径；
9. 增加 Review、审批和分支；
10. 扩展完整场景、第二场景和上线能力。

任何阶段若核心不变量尚未通过测试，不进入依赖它的 UI 扩展阶段。

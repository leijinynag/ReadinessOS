<!-- markdownlint-disable MD013 -->

# ReadinessOS MVP 实施任务清单

> 状态：W5 已完成，已合并审批、Review、回放与分支闭环
> 更新日期：2026-07-16
> 依据：[plan.md](./plan.md)

## 使用规则

- `[ ]` 表示未完成，`[x]` 表示已经满足实现、测试和文档要求。
- 从上到下执行；存在明确依赖的任务不得提前标记完成。
- 每次只处理一个能够独立验收的逻辑单元，完成后立即更新本文件。
- 实现任务只有在对应测试、类型检查和必要文档完成后才能勾选。
- `Commit Checkpoint` 只有在前置任务完成且检查通过后才能勾选。
- `Push Checkpoint` 只有在远端分支确实更新后才能勾选；未配置远端时保持未完成。
- 新增 DomainEvent 时同步更新 Event Catalog；新增环境变量时同步更新校验和示例文件。
- 数据库 Schema 与对应 Prisma Migration SQL 必须一起提交。
- 不提交 `.env`、密钥、模型凭据、运行日志、大型生成物或本地数据库。

## 提交与推送约定

- 分支建议：`feat/w1-foundation`、`feat/w2-kernel`，按阶段或纵向功能创建。
- Commit 使用 Conventional Commits，例如 `feat(database): add initial prisma schema`。
- Commit 前运行受影响范围的 format、lint、typecheck 和 test。
- 一个 Commit 包含一个完整逻辑单元的实现、测试和文档，不机械地一项任务一个 Commit。
- 每个阶段退出标准通过后 Push；高风险 Schema、事件协议或部署改动开始前也先 Push 已验证状态。
- `main` 保持可构建，阶段成果通过 PR 合并。

---

## W0 开发前准备

### 仓库与环境

- [x] `W0-01` 确认本机 Node.js 24、pnpm 和 PostgreSQL 开发环境可用。
- [x] `W0-02` 初始化 Git 仓库，默认分支设为 `main`。
- [x] `W0-03` 创建 `.gitignore`，覆盖 `.env*`、依赖、构建产物、测试产物和本地数据库文件。
- [x] `W0-04` 配置项目远端 `origin`；若远端尚未创建，本项保持未完成。
- [x] `W0-05` 记录本地、Preview 和 Production 所需外部服务及账号负责人。
- [x] `W0-06` 确认 `plan.md` 与 `tasks.md` 是当前实施基线。

### 文档检查点

- [x] `W0-C1` Commit Checkpoint：提交计划和任务清单，建议 `docs: add MVP implementation plan and task checklist`。
- [x] `W0-P1` Push Checkpoint：推送初始化分支并确认远端可见。

---

## W1 工程与领域基线

### Monorepo

- [x] `W1-01` 初始化 pnpm Workspace 和根 `package.json`。
- [x] `W1-02` 初始化 Turborepo，定义 `dev`、`build`、`lint`、`typecheck`、`test` 和 `format` Pipeline。
- [x] `W1-03` 创建 `apps/web` Next.js 16 App Router 应用。
- [x] `W1-04` 创建计划中的 `packages/*` 和 `scenario-packs/*` 目录边界。
- [x] `W1-05` 配置共享 TypeScript strict 基线和包级 `tsconfig`。
- [x] `W1-06` 配置 ESLint、Prettier 和 EditorConfig。
- [x] `W1-07` 创建环境变量 Schema、`.env.example` 和启动时校验。
- [x] `W1-08` 添加根 README，记录安装、环境配置和本地启动命令。

### Prisma 与 PostgreSQL

- [x] `W1-09` 创建 `packages/database`，安装并初始化 Prisma ORM。
- [x] `W1-10` 创建 `schema.prisma`、Prisma Client 单例和数据库 package 出口。
- [x] `W1-11` 建立 Organization、User、Member 数据模型和租户索引。
- [x] `W1-12` 建立 Scenario、ScenarioVersion 基础数据模型。
- [x] `W1-13` 建立 SimulationRun、RunParticipant 基础数据模型。
- [x] `W1-14` 建立首个 Prisma Migration，并人工审查生成 SQL。
- [x] `W1-15` 添加 Prisma format、validate、generate 和 migrate 脚本。
- [x] `W1-16` 添加全新数据库从零应用 Migration 的集成测试。
- [x] `W1-17` 配置开发和 Vercel 环境的连接池策略，避免重复创建 Prisma Client。
- [x] `W1-18` 创建 Seed 脚本，写入演示组织、用户和两个场景占位。

### 身份与协议

- [x] `W1-19` 定义 `AuthSession`、`AuthorizationService` 和 Organization 权限边界。
- [x] `W1-20` 接入 Auth.js，并通过 Auth Port 隔离框架类型。
- [x] `W1-21` 实现登录、退出和受保护应用布局。
- [x] `W1-22` 定义 DomainEvent Envelope 及 Zod Schema。
- [x] `W1-23` 定义 CommandEnvelope、ActorRef 和标准错误码。
- [x] `W1-24` 创建 Event Catalog 文档并登记初始事件。
- [x] `W1-25` 为事件 Schema、租户隔离和数据库唯一约束添加测试。

### CI 与可观测性

- [x] `W1-26` 创建 GitHub Actions CI，执行 install、format、lint、typecheck 和 unit test。
- [x] `W1-27` 在 CI 中加入 Prisma format、validate 和全新数据库迁移检查。
- [x] `W1-28` 接入基础 OpenTelemetry request/command trace。
- [x] `W1-29` 创建场景列表占位页，验证登录后的最小纵向路径。

### W1 验收

- [x] `W1-A1` 一条命令可以启动 Web 和必要本地依赖。
- [x] `W1-A2` 用户可以登录并看到场景列表占位。
- [x] `W1-A3` Prisma Migration 可在空数据库完整应用。
- [x] `W1-A4` 事件 Schema 和数据库约束测试通过。
- [x] `W1-A5` format、lint、typecheck、test 和 build 全部通过。
- [x] `W1-C1` Commit Checkpoint：提交工程骨架，建议 `feat(platform): establish monorepo and prisma foundation`。
- [x] `W1-P1` Push Checkpoint：推送 W1 分支并创建或更新 PR。

---

## W2 Simulation Kernel 与 Scenario SDK

### 纯函数内核

- [x] `W2-01` 定义 `SimulationKernel`、`KernelContext`、`KernelResult` 和副作用意图。
- [x] `W2-02` 实现 Create、Start、Pause、Resume、AdvanceClock 生命周期 Command。
- [x] `W2-03` 实现 SubmitAction、ResolveApproval、TriggerInject 和 FinishRun Command。
- [x] `W2-04` 实现严格递增 sequence 和稳定 idempotencyKey 规则。
- [x] `W2-05` 实现确定性随机数接口，禁止 Kernel 直接调用系统随机数。
- [x] `W2-06` 实现 Trigger 组合器 `all/any/not` 和时间、状态、事件条件。
- [x] `W2-07` 实现有限 Effect DSL，并在 Pack 加载时校验所有 State path。
- [x] `W2-08` 实现 Participant、Capability、Permission 和 Knowledge Scope 校验。
- [x] `W2-09` 实现 Action 前置条件和审批策略。
- [x] `W2-10` 实现终止条件、Checkpoint 和基础确定性 Evaluation。
- [x] `W2-11` 实现 Event replay 和 Snapshot 恢复。
- [x] `W2-12` 防止零延迟 Trigger 产生无限循环。

### Scenario SDK

- [x] `W2-13` 定义 ScenarioPack、Manifest、Action、Signal、Inject、Evaluator 和 UIContribution 接口。
- [x] `W2-14` 创建 Scenario Pack Contract Test Harness。
- [x] `W2-15` 创建 SaaS Incident WorldState Zod Schema。
- [x] `W2-16` 实现最小参与方、动作、Signal、Inject 和结束条件。
- [x] `W2-17` 添加固定种子的 CLI 或测试运行入口。

### 测试

- [x] `W2-18` 添加 Kernel 生命周期单元测试。
- [x] `W2-19` 添加权限、知识边界和审批不变量测试。
- [x] `W2-20` 使用 fast-check 验证相同输入重放结果一致。
- [x] `W2-21` 验证未批准动作绝不产生 `action.executed`。
- [x] `W2-22` 验证 Scenario Pack 不依赖 Prisma、Next.js、React 或 Eve。

### W2 验收

- [x] `W2-A1` 无 LLM、无数据库即可运行完整最小场景。
- [x] `W2-A2` Snapshot replay 与完整 replay 结果一致。
- [x] `W2-A3` Kernel 全部不变量测试通过。
- [x] `W2-A4` Scenario Pack Contract Test 通过。
- [x] `W2-C1` Commit Checkpoint：提交确定性内核，建议 `feat(kernel): implement deterministic simulation engine`。
- [x] `W2-C2` Commit Checkpoint：提交 Scenario SDK 和最小场景，建议 `feat(scenarios): add scenario SDK and incident pack skeleton`。
- [x] `W2-P1` Push Checkpoint：推送 W2 分支并更新 PR。

---

## W3 Run API、事件存储、调度与 Eve

### Prisma 事件事务

- [x] `W3-01` 扩展 Prisma Schema，加入 RunEvent、Snapshot、Checkpoint 和 AgentSessionLink。
- [x] `W3-02` 扩展 Prisma Schema，加入核心 Projection、Outbox 和 UsageLedger。
- [x] `W3-03` 在 Migration SQL 中加入 sequence、idempotencyKey、Check Constraint 和必要索引。
- [x] `W3-04` 实现 Run Repository，通过 Snapshot 加后续事件加载聚合。
- [x] `W3-05` 实现 Prisma `$transaction`：追加事件、更新 Run version、同步投影和写 Outbox。
- [x] `W3-06` 实现 `id + version` 乐观并发控制并校验更新行数。
- [x] `W3-07` 实现参数化 TypedSQL 或 `$queryRaw` Outbox 批量锁定。
- [x] `W3-08` 添加事务回滚、并发冲突、重复 Command 和 Outbox 重试测试。

### Command、Query 与实时流

- [x] `W3-09` 实现创建、启动、暂停、继续和动作提交 Command API。
- [x] `W3-10` 实现 Run Overview 和 Event Cursor Query API。
- [x] `W3-11` 实现 SSE/NDJSON StreamEnvelope 和 Cursor 推送。
- [x] `W3-12` 实现断线重连、事件去重和 Cursor 缺口补拉。
- [x] `W3-13` 添加刷新恢复、重复事件和 sequence gap 集成测试。

### RunScheduler

- [x] `W3-14` 定义 `RunScheduler` Port 和调度 generation。
- [x] `W3-15` 实现 Workflow DevKit durable sleep Adapter。
- [x] `W3-16` 实现稳定的 `tick:{runId}:{generation}:{tickIndex}` 幂等键。
- [x] `W3-17` 确保 Pause/Terminal 使旧 tick 成为 no-op，Resume 只产生一个有效 generation。
- [x] `W3-18` 实现测试虚拟时钟和手动推进 Adapter。
- [x] `W3-19` 实现低频孤儿 Run Reconciliation Job。
- [x] `W3-20` 添加 Workflow 重试、重复启动、Pause/Resume 和对账恢复测试。

### Eve Adapter

- [x] `W3-21` 使用 `withEve()` 接入 Eve，并创建 filesystem-first Agent 目录。
- [x] `W3-22` 定义 `AgentRuntime` Port 和 Eve Adapter。
- [x] `W3-23` 创建 Director 根 Agent 与最小 Stakeholder Subagent。
- [x] `W3-24` 实现 Participant 最小 Observation 构造。
- [x] `W3-25` 实现 ProposedAction Zod Schema 和校验 Pipeline。
- [x] `W3-26` 持久化 RunParticipant 与 Eve Session 映射及恢复信息。
- [x] `W3-27` 消费 NDJSON 生命周期事件并处理 `input.requested` 和失败状态。
- [x] `W3-28` 确保 Eve Trace 与 DomainEvent 分开存储和展示。
- [x] `W3-29` 添加 Eve Adapter Contract Test 和非法输出测试。

### W3 验收

- [x] `W3-A1` Agent 可基于最小 Observation 提出合法 ProposedAction。
- [x] `W3-A2` Event、Projection 和 Outbox 保持同事务一致。
- [x] `W3-A3` SSE 刷新恢复无重复且能补齐缺口。
- [x] `W3-A4` Pause 后不推进，Resume 后没有并行调度。
- [x] `W3-A5` Eve 失败不会改变 WorldState。
- [x] `W3-C1` Commit Checkpoint：提交事件事务和 API，建议 `feat(runtime): add event store command API and live stream`。
- [x] `W3-C2` Commit Checkpoint：提交调度系统，建议 `feat(scheduler): add durable run tick workflow`。
- [x] `W3-C3` Commit Checkpoint：提交 Eve Adapter，建议 `feat(agent): integrate Eve runtime and proposed actions`。
- [x] `W3-P1` Push Checkpoint：已推送 W3 分支并合并至 `main`。

---

## W4 Studio Lite 与 Live 纵向闭环

### Studio Lite

- [x] `W4-01` 实现场景列表和场景详情 Query。
- [x] `W4-02` 实现难度、目标、随机种子和参与方启停配置。
- [x] `W4-03` 实现 human、agent、system Controller 切换。
- [x] `W4-04` 展示参与方 Capability、Knowledge Scope 和只读事件图。
- [x] `W4-05` 创建不可变 ScenarioVersion 并启动 Run。

### Live Runtime

- [x] `W4-06` 创建 Live 页面主布局和响应式区域。
- [x] `W4-07` 实现 RunEventStore、cursor、去重和 pending command queue。
- [x] `W4-08` 实现 Run、Connection 和 Approval XState Actors。
- [x] `W4-09` 实现风险摘要、业务指标、目标和虚拟时间。
- [x] `W4-10` 实现动态参与方状态和 Capability 模块。
- [x] `W4-11` 使用 TanStack Virtual 实现 Timeline。
- [x] `W4-12` 实现用户动作提交及 pending/accepted/rejected 状态。
- [x] `W4-13` 实现暂停、继续和 Director Inject 控制。
- [x] `W4-14` 实现 SSE 连接状态、断线恢复和缺口提示。
- [x] `W4-15` 确保 Agent 发言、提议动作与执行结果在时间线中可区分。

### UI 验证

- [x] `W4-16` 添加 Studio 到 Live 的组件和集成测试。
- [ ] `W4-17` 添加一个 human 与至少两个 Agent 的纵向 E2E。
- [ ] `W4-18` 添加断网 30 秒后恢复 E2E。
- [ ] `W4-19` 使用 Playwright 检查桌面和手机视口无重叠、溢出。
- [x] `W4-20` 验证键盘操作和关键无障碍名称。

### W4 验收

- [x] `W4-A1` 用户可从 Studio 配置进入真实 Live Run。
- [ ] `W4-A2` human 与 Agent 可在同一运行中产生可追踪事件。
- [ ] `W4-A3` 页面刷新和短时断网后恢复正确。
- [ ] `W4-A4` 桌面和手机关键路径可用。
- [x] `W4-C1` Commit Checkpoint：提交 Studio 纵向路径，建议 `feat(studio): add scenario configuration and immutable versions`。
- [x] `W4-C2` Commit Checkpoint：提交 Live Workspace，建议 `feat(live): add realtime simulation workspace`。
- [x] `W4-P1` Push Checkpoint：已推送 W4 分支并合并至 `main`。

---

## W5 审批、Review、回放与分支

### 审批

- [x] `W5-01` 扩展 Prisma Schema，加入 Decision、Approval、Evidence、Evaluation 和 RemediationItem。
- [x] `W5-02` 创建并审查对应 Prisma Migration SQL。
- [x] `W5-03` 实现 Eve Tool Approval 与平台业务 Approval 双层流程。
- [x] `W5-04` 实现批准、拒绝、过期和 stale 前置条件处理。
- [x] `W5-05` 实现审批抽屉，展示影响、参数、理由和证据。
- [x] `W5-06` 添加未批准、重复批准和过期审批测试。

### Review 与回放

- [x] `W5-07` 实现 Review Projection 和异步重建入口。
- [x] `W5-08` 实现基于 Snapshot 的服务端事件 replay 和检查点定位；浏览器 Worker 留给 W8 性能优化。
- [x] `W5-09` 实现时间线、决策、状态变化和结果因果链。
- [x] `W5-10` 实现评分和 EvidenceRef 跳转；六维 Evaluator 由 W6 场景包补齐。
- [x] `W5-11` 实现整改项创建和状态更新。
- [x] `W5-12` 采用服务端 Projection 为 MVP 基线路径，不依赖 Worker 可用性。

### 分支

- [x] `W5-13` 实现分支前强制 Snapshot。
- [x] `W5-14` 实现 BranchRun 的 parent、branch sequence 和初始 Snapshot。
- [x] `W5-15` 实现父子虚拟时间、关键事件和评分 Diff；通用 State path Diff 留给 W8。
- [x] `W5-16` 验证子运行不会修改父运行历史。
- [x] `W5-17` 添加 Snapshot replay、BranchRun 和 Evidence 跳转回归测试。

### W5 验收

- [x] `W5-A1` 高风险动作可批准、拒绝和过期。
- [x] `W5-A2` 每个评分项至少关联一个有效 EvidenceRef。
- [x] `W5-A3` 分支不复制或修改父运行历史。
- [x] `W5-A4` Snapshot replay 与完整 replay 一致。
- [x] `W5-C1` Commit Checkpoint：已提交审批闭环 `feat(approvals): add governed agent action execution`。
- [x] `W5-C2` Commit Checkpoint：已提交 Review 和分支 `feat(review): add evidence replay and branch comparison`。
- [x] `W5-P1` Push Checkpoint：已推送 W5 分支并合并至 `main`。

---

## W6 完整 SaaS Incident Pack

### 场景内容

- [ ] `W6-01` 完成支付故障 WorldState、目标和终止条件。
- [ ] `W6-02` 完成 Incident Commander、On-call、Support、Executive、Monitoring 和 Provider 参与方。
- [ ] `W6-03` 完成约 10 个核心动作及权限、前置条件和审批策略。
- [ ] `W6-04` 完成约 10 个 Inject、触发条件和 Effect。
- [ ] `W6-05` 完成各参与方 Signal 可见性和 Knowledge Scope。
- [ ] `W6-06` 完成 Director 节奏策略和可选 Inject 范围。
- [ ] `W6-07` 完成 Observer 关键决策与检查点标记。
- [ ] `W6-08` 完成六个 Evaluator 和确定性评分组合。
- [ ] `W6-09` 创建固定种子、演示数据和 5 分钟演示脚本。

### Agent Eval 与稳定性

- [ ] `W6-10` 创建正常故障、重复扣款、Provider 延迟等 Eval 数据集。
- [ ] `W6-11` 添加越权读取、未审批动作和无证据评分对抗用例。
- [ ] `W6-12` 记录 Schema 合法率、越权率、Evidence 有效率和动作命中率。
- [ ] `W6-13` 记录每场 Turn、Token、费用和延迟。
- [ ] `W6-14` 使用固定种子连续自动运行主场景 20 次。
- [ ] `W6-15` 修复所有无限循环、非法状态和事件顺序错误。

### W6 验收

- [ ] `W6-A1` 主场景连续运行 20 次无非法状态。
- [ ] `W6-A2` 每个评分项都有可跳转 Evidence。
- [ ] `W6-A3` Agent 权限和审批 Eval 达到约定阈值。
- [ ] `W6-A4` 单场费用和运行时间在预算内。
- [ ] `W6-C1` Commit Checkpoint：提交完整主场景，建议 `feat(scenarios): complete SaaS incident simulation pack`。
- [ ] `W6-C2` Commit Checkpoint：提交 Agent Eval，建议 `test(agent): add incident safety and quality eval suite`。
- [ ] `W6-P1` Push Checkpoint：推送 W6 分支并更新 PR。

---

## W7 第二场景与扩展证明

### Customer Escalation Pack

- [ ] `W7-01` 定义关键客户升级场景 State 和目标。
- [ ] `W7-02` 定义参与方、Action、Signal、Inject 和 Evaluator。
- [ ] `W7-03` 通过既有 UIContribution 接口接入 Live 和 Review。
- [ ] `W7-04` 确认未修改 Simulation Kernel。
- [ ] `W7-05` 确认未创建场景专属路由或复制 Live/Review 页面。
- [ ] `W7-06` 运行 Scenario Pack Contract Test。
- [ ] `W7-07` 添加两个场景切换和完整闭环 E2E。
- [ ] `W7-08` 输出扩展性报告，记录第二场景实际复用与新增内容。

### W7 验收

- [ ] `W7-A1` 两个场景使用相同 Kernel、Command、Live 和 Review。
- [ ] `W7-A2` 两个场景通过同一 Contract Harness。
- [ ] `W7-A3` 第二场景无需新增专属页面即可运行。
- [ ] `W7-C1` Commit Checkpoint：提交第二场景，建议 `feat(scenarios): add customer escalation pack`。
- [ ] `W7-P1` Push Checkpoint：推送 W7 分支并更新 PR。

---

## W8 上线质量与演示

### 安全与成本

- [ ] `W8-01` 实现 Guest Demo 身份、运行时长和功能限制。
- [ ] `W8-02` 实现数据库限流和 UsageLedger。
- [ ] `W8-03` 配置 Agent Turn、Token、Tool、Subagent 和总费用预算。
- [ ] `W8-04` 配置 Eve Sandbox 网络 allowlist 或 deny-all。
- [ ] `W8-05` 完成跨租户、Knowledge Scope、分享链接和日志脱敏测试。
- [ ] `W8-06` 确认 Production 密钥全部进入 Secret Store。

### 可观测性与运维

- [ ] `W8-07` 接入 Sentry 前后端错误监控。
- [ ] `W8-08` 完成 Command、Run、Agent、Workflow 和 Projection OTel Trace。
- [ ] `W8-09` 建立错误率、运行失败率、Agent 成本和 Tick 延迟 Dashboard。
- [ ] `W8-10` 配置预算、Workflow 孤儿、Outbox 积压和数据库错误告警。
- [ ] `W8-11` 编写发布、回滚、数据库迁移和事故 Runbook。
- [ ] `W8-12` 完成数据库 PITR 和恢复演练。

### 性能、无障碍与视觉

- [ ] `W8-13` 验证 5,000 事件 Timeline 不创建全量 DOM。
- [ ] `W8-14` 验证 10 events/s 下输入和面板交互保持响应。
- [ ] `W8-15` 验证 Command、SSE、恢复和首屏性能预算。
- [ ] `W8-16` 完成键盘、屏幕阅读器和 Reduced Motion 检查。
- [ ] `W8-17` 用 Playwright 检查主要桌面和手机视口。
- [ ] `W8-18` 修复所有文本重叠、横向溢出和不可操作控件。

### 部署与演示

- [ ] `W8-19` 配置 Vercel Preview 环境和独立数据库分支或 Schema。
- [ ] `W8-20` 在 Preview 显式运行 Prisma Migration 并执行 Smoke Test。
- [ ] `W8-21` 配置 Vercel Production 和自定义域名。
- [ ] `W8-22` 执行 Production Migration、Seed 和核心 Smoke Test。
- [ ] `W8-23` 完成 README、架构图、ADR 和演示数据。
- [ ] `W8-24` 演练 5 分钟流程：动态 Agent、审批、复盘和分支。

### W8 验收

- [ ] `W8-A1` Production 可访问且核心 E2E、Eval、A11y 和 Visual 全绿。
- [ ] `W8-A2` 数据库恢复演练和回滚流程完成。
- [ ] `W8-A3` 访客限流、运行预算和告警生效。
- [ ] `W8-A4` 已知风险和 P1 后续项已记录。
- [ ] `W8-C1` Commit Checkpoint：提交上线配置，建议 `chore(release): prepare ReadinessOS MVP production release`。
- [ ] `W8-P1` Push Checkpoint：推送 Release 分支并创建发布 PR。
- [ ] `W8-P2` Push Checkpoint：合并后推送 Release Tag。

---

## 最终发布验收

### 产品

- [ ] `FINAL-01` 两个 Scenario Pack 均可完成配置、运行和复盘。
- [ ] `FINAL-02` Studio Lite、Live、Review、审批、整改和分支全部可用。
- [ ] `FINAL-03` 访客、登录用户和只读分享权限正确。

### 数据与一致性

- [ ] `FINAL-04` Run Event 严格顺序且 Command 幂等。
- [ ] `FINAL-05` Tick 重试不重复推进，Pause/Resume 不产生并行调度。
- [ ] `FINAL-06` Snapshot 恢复、Projection 重建和 BranchRun 正确。
- [ ] `FINAL-07` Prisma Migration 可在空数据库和现有 Preview 数据库应用。
- [ ] `FINAL-08` 跨租户访问测试通过。

### Agent

- [ ] `FINAL-09` ProposedAction Schema 合法，Agent 无法直接修改 WorldState。
- [ ] `FINAL-10` 高风险 Tool 经过审批，Knowledge Scope 隔离有效。
- [ ] `FINAL-11` Eve Session 可恢复，Eval 达到阈值。
- [ ] `FINAL-12` Agent 的观察、判断、沟通、行动提议和证据化评估均可在 UI 中观察。

### 前端与运维

- [ ] `FINAL-13` Timeline、SSE 恢复、Worker 降级和移动端达到计划要求。
- [ ] `FINAL-14` Sentry、OTel、告警、PITR、发布和回滚 Runbook 均已验证。
- [ ] `FINAL-15` Production Smoke Test 和 5 分钟演示流程通过。
- [ ] `FINAL-C1` Commit Checkpoint：更新最终状态和发布文档，建议 `docs: finalize MVP release status`。
- [ ] `FINAL-P1` Push Checkpoint：推送最终文档状态和发布 Tag。

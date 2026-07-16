# W7 第二场景扩展报告

## 结论

关键客户升级场景以独立的 `@readinessos/scenario-pack-customer-escalation` 接入现有系统。
实现没有修改 `packages/simulation-kernel`，没有增加场景专属路由，也没有复制 Live 或 Review
页面。两个场景都通过同一份 `ScenarioPack` 契约、`InMemoryScenarioPackRegistry`、通用运行时、
`buildScenarioGraph`、Live Workspace 和 Review 投影。

## 实际复用

| 层级     | 复用组件                                                  | 第二场景新增内容                                      |
| -------- | --------------------------------------------------------- | ----------------------------------------------------- |
| 领域执行 | `SimulationKernel`、Command、Event、审批与 Evaluator 协议 | 无                                                    |
| 场景契约 | `ScenarioPack`、Zod State Schema、UIContribution          | 客户风险领域 State、Action、Signal、Inject、Evaluator |
| Web 装载 | `scenarioPackRegistry`、Studio 场景配置、通用图 DTO       | Registry 增加一个 allowlist 项                        |
| 数据     | Scenario、ScenarioVersion 和不可变 seed revision          | 关键客户升级的 Pack 配置和参与方快照                  |
| 测试     | Pack Contract、Kernel 闭环、通用图 DTO                    | 20 个固定 seed、越权和审批对抗用例                    |

## 运行路径

1. `packages/database/prisma/seed.ts` 从 Pack 导出参与方、目标、固定 seed 和预计时长，创建新的
   不可变 `ScenarioVersion`。
2. Studio 从该版本读取 `packKey` 和参与方选择；客户端不能上传新的 Pack 定义。
3. `scenarioPackRegistry` 仅按服务端 allowlist 解析 `customer-escalation`。
4. Run Application Service 使用同一个 Kernel 和 Command 路径执行场景。
5. Live/Review 读取通用 Run、Event、Evaluation 与 `uiContributions`，无需添加路由。

## 验证

- `scenario-packs/customer-escalation/test/pack.test.ts`：完整闭环、20 个固定 seed、审批和越权。
- `apps/web/lib/scenario-pack-registry.test.ts`：两个 Pack 都通过同一个 SDK Contract，并可转换为
  通用图 DTO。
- `apps/web/lib/scenario-graph.test.ts`：第二场景不依赖页面专用图逻辑。
- W7 验收时运行 `git diff --exit-code main -- packages/simulation-kernel`，确保 Kernel 没有变更。

## 后续扩展边界

新增第三个场景只需要创建 Pack、注册 allowlist，并为其 seed 版本提供配置和回归测试。只有当
新的业务需要无法由现有 Action、Effect、Trigger、Signal 或 Evaluation 契约表达时，才应评估
扩展 Kernel；该决策应作为独立架构变更，而非随单个场景一同修改。

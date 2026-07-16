# Critical Customer Escalation Pack

## 场景范围

本场景模拟关键客户因产品问题准备重新评估续约时的跨职能响应。它与 SaaS Payment
Incident 使用同一套 Scenario SDK、Simulation Kernel、Studio、Live 和 Review；Pack
本身不依赖数据库、Next.js、React、Eve 或 LLM。

固定演示种子为 `20260716`。演练包含客户升级、根因确认、管理层同步、客户沟通、恢复计划、
受审批的生产修复、客户验证与关闭，虚拟时间约 6 分钟。

## 状态与目标

- `customerRecovery`：稳定客户沟通并通过客户验证恢复信心。
- `executiveAlignment`：明确业务负责人并完成管理层风险同步。
- `deliveryConfidence`：确认技术根因、受控安排生产修复并验证完成。

世界状态保存续约金额与风险、客户信心、升级处理状态、恢复计划、修复排期和验证结果。
Live 与 Review 通过 `uiContributions` 展示客户风险、续约金额、客户信心、修复状态和续约状态。

## 参与方与审批

| 参与方                 | 控制方式 | 主要职责                           |
| ---------------------- | -------- | ---------------------------------- |
| Account Executive      | Human    | 确认升级、同步管理层、关闭升级     |
| Customer Success Lead  | Agent    | 客户更新、恢复计划和客户验证       |
| Engineering Lead       | Agent    | 技术排查和安排生产修复             |
| Executive Sponsor      | Agent    | 接收管理层风险升级                 |
| Customer Signal System | System   | 提供客户关系和沟通范围内的系统信号 |

`schedule-remediation` 是高风险动作，必须经过 Kernel 审批。权限、能力和 knowledge scope
不匹配的参与方会被拒绝，未获批准的修复排期不会产生任何状态副作用。

## 固定闭环

1. 启动演练，系统创建关键客户升级并下调客户信心。
2. Account Executive 确认升级，Engineering Lead 排查根因。
3. 推进 4 分钟，演示未沟通时的管理层、客户信心和续约风险升级信号。
4. Account Executive 同步管理层；Customer Success Lead 发送客户更新和恢复计划。
5. Engineering Lead 申请 `schedule-remediation`，在审批面板批准后推进 2 分钟。
6. Customer Success Lead 验证客户恢复，Account Executive 关闭升级。五个 Evaluator 均应为
   `100`，并能从 Review 时间线定位 `action.executed` 与 `inject.triggered` 证据。

`test/pack.test.ts` 会对 20 个固定 seed 执行完整闭环，同时验证状态 Schema、事件连续序号、
评分证据、越权拒绝和审批前无副作用。

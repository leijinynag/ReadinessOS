# SaaS Payment Incident Pack

## 场景范围

本场景模拟支付服务异常引发的客户影响、重复扣费风险和跨职能响应。它只依赖
Scenario SDK、Simulation Kernel 和 Zod，可在没有数据库、Web 界面或 LLM 的情况下运行。

固定演示种子为 `20260716`。场景运行总时长约 7 个虚拟分钟，适合在 5 分钟内完成产品演示。

## 状态与目标

- `serviceAvailability`：控制支付错误率并验证服务恢复。
- `customerTrust`：发布状态页、通知客户并同步管理层。
- `financialIntegrity`：冻结自动重试，识别并完成重复扣费对账。

世界状态包含支付成功率、错误率、P95 延迟、Provider 状态、受影响客户数、支持队列、
重复扣费数量，以及事件响应与对账状态。

## 参与方与权限

| 参与方                | 控制方式 | 主要职责                                      |
| --------------------- | -------- | --------------------------------------------- |
| Incident Commander    | Human    | 声明 SEV1、管理沟通节奏、关闭事件             |
| On-call Engineer      | Agent    | 分析指标、隔离风险、联系 Provider、回滚与验证 |
| Customer Support Lead | Agent    | 状态页、客户通知与重复扣费对账                |
| Executive Stakeholder | Agent    | 接收影响与风险升级信息                        |
| Monitoring System     | System   | 提供监控范围内的信号可见性                    |
| Payment Provider      | Agent    | 接收 Provider 范围的联系与恢复更新            |

冻结自动重试、禁用支付写入和启动回滚都是高风险动作，必须先经过 Kernel 审批；
任何不具备 capability、permission 或 knowledge scope 的参与方都会被拒绝。

## 五分钟演示流程

1. 使用 seed `20260716` 创建并启动 SaaS Payment Incident 运行。支付成功率降为 53%，
   并向指挥、值班、客服和管理层发送故障信号。
2. On-call 执行 `inspect-metrics`，Incident Commander 执行 `declare-incident`。
   Review 时间线会出现监控确认和 SEV1 指挥责任。
3. On-call 依次申请 `freeze-payment-retries` 和 `disable-payment-writes`，在审批面板批准。
   展示未审批时没有状态副作用，批准后才产生隔离事件。
4. On-call 联系 Provider；客服发布状态页；指挥同步管理层。推进 5 分钟以触发支持队列与
   重复扣费 Inject，然后客服通知客户并启动对账。
5. On-call 申请并批准 `start-rollback`，推进 2 分钟后验证恢复；最后由指挥关闭事件。
   六个 Evaluator 都应得到 100 分，并在 Review 中关联运行时间线证据。

## 固定 Eval 数据集

| 数据集         |          固定 seed | 覆盖点                                           |
| -------------- | -----------------: | ------------------------------------------------ |
| 主闭环         |         `20260716` | 监控确认、审批、客户沟通、对账、回滚、恢复验证   |
| 重复扣费       | `10000` 至 `10019` | 第 5 分钟 Inject 与财务完整性处置                |
| Provider 延迟  | `10000` 至 `10019` | 未联系 Provider 时第 3 分钟的升级 Inject         |
| 权限与审批对抗 |               `42` | 越权 action 被拒绝、拒绝审批不会产生高风险副作用 |

`test/pack.test.ts` 会连续执行 20 个固定 seed，验证状态 Schema、事件连续序号、评分证据类型
与完整闭环。Agent 的真实 token、费用和延迟数据由运行时 Provider 返回后写入 UsageLedger；
费用以 `micro_usd` 整数保存，缺少 Provider 用量时不会伪造 Token 或费用。

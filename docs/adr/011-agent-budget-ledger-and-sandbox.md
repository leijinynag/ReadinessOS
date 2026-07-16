# ADR-011：Agent 预算账本与 Sandbox

## 决策

Agent 成本边界以数据库 `UsageLedger` 为权威来源；Eve 流事件转换为 Turn、Token、工具、子 Agent、
费用和延迟记录。生产可用 Sandbox 默认拒绝全部网络出口。

## 原因

浏览器状态和进程内计数无法抵抗重试、重放或多实例部署。将账本与 Trace 幂等锚点写入同一事务后，
预算可在任何实例上稳定读取。

## 后果

预算预检阻止已耗尽 Run 的下一次 Agent Turn；单次已经启动的 Turn 仍需通过 Sandbox 与 Provider 配额
共同限制。`just-bash` 没有等价网络隔离能力，只能用于本地开发。

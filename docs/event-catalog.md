# ReadinessOS Event Catalog

> 版本：0.1  
> 更新日期：2026-07-11

## 事件信封

每个 DomainEvent 使用 `@readinessos/domain-events` 中的 `DomainEvent` 信封：

- `id`：全局 UUID；
- `organizationId`、`runId`：租户与运行边界；
- `sequence`：单 Run 内严格递增的正整数；
- `type`、`version`：事件类型与 payload 版本；
- `source`、`participantId`：事实来源；
- `simulatedAt`、`recordedAt`：虚拟时间与记录时间；
- `causationId`、`correlationId`：因果与请求关联；
- `idempotencyKey`：重复 Command 或 Workflow tick 的去重键；
- `payload`：由具体事件版本定义的 JSON 值。

## 初始事件类型

| 事件                         | 版本 | 说明                                     |
| ---------------------------- | ---- | ---------------------------------------- |
| `run.created`                | 1    | 创建运行及初始种子。                     |
| `run.started`                | 1    | 运行开始。                               |
| `run.paused`                 | 1    | 运行暂停。                               |
| `run.resumed`                | 1    | 运行继续。                               |
| `run.completed`              | 1    | 满足终止条件或手动结束。                 |
| `run.failed`                 | 1    | 无法恢复的运行失败。                     |
| `clock.advanced`             | 1    | 虚拟时间离散推进。                       |
| `signal.emitted`             | 1    | 场景产生新的 Signal。                    |
| `signal.observed`            | 1    | 参与方观察到可见 Signal。                |
| `action.proposed`            | 1    | Human 或 Agent 提出动作。                |
| `action.rejected`            | 1    | 动作未通过策略、前置条件或当前状态检查。 |
| `action.approval_requested`  | 1    | 高风险动作等待审批。                     |
| `action.approved`            | 1    | 动作获得业务审批。                       |
| `action.denied`              | 1    | 动作被拒绝。                             |
| `action.executed`            | 1    | Kernel 已执行动作。                      |
| `state.changed`              | 1    | WorldState 的受控变更。                  |
| `inject.scheduled`           | 1    | 注册在未来虚拟时间触发的预定义 Inject。  |
| `inject.triggered`           | 1    | Director 或调度触发预定义 Inject。       |
| `metric.recorded`            | 1    | 记录场景内用于评估的确定性指标。         |
| `participant.joined`         | 1    | 参与方加入运行。                         |
| `participant.status_changed` | 1    | 参与方状态改变。                         |
| `decision.recorded`          | 1    | 记录可复盘的关键决策。                   |
| `checkpoint.created`         | 1    | 创建可回放和分支的检查点。               |
| `evaluation.completed`       | 1    | 完成一个评估维度。                       |
| `remediation.created`        | 1    | 创建整改项。                             |
| `branch.created`             | 1    | 从父运行检查点创建子运行。               |

新增事件或破坏性 payload 修改必须新增版本、提供 upcaster，或声明新事件类型；已写入事实不可原地修改。

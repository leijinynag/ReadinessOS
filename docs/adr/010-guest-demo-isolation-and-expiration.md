# ADR-010：Guest Demo 隔离与时效

## 决策

每次 Guest Demo 创建独立 Organization、Guest User 和 owner Member，并复制共享演示组织中已发布的
ScenarioVersion。访客 token 仅以 HMAC 保存；Run 与身份分别具有到期时间。

## 原因

复用共享组织会让访客数据、成员关系和 Run 互相可见，且难以在既有授权模型中安全清理。独立组织允许
现有组织权限查询继续作为租户边界。

## 后果

Guest 创建需要限制频率，因此使用数据库固定窗口限流。Guest 可完成受控 Studio 演示，但不能创建分支、
触发 Director Inject 或执行 Agent Turn。

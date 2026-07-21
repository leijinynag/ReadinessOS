import type { AgentDispatchWorkflowInput } from '@/lib/agent-dispatch-execution';
import { executeAgentDispatch } from '@/lib/agent-dispatch-execution';

/**
 * Eve 推理可能比 HTTP 请求生命周期长。这里仅负责编排，所有数据库和网络访问
 * 均放在 step 中，使 Workflow Runtime 可以在宿主重启后继续执行。
 */
export async function agentDispatchWorkflow(input: AgentDispatchWorkflowInput): Promise<void> {
  'use workflow';

  await executeAgentDispatchStep(input);
}

async function executeAgentDispatchStep(input: AgentDispatchWorkflowInput): Promise<void> {
  'use step';

  await executeAgentDispatch(input);
}

// Dispatch 自己维护指数退避及审计活动；避免 Workflow 的立即重试与 Outbox 重试
// 叠加，造成同一个模型调用在短时间内被放大。
executeAgentDispatchStep.maxRetries = 0;

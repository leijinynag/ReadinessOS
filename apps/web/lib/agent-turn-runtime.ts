import { AgentObservationService } from '@readinessos/application';
import { prisma } from '@readinessos/database';
import { ApplicationError } from '@readinessos/domain-events';
import { AgentTurnService } from '@/lib/agent-turn-service';
import { createEveAgentRuntime } from '@/lib/eve-agent-runtime';
import { env } from '@/lib/env';
import { withSpan } from '@/lib/observability';
import { getAgentRunBudget, requireAgentRunBudget } from '@/lib/release-policy';
import { runService } from '@/lib/run-runtime';

export function createProductionAgentTurnService(origin: string): AgentTurnService {
  const observationService = new AgentObservationService(prisma);
  return new AgentTurnService({
    runtimeFactory() {
      // 一体化部署时 Eve 会由 Next.js 将 /eve/v1 代理到动态 Runtime 端口，
      // 因此服务端 Client 必须使用当前请求的绝对 Origin，不能使用相对地址。
      const host = env.EVE_RUNTIME_URL?.trim() || origin;
      return createEveAgentRuntime(prisma, host);
    },
    async buildObservation(input) {
      return withSpan('readinessos.agent.observation', { 'run.id': input.runId }, async () => {
        const budget = await getAgentRunBudget(prisma, input.runId);
        const pack = await runService.getRunScenarioPack(input.runId, input.organizationId);
        return observationService.build({
          ...input,
          pack,
          remainingTurns: budget.remainingTurns,
          remainingTokens: budget.remainingTokens,
        });
      });
    },
    async requireAgentParticipant(input) {
      const participant = await prisma.runParticipant.findFirst({
        where: {
          id: input.participantId,
          runId: input.runId,
          controller: 'agent',
          run: { organizationId: input.organizationId, status: 'running' },
        },
        select: { id: true, runId: true, key: true },
      });
      if (!participant) {
        throw new ApplicationError('NOT_FOUND', 'Agent participant not found.');
      }
      await requireAgentRunBudget(prisma, participant.runId);
      return { agentKey: participant.key };
    },
  });
}

const services = new Map<string, AgentTurnService>();

export function getProductionAgentTurnService(origin: string): AgentTurnService {
  let service = services.get(origin);
  if (!service) {
    service = createProductionAgentTurnService(origin);
    services.set(origin, service);
  }
  return service;
}

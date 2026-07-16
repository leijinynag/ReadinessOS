import { AgentObservationService } from '@readinessos/application';
import { prisma } from '@readinessos/database';
import { ApplicationError } from '@readinessos/domain-events';
import { AgentTurnService } from '@/lib/agent-turn-service';
import { createEveAgentRuntime } from '@/lib/eve-agent-runtime';
import { env } from '@/lib/env';
import { withSpan } from '@/lib/observability';
import { getAgentRunBudget, requireAgentRunBudget } from '@/lib/release-policy';

export function createProductionAgentTurnService(): AgentTurnService {
  const observationService = new AgentObservationService(prisma);
  return new AgentTurnService({
    runtimeFactory() {
      const host = env.EVE_BASE_URL?.trim();
      if (!host) {
        throw new Error('EVE_BASE_URL is required to run an agent turn.');
      }
      const apiKey = env.EVE_API_KEY?.trim() || undefined;
      return createEveAgentRuntime(prisma, host, apiKey);
    },
    async buildObservation(input) {
      return withSpan('readinessos.agent.observation', { 'run.id': input.runId }, async () => {
        const budget = await getAgentRunBudget(prisma, input.runId);
        return observationService.build({
          ...input,
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
        select: { id: true, runId: true },
      });
      if (!participant) {
        throw new ApplicationError('NOT_FOUND', 'Agent participant not found.');
      }
      await requireAgentRunBudget(prisma, participant.runId);
    },
  });
}

let service: AgentTurnService | undefined;
export function getProductionAgentTurnService(): AgentTurnService {
  service ??= createProductionAgentTurnService();
  return service;
}

import { AgentObservationService } from '@readinessos/application';
import { prisma } from '@readinessos/database';
import { ApplicationError } from '@readinessos/domain-events';
import { AgentTurnService } from '@/lib/agent-turn-service';
import { createEveAgentRuntime } from '@/lib/eve-agent-runtime';
import { env } from '@/lib/env';

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
    buildObservation: (input) => observationService.build(input),
    async requireAgentParticipant(input) {
      const participant = await prisma.runParticipant.findFirst({
        where: {
          id: input.participantId,
          runId: input.runId,
          controller: 'agent',
          run: { organizationId: input.organizationId, status: 'running' },
        },
        select: { id: true },
      });
      if (!participant) {
        throw new ApplicationError('NOT_FOUND', 'Agent participant not found.');
      }
    },
  });
}

let service: AgentTurnService | undefined;
export function getProductionAgentTurnService(): AgentTurnService {
  service ??= createProductionAgentTurnService();
  return service;
}
